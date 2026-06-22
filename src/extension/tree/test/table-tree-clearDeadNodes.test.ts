import { SQLiteAdapter } from "../../../adapter/SQLite"
import { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"
import { clearDeadNodes } from "../tool/clearDeadNodes"

function createTreeTable(name: string, enableMarkDelete = true) {
    return new TableTree<ITreeNode>({
        name,
        adapter: SQLiteAdapter({ filename: ":memory:", driver: "better-sqlite3" }),
        enableMarkDelete,
    })
}

describe("TableTree clearDeadNodes 死节点清理工具", () => {
    test("空树情况下运行不应该报错并返回 0", async () => {
        const table = createTreeTable("tree_clear_empty")
        await table.inited

        const deadCount = await clearDeadNodes(table)
        expect(deadCount).toBe(0)
    })

    test("正常树结构下运行不应误删任何节点", async () => {
        const table = createTreeTable("tree_clear_normal")
        await table.inited

        // 创建根节点和子节点
        await table.createNodes([{ id: "dir-a", name: "文件夹A", isDir: true }], "/")
        await table.createNodes([
            { id: "file-b", name: "文件B.txt", size: 10, isDir: false },
            { id: "dir-c", name: "文件夹C", isDir: true },
        ], "dir-a")
        await table.createNodes([{ id: "file-d", name: "文件D.txt", size: 20, isDir: false }], "dir-c")

        const deadCount = await clearDeadNodes(table)
        expect(deadCount).toBe(0)

        // 验证结构仍然完整，且节点上没有残留临时属性
        const fileD = await table.get("file-d")
        expect(fileD).toBeDefined()
        expect(fileD?.parentId).toBe("dir-c")
        expect((fileD as any).__checkIsNotDead).toBeUndefined()
    })

    test("应能成功扫描并物理删除孤立的无效子树", async () => {
        const table = createTreeTable("tree_clear_orphans", false) // 物理删除表
        await table.inited

        await table.createNodes([{ id: "dir-a", name: "文件夹A", isDir: true }], "/")
        await table.createNodes([{ id: "dir-b", name: "文件夹B", isDir: true }], "dir-a")
        await table.createNodes([{ id: "file-c", name: "文件C.txt", size: 5, isDir: false }], "dir-b")

        // 模拟外部意外物理删除父节点 dir-b，保留其子节点 file-c
        await table.adapter.delete("dir-b")

        expect(await table.get("dir-b")).toBeUndefined()
        // 子节点 file-c 在数据库中依然存在
        expect(await table.get("file-c")).toBeDefined()

        // 运行清理
        const deadCount = await clearDeadNodes(table)
        expect(deadCount).toBe(1) // 应该删除 file-c

        // 验证 file-c 已被物理删除
        expect(await table.get("file-c")).toBeUndefined()
        // 根文件夹 dir-a 依然存在
        expect(await table.get("dir-a")).toBeDefined()
    })

    test("在开启标记删除时，清理死节点应物理删除孤立节点，但保留已逻辑删除的节点", async () => {
        const table = createTreeTable("tree_clear_with_mark_delete", true) // 启用标记删除
        await table.inited

        // 创建根节点和子节点
        await table.createNodes([{ id: "dir-a", name: "文件夹A", isDir: true }], "/")
        await table.createNodes([{ id: "dir-b", name: "文件夹B", isDir: true }], "dir-a")
        await table.createNodes([{ id: "file-c", name: "文件C.txt", size: 5, isDir: false }], "dir-b")
        await table.createNodes([{ id: "file-d", name: "文件D.txt", size: 10, isDir: false }], "dir-a")

        // 正常使用 table 删除 dir-b。由于启用了标记删除，这会标记 dir-b 和它的子节点 file-c 均为逻辑删除
        await table.deleteNodes(["dir-b"])

        // 此时在正常视图中 dir-b 和 file-c 均不可见
        expect(await table.get("dir-b")).toBeUndefined()
        expect(await table.get("file-c")).toBeUndefined()

        // 模拟脏数据产生：手动将 file-c 恢复为未删除状态（但它的父级 dir-b 依然是 _isDeleted: true）
        await table.adapter.updateOne({ id: "file-c" }, { $unset: { _isDeleted: "" } as any })
        const fileCReal = await table.adapter.get("file-c")
        expect(fileCReal?._isDeleted).toBeUndefined() // 现在它是正常存活的孤立节点

        // 运行清理
        const deadCount = await clearDeadNodes(table)
        expect(deadCount).toBe(1) // 应该清理 file-c，因为它是正常未删除的孤立节点

        // 验证 file-c 已被物理删除
        expect(await table.adapter.get("file-c")).toBeUndefined()

        // 验证 dir-b 这一逻辑删除的记录应当被保留，不被物理删除
        const dirBReal = await table.adapter.get("dir-b")
        expect(dirBReal).toBeDefined()
        expect(dirBReal?._isDeleted).toBe(true)

        // 验证非孤立的正常节点不受影响
        expect(await table.get("file-d")).toBeDefined()
    })
})
