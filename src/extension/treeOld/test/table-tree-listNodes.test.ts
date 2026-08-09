import { SQLiteAdapter } from "../../../adapter/SQLite"
import { TableTree, defineTableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"

interface ITestTreeNode extends ITreeNode {
    tag?: string
    meta?: {
        group?: string
    }
}

let tableIndex = 0

async function createDefinedTreeTable(name: string, enableMarkDelete = true) {
    const useTreeTable = defineTableTree<ITestTreeNode>({
        name: `test-tree-list-${tableIndex++}-${name}`,
        adapter: SQLiteAdapter({ filename: ":memory:", driver: "better-sqlite3" }),
        enableMarkDelete,
    })

    return await useTreeTable()
}

async function createListFixture(table: TableTree<ITestTreeNode>) {
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

function ids(nodes: ITreeNode[]) {
    return nodes.map((node) => node.id)
}

describe("TableTree listNodes", () => {
    test("应该只列出指定父级的直属子节点", async () => {
        const table = await createDefinedTreeTable("direct-children")
        await createListFixture(table)

        const result = await table.listNodes("root-a", { pageSize: 20 })

        expect(ids(result.list)).toEqual(["file-a", "dir-a", "file-b", "file-c"])
        expect(ids(result.list)).not.toContain("deep-file")
        expect(ids(result.list)).not.toContain("other-file")
    })

    test("应该支持列出根节点", async () => {
        const table = await createDefinedTreeTable("root")
        await createListFixture(table)

        const result = await table.listNodes("/", { pageSize: 20 })

        expect(ids(result.list)).toEqual(["root-a", "root-b"])
    })

    test("默认应按 index 升序返回子节点", async () => {
        const table = await createDefinedTreeTable("default-sort")

        await table.createNodes([{ id: "dir", name: "目录", isDir: true }], "/")
        await table.createNodes([{ id: "last", name: "last", isDir: false }], "dir", { index: { toEnd: true } })
        await table.createNodes([{ id: "first", name: "first", isDir: false }], "dir", { index: { toStart: true } })

        const result = await table.listNodes("dir", { pageSize: 20 })

        expect(ids(result.list)).toEqual(["first", "last"])
    })

    test("应该支持 skip 分页、hasNext 和 total", async () => {
        const table = await createDefinedTreeTable("skip-paging")
        await createListFixture(table)

        const first = await table.listNodes("root-a", { pageIndex: 1, pageSize: 2, getTotal: true })
        const second = await table.listNodes("root-a", { pageIndex: 2, pageSize: 2, getTotal: true })

        expect(first.pageIndex).toBe(1)
        expect(first.pageSize).toBe(2)
        expect(first.total).toBe(4)
        expect(first.hasNext).toBe(true)
        expect(ids(first.list)).toEqual(["file-a", "dir-a"])
        expect(second.hasNext).toBe(false)
        expect(ids(second.list)).toEqual(["file-b", "file-c"])
    })

    test("应该支持自定义 sort 覆盖默认 index 排序", async () => {
        const table = await createDefinedTreeTable("custom-sort")
        await createListFixture(table)

        const result = await table.listNodes("root-a", { pageSize: 20, sort: { name: -1 } })

        expect(result.list.map((node) => node.name)).toEqual(["目录 A", "c.md", "b.png", "a.txt"])
    })

    test("onlyTypes 应只返回指定类型节点", async () => {
        const table = await createDefinedTreeTable("only-types")
        await createListFixture(table)

        const result = await table.listNodes("root-a", { pageSize: 20, onlyTypes: ["text"] })

        expect(ids(result.list)).toEqual(["file-a", "file-c"])
    })

    test("onlyTypes 优先级应高于 onlyNotTypes", async () => {
        const table = await createDefinedTreeTable("type-priority")
        await createListFixture(table)

        const result = await table.listNodes("root-a", {
            pageSize: 20,
            onlyTypes: ["text"],
            onlyNotTypes: ["text"],
        })

        expect(ids(result.list)).toEqual(["file-a", "file-c"])
    })

    test("onlyNotTypes 应排除指定类型节点", async () => {
        const table = await createDefinedTreeTable("only-not-types")
        await createListFixture(table)

        const result = await table.listNodes("root-a", { pageSize: 20, onlyNotTypes: ["text"] })

        expect(ids(result.list)).toEqual(["dir-a", "file-b"])
    })

    test("filter 应作为额外条件并且不能覆盖 parentId 限定", async () => {
        const table = await createDefinedTreeTable("extra-filter")
        await createListFixture(table)

        const result = await table.listNodes("root-a", {
            pageSize: 20,
            filter: { parentId: "root-b", tag: "keep" },
        })

        expect(ids(result.list)).toEqual(["file-a", "dir-a", "file-c"])
    })

    test("应该支持投影字段", async () => {
        const table = await createDefinedTreeTable("projection")
        await createListFixture(table)

        const result = await table.listNodes("root-a", {
            pageSize: 1,
            projection: ["id", "name"],
        })

        expect(result.list[0]).toEqual({ id: "file-a", name: "a.txt" })
    })

    test("标记删除模式下默认不返回已删除节点，ignoreMarkDelete 可返回", async () => {
        const table = await createDefinedTreeTable("mark-delete", true)
        await createListFixture(table)

        await table.deleteNodes(["file-b"])

        const visible = await table.listNodes("root-a", { pageSize: 20 })
        const all = await table.listNodes("root-a", { pageSize: 20, ignoreMarkDelete: true })

        expect(ids(visible.list)).toEqual(["file-a", "dir-a", "file-c"])
        expect(ids(all.list)).toEqual(["file-a", "dir-a", "file-b", "file-c"])
        expect(all.list.find((node) => node.id === "file-b")?._isDeleted).toBe(true)
    })
})

describe("TableTree listNodesByCursor", () => {
    test("应该按游标分页连续列出直属子节点", async () => {
        const table = await createDefinedTreeTable("cursor")
        await createListFixture(table)

        const first = await table.listNodesByCursor("root-a", { pageSize: 2, sortKey: "id", sortOrder: 1 })
        const second = await table.listNodesByCursor("root-a", {
            pageSize: 2,
            sortKey: "id",
            sortOrder: 1,
            cursor: first.nextCursor,
        })

        expect(first.hasNext).toBe(true)
        expect(ids(first.list)).toEqual(["dir-a", "file-a"])
        expect(second.hasNext).toBe(false)
        expect(ids(second.list)).toEqual(["file-b", "file-c"])
    })

    test("游标分页应支持倒序排序", async () => {
        const table = await createDefinedTreeTable("cursor-desc")
        await createListFixture(table)

        const first = await table.listNodesByCursor("root-a", { pageSize: 3, sortKey: "id", sortOrder: -1 })

        expect(ids(first.list)).toEqual(["file-c", "file-b", "file-a"])
        expect(first.hasNext).toBe(true)
    })

    test("游标分页应支持类型过滤和额外 filter", async () => {
        const table = await createDefinedTreeTable("cursor-filter")
        await createListFixture(table)

        const result = await table.listNodesByCursor("root-a", {
            pageSize: 20,
            sortKey: "id",
            sortOrder: 1,
            onlyTypes: ["text"],
            filter: { tag: "keep" },
        })

        expect(ids(result.list)).toEqual(["file-a", "file-c"])
    })

    test("游标分页默认不返回已删除节点，ignoreMarkDelete 可返回", async () => {
        const table = await createDefinedTreeTable("cursor-mark-delete", true)
        await createListFixture(table)

        await table.deleteNodes(["file-b"])

        const visible = await table.listNodesByCursor("root-a", { pageSize: 20, sortKey: "id", sortOrder: 1 })
        const all = await table.listNodesByCursor("root-a", {
            pageSize: 20,
            sortKey: "id",
            sortOrder: 1,
            ignoreMarkDelete: true,
        })

        expect(ids(visible.list)).toEqual(["dir-a", "file-a", "file-c"])
        expect(ids(all.list)).toEqual(["dir-a", "file-a", "file-b", "file-c"])
    })

    test("游标分页的 filter 不允许包含 sortKey 字段", async () => {
        const table = await createDefinedTreeTable("cursor-sort-key-guard")
        await createListFixture(table)

        await expect(
            table.listNodesByCursor("root-a", {
                pageSize: 20,
                sortKey: "id",
                filter: { id: "file-a" },
            }),
        ).rejects.toThrow("sort field")
    })
})
