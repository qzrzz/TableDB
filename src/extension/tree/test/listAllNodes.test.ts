import { SQLiteAdapter } from "../../../adapter/SQLite/SQLiteAdapter"
import { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"

function createTestTreeTable(tableName: string) {
    return new TableTree<ITreeNode>({
        name: tableName,
        adapter: SQLiteAdapter({ filename: ":memory:" }),
    })
}

test("listAllNodes 会按深度优先返回扁平化后代列表，并支持 cursor 翻页", async () => {
    const table = createTestTreeTable(`tree_list_all_${Date.now()}`)
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
                    id: "dir-b",
                    parentId: "/",
                    name: "目录B",
                    modif: 0,
                    isDir: true,
                    size: 1,
                    type: "dir",
                },
            ],
            "/",
        )

        await table.createNodes(
            [
                {
                    id: "mid-x",
                    parentId: "dir-a",
                    name: "中间节点X",
                    modif: 0,
                    isDir: true,
                    size: 1,
                    type: "mid",
                },
                {
                    id: "file-a1",
                    parentId: "dir-a",
                    name: "文件A1",
                    modif: 0,
                    isDir: false,
                    size: 2,
                    type: "file",
                },
            ],
            "dir-a",
        )

        await table.createNodes(
            [
                {
                    id: "file-x1",
                    parentId: "mid-x",
                    name: "文件X1",
                    modif: 0,
                    isDir: false,
                    size: 3,
                    type: "file",
                },
            ],
            "mid-x",
        )

        await table.createNodes(
            [
                {
                    id: "file-b1",
                    parentId: "dir-b",
                    name: "文件B1",
                    modif: 0,
                    isDir: false,
                    size: 4,
                    type: "file",
                },
            ],
            "dir-b",
        )

        const page1 = await table.listAllNodes("/", { pageSize: 3 })
        const page2 = await table.listAllNodes("/", { pageSize: 3, cursor: page1.nextCursor ?? undefined })
        const onlyFiles = await table.listAllNodes("/", { pageSize: 10, onlyTypes: ["file"] })

        expect(page1.list.map((node) => node.id)).toEqual(["dir-a", "mid-x", "file-x1"])
        expect(page1.hasNext).toBe(true)
        expect(page1.nextCursor).toMatchObject({
            lastNodeId: "file-x1",
            depth: 3,
            parentId: "mid-x",
        })

        expect(page2.list.map((node) => node.id)).toEqual(["file-a1", "dir-b", "file-b1"])
        expect(page2.hasNext).toBe(false)
        expect(page2.nextCursor).toBeNull()

        expect(onlyFiles.list.map((node) => node.id)).toEqual(["file-x1", "file-a1", "file-b1"])
    } finally {
        await table.close()
    }
})