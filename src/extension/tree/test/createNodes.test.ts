import { SQLiteAdapter } from "../../../adapter/SQLite/SQLiteAdapter"
import { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"

function createTestTreeTable(tableName: string) {
    return new TableTree<ITreeNode>({
        name: tableName,
        adapter: SQLiteAdapter({ filename: ":memory:" }),
    })
}

test("createNodes 会重写 parentId 并自动维护祖先统计字段", async () => {
    const table = createTestTreeTable(`tree_create_nodes_${Date.now()}`)
    await table.inited

    try {
        await table.createNodes(
            [
                {
                    id: "dir-a",
                    parentId: "should-be-overwritten",
                    name: "目录A",
                    modif: 0,
                    isDir: true,
                    size: 10,
                },
            ],
            "/",
        )

        await table.createNodes(
            [
                {
                    id: "file-a",
                    parentId: "will-be-overwritten-too",
                    name: "文件A",
                    modif: 0,
                    isDir: false,
                    size: 3,
                },
            ],
            "dir-a",
        )

        const dirNode = await table.get("dir-a")
        const fileNode = await table.get("file-a")

        expect(dirNode).toMatchObject({
            id: "dir-a",
            parentId: "/",
            csize: 3,
            ctotal: 1,
            cftotal: 1,
        })

        expect(fileNode).toMatchObject({
            id: "file-a",
            parentId: "dir-a",
            csize: 0,
            ctotal: 0,
            cftotal: 0,
        })
    } finally {
        await table.close()
    }
})

test("createNodes 会忽略外部传入的统计字段", async () => {
    const table = createTestTreeTable(`tree_create_nodes_internal_stats_${Date.now()}`)
    await table.inited

    try {
        await table.createNodes(
            [
                {
                    id: "dir-stats",
                    parentId: "/",
                    name: "目录Stats",
                    modif: 0,
                    isDir: true,
                    size: 8,
                    csize: 999,
                    ctotal: 888,
                    cftotal: 777,
                } as any,
            ],
            "/",
        )

        const dirNode = await table.get("dir-stats")
        expect(dirNode).toMatchObject({
            id: "dir-stats",
            csize: 0,
            ctotal: 0,
            cftotal: 0,
        })
    } finally {
        await table.close()
    }
})

test("createNodes 支持按 index 选项插入到指定位置", async () => {
    const table = createTestTreeTable(`tree_create_nodes_index_${Date.now()}`)
    await table.inited

    try {
        await table.createNodes(
            [
                {
                    id: "node-a",
                    parentId: "/",
                    name: "A",
                    modif: 0,
                    isDir: false,
                    size: 1,
                },
                {
                    id: "node-c",
                    parentId: "/",
                    name: "C",
                    modif: 0,
                    isDir: false,
                    size: 1,
                },
            ],
            "/",
            { index: { toEnd: true } },
        )

        await table.createNodes(
            [
                {
                    id: "node-b",
                    parentId: "/",
                    name: "B",
                    modif: 0,
                    isDir: false,
                    size: 1,
                },
            ],
            "/",
            { index: { prevNodeId: "node-a" } },
        )

        await table.createNodes(
            [
                {
                    id: "node-start",
                    parentId: "/",
                    name: "Start",
                    modif: 0,
                    isDir: false,
                    size: 1,
                },
            ],
            "/",
            { index: { toStart: true } },
        )

        const rootNodes = await table.listNodes("/", { pageSize: 20 })
        expect(rootNodes.list.map((node) => node.id)).toEqual(["node-start", "node-a", "node-b", "node-c"])

        expect(rootNodes.list.map((node) => typeof node.index)).toEqual(["number", "number", "number", "number"])
        expect((rootNodes.list[0].index ?? 0) < (rootNodes.list[1].index ?? 0)).toBe(true)
        expect((rootNodes.list[1].index ?? 0) < (rootNodes.list[2].index ?? 0)).toBe(true)
        expect((rootNodes.list[2].index ?? 0) < (rootNodes.list[3].index ?? 0)).toBe(true)
    } finally {
        await table.close()
    }
})

test("createNodes 会在非根父节点下维护 clidLastIndex", async () => {
    const table = createTestTreeTable(`tree_create_nodes_clid_last_index_${Date.now()}`)
    await table.inited

    try {
        await table.createNodes(
            [
                {
                    id: "dir-parent",
                    parentId: "/",
                    name: "父目录",
                    modif: 0,
                    isDir: true,
                    size: 1,
                    clidLastIndex: 999,
                } as any,
            ],
            "/",
        )

        const parentBeforeChildren = await table.get("dir-parent")
        expect(parentBeforeChildren?.clidLastIndex).toBeUndefined()

        await table.createNodes(
            [
                {
                    id: "child-a",
                    parentId: "dir-parent",
                    name: "A",
                    modif: 0,
                    isDir: false,
                    size: 1,
                },
                {
                    id: "child-b",
                    parentId: "dir-parent",
                    name: "B",
                    modif: 0,
                    isDir: false,
                    size: 1,
                },
            ],
            "dir-parent",
            { index: { toEnd: true } },
        )

        const parentNode = await table.get("dir-parent")
        const children = await table.listNodes("dir-parent", { pageSize: 20 })

        expect(children.list.map((node) => node.id)).toEqual(["child-a", "child-b"])
        expect(parentNode?.clidLastIndex).toBe(children.list[1].index)
        expect(children.list.every((node) => node.clidLastIndex === undefined)).toBe(true)
    } finally {
        await table.close()
    }
})

test("createNodes 在已进入索引模式的父节点下会默认追加 index", async () => {
    const table = createTestTreeTable(`tree_create_nodes_auto_append_index_${Date.now()}`)
    await table.inited

    try {
        await table.createNodes(
            [
                {
                    id: "dir-parent",
                    parentId: "/",
                    name: "父目录",
                    modif: 0,
                    isDir: true,
                    size: 1,
                },
            ],
            "/",
        )

        await table.createNodes(
            [
                {
                    id: "child-a",
                    parentId: "dir-parent",
                    name: "A",
                    modif: 0,
                    isDir: false,
                    size: 1,
                },
            ],
            "dir-parent",
            { index: { toEnd: true } },
        )

        await table.createNodes(
            [
                {
                    id: "child-b",
                    parentId: "dir-parent",
                    name: "B",
                    modif: 0,
                    isDir: false,
                    size: 1,
                },
            ],
            "dir-parent",
        )

        const children = await table.listNodes("dir-parent", { pageSize: 20 })
        expect(children.list.map((node) => node.id)).toEqual(["child-a", "child-b"])
        expect(children.list.every((node) => typeof node.index === "number")).toBe(true)
    } finally {
        await table.close()
    }
})