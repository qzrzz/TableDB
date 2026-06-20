import { getIndexesBetween, smartRebalance } from "indexless"
import { SQLiteAdapter } from "../../../adapter/SQLite"
import { TableTree, defineTableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"
import { rebalanceTreeIndexes } from "../util/rebalanceTreeIndexes"

interface ITestTreeNode extends ITreeNode {
    tag?: string
}

let tableIndex = 0

async function createDefinedTreeTable(name: string) {
    const useTreeTable = defineTableTree<ITestTreeNode>({
        name: `test-tree-index-comb-${tableIndex++}-${name}`,
        adapter: SQLiteAdapter({ filename: ":memory:", driver: "better-sqlite3" }),
        enableMarkDelete: true,
    })

    return await useTreeTable()
}

async function listChildIds(table: TableTree<ITestTreeNode>, parentId: string) {
    const result = await table.listNodes(parentId, { pageSize: 100 })
    return result.list.map((node) => node.id)
}

async function getIndexes(table: TableTree<ITestTreeNode>, parentId: string) {
    const nodes = await table.findMany({ parentId }, { sort: { index: 1 } }) as ITestTreeNode[]
    return nodes.map((node) => ({ id: node.id, index: node.index ?? "" }))
}

function expectStrictlyAscending(indexes: string[]) {
    for (let i = 1; i < indexes.length; i++) {
        expect(indexes[i] > indexes[i - 1]).toBe(true)
    }
}

async function expectChildLastIndexAccurate(table: TableTree<ITestTreeNode>, parentId: string) {
    const items = await getIndexes(table, parentId)
    const expected = items
        .map((item) => item.index)
        .filter(Boolean)
        .sort()
        .at(-1)
    expect((await table.get(parentId))?.childLastIndex).toBe(expected)
}

describe("TableTree index 专题", () => {
    test("createNodes 应支持 toStart、toEnd、prevNodeId、nextNodeId 和区间插入", async () => {
        const table = await createDefinedTreeTable("create-index-options")

        await table.createNodes([{ id: "dir", name: "dir", isDir: true }], "/")
        await table.createNodes([{ id: "a", name: "a", isDir: false }], "dir", { index: { toEnd: true } })
        await table.createNodes([{ id: "c", name: "c", isDir: false }], "dir", { index: { toEnd: true } })
        await table.createNodes([{ id: "start", name: "start", isDir: false }], "dir", { index: { toStart: true } })
        await table.createNodes([{ id: "b", name: "b", isDir: false }], "dir", { index: { prevNodeId: "a", nextNodeId: "c" } })
        await table.createNodes([{ id: "after-b", name: "after-b", isDir: false }], "dir", { index: { prevNodeId: "b" } })
        await table.createNodes([{ id: "before-c", name: "before-c", isDir: false }], "dir", { index: { nextNodeId: "c" } })

        const items = await getIndexes(table, "dir")
        const ids = items.map((item) => item.id)
        expect(ids[0]).toBe("start")
        expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("b"))
        expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("after-b"))
        expect(ids.indexOf("before-c")).toBeLessThan(ids.indexOf("c"))
        const indexes = items.map((item) => item.index)
        expect(indexes.every(Boolean)).toBe(true)
        expect(indexes.indexOf((await table.get("start"))!.index!)).toBe(0)
        expect((await table.get("b"))!.index! > (await table.get("a"))!.index!).toBe(true)
        expect((await table.get("b"))!.index! < (await table.get("c"))!.index!).toBe(true)
        expect((await table.get("after-b"))!.index! > (await table.get("b"))!.index!).toBe(true)
        expect((await table.get("before-c"))!.index! < (await table.get("c"))!.index!).toBe(true)
        await expectChildLastIndexAccurate(table, "dir")
    })

    test("setNodes、moveNodes、copyNodes 和 updateNodes 都应能修改 index 并刷新顺序元数据", async () => {
        const table = await createDefinedTreeTable("all-index-writers")

        await table.setNodes(
            [
                { id: "src", parentId: "/", name: "src", isDir: true },
                { id: "target", parentId: "/", name: "target", isDir: true },
                { id: "a", parentId: "target", name: "a", isDir: false },
                { id: "b", parentId: "target", name: "b", isDir: false },
                { id: "moving", parentId: "src", name: "moving", isDir: false },
                { id: "copy-src", parentId: "src", name: "copy-src", isDir: false },
            ],
            { index: { toEnd: true } },
        )

        await table.setNodes([{ id: "set-start", parentId: "target", name: "set-start", isDir: false }], {
            index: { toStart: true },
        })
        await table.moveNodes(["moving"], "target", { index: { prevNodeId: "a", nextNodeId: "b" } })
        const copyResult = await table.copyNodes(["copy-src"], "target", { renameOnCopy: false, index: { toEnd: true } })
        const copyId = copyResult.createdNodeIds[0]
        const bIndex = (await table.get("b"))?.index
        await table.updateNodes({ id: copyId }, { $set: { index: `${bIndex}z` } })

        expect(await listChildIds(table, "target")).toEqual(["set-start", "a", "moving", "b", copyId])
        await expectChildLastIndexAccurate(table, "target")
    })

    test("未指定 index 时应保留或追加到合理位置，避免意外改变已有排序", async () => {
        const table = await createDefinedTreeTable("default-index-behavior")

        await table.createNodes([{ id: "a", name: "a", isDir: true }, { id: "b", name: "b", isDir: true }], "/")
        await table.createNodes([{ id: "old", name: "old", isDir: false }], "b", { index: { toEnd: true } })
        await table.createNodes([{ id: "x", name: "x", isDir: false }, { id: "y", name: "y", isDir: false }], "a")
        const xOldIndex = (await table.get("x"))?.index
        const yOldIndex = (await table.get("y"))?.index

        await table.setNodes([{ id: "x", parentId: "a", name: "x-renamed", isDir: false, tag: "keep-index" }])
        await table.updateNodes({ id: "y" }, { $set: { tag: "no-index-change" } })
        await table.moveNodes(["x", "y"], "b")

        expect((await table.get("x"))?.index).not.toBe(xOldIndex)
        expect((await table.get("y"))?.index).not.toBe(yOldIndex)
        expect(await listChildIds(table, "b")).toEqual(["old", "x", "y"])
        await expectChildLastIndexAccurate(table, "b")
    })

    test("rebalanceTreeIndexes 未超过长度限制时不应触发重排", async () => {
        const table = await createDefinedTreeTable("rebalance-not-needed")

        await table.createNodes([{ id: "dir", name: "dir", isDir: true }], "/")
        await table.setNodes([
            { id: "a", parentId: "dir", name: "a", isDir: false, index: "a0" },
            { id: "b", parentId: "dir", name: "b", isDir: false, index: "a1" },
        ])
        const before = await getIndexes(table, "dir")

        await rebalanceTreeIndexes(table, "dir", before, { maxIndexLength: 8 })

        expect(await getIndexes(table, "dir")).toEqual(before)
        await expectChildLastIndexAccurate(table, "dir")
    })

    test("rebalanceTreeIndexes 超过长度限制时应局部缩短 index、保持顺序并刷新同步字段", async () => {
        const table = await createDefinedTreeTable("rebalance-needed")

        await table.createNodes([{ id: "dir", name: "dir", isDir: true }], "/")
        await table.setNodes([
            { id: "left", parentId: "dir", name: "left", isDir: false, index: "a0" },
            { id: "long-a", parentId: "dir", name: "long-a", isDir: false, index: "a0zzzzzz" },
            { id: "long-b", parentId: "dir", name: "long-b", isDir: false, index: "a0zzzzzzz" },
            { id: "right", parentId: "dir", name: "right", isDir: false, index: "b00" },
        ])
        const dirBefore = await table.get("dir")
        const longABefore = await table.get("long-a")

        await new Promise((resolve) => setTimeout(resolve, 5))
        await rebalanceTreeIndexes(
            table,
            "dir",
            [
                { id: "long-a", index: "a0zzzzzz" },
                { id: "long-b", index: "a0zzzzzzz" },
            ],
            { maxIndexLength: 3 },
        )

        expect(await listChildIds(table, "dir")).toEqual(["left", "long-a", "long-b", "right"])
        const indexes = await getIndexes(table, "dir")
        expectStrictlyAscending(indexes.map((item) => item.index))
        expect((await table.get("long-a"))?.index?.length).toBeLessThanOrEqual(3)
        expect((await table.get("long-b"))?.index?.length).toBeLessThanOrEqual(3)
        expect((await table.get("long-a"))?.modif).toBeGreaterThan(longABefore!.modif)
        expect((await table.get("dir"))?.cmodif).toBeGreaterThan(dirBefore!.cmodif ?? 0)
        await expectChildLastIndexAccurate(table, "dir")
    })

    test("rebalanceTreeIndexes 在整段都超长且没有健康锚点时也应保持顺序并缩短 index", async () => {
        const table = await createDefinedTreeTable("rebalance-no-anchors")

        await table.createNodes([{ id: "dir", name: "dir", isDir: true }], "/")
        await table.setNodes([
            { id: "a", parentId: "dir", name: "a", isDir: false, index: "a0zzzz" },
            { id: "b", parentId: "dir", name: "b", isDir: false, index: "a0zzzzz" },
            { id: "c", parentId: "dir", name: "c", isDir: false, index: "a0zzzzzz" },
        ])

        await rebalanceTreeIndexes(
            table,
            "dir",
            [
                { id: "a", index: "a0zzzz" },
                { id: "b", index: "a0zzzzz" },
                { id: "c", index: "a0zzzzzz" },
            ],
            { maxIndexLength: 2 },
        )

        expect(await listChildIds(table, "dir")).toEqual(["a", "b", "c"])
        const indexes = (await getIndexes(table, "dir")).map((item) => item.index)
        expect(indexes.every((index) => index.length <= 2)).toBe(true)
        expectStrictlyAscending(indexes)
        await expectChildLastIndexAccurate(table, "dir")
    })

    test("smartRebalance 使用 items 模式时不应调用 getRangeIndexes，并应保持条目相对顺序", async () => {
        const items = [
            { id: "b", index: "a0zzzzzz" },
            { id: "a", index: "a0zzzzz" },
        ]
        const changed: { id: any; newIndex: string }[] = []

        const result = await smartRebalance(
            { items },
            {
                maxIndexLength: 3,
                returnChangedItems: true,
                getPrevIndexes: async () => [{ id: "left", index: "a0" }],
                getNextIndexes: async () => [{ id: "right", index: "b00" }],
                getRangeIndexes: async () => {
                    throw new Error("items 模式不应调用 getRangeIndexes")
                },
                setIndexes: async (reqs) => {
                    changed.push(...reqs.map((req) => ({ id: "id" in req ? req.id : req.index, newIndex: req.newIndex })))
                },
            },
        )

        expect(result.rebalanced).toBe(true)
        expect(result.callCounts.getRangeIndexes).toBe(0)
        expect(result.changedItems?.map((item) => item.id)).toEqual(["a", "b"])
        expect(changed.map((item) => item.id)).toEqual(["a", "b"])
        expectStrictlyAscending(changed.map((item) => item.newIndex))
    })

    test("smartRebalance 使用区间模式时应调用 getRangeIndexes，并只在超长时触发 setIndexes", async () => {
        const healthyResult = await smartRebalance(
            { startIndex: "a0", endIndex: "a1" },
            {
                maxIndexLength: 4,
                getPrevIndexes: async () => [],
                getNextIndexes: async () => [],
                getRangeIndexes: async () => {
                    throw new Error("未超长时不应查询区间")
                },
                setIndexes: async () => {
                    throw new Error("未超长时不应写入")
                },
            },
        )
        expect(healthyResult.rebalanced).toBe(false)
        expect(healthyResult.callCounts).toEqual({
            getPrevIndexes: 0,
            getNextIndexes: 0,
            getRangeIndexes: 0,
            setIndexes: 0,
        })

        const writes: ({ index: string; newIndex: string } | { id: any; newIndex: string })[] = []
        const longA = "a0zzzzzz"
        const longB = "a0zzzzzzz"
        const rebalanceResult = await smartRebalance(
            { startIndex: longA, endIndex: longB },
            {
                maxIndexLength: 3,
                getPrevIndexes: async () => [{ id: "left", index: "a0" }],
                getNextIndexes: async () => [{ id: "right", index: "b00" }],
                getRangeIndexes: async (startIndex, endIndex) => {
                    expect(startIndex).toBe(longA)
                    expect(endIndex).toBe(longB)
                    return [
                        { id: "long-a", index: longA },
                        { id: "long-b", index: longB },
                    ]
                },
                setIndexes: async (reqs) => {
                    writes.push(...reqs)
                },
            },
        )

        expect(rebalanceResult.rebalanced).toBe(true)
        expect(rebalanceResult.callCounts.getRangeIndexes).toBe(1)
        expect(rebalanceResult.callCounts.setIndexes).toBe(1)
        expect(writes).toHaveLength(2)
        expectStrictlyAscending(writes.map((req) => req.newIndex))
    })

    test("indexless 生成的区间索引应满足长度阈值触发重排前后的顺序约束", () => {
        const shortIndexes = getIndexesBetween("a0", "b00", 3)
        expect(shortIndexes[0] > "a0").toBe(true)
        expect(shortIndexes.at(-1)! < "b00").toBe(true)
        expectStrictlyAscending(shortIndexes)

        const denseIndexes = getIndexesBetween("a0zzzzzz", "a0zzzzzzz", 2)
        expect(denseIndexes.some((index) => index.length > 3)).toBe(true)
        expectStrictlyAscending(denseIndexes)
    })
})
