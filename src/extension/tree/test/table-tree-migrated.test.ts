import { SQLiteAdapter } from "../../../adapter/SQLite"
import type { ITreeNode } from "../tree.types"
import { TableTree, defineTableTree } from "../TableTree"

interface ITestTreeNode extends ITreeNode {
    type?: string
    tag?: string
    meta?: { group?: string }
}

let tableIndex = 0

async function createTree(name: string, enableMarkDelete = true): Promise<TableTree<ITestTreeNode>> {
    const table = new TableTree<ITestTreeNode>({
        name: `tree-migrated-${tableIndex++}-${name}`,
        adapter: SQLiteAdapter({ filename: ":memory:", driver: "better-sqlite3" }),
        enableMarkDelete,
    })
    await table.inited
    return table
}

async function createFixture(table: TableTree<ITestTreeNode>): Promise<void> {
    await table.createNodes(
        [
            { id: "root-a", name: "根 A", isDir: true },
            { id: "root-b", name: "根 B", isDir: true },
        ],
        "/",
        { index: { toEnd: true } },
    )
    await table.createNodes(
        [
            { id: "file-a", name: "a.txt", isDir: false, type: "text", size: 10, tag: "keep", meta: { group: "g1" } },
            { id: "dir-a", name: "目录 A", isDir: true, type: "dir", tag: "keep", meta: { group: "g1" } },
            { id: "file-b", name: "b.png", isDir: false, type: "image", size: 20, tag: "drop", meta: { group: "g2" } },
            { id: "file-c", name: "c.md", isDir: false, type: "text", size: 30, tag: "keep", meta: { group: "g2" } },
        ],
        "root-a",
        { index: { toEnd: true } },
    )
    await table.createNodes([{ id: "deep-file", name: "deep.txt", isDir: false, type: "text" }], "dir-a")
    await table.createNodes([{ id: "other-file", name: "other.txt", isDir: false, type: "text" }], "root-b")
}

function ids(nodes: ITreeNode[]): string[] {
    return nodes.map((node) => node.id)
}

describe("TableTree 旧测试迁移后的核心场景", () => {
    test("defineTableTree 应返回新的 TableTree 实例", async () => {
        const useTree = defineTableTree<ITestTreeNode>({
            name: `tree-migrated-defined-${tableIndex++}`,
            adapter: SQLiteAdapter({ filename: ":memory:" }),
        })

        const table = await useTree()
        expect(table).toBeInstanceOf(TableTree)
        expect(typeof table.createNodes).toBe("function")
        expect(typeof table.setNodes).toBe("function")
    })

    test("createNodes 应校验父节点、归一化字段并维护统计", async () => {
        const table = await createTree("create")

        await expect(table.createNodes([{ id: "missing", name: "missing", isDir: false }], "missing-parent"))
            .rejects.toThrow("父节点不存在")

        const result = await table.createNodes(
            [{ id: "dir", parentId: "wrong", name: "目录", isDir: true, ctotal: 99 } as any],
            "/",
            { returnNewNodes: true },
        )
        await table.createNodes([{ id: "file", name: "文件", isDir: false, size: 10 }], "dir")

        expect(result.createdNodeIds).toEqual(["dir"])
        expect(result.newNodes?.[0].parentId).toBe("/")
        expect((await table.get("dir"))?.ctotal).toBe(1)
        expect((await table.get("dir"))?.csize).toBe(10)
    })

    test("createNodes 应支持旧测试中的首尾和相邻排序语义", async () => {
        const table = await createTree("index")
        await table.createNodes([{ id: "dir", name: "目录", isDir: true }], "/")
        await table.createNodes([{ id: "a", name: "a", isDir: false }], "dir", { index: { toEnd: true } })
        await table.createNodes([{ id: "b", name: "b", isDir: false }], "dir", { index: { toEnd: true } })
        await table.createNodes([{ id: "start", name: "start", isDir: false }], "dir", { index: { toStart: true } })
        await table.createNodes([{ id: "between", name: "between", isDir: false }], "dir", {
            index: { prevNodeId: "a", nextNodeId: "b" },
        })

        const result = await table.listNodes("dir", { pageSize: 20 })
        expect(ids(result.list)).toEqual(["start", "a", "between", "b"])
        expect((await table.get("dir"))?.childLastIndex).toBe((await table.get("b"))?.index)
    })

    test("listNodes 应支持直属子节点、过滤、分页和软删除可见性", async () => {
        const table = await createTree("list")
        await createFixture(table)

        const first = await table.listNodes("root-a", { pageIndex: 1, pageSize: 2, getTotal: true })
        const second = await table.listNodes("root-a", { pageIndex: 2, pageSize: 2, getTotal: true })
        expect(ids(first.list)).toEqual(["file-a", "dir-a"])
        expect(ids(second.list)).toEqual(["file-b", "file-c"])
        expect(first.total).toBe(4)
        expect(first.hasNext).toBe(true)

        const filtered = await table.listNodes("root-a", {
            pageSize: 20,
            onlyTypes: ["text"],
            onlyNotTypes: ["text"],
            filter: { parentId: "root-b", tag: "keep" },
        })
        expect(ids(filtered.list)).toEqual(["file-a", "file-c"])

        await table.deleteNodes(["file-b"])
        expect(ids((await table.listNodes("root-a", { pageSize: 20 })).list)).toEqual(["file-a", "dir-a", "file-c"])
        expect(ids((await table.listNodes("root-a", { pageSize: 20, ignoreMarkDelete: true })).list))
            .toEqual(["file-a", "dir-a", "file-b", "file-c"])
    })

    test("listNodes 应支持投影和自定义排序", async () => {
        const table = await createTree("list-options")
        await createFixture(table)

        const result = await table.listNodes("root-a", {
            pageSize: 20,
            sort: { name: -1 },
            projection: ["id", "name"],
        })
        expect(result.list).toEqual([
            { id: "dir-a", name: "目录 A" },
            { id: "file-c", name: "c.md" },
            { id: "file-b", name: "b.png" },
            { id: "file-a", name: "a.txt" },
        ])
    })

    test("deleteNodes 应递归删除、保持幂等并更新父级统计", async () => {
        const table = await createTree("delete")
        await table.createNodes([{ id: "root", name: "根", isDir: true }], "/")
        await table.createNodes([{ id: "dir", name: "目录", isDir: true }, { id: "root-file", name: "根文件", size: 5 }], "root")
        await table.createNodes([{ id: "file", name: "文件", size: 10 }, { id: "sub", name: "子目录", isDir: true }], "dir")
        await table.createNodes([{ id: "deep", name: "深层", size: 20 }], "sub")

        const result = await table.deleteNodes(["dir", "sub"])
        expect(result).toEqual({ hasDeleted: true, hasChildDeleted: true, deletedCount: 4 })
        expect(await table.get("dir")).toBeUndefined()
        expect(await table.get("deep")).toBeUndefined()
        expect((await table.get("root"))?.ctotal).toBe(1)
        expect((await table.get("root"))?.csize).toBe(5)
        await expect(table.deleteNodes(["dir"])).resolves.toEqual({
            hasDeleted: false,
            hasChildDeleted: false,
            deletedCount: 0,
        })
    })

    test("deleteNodes 的 realDelete 应清理已标记节点", async () => {
        const table = await createTree("real-delete")
        await table.createNodes([{ id: "dir", name: "目录", isDir: true }], "/")
        await table.createNodes([{ id: "file", name: "文件", size: 10 }], "dir")
        await table.deleteNodes(["file"])
        expect((await table.get("file", { ignoreMarkDelete: true }))?._isDeleted).toBe(true)

        await table.deleteNodes(["file"], { realDelete: true })
        expect(await table.get("file", { ignoreMarkDelete: true })).toBeUndefined()
        expect((await table.get("dir"))?.ctotal).toBeUndefined()
    })

    test("moveNodes 应更新新旧父级统计并防止移动到自身子树", async () => {
        const table = await createTree("move")
        await table.createNodes([{ id: "a", name: "A", isDir: true }, { id: "b", name: "B", isDir: true }], "/")
        await table.createNodes([{ id: "file", name: "文件", size: 8 }], "a")

        await table.moveNodes(["file"], "b")
        expect((await table.get("file"))?.parentId).toBe("b")
        expect((await table.get("a"))?.ctotal).toBeUndefined()
        expect((await table.get("b"))?.ctotal).toBe(1)

        await table.createNodes([{ id: "child", name: "子目录", isDir: true }], "b")
        await expect(table.moveNodes(["b"], "child")).rejects.toThrow()
    })

    test("updateNodes 应支持内容和大小更新，并刷新目录统计", async () => {
        const table = await createTree("update")
        await table.createNodes([{ id: "dir", name: "目录", isDir: true }], "/")
        await table.createNodes([{ id: "file", name: "文件", size: 8 }], "dir")

        await table.updateNodes({ id: "file" }, { $set: { name: "新文件", size: 12 } })
        expect((await table.get("file"))?.name).toBe("新文件")
        expect((await table.get("dir"))?.csize).toBe(12)
    })

    test("setNodes 应按父子拓扑创建并在失败时回滚整批写入", async () => {
        const table = await createTree("set-topology")
        await table.setNodes([
            { id: "dir", parentId: "/", name: "目录", isDir: true },
            { id: "file", parentId: "dir", name: "文件", size: 1 },
        ])
        expect((await table.get("dir"))?.ctotal).toBe(1)

        await expect(table.setNodes([
            { id: "created-before-error", parentId: "/", name: "临时" },
            { id: "orphan", parentId: "missing", name: "孤儿" },
        ])).rejects.toThrow("不存在的父节点")
        expect(await table.get("created-before-error")).toBeUndefined()
    })

    test("setNodes 应支持 newName、replace 和已删除节点恢复", async () => {
        const table = await createTree("set-overwrite")
        await table.setNodes([{ id: "old", parentId: "/", name: "文件.txt" }])
        await table.setNodes([{ id: "new", parentId: "/", name: "文件.txt" }], {
            uniqueBy: "name",
            overwriteMode: "newName",
        })
        expect((await table.get("new"))?.name).toBe("文件 (1).txt")

        await table.deleteNodes(["new"])
        await table.setNodes([{ id: "new", parentId: "/", name: "恢复.txt" }])
        expect((await table.get("new"))?.name).toBe("恢复.txt")

        await table.setNodes([{ id: "replacement", parentId: "/", name: "文件.txt" }], {
            uniqueBy: "name",
            overwriteMode: "replace",
        })
        expect(await table.get("old")).toBeUndefined()
        expect(await table.get("replacement")).toBeDefined()
    })

    test("refreshTreeMetadata 应按子节点到父节点的顺序修复过期统计", async () => {
        const table = await createTree("refresh-metadata")
        await table.createNodes([{ id: "dir", name: "目录", isDir: true }], "/")
        await table.createNodes([{ id: "sub", name: "子目录", isDir: true }], "dir")
        await table.createNodes([{ id: "file", name: "文件", size: 12 }], "sub")

        await table.adapter.updateMany(
            { id: { $in: ["dir", "sub"] } },
            { $unset: { ctotal: "", cftotal: "", csize: "", childLastIndex: "" } as any },
        )

        await table.refreshTreeMetadata("/")

        expect((await table.get("sub"))?.ctotal).toBe(1)
        expect((await table.get("sub"))?.csize).toBe(12)
        expect((await table.get("dir"))?.ctotal).toBe(2)
        expect((await table.get("dir"))?.csize).toBe(12)
    })
})
