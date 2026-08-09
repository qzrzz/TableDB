import { SQLiteAdapter } from "../../../adapter/SQLite"
import { TableTree, defineTableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"

interface ITestTreeNode extends ITreeNode {
    tag?: string
    meta?: {
        hash_md5?: string
    }
}

let tableIndex = 0

async function createDefinedTreeTable(name: string) {
    const useTreeTable = defineTableTree<ITestTreeNode>({
        name: `test-tree-move-${tableIndex++}-${name}`,
        adapter: SQLiteAdapter({ filename: ":memory:", driver: "better-sqlite3" }),
        enableMarkDelete: true,
    })

    return await useTreeTable()
}

async function listChildIds(table: TableTree<ITestTreeNode>, parentId: string) {
    const result = await table.listNodes(parentId, { pageSize: 50 })
    return result.list.map((node) => node.id)
}

describe("defineTableTree 创建的 TableTree moveNodes", () => {
    test("空节点列表或不存在的节点应返回空结果", async () => {
        const table = await createDefinedTreeTable("empty")

        await table.createNodes([{ id: "dir", name: "目录", isDir: true }], "/")

        await expect(table.moveNodes([], "dir")).resolves.toEqual({})
        await expect(table.moveNodes(["", "missing"], "dir")).resolves.toEqual({})
    })

    test("移动节点时应更新父级和新旧父级统计信息", async () => {
        const table = await createDefinedTreeTable("metadata")

        await table.createNodes(
            [
                { id: "a", name: "A", isDir: true },
                { id: "b", name: "B", isDir: true },
            ],
            "/",
        )
        await table.createNodes([{ id: "file", name: "file.txt", isDir: false, size: 8 }], "a")

        const result = await table.moveNodes(["file"], "b")

        expect(result.modif).toBe(result.cmodif)
        expect((await table.get("file"))?.parentId).toBe("b")
        expect((await table.get("file"))?.modif).toBe(result.modif)
        expect((await table.get("a"))?.ctotal ?? 0).toBe(0)
        expect((await table.get("b"))?.ctotal).toBe(1)
        expect((await table.get("b"))?.cftotal).toBe(1)
        expect((await table.get("b"))?.csize).toBe(8)
    })

    test("移动目录时应携带子树并刷新祖先统计信息", async () => {
        const table = await createDefinedTreeTable("move-dir")

        await table.createNodes(
            [
                { id: "src-parent", name: "来源父级", isDir: true },
                { id: "target-parent", name: "目标父级", isDir: true },
            ],
            "/",
        )
        await table.createNodes([{ id: "dir", name: "目录", isDir: true }], "src-parent")
        await table.createNodes([{ id: "child", name: "child.txt", isDir: false, size: 6 }], "dir")

        await table.moveNodes(["dir"], "target-parent")

        expect((await table.get("dir"))?.parentId).toBe("target-parent")
        expect((await table.get("child"))?.parentId).toBe("dir")
        expect((await table.get("src-parent"))?.ctotal ?? 0).toBe(0)
        expect((await table.get("target-parent"))?.ctotal).toBe(2)
        expect((await table.get("target-parent"))?.csize).toBe(6)
    })

    test("移动节点时应拒绝不存在父级、自身和后代父级", async () => {
        const table = await createDefinedTreeTable("guard")

        await table.createNodes([{ id: "dir", name: "目录", isDir: true }], "/")
        await table.createNodes([{ id: "child", name: "子目录", isDir: true }], "dir")

        await expect(table.moveNodes(["dir"], "missing-parent")).rejects.toThrow("父节点不存在")
        await expect(table.moveNodes(["dir"], "dir")).rejects.toThrow("自己")
        await expect(table.moveNodes(["dir"], "child")).rejects.toThrow("后代")
    })

    test("移动节点时应去重节点 ID 并忽略空 ID", async () => {
        const table = await createDefinedTreeTable("dedupe")

        await table.createNodes(
            [
                { id: "src", name: "来源", isDir: true },
                { id: "target", name: "目标", isDir: true },
            ],
            "/",
        )
        await table.createNodes([{ id: "file", name: "file.txt", isDir: false, size: 3 }], "src")

        await table.moveNodes(["", "file", "file"], "target")

        expect(await listChildIds(table, "target")).toEqual(["file"])
        expect((await table.get("target"))?.ctotal).toBe(1)
    })

    test("使用 toEnd 移动节点时应追加到末尾并维护 childLastIndex", async () => {
        const table = await createDefinedTreeTable("index-to-end")

        await table.createNodes(
            [
                { id: "src", name: "来源", isDir: true },
                { id: "target", name: "目标", isDir: true },
            ],
            "/",
        )
        await table.createNodes([{ id: "a", name: "a", isDir: false }], "target", { index: { toEnd: true } })
        await table.createNodes([{ id: "b", name: "b", isDir: false }], "src")

        await table.moveNodes(["b"], "target", { index: { toEnd: true } })

        expect(await listChildIds(table, "target")).toEqual(["a", "b"])
        expect((await table.get("target"))?.childLastIndex).toBe((await table.get("b"))?.index)
    })

    test("使用 toStart 移动节点时应插入到开头", async () => {
        const table = await createDefinedTreeTable("index-to-start")

        await table.createNodes(
            [
                { id: "src", name: "来源", isDir: true },
                { id: "target", name: "目标", isDir: true },
            ],
            "/",
        )
        await table.createNodes([{ id: "a", name: "a", isDir: false }], "target", { index: { toEnd: true } })
        await table.createNodes([{ id: "b", name: "b", isDir: false }], "target", { index: { toEnd: true } })
        await table.createNodes([{ id: "start", name: "start", isDir: false }], "src")

        await table.moveNodes(["start"], "target", { index: { toStart: true } })

        expect(await listChildIds(table, "target")).toEqual(["start", "a", "b"])
    })

    test("使用 prevNodeId 和 nextNodeId 移动节点时应插入到两个参考节点之间", async () => {
        const table = await createDefinedTreeTable("index-between")

        await table.createNodes(
            [
                { id: "src", name: "来源", isDir: true },
                { id: "target", name: "目标", isDir: true },
            ],
            "/",
        )
        await table.createNodes(
            [
                { id: "a", name: "a", isDir: false },
                { id: "b", name: "b", isDir: false },
            ],
            "target",
            { index: { toEnd: true } },
        )
        await table.createNodes([{ id: "middle", name: "middle", isDir: false }], "src")

        await table.moveNodes(["middle"], "target", { index: { prevNodeId: "a", nextNodeId: "b" } })

        expect(await listChildIds(table, "target")).toEqual(["a", "middle", "b"])
    })

    test("排序参考节点不存在或不属于目标父级时应抛出错误", async () => {
        const table = await createDefinedTreeTable("index-guard")

        await table.createNodes(
            [
                { id: "src", name: "来源", isDir: true },
                { id: "target", name: "目标", isDir: true },
                { id: "other", name: "其他", isDir: true },
            ],
            "/",
        )
        await table.createNodes([{ id: "file", name: "file", isDir: false }], "src")
        await table.createNodes([{ id: "other-child", name: "other-child", isDir: false }], "other")

        await expect(table.moveNodes(["file"], "target", { index: { prevNodeId: "missing" } })).rejects.toThrow(
            "排序参考节点不存在",
        )
        await expect(table.moveNodes(["file"], "target", { index: { prevNodeId: "other-child" } })).rejects.toThrow(
            "排序参考节点不属于目标父级",
        )
    })

    test("父级已有 childLastIndex 时默认移动应追加到末尾", async () => {
        const table = await createDefinedTreeTable("default-end")

        await table.createNodes(
            [
                { id: "src", name: "来源", isDir: true },
                { id: "target", name: "目标", isDir: true },
            ],
            "/",
        )
        await table.createNodes([{ id: "a", name: "a", isDir: false }], "target", { index: { toEnd: true } })
        await table.createNodes([{ id: "b", name: "b", isDir: false }], "src")

        await table.moveNodes(["b"], "target")

        expect(await listChildIds(table, "target")).toEqual(["a", "b"])
        expect((await table.get("b"))?.index).toBeTruthy()
    })

    test("replace 覆盖策略应删除冲突目标并移动来源节点", async () => {
        const table = await createDefinedTreeTable("replace")

        await table.createNodes(
            [
                { id: "src", name: "来源", isDir: true },
                { id: "target", name: "目标", isDir: true },
            ],
            "/",
        )
        await table.createNodes([{ id: "source-file", name: "same.txt", isDir: false, tag: "source" }], "src")
        await table.createNodes([{ id: "target-file", name: "same.txt", isDir: false, tag: "target" }], "target")

        await table.moveNodes(["source-file"], "target", { uniqueBy: "name", overwriteMode: "replace" })

        expect(await table.get("target-file")).toBeUndefined()
        expect((await table.get("source-file"))?.parentId).toBe("target")
        expect((await table.get("source-file"))?.tag).toBe("source")
    })

    test("skip 覆盖策略应跳过冲突来源节点", async () => {
        const table = await createDefinedTreeTable("skip")

        await table.createNodes(
            [
                { id: "src", name: "来源", isDir: true },
                { id: "target", name: "目标", isDir: true },
            ],
            "/",
        )
        await table.createNodes([{ id: "source-file", name: "same.txt", isDir: false }], "src")
        await table.createNodes([{ id: "target-file", name: "same.txt", isDir: false }], "target")

        await expect(
            table.moveNodes(["source-file"], "target", { uniqueBy: "name", overwriteMode: "skip" }),
        ).resolves.toEqual({})
        expect((await table.get("source-file"))?.parentId).toBe("src")
        expect((await table.get("target-file"))?.parentId).toBe("target")
    })

    test("newName 覆盖策略应重命名来源节点后移动", async () => {
        const table = await createDefinedTreeTable("new-name")

        await table.createNodes(
            [
                { id: "src", name: "来源", isDir: true },
                { id: "target", name: "目标", isDir: true },
            ],
            "/",
        )
        await table.createNodes([{ id: "source-file", name: "文件.txt", isDir: false }], "src")
        await table.createNodes(
            [
                { id: "target-file", name: "文件.txt", isDir: false },
                { id: "target-file-1", name: "文件 (1).txt", isDir: false },
            ],
            "target",
        )

        await table.moveNodes(["source-file"], "target", { uniqueBy: "name", overwriteMode: "newName" })

        expect((await table.get("source-file"))?.parentId).toBe("target")
        expect((await table.get("source-file"))?.name).toBe("文件 (2).txt")
    })

    test("merge 覆盖策略应递归合并目录子节点并删除来源目录", async () => {
        const table = await createDefinedTreeTable("merge")

        await table.createNodes(
            [
                { id: "src", name: "same", isDir: true },
                { id: "target", name: "same", isDir: true },
            ],
            "/",
        )
        await table.createNodes([{ id: "file", name: "index.ts", isDir: false, size: 9 }], "src")

        const result = await table.moveNodes(["src"], "/", { uniqueBy: "name", overwriteMode: "merge" })

        expect(result.modif).toBeTypeOf("number")
        expect(result.modif).toBe(result.cmodif)
        expect(await table.get("src")).toBeUndefined()
        expect((await table.get("file"))?.parentId).toBe("target")
        expect((await table.get("target"))?.ctotal).toBe(1)
        expect((await table.get("target"))?.csize).toBe(9)
        expect((await table.get("target"))?.cmodif).toBe(result.cmodif)
    })

    test("merge 递归移动子节点时不应复用外层父级的排序锚点", async () => {
        const table = await createDefinedTreeTable("merge-nested-index-anchor")

        await table.createNodes(
            [
                { id: "source-parent", name: "来源父级", isDir: true },
                { id: "target-parent", name: "目标父级", isDir: true },
            ],
            "/",
        )
        await table.createNodes([{ id: "source", name: "same", isDir: true }], "source-parent")
        await table.createNodes([{ id: "source-child", name: "child.txt", isDir: false }], "source")
        await table.createNodes(
            [
                { id: "anchor", name: "anchor", isDir: false },
                { id: "target", name: "same", isDir: true },
            ],
            "target-parent",
            { index: { toEnd: true } },
        )

        await table.moveNodes(["source"], "target-parent", {
            uniqueBy: "name",
            overwriteMode: "merge",
            index: { prevNodeId: "anchor" },
        })

        expect((await table.get("source-child"))?.parentId).toBe("target")
    })

    test("mergeByModif 对文件冲突应保留较新的目标节点", async () => {
        const table = await createDefinedTreeTable("merge-by-modif-older")

        await table.createNodes(
            [
                { id: "src", name: "来源", isDir: true },
                { id: "target", name: "目标", isDir: true },
            ],
            "/",
        )
        await table.createNodes([{ id: "source-file", name: "same.txt", isDir: false, tag: "older", modif: 10 }], "src")
        await table.createNodes([{ id: "target-file", name: "same.txt", isDir: false, tag: "newer", modif: 20 }], "target")

        await expect(
            table.moveNodes(["source-file"], "target", { uniqueBy: "name", overwriteMode: "mergeByModif" }),
        ).resolves.toEqual({})
        expect((await table.get("source-file"))?.parentId).toBe("src")
        expect((await table.get("target-file"))?.tag).toBe("newer")
    })

    test("mergeByModif 对文件冲突应移动较新的来源节点并删除目标节点", async () => {
        const table = await createDefinedTreeTable("merge-by-modif-newer")

        await table.createNodes(
            [
                { id: "src", name: "来源", isDir: true },
                { id: "target", name: "目标", isDir: true },
            ],
            "/",
        )
        await table.createNodes([{ id: "source-file", name: "same.txt", isDir: false, tag: "newer", modif: 20 }], "src")
        await table.createNodes([{ id: "target-file", name: "same.txt", isDir: false, tag: "older", modif: 10 }], "target")

        await table.moveNodes(["source-file"], "target", { uniqueBy: "name", overwriteMode: "mergeByModif" })

        expect(await table.get("target-file")).toBeUndefined()
        expect((await table.get("source-file"))?.parentId).toBe("target")
        expect((await table.get("source-file"))?.tag).toBe("newer")
    })

    test("默认不允许文件覆盖目录，开启 enableFileOverwriteDir 后应允许", async () => {
        const table = await createDefinedTreeTable("file-overwrite-dir")

        await table.createNodes(
            [
                { id: "src", name: "来源", isDir: true },
                { id: "target", name: "目标", isDir: true },
            ],
            "/",
        )
        await table.createNodes([{ id: "source-file", name: "same", isDir: false }], "src")
        await table.createNodes([{ id: "target-dir", name: "same", isDir: true }], "target")

        await expect(
            table.moveNodes(["source-file"], "target", { uniqueBy: "name", overwriteMode: "replace" }),
        ).resolves.toEqual({})
        expect((await table.get("source-file"))?.parentId).toBe("src")
        expect((await table.get("target-dir"))?.parentId).toBe("target")

        await table.moveNodes(["source-file"], "target", {
            uniqueBy: "name",
            overwriteMode: "replace",
            enableFileOverwriteDir: true,
        })
        expect(await table.get("target-dir")).toBeUndefined()
        expect((await table.get("source-file"))?.parentId).toBe("target")
    })

    test("uniqueBy 应支持点路径字段", async () => {
        const table = await createDefinedTreeTable("unique-path")

        await table.createNodes(
            [
                { id: "src", name: "来源", isDir: true },
                { id: "target", name: "目标", isDir: true },
            ],
            "/",
        )
        await table.createNodes(
            [{ id: "source-file", name: "source.txt", isDir: false, meta: { hash_md5: "hash-1" } }],
            "src",
        )
        await table.createNodes(
            [{ id: "target-file", name: "target.txt", isDir: false, meta: { hash_md5: "hash-1" } }],
            "target",
        )

        await table.moveNodes(["source-file"], "target", { uniqueBy: "meta.hash_md5", overwriteMode: "replace" })

        expect(await table.get("target-file")).toBeUndefined()
        expect((await table.get("source-file"))?.parentId).toBe("target")
    })
})
