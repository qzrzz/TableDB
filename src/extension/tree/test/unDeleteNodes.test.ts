import { SQLiteAdapter } from "../../../adapter/SQLite/SQLiteAdapter"
import { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"

function createTestTreeTable(tableName: string) {
    return new TableTree<ITreeNode>({
        name: tableName,
        adapter: SQLiteAdapter({ filename: ":memory:" }),
        enableMarkDelete: true,
    })
}

test("unDeleteNodes 会恢复标记删除的子树并回补祖先统计", async () => {
    const table = createTestTreeTable(`tree_undelete_nodes_${Date.now()}`)
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

        await table.deleteNodes(["dir-b"])
        expect(await table.get("dir-b")).toBeUndefined()
        expect(await table.get("file-a")).toBeUndefined()

        await table.unDeleteNodes(["dir-b"])

        const dirANode = await table.get("dir-a")
        const dirBNode = await table.get("dir-b")
        const fileNode = await table.get("file-a")

        expect(dirBNode).toMatchObject({
            id: "dir-b",
            parentId: "dir-a",
            csize: 3,
            ctotal: 1,
            cftotal: 1,
        })

        expect(fileNode).toMatchObject({
            id: "file-a",
            parentId: "dir-b",
        })

        expect(dirANode).toMatchObject({
            id: "dir-a",
            csize: 5,
            ctotal: 2,
            cftotal: 1,
        })
    } finally {
        await table.close()
    }
})