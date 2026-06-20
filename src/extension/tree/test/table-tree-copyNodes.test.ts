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
        name: `test-tree-copy-${tableIndex++}-${name}`,
        adapter: SQLiteAdapter({ filename: ":memory:", driver: "better-sqlite3" }),
        enableMarkDelete: true,
    })

    return await useTreeTable()
}

async function createCopyFixture(table: TableTree<ITestTreeNode>) {
    await table.createNodes(
        [
            { id: "src", name: "src", isDir: true, tag: "source" },
            { id: "target", name: "target", isDir: true, tag: "target" },
        ],
        "/",
    )
    await table.createNodes(
        [
            { id: "src-file", name: "index.ts", isDir: false, size: 10, tag: "source-file", meta: { hash_md5: "hash-1" } },
            { id: "src-dir", name: "lib", isDir: true, tag: "source-dir" },
        ],
        "src",
        { index: { toEnd: true } },
    )
    await table.createNodes(
        [{ id: "src-deep-file", name: "deep.ts", isDir: false, size: 20, tag: "deep-file" }],
        "src-dir",
        { index: { toEnd: true } },
    )
}

async function listChildIds(table: TableTree<ITestTreeNode>, parentId: string) {
    const result = await table.listNodes(parentId, { pageSize: 50 })
    return result.list.map((node) => node.id)
}

describe("TableTree copyNodes", () => {
    test("空列表或不存在的源节点应返回空创建结果", async () => {
        const table = await createDefinedTreeTable("empty")

        await table.createNodes([{ id: "target", name: "target", isDir: true }], "/")

        await expect(table.copyNodes([], "target")).resolves.toEqual({ createdNodeIds: [] })
        await expect(table.copyNodes(["", "missing"], "target")).resolves.toEqual({ createdNodeIds: [] })
    })

    test("目标父级不存在时应抛出错误", async () => {
        const table = await createDefinedTreeTable("missing-parent")

        await table.createNodes([{ id: "src", name: "src", isDir: false }], "/")

        await expect(table.copyNodes(["src"], "missing-parent")).rejects.toThrow("父节点不存在")
    })

    test("默认复制到同一父级时应自动重命名并生成新 ID", async () => {
        const table = await createDefinedTreeTable("default-rename")

        await table.createNodes([{ id: "src-file", name: "file.txt", isDir: false, size: 10, tag: "source" }], "/")

        const result = await table.copyNodes(["src-file"], "/")

        expect(result.createdNodeIds).toHaveLength(1)
        expect(result.createdNodeIds[0]).not.toBe("src-file")
        const copied = await table.get(result.createdNodeIds[0])
        expect(copied?.name).toBe("file (1).txt")
        expect(copied?.parentId).toBe("/")
        expect(copied?.size).toBe(10)
        expect(copied?.tag).toBe("source")
    })

    test("renameOnCopy 为 false 且未配置覆盖策略时应保留原名称", async () => {
        const table = await createDefinedTreeTable("rename-false")

        await table.createNodes(
            [
                { id: "src", name: "来源", isDir: true },
                { id: "target", name: "目标", isDir: true },
            ],
            "/",
        )
        await table.createNodes([{ id: "src-file", name: "file.txt", isDir: false }], "src")

        const result = await table.copyNodes(["src-file"], "target", { renameOnCopy: false })

        expect((await table.get(result.createdNodeIds[0]))?.name).toBe("file.txt")
    })

    test("非 deep 复制目录时不应复制子节点", async () => {
        const table = await createDefinedTreeTable("shallow-dir")
        await createCopyFixture(table)

        const result = await table.copyNodes(["src"], "target", { renameOnCopy: false })

        expect(result.createdNodeIds).toHaveLength(1)
        const copiedRoot = await table.get(result.createdNodeIds[0])
        expect(copiedRoot?.name).toBe("src")
        expect(copiedRoot?.parentId).toBe("target")
        expect((await table.findMany({ parentId: result.createdNodeIds[0] })).length).toBe(0)
        expect((await table.get("target"))?.ctotal).toBe(1)
    })

    test("deep 复制目录时应递归复制子树并维护统计信息", async () => {
        const table = await createDefinedTreeTable("deep-dir")
        await createCopyFixture(table)

        const result = await table.copyNodes(["src"], "target", { deep: true, renameOnCopy: false })

        expect(result.createdNodeIds).toHaveLength(1)
        const copiedRootId = result.createdNodeIds[0]
        const copiedRoot = await table.get(copiedRootId)
        const copiedChildren = await table.findMany({ parentId: copiedRootId }, { sort: { index: 1 } })
        const copiedDir = copiedChildren.find((node) => node.name === "lib")
        const copiedFile = copiedChildren.find((node) => node.name === "index.ts")
        const copiedDeepFiles = copiedDir ? await table.findMany({ parentId: copiedDir.id }) : []

        expect(copiedRoot?.name).toBe("src")
        expect(copiedChildren.map((node) => node.name)).toEqual(["index.ts", "lib"])
        expect(copiedFile?.id).not.toBe("src-file")
        expect(copiedDir?.id).not.toBe("src-dir")
        expect(copiedDeepFiles.map((node) => node.name)).toEqual(["deep.ts"])
        expect((await table.get(copiedRootId))?.ctotal).toBe(3)
        expect((await table.get(copiedRootId))?.csize).toBe(30)
        expect((await table.get("target"))?.ctotal).toBe(4)
        expect((await table.get("target"))?.csize).toBe(30)
    })

    test("同时复制父节点和其后代时应只复制最外层根节点", async () => {
        const table = await createDefinedTreeTable("nested-roots")
        await createCopyFixture(table)

        const result = await table.copyNodes(["src", "src-file", "src-dir"], "target", { deep: true, renameOnCopy: false })

        expect(result.createdNodeIds).toHaveLength(1)
        const copiedRootId = result.createdNodeIds[0]
        expect((await table.get(copiedRootId))?.name).toBe("src")
        expect((await table.findMany({ parentId: "target" })).filter((node) => node.name === "src")).toHaveLength(1)
    })

    test("复制多个根节点时应按源节点顺序返回顶层创建 ID", async () => {
        const table = await createDefinedTreeTable("multi-root")

        await table.createNodes(
            [
                { id: "a", name: "a.txt", isDir: false },
                { id: "b", name: "b.txt", isDir: false },
                { id: "target", name: "target", isDir: true },
            ],
            "/",
        )

        const result = await table.copyNodes(["b", "a"], "target", { renameOnCopy: false })

        expect(result.createdNodeIds).toHaveLength(2)
        expect((await table.get(result.createdNodeIds[0]))?.name).toBe("b.txt")
        expect((await table.get(result.createdNodeIds[1]))?.name).toBe("a.txt")
    })

    test("复制时应去重源节点 ID 并忽略空 ID", async () => {
        const table = await createDefinedTreeTable("dedupe")

        await table.createNodes(
            [
                { id: "src", name: "src.txt", isDir: false },
                { id: "target", name: "target", isDir: true },
            ],
            "/",
        )

        const result = await table.copyNodes(["", "src", "src"], "target", { renameOnCopy: false })

        expect(result.createdNodeIds).toHaveLength(1)
        expect(await listChildIds(table, "target")).toEqual(result.createdNodeIds)
    })

    test("index.toEnd 应把复制节点追加到目标父级末尾", async () => {
        const table = await createDefinedTreeTable("index-to-end")

        await table.createNodes(
            [
                { id: "src", name: "src.txt", isDir: false },
                { id: "target", name: "target", isDir: true },
            ],
            "/",
        )
        await table.createNodes([{ id: "old", name: "old.txt", isDir: false }], "target", { index: { toEnd: true } })

        const result = await table.copyNodes(["src"], "target", { renameOnCopy: false, index: { toEnd: true } })

        expect(await listChildIds(table, "target")).toEqual(["old", result.createdNodeIds[0]])
        expect((await table.get("target"))?.childLastIndex).toBe((await table.get(result.createdNodeIds[0]))?.index)
    })

    test("index.toStart 应把复制节点插入到目标父级开头", async () => {
        const table = await createDefinedTreeTable("index-to-start")

        await table.createNodes(
            [
                { id: "src", name: "src.txt", isDir: false },
                { id: "target", name: "target", isDir: true },
            ],
            "/",
        )
        await table.createNodes([{ id: "old", name: "old.txt", isDir: false }], "target", { index: { toEnd: true } })

        const result = await table.copyNodes(["src"], "target", { renameOnCopy: false, index: { toStart: true } })

        expect(await listChildIds(table, "target")).toEqual([result.createdNodeIds[0], "old"])
    })

    test("overwriteMode skip 应跳过冲突节点", async () => {
        const table = await createDefinedTreeTable("skip")

        await table.createNodes(
            [
                { id: "src", name: "same.txt", isDir: false },
                { id: "target", name: "same.txt", isDir: false },
            ],
            "/",
        )

        const result = await table.copyNodes(["src"], "/", {
            uniqueBy: "name",
            overwriteMode: "skip",
        })

        expect(result.createdNodeIds).toEqual([])
        expect((await table.listNodes("/", { pageSize: 10 })).list.map((node) => node.id).sort()).toEqual(["src", "target"])
    })

    test("overwriteMode replace 应命中冲突目标并更新目标节点", async () => {
        const table = await createDefinedTreeTable("replace")

        await table.createNodes(
            [
                { id: "src-parent", name: "来源", isDir: true },
                { id: "target-parent", name: "目标", isDir: true },
            ],
            "/",
        )
        await table.createNodes([{ id: "src", name: "same.txt", isDir: false, tag: "source" }], "src-parent")
        await table.createNodes([{ id: "target", name: "same.txt", isDir: false, tag: "target" }], "target-parent")

        const result = await table.copyNodes(["src"], "target-parent", {
            uniqueBy: "name",
            overwriteMode: "replace",
        })

        expect(result.createdNodeIds).toEqual([])
        expect((await table.get("target"))?.tag).toBe("source")
        expect((await table.get("target"))?.name).toBe("same.txt")
    })

    test("overwriteMode newName 应生成不冲突名称", async () => {
        const table = await createDefinedTreeTable("new-name")

        await table.createNodes(
            [
                { id: "src", name: "文件.txt", isDir: false },
                { id: "old", name: "文件.txt", isDir: false },
                { id: "old-1", name: "文件 (1).txt", isDir: false },
            ],
            "/",
        )

        const result = await table.copyNodes(["src"], "/", {
            uniqueBy: "name",
            overwriteMode: "newName",
        })

        expect((await table.get(result.createdNodeIds[0]))?.name).toBe("文件 (2).txt")
    })

    test("overwriteMode merge 应递归合并目录子节点", async () => {
        const table = await createDefinedTreeTable("merge")

        await table.createNodes(
            [
                { id: "src-parent", name: "来源", isDir: true },
                { id: "target-parent", name: "目标", isDir: true },
            ],
            "/",
        )
        await table.createNodes([{ id: "src", name: "same", isDir: true, tag: "source" }], "src-parent")
        await table.createNodes([{ id: "target", name: "same", isDir: true, tag: "target" }], "target-parent")
        await table.createNodes([{ id: "src-file", name: "index.ts", isDir: false, size: 9 }], "src")

        const result = await table.copyNodes(["src"], "target-parent", {
            deep: true,
            uniqueBy: "name",
            overwriteMode: "merge",
        })

        expect(result.createdNodeIds).toEqual([])
        expect((await table.get("target"))?.tag).toBe("source")
        const targetChildren = await table.findMany({ parentId: "target" })
        expect(targetChildren.map((node) => node.name)).toEqual(["index.ts"])
        expect(targetChildren[0].id).not.toBe("src-file")
        expect((await table.get("target"))?.ctotal).toBe(1)
        expect((await table.get("target"))?.csize).toBe(9)
    })

    test("uniqueBy 应支持点路径字段", async () => {
        const table = await createDefinedTreeTable("unique-path")

        await table.createNodes(
            [
                { id: "src-parent", name: "来源", isDir: true },
                { id: "target-parent", name: "目标", isDir: true },
            ],
            "/",
        )
        await table.createNodes(
            [{ id: "src", name: "source.txt", isDir: false, tag: "source", meta: { hash_md5: "hash-1" } }],
            "src-parent",
        )
        await table.createNodes(
            [{ id: "target", name: "target.txt", isDir: false, tag: "target", meta: { hash_md5: "hash-1" } }],
            "target-parent",
        )

        const result = await table.copyNodes(["src"], "target-parent", {
            uniqueBy: "meta.hash_md5",
            overwriteMode: "replace",
        })

        expect(result.createdNodeIds).toEqual([])
        expect((await table.get("target"))?.tag).toBe("source")
    })

    test("默认不复制已标记删除的源节点", async () => {
        const table = await createDefinedTreeTable("mark-delete-source")

        await table.createNodes(
            [
                { id: "src", name: "src.txt", isDir: false },
                { id: "target", name: "target", isDir: true },
            ],
            "/",
        )
        await table.deleteNodes(["src"])

        const result = await table.copyNodes(["src"], "target")

        expect(result.createdNodeIds).toEqual([])
        expect(await listChildIds(table, "target")).toEqual([])
    })
})
