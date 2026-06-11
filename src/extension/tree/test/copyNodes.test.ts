import { SQLiteAdapter } from "../../../adapter/SQLite/SQLiteAdapter"
import { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"

function createTestTreeTable(tableName: string) {
    return new TableTree<ITreeNode>({
        name: tableName,
        adapter: SQLiteAdapter({ filename: ":memory:" }),
    })
}

test("copyNodes 会递归复制子树、默认重命名根节点并维护目标祖先统计", async () => {
    const table = createTestTreeTable(`tree_copy_nodes_${Date.now()}`)
    await table.inited

    try {
        await table.createNodes(
            [
                {
                    id: "dir-a",
                    parentId: "/",
                    name: "目录A",
                    modif: 0,
                    isDir: true,
                    size: 1,
                    type: "dir",
                },
                {
                    id: "dir-target",
                    parentId: "/",
                    name: "目标目录",
                    modif: 0,
                    isDir: true,
                    size: 2,
                    type: "dir",
                },
            ],
            "/",
        )

        await table.createNodes(
            [
                {
                    id: "file-a1",
                    parentId: "dir-a",
                    name: "文件A1",
                    modif: 0,
                    isDir: false,
                    size: 3,
                    type: "file",
                },
            ],
            "dir-a",
        )

        await table.copyNodes(["dir-a"], "/", { deep: true })

        const rootChildren = await table.listNodes("/", { pageSize: 20 })
        const copiedRoot = rootChildren.list.find((node) => node.name === "目录A (1)")
        expect(copiedRoot).toBeTruthy()
        expect(copiedRoot).toMatchObject({
            parentId: "/",
            csize: 3,
            ctotal: 1,
            cftotal: 1,
        })

        const copiedChildren = await table.listNodes(copiedRoot!.id, { pageSize: 20 })
        expect(copiedChildren.list).toHaveLength(1)
        expect(copiedChildren.list[0]).toMatchObject({
            name: "文件A1",
            parentId: copiedRoot!.id,
            size: 3,
        })
    } finally {
        await table.close()
    }
})

test("copyNodes 支持把复制出来的根节点插入到 prevNodeId 之后", async () => {
    const table = createTestTreeTable(`tree_copy_nodes_prev_index_${Date.now()}`)
    await table.inited

    try {
        await table.createNodes(
            [
                {
                    id: "dir-source",
                    parentId: "/",
                    name: "源目录",
                    modif: 0,
                    isDir: true,
                    size: 1,
                },
                {
                    id: "target-a",
                    parentId: "/",
                    name: "A",
                    modif: 0,
                    isDir: false,
                    size: 1,
                },
                {
                    id: "target-c",
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
                    id: "file-a1",
                    parentId: "dir-source",
                    name: "文件A1",
                    modif: 0,
                    isDir: false,
                    size: 3,
                },
            ],
            "dir-source",
        )

        await table.copyNodes(["dir-source"], "/", {
            deep: true,
            prevNodeId: "target-a",
        })

        const rootChildren = await table.listNodes("/", { pageSize: 20 })
        const copiedRoot = rootChildren.list.find((node) => node.name === "源目录 (1)")

        expect(copiedRoot).toBeTruthy()
        expect(rootChildren.list.map((node) => node.name)).toEqual(["源目录", "A", "源目录 (1)", "C"])

        const copiedChildren = await table.listNodes(copiedRoot!.id, { pageSize: 20 })
        expect(copiedChildren.list).toHaveLength(1)
        expect(copiedChildren.list[0]).toMatchObject({
            name: "文件A1",
            parentId: copiedRoot!.id,
            size: 3,
        })
    } finally {
        await table.close()
    }
})

test("copyNodes 会在复制到非根父节点末尾时推进 clidLastIndex", async () => {
    const table = createTestTreeTable(`tree_copy_nodes_clid_last_index_${Date.now()}`)
    await table.inited

    try {
        await table.createNodes(
            [
                {
                    id: "dir-source",
                    parentId: "/",
                    name: "源目录",
                    modif: 0,
                    isDir: true,
                    size: 1,
                },
                {
                    id: "dir-target",
                    parentId: "/",
                    name: "目标目录",
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
                    id: "target-a",
                    parentId: "dir-target",
                    name: "A",
                    modif: 0,
                    isDir: false,
                    size: 1,
                },
            ],
            "dir-target",
            { index: { toEnd: true } },
        )

        await table.copyNodes(["dir-source"], "dir-target", {
            deep: false,
            renameOnCopy: false,
        })

        const targetDir = await table.get("dir-target")
        const targetChildren = await table.listNodes("dir-target", { pageSize: 20 })
        const copiedNode = targetChildren.list.find((node) => node.name === "源目录")

        expect(copiedNode).toBeTruthy()
        expect(targetChildren.list.map((node) => node.name)).toEqual(["A", "源目录"])
        expect(targetDir?.clidLastIndex).toBe(copiedNode?.index)
    } finally {
        await table.close()
    }
})