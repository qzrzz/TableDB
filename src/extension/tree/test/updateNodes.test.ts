import { SQLiteAdapter } from "../../../adapter/SQLite/SQLiteAdapter"
import { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"

function createTestTreeTable(tableName: string) {
    return new TableTree<ITreeNode>({
        name: tableName,
        adapter: SQLiteAdapter({ filename: ":memory:" }),
    })
}

test("updateNodes 不允许外部修改树内部维护字段", async () => {
    const table = createTestTreeTable(`tree_update_nodes_guard_${Date.now()}`)
    await table.inited

    try {
        await table.createNodes(
            [
                {
                    id: "file-a",
                    parentId: "/",
                    name: "文件A",
                    modif: 0,
                    isDir: false,
                    size: 2,
                },
            ],
            "/",
        )

        await expect(
            table.updateNodes(
                { id: "file-a" },
                {
                    $set: {
                        csize: 123,
                    } as any,
                },
            ),
        ).rejects.toThrow("不允许外部修改树内部维护字段")

        await expect(
            table.updateNodes(
                { id: "file-a" },
                {
                    $set: {
                        clidLastIndex: 456,
                    } as any,
                },
            ),
        ).rejects.toThrow("不允许外部修改树内部维护字段")
    } finally {
        await table.close()
    }
})

test("updateNodes 修改 size 时会自动刷新祖先统计字段", async () => {
    const table = createTestTreeTable(`tree_update_nodes_stats_${Date.now()}`)
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
                },
            ],
            "/",
        )

        await table.createNodes(
            [
                {
                    id: "file-a",
                    parentId: "dir-a",
                    name: "文件A",
                    modif: 0,
                    isDir: false,
                    size: 2,
                },
            ],
            "dir-a",
        )

        await table.updateNodes(
            { id: "file-a" },
            {
                $set: {
                    size: 6,
                },
            },
        )

        const dirNode = await table.get("dir-a")
        const fileNode = await table.get("file-a")

        expect(fileNode).toMatchObject({
            id: "file-a",
            size: 6,
            csize: 0,
            ctotal: 0,
            cftotal: 0,
        })

        expect(dirNode).toMatchObject({
            id: "dir-a",
            csize: 6,
            ctotal: 1,
            cftotal: 1,
        })
    } finally {
        await table.close()
    }
})

test("updateNodes 支持 deep 递归更新整棵子树并同步刷新统计", async () => {
    const table = createTestTreeTable(`tree_update_nodes_deep_${Date.now()}`)
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
                },
            ],
            "/",
        )

        await table.createNodes(
            [
                {
                    id: "dir-b",
                    parentId: "dir-a",
                    name: "目录B",
                    modif: 0,
                    isDir: true,
                    size: 2,
                },
            ],
            "dir-a",
        )

        await table.createNodes(
            [
                {
                    id: "file-a",
                    parentId: "dir-b",
                    name: "文件A",
                    modif: 0,
                    isDir: false,
                    size: 3,
                },
            ],
            "dir-b",
        )

        await table.updateNodes(
            { id: "dir-a" },
            {
                $set: {
                    size: 10,
                    modif: 7,
                },
            },
            {
                deep: true,
            },
        )

        const dirA = await table.get("dir-a")
        const dirB = await table.get("dir-b")
        const fileA = await table.get("file-a")

        expect(dirA).toMatchObject({
            id: "dir-a",
            size: 10,
            modif: 7,
            csize: 20,
            ctotal: 2,
            cftotal: 1,
        })

        expect(dirB).toMatchObject({
            id: "dir-b",
            size: 10,
            modif: 7,
            csize: 10,
            ctotal: 1,
            cftotal: 1,
        })

        expect(fileA).toMatchObject({
            id: "file-a",
            size: 10,
            modif: 7,
            csize: 0,
            ctotal: 0,
            cftotal: 0,
        })
    } finally {
        await table.close()
    }
})