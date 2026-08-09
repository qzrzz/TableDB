import { SQLiteAdapter } from "../../../adapter/SQLite"
import type { ITreeNode } from "../tree.types"
import { TableTree } from "../TableTree"

interface ITestTreeNode extends ITreeNode {
    note?: string
}

async function createTree(name: string): Promise<TableTree<ITestTreeNode>> {
    const table = new TableTree<ITestTreeNode>({
        name,
        adapter: SQLiteAdapter({ filename: ":memory:" }),
        enableMarkDelete: true,
    })
    await table.inited
    return table
}

function file(id: string, parentId: string, name = id): Partial<ITestTreeNode> {
    return { id, parentId, name, isDir: false, size: 1 }
}

describe("TableTree", () => {
    test("setNodes 工具可以在一个事务中按父子拓扑创建节点", async () => {
        const table = await createTree("tree-set-topology")

        const result = await table.setNodes([
            { id: "dir", parentId: "/", name: "目录", isDir: true },
            file("child", "dir", "文件"),
        ], { returnChangedNodesIds: true })

        expect(result.changedNodeIds).toEqual(expect.arrayContaining(["dir", "child"]))
        expect((await table.get("child"))?.parentId).toBe("dir")
        expect((await table.get("dir"))?.ctotal).toBe(1)
    })

    test("moveNodes 和 deleteNodes 共用事务上下文并维护父级统计", async () => {
        const table = await createTree("tree-structure")
        await table.setNodes([
            { id: "a", parentId: "/", name: "A", isDir: true },
            { id: "b", parentId: "/", name: "B", isDir: true },
            file("f", "a"),
        ])

        await table.moveNodes(["f"], "b")
        expect((await table.get("f"))?.parentId).toBe("b")
        expect((await table.get("a"))?.ctotal ?? 0).toBe(0)
        expect((await table.get("b"))?.ctotal).toBe(1)

        const deleted = await table.deleteNodes(["b"])
        expect(deleted.deletedCount).toBe(2)
        expect(await table.get("f")).toBeUndefined()
        expect(await table.get("b")).toBeUndefined()
    })

    test("setNodes 中途失败时事务会回滚已经执行的 core 写入", async () => {
        const table = await createTree("tree-rollback")

        await expect(table.setNodes([
            { id: "created-before-error", parentId: "/", name: "临时目录", isDir: true },
            file("orphan", "missing-parent"),
        ])).rejects.toThrow("不存在的父节点")

        expect(await table.get("created-before-error")).toBeUndefined()
    })

    test("setNodes 的 replace 覆盖会拆解为 delete、create 和 update core", async () => {
        const table = await createTree("tree-overwrite")
        await table.setNodes([file("old", "/", "same.txt")])

        await table.setNodes([file("new", "/", "same.txt")], {
            uniqueBy: "name",
            overwriteMode: "replace",
        })

        expect(await table.get("old")).toBeUndefined()
        expect((await table.get("new"))?.name).toBe("same.txt")
    })

    test("setNodes 可以恢复软删除节点并通过 move core 更新两侧父级统计", async () => {
        const table = await createTree("tree-restore")
        await table.setNodes([
            { id: "a", parentId: "/", name: "A", isDir: true },
            { id: "b", parentId: "/", name: "B", isDir: true },
            file("f", "a"),
        ])
        await table.deleteNodes(["f"])

        await table.setNodes([file("f", "b", "恢复文件")])
        expect((await table.get("f"))?.parentId).toBe("b")
        expect((await table.get("a"))?.ctotal ?? 0).toBe(0)
        expect((await table.get("b"))?.ctotal).toBe(1)
    })

    test("setNodes 的 merge 会把来源目录子节点迁移到目标目录", async () => {
        const table = await createTree("tree-merge")
        await table.setNodes([
            { id: "target", parentId: "/", name: "合并目录", isDir: true },
            { id: "source", parentId: "/", name: "合并目录", isDir: true },
            file("source-child", "source", "来源文件"),
        ])

        await table.setNodes([
            { id: "source", parentId: "/", name: "合并目录", isDir: true },
            file("source-child", "source", "来源文件"),
        ], { uniqueBy: "name", overwriteMode: "merge" })

        expect(await table.get("source")).toBeUndefined()
        expect((await table.get("source-child"))?.parentId).toBe("target")
        expect((await table.get("target"))?.ctotal).toBe(1)
    })

    test("updateNodes 默认只处理内容更新，不要求额外的事务包装", async () => {
        const table = await createTree("tree-update")
        await table.setNodes([file("f", "/", "f")])

        await table.updateNodes({ id: "f" }, { $set: { note: "内容更新" } as any })
        expect((await table.get("f"))?.note).toBe("内容更新")
    })
})
