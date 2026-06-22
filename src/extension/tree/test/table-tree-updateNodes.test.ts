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

    test("默认不应更新已标记删除的节点，也不应返回虚假的变更结果", async () => {
        const table = await createDefinedTreeTable("skip-mark-deleted")

        await table.createNodes([{ id: "node", name: "node", isDir: false, tag: "old" }], "/")
        await table.deleteNodes(["node"])

        const result = await table.updateNodes({ id: "node" }, { $set: { tag: "new" } })

        expect(result).toEqual({})
        expect((await table.get("node", { ignoreMarkDelete: true }))?.tag).toBe("old")
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

    test("deep 更新默认不应更新已标记删除的后代节点", async () => {
        const table = await createDefinedTreeTable("deep-skip-mark-deleted-descendant")

        await table.createNodes([{ id: "root", name: "root", isDir: true }], "/")
        await table.createNodes([{ id: "visible", name: "visible.txt", isDir: false, tag: "old" }], "root")
        await table.createNodes([{ id: "deleted", name: "deleted.txt", isDir: false, tag: "old" }], "root")
        await table.deleteNodes(["deleted"])

        await table.updateNodes({ id: "root" }, { $set: { tag: "deep-updated" } }, { deep: true })

        expect((await table.get("root"))?.tag).toBe("deep-updated")
        expect((await table.get("visible"))?.tag).toBe("deep-updated")
        expect(await table.get("deleted")).toBeUndefined()
        expect((await table.get("deleted", { ignoreMarkDelete: true }))?.tag).toBe("old")
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

    test("批量更新 parentId 移动多个同级节点时应避免目标父级出现重复排序索引", async () => {
        const table = await createDefinedTreeTable("parent-index-batch")

        await table.createNodes(
            [
                { id: "src", name: "src", isDir: true },
                { id: "target", name: "target", isDir: true },
            ],
            "/",
        )
        await table.createNodes(
            [
                { id: "a", name: "a", isDir: false, tag: "move" },
                { id: "b", name: "b", isDir: false, tag: "move" },
            ],
            "src",
        )
        await table.createNodes([{ id: "old", name: "old", isDir: false }], "target", { index: { toEnd: true } })

        await table.updateNodes({ tag: "move" }, { $set: { parentId: "target" } })

        const moved = await table.findMany({ parentId: "target" })
        const indexes = moved.map((node) => node.index)
        expect(new Set(indexes).size).toBe(indexes.length)
        expect(indexes.every((index) => Boolean(index))).toBe(true)
        expect((await table.get("target"))?.childLastIndex).toBeTruthy()
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

    test("应忽略 $inc 等数值算子中外部修改树统计字段的请求", async () => {
        const table = await createDefinedTreeTable("ignore-managed-number-ops")

        await table.createNodes([{ id: "dir", name: "dir", isDir: true }], "/")
        await table.createNodes([{ id: "file", name: "file.txt", isDir: false, size: 5 }], "dir")

        await table.updateNodes(
            { id: "dir" },
            {
                $inc: { ctotal: 99, cftotal: 88, csize: 77 } as any,
                $max: { childLastIndex: "ZZ" } as any,
                $set: { tag: "updated" },
            },
        )

        const dir = await table.get("dir")
        expect(dir?.tag).toBe("updated")
        expect(dir?.ctotal).toBe(1)
        expect(dir?.cftotal).toBe(1)
        expect(dir?.csize).toBe(5)
        expect(dir?.childLastIndex).not.toBe("ZZ")
    })

    test("应忽略 $rename 中外部改写树统计字段的请求", async () => {
        const table = await createDefinedTreeTable("ignore-managed-rename")

        await table.createNodes([{ id: "dir", name: "dir", isDir: true, tag: "source" }], "/")
        await table.createNodes([{ id: "file", name: "file.txt", isDir: false, size: 5 }], "dir")

        await table.updateNodes(
            { id: "dir" },
            {
                $rename: { tag: "ctotal", csize: "oldCsize" } as any,
            },
        )

        const dir = await table.get("dir")
        expect(dir?.tag).toBe("source")
        expect((dir as any).oldCsize).toBeUndefined()
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

    test("应拒绝修改或移除节点身份和树结构必填字段", async () => {
        const table = await createDefinedTreeTable("guard-required-fields")

        await table.createNodes([{ id: "dir", name: "dir", isDir: true }], "/")
        await table.createNodes([{ id: "file", name: "file.txt", isDir: false, size: 5 }], "dir")

        await expect(table.updateNodes({ id: "file" }, { $set: { id: "renamed-id" } as any })).rejects.toThrow("结构字段")
        await expect(table.updateNodes({ id: "file" }, { $unset: { id: true } as any })).rejects.toThrow("结构字段")
        await expect(table.updateNodes({ id: "file" }, { $unset: { parentId: true } as any })).rejects.toThrow("结构字段")
        await expect(table.updateNodes({ id: "file" }, { $unset: ["name"] as any })).rejects.toThrow("结构字段")

        expect(await table.get("renamed-id")).toBeUndefined()
        expect((await table.get("file"))?.parentId).toBe("dir")
        expect((await table.get("file"))?.name).toBe("file.txt")
        expect(await listChildIds(table, "dir")).toEqual(["file"])
        expect((await table.get("dir"))?.ctotal).toBe(1)
    })

    test("应拒绝把树结构必填字段更新为空值", async () => {
        const table = await createDefinedTreeTable("guard-empty-required-fields")

        await table.createNodes([{ id: "dir", name: "dir", isDir: true }], "/")
        await table.createNodes([{ id: "file", name: "file.txt", isDir: false, size: 5 }], "dir")

        await expect(table.updateNodes({ id: "file" }, { $set: { parentId: undefined } as any })).rejects.toThrow("结构字段")
        await expect(table.updateNodes({ id: "file" }, { $set: { name: undefined } as any })).rejects.toThrow("结构字段")
        await expect(table.updateNodes({ id: "file" }, { $set: { isDir: null } as any })).rejects.toThrow("结构字段")
        await expect(table.updateNodes({ id: "file" }, { $set: { size: undefined } as any })).rejects.toThrow("结构字段")

        expect((await table.get("file"))?.parentId).toBe("dir")
        expect((await table.get("file"))?.name).toBe("file.txt")
        expect((await table.get("file"))?.isDir).toBe(false)
        expect((await table.get("file"))?.size).toBe(5)
        expect(await listChildIds(table, "dir")).toEqual(["file"])
    })

    test("应拒绝通过 rename 算子改写树结构字段", async () => {
        const table = await createDefinedTreeTable("guard-rename-structure-fields")

        await table.createNodes([{ id: "dir", name: "dir", isDir: true }], "/")
        await table.createNodes([{ id: "file", name: "file.txt", isDir: false, size: 5, tag: "draft" }], "dir")

        await expect(table.updateNodes({ id: "file" }, { $rename: { parentId: "oldParentId" } as any })).rejects.toThrow("结构字段")
        await expect(table.updateNodes({ id: "file" }, { $rename: { tag: "parentId" } as any })).rejects.toThrow("结构字段")
        await expect(table.updateNodes({ id: "file" }, { $rename: { name: "title" } as any })).rejects.toThrow("结构字段")

        expect((await table.get("file"))?.parentId).toBe("dir")
        expect((await table.get("file"))?.name).toBe("file.txt")
        expect((await table.get("file"))?.tag).toBe("draft")
        expect(await listChildIds(table, "dir")).toEqual(["file"])
    })

    test("应拒绝通过比较算子改写树结构字段", async () => {
        const table = await createDefinedTreeTable("guard-compare-structure-fields")

        await table.createNodes([{ id: "dir", name: "dir", isDir: true }], "/")
        await table.createNodes([{ id: "file", name: "file.txt", isDir: false, size: 5 }], "dir")

        await expect(table.updateNodes({ id: "file" }, { $max: { parentId: "missing-parent" } as any })).rejects.toThrow("结构字段")
        await expect(table.updateNodes({ id: "file" }, { $min: { name: "bad/name" } as any })).rejects.toThrow("结构字段")
        await expect(table.updateNodes({ id: "file" }, { $max: { id: "renamed-id" } as any })).rejects.toThrow("结构字段")
        await expect(table.updateNodes({ id: "file" }, { $min: { isDir: null } as any })).rejects.toThrow("结构字段")
        await expect(table.updateNodes({ id: "file" }, { $min: { size: null } as any })).rejects.toThrow("结构字段")

        expect(await table.get("renamed-id")).toBeUndefined()
        expect((await table.get("file"))?.parentId).toBe("dir")
        expect((await table.get("file"))?.name).toBe("file.txt")
        expect((await table.get("file"))?.isDir).toBe(false)
        expect((await table.get("file"))?.size).toBe(5)
        expect(await listChildIds(table, "dir")).toEqual(["file"])
    })

    test("批量命中父子节点并更新 parentId 时应拒绝平铺后代节点", async () => {
        const table = await createDefinedTreeTable("batch-parent-child-parent-guard")

        await table.createNodes([{ id: "dir", name: "dir", isDir: true, tag: "move" }], "/")
        await table.createNodes([{ id: "child", name: "child", isDir: true, tag: "move" }], "dir")
        await table.createNodes([{ id: "target", name: "target", isDir: true }], "/")

        await expect(
            table.updateNodes({ tag: "move" }, { $set: { parentId: "target" } }),
        ).rejects.toThrow("后代")

        expect((await table.get("dir"))?.parentId).toBe("/")
        expect((await table.get("child"))?.parentId).toBe("dir")
    })

    test("deep 更新时如果修改 parentId 应抛出错误并保持原有层级", async () => {
        const table = await createDefinedTreeTable("deep-parent-guard")

        await table.createNodes([{ id: "dir", name: "dir", isDir: true }], "/")
        await table.createNodes([{ id: "child", name: "child", isDir: true }], "dir")
        await table.createNodes([{ id: "deep-child", name: "deep-child", isDir: true }], "child")
        await table.createNodes([{ id: "target", name: "target", isDir: true }], "/")

        await expect(
            table.updateNodes({ id: "dir" }, { $set: { parentId: "target" } }, { deep: true }),
        ).rejects.toThrow("deep 更新不能同时修改 parentId")

        expect((await table.get("dir"))?.parentId).toBe("/")
        expect((await table.get("child"))?.parentId).toBe("dir")
        expect((await table.get("deep-child"))?.parentId).toBe("child")
    })
})
