import { SQLiteAdapter } from "../../../adapter/SQLite/SQLiteAdapter"
import { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"

function createTestTreeTable(tableName: string) {
    return new TableTree<ITreeNode>({
        name: tableName,
        adapter: SQLiteAdapter({ filename: ":memory:" }),
    })
}

test("deleteNodes 会递归删除子树并回退祖先统计字段", async () => {
    const table = createTestTreeTable(`tree_delete_nodes_${Date.now()}`)
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
                    size: 5,
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
                    size: 2,
                },
            ],
            "dir-b",
        )

        const deleteResult = await table.deleteNodes(["dir-b"])
        const dirANode = await table.get("dir-a")
        const dirBNode = await table.get("dir-b")
        const fileNode = await table.get("file-a")

        expect(deleteResult).toMatchObject({
            hasDeleted: true,
            hasChildDeleted: true,
            deletedCount: 2,
        })

        expect(deleteResult.deletedNodeIds.sort()).toEqual(["dir-b", "file-a"])

        expect(dirANode).toMatchObject({
            id: "dir-a",
            csize: 0,
            ctotal: 0,
            cftotal: 0,
        })

        expect(dirBNode).toBeUndefined()
        expect(fileNode).toBeUndefined()
    } finally {
        await table.close()
    }
})