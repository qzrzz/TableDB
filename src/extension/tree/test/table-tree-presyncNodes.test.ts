import { SQLiteAdapter } from "../../../adapter/SQLite"
import { defineTableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"

let tableIndex = 0

async function createDefinedTreeTable(name: string, enableMarkDelete = true) {
    const useTreeTable = defineTableTree<ITreeNode>({
        name: `test-tree-presync-${tableIndex++}-${name}`,
        adapter: SQLiteAdapter({ filename: ":memory:", driver: "better-sqlite3" }),
        enableMarkDelete,
    })

    return await useTreeTable()
}

describe("TableTree presyncNodes", () => {
    test("空列表应返回无需同步", async () => {
        const table = await createDefinedTreeTable("empty")

        await expect(table.presyncNodes([])).resolves.toEqual({
            needSync: false,
            syncNodeIds: [],
            deletedNodeIds: [],
        })
    })

    test("modif 和 cmodif 都匹配时应返回无需同步", async () => {
        const table = await createDefinedTreeTable("matched")

        await table.createNodes([{ id: "dir", name: "目录", isDir: true, modif: 10 }], "/")
        await table.createNodes([{ id: "file", name: "文件.txt", isDir: false, size: 5, modif: 20 }], "dir")
        const dir = await table.get("dir")

        const result = await table.presyncNodes([
            { id: "dir", modif: dir?.modif, cmodif: dir?.cmodif },
            { id: "file", modif: 20 },
        ])

        expect(result).toEqual({
            needSync: false,
            syncNodeIds: [],
            deletedNodeIds: [],
        })
    })

    test("modif 不匹配时应返回需要同步的节点 ID", async () => {
        const table = await createDefinedTreeTable("modif-mismatch")

        await table.createNodes([{ id: "node", name: "node", isDir: false, modif: 20 }], "/")

        const result = await table.presyncNodes([{ id: "node", modif: 19 }])

        expect(result).toEqual({
            needSync: true,
            syncNodeIds: ["node"],
            deletedNodeIds: [],
        })
    })

    test("cmodif 不匹配时应返回需要同步的节点 ID", async () => {
        const table = await createDefinedTreeTable("cmodif-mismatch")

        await table.createNodes([{ id: "dir", name: "目录", isDir: true }], "/")
        await table.createNodes([{ id: "file", name: "文件.txt", isDir: false, size: 5 }], "dir")
        const dir = await table.get("dir")

        const result = await table.presyncNodes([{ id: "dir", cmodif: Number(dir?.cmodif) - 1 }])

        expect(result).toEqual({
            needSync: true,
            syncNodeIds: ["dir"],
            deletedNodeIds: [],
        })
    })

    test("同时提供 modif 和 cmodif 时任意一个不匹配都应同步", async () => {
        const table = await createDefinedTreeTable("any-mismatch")

        await table.createNodes([{ id: "dir", name: "目录", isDir: true, modif: 10 }], "/")
        await table.createNodes([{ id: "file", name: "文件.txt", isDir: false, size: 5 }], "dir")
        const dir = await table.get("dir")

        const result = await table.presyncNodes([{ id: "dir", modif: dir?.modif, cmodif: Number(dir?.cmodif) - 1 }])

        expect(result.needSync).toBe(true)
        expect(result.syncNodeIds).toEqual(["dir"])
        expect(result.deletedNodeIds).toEqual([])
    })

    test("节点不存在时应返回 deletedNodeIds", async () => {
        const table = await createDefinedTreeTable("missing")

        await table.createNodes([{ id: "node", name: "node", isDir: false, modif: 10 }], "/")

        const result = await table.presyncNodes([
            { id: "node", modif: 10 },
            { id: "missing", modif: 1 },
        ])

        expect(result).toEqual({
            needSync: true,
            syncNodeIds: [],
            deletedNodeIds: ["missing"],
        })
    })

    test("混合过期节点和缺失节点时应分别返回", async () => {
        const table = await createDefinedTreeTable("mixed")

        await table.createNodes([{ id: "node", name: "node", isDir: false, modif: 10 }], "/")

        const result = await table.presyncNodes([
            { id: "node", modif: 9 },
            { id: "missing", modif: 1 },
        ])

        expect(result).toEqual({
            needSync: true,
            syncNodeIds: ["node"],
            deletedNodeIds: ["missing"],
        })
    })

    test("未提供 modif 和 cmodif 的已有节点不应触发同步", async () => {
        const table = await createDefinedTreeTable("no-version-fields")

        await table.createNodes([{ id: "node", name: "node", isDir: false, modif: 10 }], "/")

        const result = await table.presyncNodes([{ id: "node" }])

        expect(result).toEqual({
            needSync: false,
            syncNodeIds: [],
            deletedNodeIds: [],
        })
    })

    test("标记删除模式下已删除节点应视为不存在", async () => {
        const table = await createDefinedTreeTable("mark-delete", true)

        await table.createNodes([{ id: "node", name: "node", isDir: false, modif: 10 }], "/")
        await table.deleteNodes(["node"])

        const result = await table.presyncNodes([{ id: "node", modif: 10 }])

        expect(result).toEqual({
            needSync: true,
            syncNodeIds: [],
            deletedNodeIds: ["node"],
        })
    })

    test("非标记删除模式下物理删除节点应视为不存在", async () => {
        const table = await createDefinedTreeTable("real-delete", false)

        await table.createNodes([{ id: "node", name: "node", isDir: false, modif: 10 }], "/")
        await table.deleteNodes(["node"])

        const result = await table.presyncNodes([{ id: "node", modif: 10 }])

        expect(result).toEqual({
            needSync: true,
            syncNodeIds: [],
            deletedNodeIds: ["node"],
        })
    })

    test("重复输入应保留重复的同步结果", async () => {
        const table = await createDefinedTreeTable("duplicate-input")

        await table.createNodes([{ id: "node", name: "node", isDir: false, modif: 10 }], "/")

        const result = await table.presyncNodes([
            { id: "node", modif: 9 },
            { id: "node", modif: 8 },
            { id: "missing", modif: 1 },
            { id: "missing", modif: 2 },
        ])

        expect(result).toEqual({
            needSync: true,
            syncNodeIds: ["node", "node"],
            deletedNodeIds: ["missing", "missing"],
        })
    })
})
