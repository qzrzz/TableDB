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

    test("updateNodes 应忽略 parentId，不能通过更新制造父子环", async () => {
        const table = await createTree("tree-update-ignore-parent")
        await table.setNodes([
            { id: "p", parentId: "/", name: "父", isDir: true },
            { id: "c", parentId: "p", name: "子", isDir: true },
        ])

        await table.updateNodes({ id: "p" }, { $set: { parentId: "c", note: "仍更新内容" } as any })
        expect((await table.get("p"))?.parentId).toBe("/")
        expect((await table.get("p"))?.note).toBe("仍更新内容")
        expect((await table.get("c"))?.parentId).toBe("p")
    })

    test("moveNodes 默认按 id 移动时不得删除目标父级下的兄弟节点", async () => {
        const table = await createTree("tree-move-no-wipe")
        await table.setNodes([
            { id: "a", parentId: "/", name: "A", isDir: true },
            { id: "b", parentId: "/", name: "B", isDir: true },
            file("f1", "a"),
            file("f2", "b"),
            file("f3", "b"),
        ])

        await table.moveNodes(["f1"], "b")
        expect((await table.get("f1"))?.parentId).toBe("b")
        expect(await table.get("f2")).toBeDefined()
        expect(await table.get("f3")).toBeDefined()
        expect((await table.listNodes("b")).list.map((node) => node.id).sort()).toEqual(["f1", "f2", "f3"])
    })

    test("setNodes 移动已有节点时不得删除目标父级下的兄弟节点", async () => {
        const table = await createTree("tree-set-move-no-wipe")
        await table.setNodes([
            { id: "a", parentId: "/", name: "A", isDir: true },
            { id: "b", parentId: "/", name: "B", isDir: true },
            file("f1", "a"),
            file("f2", "b"),
            file("f3", "b"),
        ])

        await table.setNodes([file("f1", "b", "f1")])
        expect((await table.get("f1"))?.parentId).toBe("b")
        expect(await table.get("f2")).toBeDefined()
        expect(await table.get("f3")).toBeDefined()
    })

    test("moveNodes 的 newName 应真正写入新名称", async () => {
        const table = await createTree("tree-move-newname")
        await table.setNodes([
            { id: "d1", parentId: "/", name: "D1", isDir: true },
            { id: "d2", parentId: "/", name: "D2", isDir: true },
            file("a", "d1", "file.txt"),
            file("b", "d2", "file.txt"),
        ])

        await table.moveNodes(["a"], "d2", { uniqueBy: "name", overwriteMode: "newName" })
        expect((await table.get("a"))?.parentId).toBe("d2")
        expect((await table.get("a"))?.name).toBe("file (1).txt")
        expect((await table.get("b"))?.name).toBe("file.txt")
    })

    test("moveNodes 默认禁止文件覆盖目录", async () => {
        const table = await createTree("tree-move-file-over-dir")
        await table.setNodes([
            { id: "d", parentId: "/", name: "item", isDir: true },
            file("child", "d", "c"),
            { id: "src", parentId: "/", name: "src", isDir: true },
            file("f", "src", "item"),
        ])

        await table.moveNodes(["f"], "/", { uniqueBy: "name", overwriteMode: "replace" })
        expect(await table.get("d")).toBeDefined()
        expect(await table.get("child")).toBeDefined()
        expect((await table.get("f"))?.parentId).toBe("src")
    })

    test("moveNodes 的 merge 对文件冲突应按替换处理", async () => {
        const table = await createTree("tree-move-merge-file")
        await table.setNodes([
            { id: "d", parentId: "/", name: "D", isDir: true },
            file("a", "d", "same.txt"),
            { id: "src", parentId: "/", name: "src", isDir: true },
            { id: "b", parentId: "src", name: "same.txt", isDir: false, size: 2 },
        ])

        await table.moveNodes(["b"], "d", { uniqueBy: "name", overwriteMode: "merge" })
        expect(await table.get("a")).toBeUndefined()
        expect((await table.get("b"))?.parentId).toBe("d")
        expect((await table.get("b"))?.size).toBe(2)
    })

    test("setNodes 的 mergeByModif 应保留较新的同名文件", async () => {
        const table = await createTree("tree-set-merge-modif")
        await table.setNodes([{ id: "old", parentId: "/", name: "f.txt", modif: 100, size: 1 }])
        await table.setNodes([{ id: "new", parentId: "/", name: "f.txt", modif: 50, size: 9 }], {
            uniqueBy: "name",
            overwriteMode: "mergeByModif",
        })

        expect(await table.get("old")).toBeDefined()
        expect((await table.get("old"))?.size).toBe(1)
        expect(await table.get("new")).toBeUndefined()
    })

    test("refreshTreeMetadata 应修复空目录上的过期统计", async () => {
        const table = await createTree("tree-refresh-empty")
        await table.setNodes([
            { id: "dir", parentId: "/", name: "目录", isDir: true },
            file("f", "dir", "文件"),
        ])
        await table.adapter.updateMany(
            { id: "dir" },
            { $set: { ctotal: 99, cftotal: 99, csize: 999 } as any },
        )
        await table.adapter.deleteMany({ id: "f" }, { readDelete: true } as any)

        await table.refreshTreeMetadata("dir")
        expect((await table.get("dir"))?.ctotal).toBeUndefined()
        expect((await table.get("dir"))?.csize).toBeUndefined()
    })
})
