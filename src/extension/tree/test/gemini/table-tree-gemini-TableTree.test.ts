import { SQLiteAdapter } from "../../../../adapter/SQLite"
import { TableTree } from "../../TableTree"
import type { ITreeNode } from "../../tree.types"

function createTreeTable(name: string) {
    return new TableTree<ITreeNode>({
        name,
        adapter: SQLiteAdapter({ filename: ":memory:", driver: "better-sqlite3" }),
        enableMarkDelete: true,
    })
}

describe("TableTree 目录树 BUG 测试 (Gemini)", () => {
    test("使用 setNodes 批量创建嵌套多层级节点时，父节点的统计信息（ctotal, csize 等）应该正确维护", async () => {
        const table = createTreeTable("tree_bug_nested_set_nodes")
        await table.inited

        // 一次性批量写入三层嵌套 of 目录树结构
        await table.setNodes([
            { id: "dir1", name: "dir1", isDir: true, parentId: "/" },
            { id: "dir2", name: "dir2", isDir: true, parentId: "dir1" },
            { id: "file1", name: "file1.txt", isDir: false, size: 100, parentId: "dir2" },
        ])

        const nodeDir2 = await table.get("dir2")
        const nodeDir1 = await table.get("dir1")

        // 验证第二层节点 dir2 的统计信息
        expect(nodeDir2?.ctotal).toBe(1)
        expect(nodeDir2?.cftotal).toBe(1)
        expect(nodeDir2?.csize).toBe(100)

        // 验证第一层节点 dir1 的统计信息
        // 应该包含 dir2 (1个目录) 加上 file1 (1个文件)，共计 2 个后代节点
        expect(nodeDir1?.ctotal).toBe(2)
        expect(nodeDir1?.cftotal).toBe(1)
        expect(nodeDir1?.csize).toBe(100)
    })

    test("当父节点的 ctotal 或 csize 从 undefined 变为有值时，其 modif 应该被更新", async () => {
        const table = createTreeTable("tree_bug_modif_update")
        await table.inited

        // 1. 创建一个初始为空的目录
        await table.createNodes([{ id: "dir", name: "dir", isDir: true }], "/")
        const dirInit = await table.get("dir")
        expect(dirInit?.ctotal).toBeUndefined()
        expect(dirInit?.csize).toBeUndefined()
        const initModif = dirInit?.modif
        expect(initModif).toBeGreaterThan(0)

        // 稍作延迟确保时间戳不同
        await new Promise((resolve) => setTimeout(resolve, 5))

        // 2. 在该目录下创建一个子文件，使得 ctotal 从 undefined 变为 1，csize 从 undefined 变为 10
        await table.createNodes([{ id: "file", name: "file.txt", size: 10, isDir: false }], "dir")

        const dirAfter = await table.get("dir")
        expect(dirAfter?.ctotal).toBe(1)
        expect(dirAfter?.csize).toBe(10)

        // 验证 modif 确实被更新（变大）
        expect(dirAfter?.modif).toBeGreaterThan(initModif!)
    })

    test("使用 copyNodes 递归复制多层级嵌套节点时，复制得到的新目录的统计信息应该正确维护", async () => {
        const table = createTreeTable("tree_bug_copy_nested")
        await table.inited

        // 1. 创建嵌套结构（分批创建以避开 setNodes 的 bug）
        await table.createNodes([{ id: "dir1", name: "dir1", isDir: true }], "/")
        await table.createNodes([{ id: "dir2", name: "dir2", isDir: true }], "dir1")
        await table.createNodes([{ id: "file1", name: "file1.txt", isDir: false, size: 100 }], "dir2")

        // 2. 递归复制整个目录
        const result = await table.copyNodes(["dir1"], "/", { deep: true, renameOnCopy: true })
        expect(result.createdNodeIds.length).toBe(1)
        const copiedRootId = result.createdNodeIds[0]

        // 查找复制出来的 dir2 节点
        const copiedDir2List = await table.findMany({ parentId: copiedRootId, name: "dir2" })
        expect(copiedDir2List.length).toBe(1)
        const copiedDir2 = copiedDir2List[0]

        const copiedRoot = await table.get(copiedRootId)

        // 验证复制出来的子目录和根目录的统计信息
        expect(copiedDir2?.ctotal).toBe(1)
        expect(copiedDir2?.cftotal).toBe(1)
        expect(copiedDir2?.csize).toBe(100)

        expect(copiedRoot?.ctotal).toBe(2)
        expect(copiedRoot?.cftotal).toBe(1)
        expect(copiedRoot?.csize).toBe(100)
    })
})