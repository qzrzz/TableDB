import { SQLiteAdapter } from "../../../adapter/SQLite"
import { TableTree, defineTableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"

interface ITestTreeNode extends ITreeNode {
    tag?: string
}

let tableIndex = 0

async function createDefinedTreeTable(name: string) {
    const useTreeTable = defineTableTree<ITestTreeNode>({
        name: `test-tree-create-${tableIndex++}-${name}`,
        adapter: SQLiteAdapter({ filename: ":memory:" }),
        enableMarkDelete: true,
    })

    return await useTreeTable()
}

async function listChildIds(table: TableTree<ITestTreeNode>, parentId: string) {
    const result = await table.listNodes(parentId, { pageSize: 50 })
    return result.list.map((node) => node.id)
}

describe("TableTree createNodes", () => {
    test("应该能够通过 defineTableTree 创建 TableTree 实例", async () => {
        const table = await createDefinedTreeTable("define")

        expect(table).toBeInstanceOf(TableTree)
        expect(typeof table.createNodes).toBe("function")
        expect(typeof table.listNodes).toBe("function")
    })

    test("创建节点时应归一化字段并返回新节点数据", async () => {
        const table = await createDefinedTreeTable("normalize")

        const result = await table.createNodes(
            [
                {
                    id: "node",
                    parentId: "wrong-parent",
                    name: "节点",
                    modif: 123,
                    cmodif: 456,
                    ctotal: 99,
                    cftotal: 88,
                    csize: 77,
                    childLastIndex: "ZZ",
                } as any,
            ],
            "/",
            { returnNewNodes: true },
        )

        const node = await table.get("node")
        expect(result.createdNodeIds).toEqual(["node"])
        expect(result.newNodes?.[0].parentId).toBe("/")
        expect(node?.parentId).toBe("/")
        expect(node?.isDir).toBe(false)
        expect(node?.size).toBe(0)
        expect(node?.index).toBe("")
        expect(node?.modif).toBe(123)
        expect(node?.cmodif).toBe(456)
        expect(node?.ctotal).not.toBe(99)
        expect(node?.cftotal).not.toBe(88)
        expect(node?.csize).not.toBe(77)
        expect(node?.childLastIndex).toBeUndefined()
    })

    test("创建空节点列表时应返回空结果并跳过父级校验", async () => {
        const table = await createDefinedTreeTable("empty")

        await expect(table.createNodes([], "missing-parent")).resolves.toEqual({
            createdNodeIds: [],
            newNodes: undefined,
        })
        await expect(table.createNodes([], "missing-parent", { returnNewNodes: true })).resolves.toEqual({
            createdNodeIds: [],
            newNodes: [],
        })
    })

    test("创建节点时应校验父级存在和节点名称", async () => {
        const table = await createDefinedTreeTable("guard")

        await expect(
            table.createNodes([{ id: "missing", name: "missing", isDir: false }], "missing-parent"),
        ).rejects.toThrow("父节点不存在")
        await expect(table.createNodes([{ id: "bad", name: "bad/name", isDir: false }], "/")).rejects.toThrow("/")
    })

    test("创建节点时应允许文件节点作为父级", async () => {
        const table = await createDefinedTreeTable("file-parent")

        await table.createNodes([{ id: "file-parent", name: "文件父级", isDir: false }], "/")
        await table.createNodes([{ id: "child", name: "子节点", isDir: false, size: 10 }], "file-parent")

        const parent = await table.get("file-parent")
        expect(parent?.ctotal).toBe(1)
        expect(parent?.cftotal).toBe(1)
        expect(parent?.csize).toBe(10)
    })

    test("创建节点后应刷新父级和祖先统计信息", async () => {
        const table = await createDefinedTreeTable("metadata")

        await table.createNodes([{ id: "root", name: "根目录", isDir: true }], "/")
        await table.createNodes(
            [
                { id: "sub", name: "子目录", isDir: true },
                { id: "file", name: "文件.txt", isDir: false, size: 20 },
            ],
            "root",
        )
        await table.createNodes([{ id: "deep-file", name: "深层文件.txt", isDir: false, size: 30 }], "sub")

        const root = await table.get("root")
        const sub = await table.get("sub")
        expect(sub?.ctotal).toBe(1)
        expect(sub?.cftotal).toBe(1)
        expect(sub?.csize).toBe(30)
        expect(root?.ctotal).toBe(3)
        expect(root?.cftotal).toBe(2)
        expect(root?.csize).toBe(50)
        expect(root?.cmodif).toBeTruthy()
    })

    test("没有排序选项且父级没有 childLastIndex 时应使用空 index", async () => {
        const table = await createDefinedTreeTable("default-index")

        await table.createNodes([{ id: "dir", name: "目录", isDir: true }], "/")
        await table.createNodes(
            [
                { id: "a", name: "a", isDir: false },
                { id: "b", name: "b", isDir: false },
            ],
            "dir",
        )

        expect((await table.get("a"))?.index).toBe("")
        expect((await table.get("b"))?.index).toBe("")
        expect((await table.get("dir"))?.childLastIndex).toBeUndefined()
    })

    test("使用 toEnd 创建节点时应追加到末尾并维护 childLastIndex", async () => {
        const table = await createDefinedTreeTable("to-end")

        await table.createNodes([{ id: "dir", name: "目录", isDir: true }], "/")
        await table.createNodes([{ id: "a", name: "a", isDir: false }], "dir", { index: { toEnd: true } })
        await table.createNodes([{ id: "b", name: "b", isDir: false }], "dir", { index: { toEnd: true } })

        expect(await listChildIds(table, "dir")).toEqual(["a", "b"])
        expect((await table.get("dir"))?.childLastIndex).toBe((await table.get("b"))?.index)
    })

    test("使用 toStart 创建节点时应插入到开头", async () => {
        const table = await createDefinedTreeTable("to-start")

        await table.createNodes([{ id: "dir", name: "目录", isDir: true }], "/")
        await table.createNodes([{ id: "a", name: "a", isDir: false }], "dir", { index: { toEnd: true } })
        await table.createNodes([{ id: "b", name: "b", isDir: false }], "dir", { index: { toEnd: true } })
        await table.createNodes([{ id: "start", name: "start", isDir: false }], "dir", { index: { toStart: true } })

        expect(await listChildIds(table, "dir")).toEqual(["start", "a", "b"])
    })

    test("使用 prevNodeId 创建节点时应生成参考节点之后的排序索引", async () => {
        const table = await createDefinedTreeTable("prev-node")

        await table.createNodes([{ id: "dir", name: "目录", isDir: true }], "/")
        await table.createNodes(
            [
                { id: "a", name: "a", isDir: false },
                { id: "b", name: "b", isDir: false },
            ],
            "dir",
            { index: { toEnd: true } },
        )
        await table.createNodes([{ id: "after-b", name: "after-b", isDir: false }], "dir", {
            index: { prevNodeId: "b" },
        })

        expect(await listChildIds(table, "dir")).toEqual(["a", "b", "after-b"])
    })

    test("使用 nextNodeId 创建节点时应插入到参考节点之前", async () => {
        const table = await createDefinedTreeTable("next-node")

        await table.createNodes([{ id: "dir", name: "目录", isDir: true }], "/")
        await table.createNodes(
            [
                { id: "a", name: "a", isDir: false },
                { id: "b", name: "b", isDir: false },
            ],
            "dir",
            { index: { toEnd: true } },
        )
        await table.createNodes([{ id: "before-b", name: "before-b", isDir: false }], "dir", {
            index: { nextNodeId: "b" },
        })

        expect(await listChildIds(table, "dir")).toEqual(["a", "before-b", "b"])
    })

    test("同时使用 prevNodeId 和 nextNodeId 创建节点时应插入到两个参考节点之间", async () => {
        const table = await createDefinedTreeTable("between")

        await table.createNodes([{ id: "dir", name: "目录", isDir: true }], "/")
        await table.createNodes(
            [
                { id: "a", name: "a", isDir: false },
                { id: "b", name: "b", isDir: false },
            ],
            "dir",
            { index: { toEnd: true } },
        )
        await table.createNodes([{ id: "between", name: "between", isDir: false }], "dir", {
            index: { prevNodeId: "a", nextNodeId: "b" },
        })

        expect(await listChildIds(table, "dir")).toEqual(["a", "between", "b"])
    })

    test("排序参考节点不存在或不属于目标父级时应抛出错误", async () => {
        const table = await createDefinedTreeTable("index-guard")

        await table.createNodes(
            [
                { id: "dir-a", name: "目录 A", isDir: true },
                { id: "dir-b", name: "目录 B", isDir: true },
            ],
            "/",
        )
        await table.createNodes([{ id: "a", name: "a", isDir: false }], "dir-a", { index: { toEnd: true } })

        await expect(
            table.createNodes([{ id: "bad-missing", name: "bad-missing", isDir: false }], "dir-a", {
                index: { prevNodeId: "missing" },
            }),
        ).rejects.toThrow("排序参考节点不存在")
        await expect(
            table.createNodes([{ id: "bad-parent", name: "bad-parent", isDir: false }], "dir-b", {
                index: { prevNodeId: "a" },
            }),
        ).rejects.toThrow("排序参考节点不属于目标父级")
    })

    test("父级已有 childLastIndex 时默认创建节点应追加到末尾", async () => {
        const table = await createDefinedTreeTable("child-last-index")

        await table.createNodes([{ id: "dir", name: "目录", isDir: true }], "/")
        await table.createNodes([{ id: "a", name: "a", isDir: false }], "dir", { index: { toEnd: true } })
        await table.createNodes([{ id: "b", name: "b", isDir: false }], "dir")

        expect(await listChildIds(table, "dir")).toEqual(["a", "b"])
        expect((await table.get("b"))?.index).toBeTruthy()
    })

    test("重复 ID 创建节点时应跳过已存在节点并只返回实际插入节点", async () => {
        const table = await createDefinedTreeTable("duplicate-id")

        await table.createNodes([{ id: "exists", name: "旧节点", isDir: false }], "/")
        const result = await table.createNodes(
            [
                { id: "exists", name: "新节点", isDir: false },
                { id: "new", name: "新文件", isDir: false },
            ],
            "/",
            { returnNewNodes: true },
        )

        expect(result.createdNodeIds).toEqual(["new"])
        expect(result.newNodes?.map((node) => node.id)).toEqual(["new"])
        expect((await table.get("exists"))?.name).toBe("旧节点")
        expect((await table.get("new"))?.name).toBe("新文件")
    })
})
