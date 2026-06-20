import { SQLiteAdapter } from "../../../adapter/SQLite"
import { TableTree, defineTableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"

interface ITestTreeNode extends ITreeNode {
    tag?: string
    meta?: {
        a?: number
        b?: number
    }
}

let tableIndex = 0

async function createDefinedTreeTable(name: string) {
    const useTreeTable = defineTableTree<ITestTreeNode>({
        name: `test-tree-update-${tableIndex++}-${name}`,
        adapter: SQLiteAdapter({ filename: ":memory:", driver: "better-sqlite3" }),
        enableMarkDelete: true,
    })

    return await useTreeTable()
}

async function listChildIds(table: TableTree<ITestTreeNode>, parentId: string) {
    const result = await table.listNodes(parentId, { pageSize: 50 })
    return result.list.map((node) => node.id)
}

describe("defineTableTree 创建的 TableTree updateNodes", () => {
    test("没有命中节点时应返回空结果且不产生写入", async () => {
        const table = await createDefinedTreeTable("empty")

        await table.createNodes([{ id: "node", name: "node", isDir: false, tag: "old" }], "/")

        await expect(table.updateNodes({ id: "missing" }, { $set: { tag: "new" } })).resolves.toEqual({})
        expect((await table.get("node"))?.tag).toBe("old")
    })

    test("普通更新应自动写入统一的 modif", async () => {
        const table = await createDefinedTreeTable("basic")

        await table.createNodes(
            [
                { id: "a", name: "a", isDir: false, tag: "old" },
                { id: "b", name: "b", isDir: false, tag: "old" },
            ],
            "/",
        )

        const result = await table.updateNodes({ tag: "old" }, { $set: { tag: "new" } })

        expect(result.modif).toBe(result.cmodif)
        expect((await table.get("a"))?.tag).toBe("new")
        expect((await table.get("b"))?.tag).toBe("new")
        expect((await table.get("a"))?.modif).toBe(result.modif)
        expect((await table.get("b"))?.modif).toBe(result.modif)
    })

    test("用户指定 modif 时应使用用户提供的 modif", async () => {
        const table = await createDefinedTreeTable("user-modif")

        await table.createNodes([{ id: "node", name: "node", isDir: false }], "/")

        const result = await table.updateNodes({ id: "node" }, { $set: { tag: "new", modif: 123 } })

        expect(result.modif).toBe(123)
        expect(result.cmodif).toBe(123)
        expect((await table.get("node"))?.modif).toBe(123)
    })

    test("没有 $set 时也应自动写入 modif", async () => {
        const table = await createDefinedTreeTable("auto-modif-without-set")

        await table.createNodes([{ id: "node", name: "node", isDir: false, tag: "old" }], "/")

        const result = await table.updateNodes({ id: "node" }, { $unset: { tag: true } })

        expect((await table.get("node"))?.tag).toBeUndefined()
        expect((await table.get("node"))?.modif).toBe(result.modif)
    })

    test("deep 更新应递归更新目标节点的全部后代", async () => {
        const table = await createDefinedTreeTable("deep")

        await table.createNodes([{ id: "root", name: "root", isDir: true }], "/")
        await table.createNodes(
            [
                { id: "child-dir", name: "child-dir", isDir: true },
                { id: "child-file", name: "child-file", isDir: false },
            ],
            "root",
        )
        await table.createNodes([{ id: "deep-file", name: "deep-file", isDir: false }], "child-dir")

        await table.updateNodes({ id: "root" }, { $set: { tag: "deep-updated" } }, { deep: true })

        expect((await table.get("root"))?.tag).toBe("deep-updated")
        expect((await table.get("child-dir"))?.tag).toBe("deep-updated")
        expect((await table.get("child-file"))?.tag).toBe("deep-updated")
        expect((await table.get("deep-file"))?.tag).toBe("deep-updated")
    })

    test("非 deep 更新不应影响后代节点", async () => {
        const table = await createDefinedTreeTable("not-deep")

        await table.createNodes([{ id: "root", name: "root", isDir: true }], "/")
        await table.createNodes([{ id: "child", name: "child", isDir: false, tag: "old" }], "root")

        await table.updateNodes({ id: "root" }, { $set: { tag: "updated" } })

        expect((await table.get("root"))?.tag).toBe("updated")
        expect((await table.get("child"))?.tag).toBe("old")
    })

    test("更新 size 和 isDir 后应刷新父级统计信息", async () => {
        const table = await createDefinedTreeTable("metadata")

        await table.createNodes([{ id: "dir", name: "dir", isDir: true }], "/")
        await table.createNodes([{ id: "file", name: "file.txt", isDir: false, size: 10 }], "dir")

        const result = await table.updateNodes({ id: "file" }, { $set: { size: 25, isDir: true } })

        const dir = await table.get("dir")
        expect(dir?.ctotal).toBe(1)
        expect(dir?.cftotal ?? 0).toBe(0)
        expect(dir?.csize).toBe(25)
        expect(dir?.cmodif).toBe(result.cmodif)
    })

    test("更新 parentId 时应移动节点并刷新新旧父级统计信息", async () => {
        const table = await createDefinedTreeTable("move-parent")

        await table.createNodes(
            [
                { id: "a", name: "A", isDir: true },
                { id: "b", name: "B", isDir: true },
            ],
            "/",
        )
        await table.createNodes([{ id: "file", name: "file.txt", isDir: false, size: 8 }], "a")

        await table.updateNodes({ id: "file" }, { $set: { parentId: "b" } })

        expect((await table.get("file"))?.parentId).toBe("b")
        expect((await table.get("a"))?.ctotal ?? 0).toBe(0)
        expect((await table.get("b"))?.ctotal).toBe(1)
        expect((await table.get("b"))?.csize).toBe(8)
    })

    test("更新 index 后应刷新父级 childLastIndex 并影响列表顺序", async () => {
        const table = await createDefinedTreeTable("index")

        await table.createNodes([{ id: "dir", name: "dir", isDir: true }], "/")
        await table.createNodes(
            [
                { id: "a", name: "a", isDir: false },
                { id: "b", name: "b", isDir: false },
            ],
            "dir",
            { index: { toEnd: true } },
        )
        const aIndex = (await table.get("a"))?.index
        const bIndex = (await table.get("b"))?.index

        await table.updateNodes({ id: "a" }, { $set: { index: `${bIndex}z` } })

        expect(await listChildIds(table, "dir")).toEqual(["b", "a"])
        expect((await table.get("dir"))?.childLastIndex).toBe(`${bIndex}z`)
        expect((await table.get("a"))?.index).not.toBe(aIndex)
    })

    test("应忽略 $set 中外部传入的树统计字段", async () => {
        const table = await createDefinedTreeTable("ignore-managed-set")

        await table.createNodes([{ id: "dir", name: "dir", isDir: true }], "/")
        await table.createNodes([{ id: "file", name: "file.txt", isDir: false, size: 5 }], "dir")

        await table.updateNodes(
            { id: "dir" },
            {
                $set: {
                    ctotal: 99,
                    cftotal: 88,
                    csize: 77,
                    childLastIndex: "ZZ",
                } as any,
            },
        )

        const dir = await table.get("dir")
        expect(dir?.ctotal).toBe(1)
        expect(dir?.cftotal).toBe(1)
        expect(dir?.csize).toBe(5)
        expect(dir?.childLastIndex).not.toBe("ZZ")
    })

    test("应忽略 $unset 中外部移除树统计字段的请求", async () => {
        const table = await createDefinedTreeTable("ignore-managed-unset")

        await table.createNodes([{ id: "dir", name: "dir", isDir: true }], "/")
        await table.createNodes([{ id: "file", name: "file.txt", isDir: false, size: 5 }], "dir")

        await table.updateNodes(
            { id: "dir" },
            {
                $unset: ["ctotal", "cftotal", "csize", "childLastIndex"] as any,
            },
        )

        const dir = await table.get("dir")
        expect(dir?.ctotal).toBe(1)
        expect(dir?.cftotal).toBe(1)
        expect(dir?.csize).toBe(5)
    })

    test("应拒绝非法名称、不存在父级、自身父级和后代父级", async () => {
        const table = await createDefinedTreeTable("guard")

        await table.createNodes([{ id: "dir", name: "dir", isDir: true }], "/")
        await table.createNodes([{ id: "child", name: "child", isDir: true }], "dir")

        await expect(table.updateNodes({ id: "dir" }, { $set: { name: "bad/name" } })).rejects.toThrow("/")
        await expect(table.updateNodes({ id: "dir" }, { $set: { parentId: "missing" } })).rejects.toThrow("父节点不存在")
        await expect(table.updateNodes({ id: "dir" }, { $set: { parentId: "dir" } })).rejects.toThrow("自己")
        await expect(table.updateNodes({ id: "dir" }, { $set: { parentId: "child" } })).rejects.toThrow("后代")
    })

    test("deep 更新移动目录时应拒绝移动到自己的后代中", async () => {
        const table = await createDefinedTreeTable("deep-parent-guard")

        await table.createNodes([{ id: "dir", name: "dir", isDir: true }], "/")
        await table.createNodes([{ id: "child", name: "child", isDir: true }], "dir")
        await table.createNodes([{ id: "deep-child", name: "deep-child", isDir: true }], "child")

        await expect(
            table.updateNodes({ id: "dir" }, { $set: { parentId: "deep-child" } }, { deep: true }),
        ).rejects.toThrow("自己")
    })
})
