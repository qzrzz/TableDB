import { SQLiteAdapter } from "../../../adapter/SQLite"
import type { ITreeSetNodesOptions } from "../core/setNodes"
import { TableTree, defineTableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"

interface ITestTreeNode extends ITreeNode {
    tag?: string
    meta?: {
        hash_md5?: string
        keep?: boolean
        old?: boolean
        next?: boolean
        nested?: {
            a?: number
            b?: number
        }
    }
}

let tableIndex = 0

async function createDefinedTreeTable(name: string) {
    const useTreeTable = defineTableTree<ITestTreeNode>({
        name: `test-tree-set-${tableIndex++}-${name}`,
        adapter: SQLiteAdapter({ filename: ":memory:", driver: "better-sqlite3" }),
        enableMarkDelete: true,
    })

    return await useTreeTable()
}

async function listChildIds(table: TableTree<ITestTreeNode>, parentId: string) {
    const result = await table.listNodes(parentId, { pageSize: 50 })
    return result.list.map((node) => node.id)
}

describe("TableTree setNodes", () => {
    test("部分更新已有节点时应保留未提供的树结构字段", async () => {
        const table = await createDefinedTreeTable("partial-update-preserves-fields")

        await table.createNodes([{ id: "dir", name: "目录", isDir: true }], "/")
        await table.createNodes([{ id: "file", name: "原文件.txt", isDir: false, size: 12, tag: "old" }], "dir")

        await table.setNodes([{ id: "file", tag: "new" }])

        const file = await table.get("file")
        expect(file?.parentId).toBe("dir")
        expect(file?.name).toBe("原文件.txt")
        expect(file?.isDir).toBe(false)
        expect(file?.size).toBe(12)
        expect(file?.tag).toBe("new")
    })

    test("replace 已存在的来源节点时应保留来源 ID 和原有子树", async () => {
        const table = await createDefinedTreeTable("replace-existing-source")

        await table.createNodes(
            [
                { id: "source-parent", name: "来源父级", isDir: true },
                { id: "target-parent", name: "目标父级", isDir: true },
            ],
            "/",
        )
        await table.createNodes([{ id: "source", name: "same", isDir: true }], "source-parent")
        await table.createNodes([{ id: "source-child", name: "child.txt", isDir: false, size: 4 }], "source")
        await table.createNodes([{ id: "target", name: "same", isDir: true }], "target-parent")
        await table.createNodes([{ id: "target-child", name: "stale.txt", isDir: false, size: 8 }], "target")

        await table.setNodes(
            [{ id: "source", parentId: "target-parent", name: "same", isDir: true }],
            { uniqueBy: "name", overwriteMode: "replace" },
        )

        expect(await table.get("target")).toBeUndefined()
        expect((await table.get("source"))?.parentId).toBe("target-parent")
        expect((await table.get("source-child"))?.parentId).toBe("source")
        expect(await table.get("target-child")).toBeUndefined()
    })

    test("uniqueBy 对象值相等时应识别为同一冲突键", async () => {
        const table = await createDefinedTreeTable("object-unique-value")

        await table.createNodes([{ id: "old", name: "old", isDir: false, meta: { hash_md5: "same" } }], "/")
        await table.setNodes(
            [{ id: "incoming", parentId: "/", name: "new", isDir: false, meta: { hash_md5: "same" } }],
            { uniqueBy: "meta", overwriteMode: "replace" },
        )

        expect(await table.findMany({ parentId: "/" })).toHaveLength(1)
        expect((await table.get("old"))?.meta).toEqual({ hash_md5: "same" })
        expect(await table.get("incoming")).toBeUndefined()
    })

    test("应该能够创建节点并返回本次变更信息", async () => {
        const table = await createDefinedTreeTable("create")
        const options: ITreeSetNodesOptions = {
            returnChangedNodesIds: true,
        }

        const result = await table.setNodes(
            [
                { id: "f1", name: "f1.txt", parentId: "/", isDir: false, size: 10 },
                { id: "f2", name: "f2.txt", parentId: "/", isDir: false, size: 20 },
            ],
            options,
        )

        expect(result.modif).toBe(result.cmodif)
        expect(result.changedNodeIds).toEqual(["f1", "f2"])
        expect(await listChildIds(table, "/")).toEqual(["f1", "f2"])
        expect((await table.get("f1"))?.modif).toBe(result.modif)
        expect((await table.get("f2"))?.size).toBe(20)
    })

    test("设置空节点列表时应返回空结果", async () => {
        const table = await createDefinedTreeTable("empty")

        await expect(table.setNodes([])).resolves.toEqual({})
        await expect(table.setNodes([], { returnChangedNodesIds: true })).resolves.toEqual({
            changedNodeIds: [],
        })
    })

    test("应该支持同一批次内创建父节点和子节点", async () => {
        const table = await createDefinedTreeTable("batch-parent")

        await table.setNodes([
            { id: "dir", name: "目录", parentId: "/", isDir: true },
            { id: "child", name: "子文件.txt", parentId: "dir", isDir: false, size: 5 },
        ])

        const dir = await table.get("dir")
        expect((await table.get("child"))?.parentId).toBe("dir")
        expect(dir?.ctotal).toBe(1)
        expect(dir?.cftotal).toBe(1)
        expect(dir?.csize).toBe(5)
    })

    test("应该支持同一批次内创建多层节点并正确刷新祖先统计", async () => {
        const table = await createDefinedTreeTable("batch-deep-parent")

        await table.setNodes([
            { id: "dir1", name: "dir1", isDir: true, parentId: "/" },
            { id: "dir2", name: "dir2", isDir: true, parentId: "dir1" },
            { id: "file1", name: "file1.txt", isDir: false, size: 100, parentId: "dir2" },
        ])

        const dir1 = await table.get("dir1")
        const dir2 = await table.get("dir2")
        expect((await table.get("file1"))?.parentId).toBe("dir2")
        expect(dir2?.ctotal).toBe(1)
        expect(dir2?.cftotal).toBe(1)
        expect(dir2?.csize).toBe(100)
        expect(dir1?.ctotal).toBe(2)
        expect(dir1?.cftotal).toBe(1)
        expect(dir1?.csize).toBe(100)
    })

    test("同一批次包含多个 parentId 时应能创建多棵独立子树并分别刷新 metadata", async () => {
        const table = await createDefinedTreeTable("batch-multi-parent-forest")

        await table.setNodes(
            [
                { id: "docs", name: "docs", isDir: true, parentId: "/" },
                { id: "src", name: "src", isDir: true, parentId: "/" },
                { id: "docs-guide", name: "guide.md", isDir: false, size: 3, parentId: "docs" },
                { id: "docs-api", name: "api", isDir: true, parentId: "docs" },
                { id: "docs-api-index", name: "index.md", isDir: false, size: 5, parentId: "docs-api" },
                { id: "src-core", name: "core", isDir: true, parentId: "src" },
                { id: "src-index", name: "index.ts", isDir: false, size: 7, parentId: "src-core" },
            ],
            { index: { toEnd: true } },
        )

        expect(await listChildIds(table, "/")).toEqual(["docs", "src"])
        expect(await listChildIds(table, "docs")).toEqual(["docs-guide", "docs-api"])
        expect(await listChildIds(table, "docs-api")).toEqual(["docs-api-index"])
        expect(await listChildIds(table, "src")).toEqual(["src-core"])

        const docs = await table.get("docs")
        const src = await table.get("src")
        expect(docs?.ctotal).toBe(3)
        expect(docs?.cftotal).toBe(2)
        expect(docs?.csize).toBe(8)
        expect(src?.ctotal).toBe(2)
        expect(src?.cftotal).toBe(1)
        expect(src?.csize).toBe(7)
    })

    test("同一批次多个 parentId 即使子节点先于父节点传入也应按最终父级关系建树", async () => {
        const table = await createDefinedTreeTable("batch-multi-parent-out-of-order")

        await table.setNodes(
            [
                { id: "docs-guide", name: "guide.md", isDir: false, size: 3, parentId: "docs" },
                { id: "src-index", name: "index.ts", isDir: false, size: 7, parentId: "src-core" },
                { id: "docs-api-index", name: "index.md", isDir: false, size: 5, parentId: "docs-api" },
                { id: "docs", name: "docs", isDir: true, parentId: "/" },
                { id: "src-core", name: "core", isDir: true, parentId: "src" },
                { id: "src", name: "src", isDir: true, parentId: "/" },
                { id: "docs-api", name: "api", isDir: true, parentId: "docs" },
            ],
            { index: { toEnd: true } },
        )

        expect(await listChildIds(table, "/")).toEqual(["docs", "src"])
        expect(await listChildIds(table, "docs")).toEqual(["docs-guide", "docs-api"])
        expect(await listChildIds(table, "docs-api")).toEqual(["docs-api-index"])
        expect(await listChildIds(table, "src")).toEqual(["src-core"])
        expect(await listChildIds(table, "src-core")).toEqual(["src-index"])
        expect((await table.get("docs"))?.ctotal).toBe(3)
        expect((await table.get("docs"))?.csize).toBe(8)
        expect((await table.get("src"))?.ctotal).toBe(2)
        expect((await table.get("src"))?.csize).toBe(7)
    })

    test("同一批次多个 parentId 可混合使用库中已有父级和本批次新建父级", async () => {
        const table = await createDefinedTreeTable("batch-mixed-existing-and-new-parents")

        await table.createNodes(
            [
                { id: "workspace", name: "workspace", isDir: true },
                { id: "archive", name: "archive", isDir: true },
            ],
            "/",
        )

        await table.setNodes(
            [
                { id: "workspace-readme", name: "README.md", isDir: false, size: 2, parentId: "workspace" },
                { id: "archive-2026", name: "2026", isDir: true, parentId: "archive" },
                { id: "archive-log", name: "log.txt", isDir: false, size: 4, parentId: "archive-2026" },
                { id: "drafts", name: "drafts", isDir: true, parentId: "workspace" },
                { id: "draft-note", name: "note.md", isDir: false, size: 6, parentId: "drafts" },
            ],
            { index: { toEnd: true } },
        )

        expect(await listChildIds(table, "workspace")).toEqual(["workspace-readme", "drafts"])
        expect(await listChildIds(table, "archive")).toEqual(["archive-2026"])
        expect((await table.get("workspace"))?.ctotal).toBe(3)
        expect((await table.get("workspace"))?.csize).toBe(8)
        expect((await table.get("archive"))?.ctotal).toBe(2)
        expect((await table.get("archive"))?.csize).toBe(4)
    })

    test("同一批次多个 parentId 中只要有缺失父级就应整体失败且不写入其它合法子树", async () => {
        const table = await createDefinedTreeTable("batch-multi-parent-missing-parent")

        await table.createNodes([{ id: "valid-root", name: "valid", isDir: true }], "/")

        await expect(
            table.setNodes([
                { id: "valid-file", name: "ok.txt", isDir: false, size: 1, parentId: "valid-root" },
                { id: "missing-child", name: "bad.txt", isDir: false, size: 2, parentId: "missing-root" },
                { id: "missing-grandchild", name: "bad-deep.txt", isDir: false, size: 3, parentId: "missing-child" },
            ]),
        ).rejects.toThrow("父节点不存在")

        expect(await table.get("valid-file", { ignoreMarkDelete: true })).toBeUndefined()
        expect(await table.get("missing-child", { ignoreMarkDelete: true })).toBeUndefined()
        expect(await table.get("missing-grandchild", { ignoreMarkDelete: true })).toBeUndefined()
        expect((await table.get("valid-root"))?.ctotal ?? 0).toBe(0)
    })

    test("同一批次多个 parentId 中存在深层循环时应整体失败且不写入无关合法节点", async () => {
        const table = await createDefinedTreeTable("batch-multi-parent-deep-cycle")

        await expect(
            table.setNodes([
                { id: "safe-dir", name: "safe", isDir: true, parentId: "/" },
                { id: "safe-file", name: "safe.txt", isDir: false, size: 1, parentId: "safe-dir" },
                { id: "cycle-a", name: "a", isDir: true, parentId: "cycle-c" },
                { id: "cycle-b", name: "b", isDir: true, parentId: "cycle-a" },
                { id: "cycle-c", name: "c", isDir: true, parentId: "cycle-b" },
            ]),
        ).rejects.toThrow("循环父级")

        expect(await table.get("safe-dir", { ignoreMarkDelete: true })).toBeUndefined()
        expect(await table.get("safe-file", { ignoreMarkDelete: true })).toBeUndefined()
        expect(await table.get("cycle-a", { ignoreMarkDelete: true })).toBeUndefined()
        expect(await table.get("cycle-b", { ignoreMarkDelete: true })).toBeUndefined()
        expect(await table.get("cycle-c", { ignoreMarkDelete: true })).toBeUndefined()
    })

    test("同一批次多个 parentId 中任一分支节点名称非法时应整体失败且不写入其它合法分支", async () => {
        const table = await createDefinedTreeTable("batch-multi-parent-invalid-name")

        await table.setNodes([{ id: "valid-root", name: "valid", isDir: true, parentId: "/" }])

        await expect(
            table.setNodes([
                { id: "valid-file", name: "ok.txt", isDir: false, size: 1, parentId: "valid-root" },
                { id: "bad-dir", name: "bad/name", isDir: true, parentId: "/" },
                { id: "bad-child", name: "child.txt", isDir: false, size: 2, parentId: "bad-dir" },
            ]),
        ).rejects.toThrow("节点名称不能包含")

        expect(await table.get("valid-file", { ignoreMarkDelete: true })).toBeUndefined()
        expect(await table.get("bad-dir", { ignoreMarkDelete: true })).toBeUndefined()
        expect(await table.get("bad-child", { ignoreMarkDelete: true })).toBeUndefined()
        expect((await table.get("valid-root"))?.ctotal ?? 0).toBe(0)
    })

    test("同一批次重复 ID 指向不同 parentId 时应拒绝写入并保持原树不变", async () => {
        const table = await createDefinedTreeTable("batch-duplicate-id-different-parent")

        await table.setNodes(
            [
                { id: "left", name: "left", isDir: true, parentId: "/" },
                { id: "right", name: "right", isDir: true, parentId: "/" },
                { id: "left-old", name: "old.txt", isDir: false, size: 1, parentId: "left" },
            ],
            { index: { toEnd: true } },
        )

        await expect(
            table.setNodes([
                { id: "same-node", name: "same-left.txt", isDir: false, size: 2, parentId: "left" },
                { id: "same-node", name: "same-right.txt", isDir: false, size: 3, parentId: "right" },
                { id: "right-ok", name: "right-ok.txt", isDir: false, size: 4, parentId: "right" },
            ]),
        ).rejects.toThrow("重复节点 ID")

        expect(await table.get("same-node", { ignoreMarkDelete: true })).toBeUndefined()
        expect(await table.get("right-ok", { ignoreMarkDelete: true })).toBeUndefined()
        expect(await listChildIds(table, "left")).toEqual(["left-old"])
        expect(await listChildIds(table, "right")).toEqual([])
        expect((await table.get("left"))?.ctotal).toBe(1)
        expect((await table.get("right"))?.ctotal ?? 0).toBe(0)
    })

    test("同一批次重复 ID 即使指向同一 parentId 也应拒绝多个写入意图", async () => {
        const table = await createDefinedTreeTable("batch-duplicate-id-same-parent")

        await table.setNodes([{ id: "root", name: "root", isDir: true, parentId: "/" }])

        await expect(
            table.setNodes(
                [
                    { id: "same-node", name: "a.txt", isDir: false, size: 1, parentId: "root", tag: "a" },
                    { id: "same-node", name: "b.txt", isDir: false, size: 2, parentId: "root", tag: "b" },
                    { id: "other-node", name: "other.txt", isDir: false, size: 3, parentId: "root" },
                ],
                { uniqueBy: "name", overwriteMode: "replace" },
            ),
        ).rejects.toThrow("重复节点 ID")

        expect(await table.get("same-node", { ignoreMarkDelete: true })).toBeUndefined()
        expect(await table.get("other-node", { ignoreMarkDelete: true })).toBeUndefined()
        expect(await listChildIds(table, "root")).toEqual([])
        expect((await table.get("root"))?.ctotal ?? 0).toBe(0)
    })

    test("replace 覆盖把来源映射为目标 ID 后若与同批次显式更新冲突应整体拒绝", async () => {
        const table = await createDefinedTreeTable("replace-resolved-duplicate-target-id")

        await table.setNodes(
            [
                { id: "left", name: "left", isDir: true, parentId: "/" },
                { id: "right", name: "right", isDir: true, parentId: "/" },
                { id: "target", name: "same.txt", isDir: false, size: 1, parentId: "left", tag: "old" },
            ],
            { index: { toEnd: true } },
        )

        await expect(
            table.setNodes(
                [
                    { id: "incoming", name: "same.txt", isDir: false, size: 5, parentId: "left", tag: "replace" },
                    { id: "target", name: "target-moved.txt", isDir: false, size: 7, parentId: "right", tag: "move" },
                ],
                { uniqueBy: "name", overwriteMode: "replace", index: { toEnd: true } },
            ),
        ).rejects.toThrow("重复节点 ID")

        expect(await table.get("incoming", { ignoreMarkDelete: true })).toBeUndefined()
        expect((await table.get("target"))?.parentId).toBe("left")
        expect((await table.get("target"))?.name).toBe("same.txt")
        expect((await table.get("target"))?.size).toBe(1)
        expect((await table.get("target"))?.tag).toBe("old")
        expect(await listChildIds(table, "left")).toEqual(["target"])
        expect(await listChildIds(table, "right")).toEqual([])
    })

    test("merge 覆盖把来源合并到目标 ID 后若与同批次显式移动冲突应整体拒绝", async () => {
        const table = await createDefinedTreeTable("merge-resolved-duplicate-target-id")

        await table.setNodes(
            [
                { id: "left", name: "left", isDir: true, parentId: "/" },
                { id: "right", name: "right", isDir: true, parentId: "/" },
                { id: "target", name: "pkg", isDir: true, parentId: "left", tag: "old-target" },
                { id: "old-file", name: "old.ts", isDir: false, size: 1, parentId: "target" },
            ],
            { index: { toEnd: true } },
        )

        await expect(
            table.setNodes(
                [
                    { id: "incoming", name: "pkg", isDir: true, parentId: "left", tag: "incoming" },
                    { id: "incoming-file", name: "new.ts", isDir: false, size: 5, parentId: "incoming" },
                    { id: "target", name: "pkg-moved", isDir: true, parentId: "right", tag: "move" },
                ],
                { uniqueBy: "name", overwriteMode: "merge", index: { toEnd: true } },
            ),
        ).rejects.toThrow("重复节点 ID")

        expect(await table.get("incoming", { ignoreMarkDelete: true })).toBeUndefined()
        expect(await table.get("incoming-file", { ignoreMarkDelete: true })).toBeUndefined()
        expect((await table.get("target"))?.parentId).toBe("left")
        expect((await table.get("target"))?.name).toBe("pkg")
        expect((await table.get("target"))?.tag).toBe("old-target")
        expect((await table.get("old-file"))?.parentId).toBe("target")
        expect(await listChildIds(table, "left")).toEqual(["target"])
        expect(await listChildIds(table, "right")).toEqual([])
        expect((await table.get("target"))?.ctotal).toBe(1)
        expect((await table.get("target"))?.csize).toBe(1)
    })

    test("同一批次移动多个已有节点到不同 parentId 时应刷新全部新旧父级 metadata", async () => {
        const table = await createDefinedTreeTable("batch-move-multi-parent")

        await table.setNodes(
            [
                { id: "left", name: "left", isDir: true, parentId: "/" },
                { id: "right", name: "right", isDir: true, parentId: "/" },
                { id: "archive", name: "archive", isDir: true, parentId: "/" },
                { id: "left-file", name: "left.txt", isDir: false, size: 2, parentId: "left" },
                { id: "right-file", name: "right.txt", isDir: false, size: 3, parentId: "right" },
                { id: "archive-file", name: "archive.txt", isDir: false, size: 5, parentId: "archive" },
            ],
            { index: { toEnd: true } },
        )

        await table.setNodes(
            [
                { id: "left-file", name: "left.txt", isDir: false, size: 2, parentId: "archive" },
                { id: "right-file", name: "right.txt", isDir: false, size: 3, parentId: "left" },
                { id: "archive-file", name: "archive.txt", isDir: false, size: 5, parentId: "right" },
            ],
            { index: { toEnd: true } },
        )

        expect(await listChildIds(table, "left")).toEqual(["right-file"])
        expect(await listChildIds(table, "right")).toEqual(["archive-file"])
        expect(await listChildIds(table, "archive")).toEqual(["left-file"])
        expect((await table.get("left"))?.ctotal).toBe(1)
        expect((await table.get("left"))?.csize).toBe(3)
        expect((await table.get("right"))?.ctotal).toBe(1)
        expect((await table.get("right"))?.csize).toBe(5)
        expect((await table.get("archive"))?.ctotal).toBe(1)
        expect((await table.get("archive"))?.csize).toBe(2)
    })

    test("同一批次移动已有父目录并把新节点写到移动后的父目录下时应保持整棵子树正确", async () => {
        const table = await createDefinedTreeTable("batch-move-parent-and-create-child")

        await table.setNodes(
            [
                { id: "workspace", name: "workspace", isDir: true, parentId: "/" },
                { id: "archive", name: "archive", isDir: true, parentId: "/" },
                { id: "pkg", name: "pkg", isDir: true, parentId: "workspace" },
                { id: "old-file", name: "old.ts", isDir: false, size: 2, parentId: "pkg" },
            ],
            { index: { toEnd: true } },
        )

        await table.setNodes(
            [
                { id: "pkg", name: "pkg", isDir: true, parentId: "archive" },
                { id: "new-dir", name: "src", isDir: true, parentId: "pkg" },
                { id: "new-file", name: "index.ts", isDir: false, size: 5, parentId: "new-dir" },
            ],
            { index: { toEnd: true } },
        )

        expect(await listChildIds(table, "workspace")).toEqual([])
        expect(await listChildIds(table, "archive")).toEqual(["pkg"])
        expect(await listChildIds(table, "pkg")).toEqual(["old-file", "new-dir"])
        expect((await table.get("pkg"))?.parentId).toBe("archive")
        expect((await table.get("new-file"))?.parentId).toBe("new-dir")
        expect((await table.get("workspace"))?.ctotal ?? 0).toBe(0)
        expect((await table.get("archive"))?.ctotal).toBe(4)
        expect((await table.get("archive"))?.csize).toBe(7)
        expect((await table.get("pkg"))?.ctotal).toBe(3)
        expect((await table.get("pkg"))?.csize).toBe(7)
    })

    test("updateOnly 多 parentId 批次应先过滤缺失节点，不应因缺失节点的父级不存在而失败", async () => {
        const table = await createDefinedTreeTable("update-only-multi-parent-filter-missing")

        await table.setNodes(
            [
                { id: "left", name: "left", isDir: true, parentId: "/" },
                { id: "right", name: "right", isDir: true, parentId: "/" },
                { id: "left-file", name: "left.txt", isDir: false, size: 1, parentId: "left", tag: "old" },
            ],
            { index: { toEnd: true } },
        )

        const result = await table.setNodes(
            [
                { id: "left-file", name: "left-new.txt", isDir: false, size: 4, parentId: "right", tag: "moved" },
                { id: "missing-file", name: "missing.txt", isDir: false, size: 8, parentId: "missing-parent" },
            ],
            { updateOnly: true, returnChangedNodesIds: true, index: { toEnd: true } },
        )

        expect(result.changedNodeIds).toEqual(["left-file"])
        expect((await table.get("left-file"))?.parentId).toBe("right")
        expect((await table.get("left-file"))?.tag).toBe("moved")
        expect(await table.get("missing-file", { ignoreMarkDelete: true })).toBeUndefined()
        expect((await table.get("left"))?.ctotal ?? 0).toBe(0)
        expect((await table.get("right"))?.ctotal).toBe(1)
        expect((await table.get("right"))?.csize).toBe(4)
    })

    test("updateOnly 多 parentId 批次应忽略重复 ID 的缺失节点而不是误判为非法树", async () => {
        const table = await createDefinedTreeTable("update-only-ignore-missing-duplicate-id")

        await table.setNodes(
            [
                { id: "left", name: "left", isDir: true, parentId: "/" },
                { id: "right", name: "right", isDir: true, parentId: "/" },
                { id: "exists", name: "exists.txt", isDir: false, size: 1, parentId: "left" },
            ],
            { index: { toEnd: true } },
        )

        const result = await table.setNodes(
            [
                { id: "missing-same", name: "missing-left.txt", isDir: false, size: 2, parentId: "left" },
                { id: "missing-same", name: "missing-right.txt", isDir: false, size: 3, parentId: "right" },
                { id: "exists", name: "exists-new.txt", isDir: false, size: 4, parentId: "right" },
            ],
            { updateOnly: true, returnChangedNodesIds: true },
        )

        expect(result.changedNodeIds).toEqual(["exists"])
        expect(await table.get("missing-same", { ignoreMarkDelete: true })).toBeUndefined()
        expect((await table.get("exists"))?.parentId).toBe("right")
        expect((await table.get("exists"))?.name).toBe("exists-new.txt")
        expect((await table.get("left"))?.ctotal ?? 0).toBe(0)
        expect((await table.get("right"))?.ctotal).toBe(1)
    })

    test("同一批次移动已有目录到本批次新建的后代节点下应被拒绝且不写入新节点", async () => {
        const table = await createDefinedTreeTable("batch-move-existing-dir-under-new-descendant")

        await table.setNodes(
            [
                { id: "root-dir", name: "root", isDir: true, parentId: "/" },
                { id: "old-child", name: "old.txt", isDir: false, size: 1, parentId: "root-dir" },
            ],
            { index: { toEnd: true } },
        )

        await expect(
            table.setNodes([
                { id: "root-dir", name: "root", isDir: true, parentId: "new-child" },
                { id: "new-child", name: "new-child", isDir: true, parentId: "root-dir" },
                { id: "new-file", name: "new.txt", isDir: false, size: 2, parentId: "new-child" },
            ]),
        ).rejects.toThrow("循环父级")

        expect((await table.get("root-dir"))?.parentId).toBe("/")
        expect((await table.get("old-child"))?.parentId).toBe("root-dir")
        expect(await table.get("new-child", { ignoreMarkDelete: true })).toBeUndefined()
        expect(await table.get("new-file", { ignoreMarkDelete: true })).toBeUndefined()
        expect((await table.get("root-dir"))?.ctotal).toBe(1)
        expect((await table.get("root-dir"))?.csize).toBe(1)
    })

    test("同一批次多个 parentId 使用无效排序锚点时应整体失败且不写入其它父级节点", async () => {
        const table = await createDefinedTreeTable("batch-multi-parent-invalid-index-anchor")

        await table.setNodes(
            [
                { id: "left", name: "left", isDir: true, parentId: "/" },
                { id: "right", name: "right", isDir: true, parentId: "/" },
                { id: "left-anchor", name: "left.txt", isDir: false, parentId: "left" },
                { id: "right-anchor", name: "right.txt", isDir: false, parentId: "right" },
            ],
            { index: { toEnd: true } },
        )

        await expect(
            table.setNodes(
                [
                    { id: "left-new", name: "new-left.txt", isDir: false, parentId: "left" },
                    { id: "right-new", name: "new-right.txt", isDir: false, parentId: "right" },
                ],
                { index: { prevNodeId: "left-anchor" } },
            ),
        ).rejects.toThrow("排序参考节点不属于目标父级")

        expect(await table.get("left-new", { ignoreMarkDelete: true })).toBeUndefined()
        expect(await table.get("right-new", { ignoreMarkDelete: true })).toBeUndefined()
        expect(await listChildIds(table, "left")).toEqual(["left-anchor"])
        expect(await listChildIds(table, "right")).toEqual(["right-anchor"])
    })

    test("replace 复用目标目录后若后续 index 校验失败不应提前删除目标旧子树", async () => {
        const table = await createDefinedTreeTable("replace-dir-invalid-index-atomic")

        await table.setNodes(
            [
                { id: "left", name: "left", isDir: true, parentId: "/" },
                { id: "right", name: "right", isDir: true, parentId: "/" },
                { id: "left-anchor", name: "left-anchor.txt", isDir: false, parentId: "left" },
                { id: "target", name: "pkg", isDir: true, parentId: "right", tag: "old" },
                { id: "old-child", name: "old.ts", isDir: false, size: 3, parentId: "target" },
                { id: "old-sub", name: "old-sub", isDir: true, parentId: "target" },
                { id: "old-deep", name: "deep.ts", isDir: false, size: 5, parentId: "old-sub" },
            ],
            { index: { toEnd: true } },
        )

        await expect(
            table.setNodes(
                [
                    { id: "incoming", name: "pkg", isDir: true, parentId: "right", tag: "new" },
                    { id: "incoming-child", name: "new.ts", isDir: false, size: 7, parentId: "incoming" },
                ],
                { uniqueBy: "name", overwriteMode: "replace", index: { prevNodeId: "left-anchor" } },
            ),
        ).rejects.toThrow("排序参考节点不属于目标父级")

        expect(await table.get("incoming", { ignoreMarkDelete: true })).toBeUndefined()
        expect(await table.get("incoming-child", { ignoreMarkDelete: true })).toBeUndefined()
        expect((await table.get("target"))?.tag).toBe("old")
        expect((await table.get("old-child"))?.parentId).toBe("target")
        expect((await table.get("old-sub"))?.parentId).toBe("target")
        expect((await table.get("old-deep"))?.parentId).toBe("old-sub")
        expect(await listChildIds(table, "target")).toEqual(["old-child", "old-sub"])
        expect((await table.get("target"))?.ctotal).toBe(3)
        expect((await table.get("target"))?.csize).toBe(8)
    })

    test("应该拒绝不存在的父级和非法节点名称", async () => {
        const table = await createDefinedTreeTable("guard")

        await expect(
            table.setNodes([{ id: "missing", parentId: "missing-parent", name: "x", isDir: false }]),
        ).rejects.toThrow("父节点不存在")
        await expect(table.setNodes([{ id: "bad", parentId: "/", name: "bad/name", isDir: false }])).rejects.toThrow(
            "/",
        )
        await expect(table.setNodes([{ id: "bad-type", parentId: "/", name: "bad", isDir: null as any }])).rejects.toThrow(
            "isDir",
        )
        await expect(table.setNodes([{ id: "bad-size", parentId: "/", name: "bad", isDir: false, size: -1 }])).rejects.toThrow(
            "size",
        )
    })

    test("更新已有目录父级时应拒绝移动到自己或后代下面", async () => {
        const table = await createDefinedTreeTable("guard-cycle-parent")

        await table.createNodes([{ id: "dir", name: "目录", isDir: true }], "/")
        await table.createNodes([{ id: "child", name: "子目录", isDir: true }], "dir")

        await expect(
            table.setNodes([{ id: "dir", parentId: "dir", name: "目录", isDir: true }]),
        ).rejects.toThrow()
        await expect(
            table.setNodes([{ id: "dir", parentId: "child", name: "目录", isDir: true }]),
        ).rejects.toThrow()
        expect((await table.get("dir"))?.parentId).toBe("/")
        expect((await table.get("child"))?.parentId).toBe("dir")
    })

    test("同一批次先移出后代再把祖先挂到该后代下时应按最终树判断为合法", async () => {
        const table = await createDefinedTreeTable("batch-swap-ancestor-descendant")

        await table.setNodes(
            [
                { id: "parent", name: "parent", isDir: true, parentId: "/" },
                { id: "child", name: "child", isDir: true, parentId: "parent" },
                { id: "parent-file", name: "parent.txt", isDir: false, size: 2, parentId: "parent" },
                { id: "child-file", name: "child.txt", isDir: false, size: 3, parentId: "child" },
            ],
            { index: { toEnd: true } },
        )

        await table.setNodes(
            [
                { id: "child", name: "child", isDir: true, parentId: "/" },
                { id: "parent", name: "parent", isDir: true, parentId: "child" },
            ],
            { index: { toEnd: true } },
        )

        expect((await table.get("child"))?.parentId).toBe("/")
        expect((await table.get("parent"))?.parentId).toBe("child")
        expect((await table.get("parent-file"))?.parentId).toBe("parent")
        expect((await table.get("child-file"))?.parentId).toBe("child")
        expect(await listChildIds(table, "/")).toEqual(["child"])
        expect(await listChildIds(table, "child")).toEqual(["child-file", "parent"])
        expect((await table.get("child"))?.ctotal).toBe(3)
        expect((await table.get("child"))?.csize).toBe(5)
        expect((await table.get("parent"))?.ctotal).toBe(1)
        expect((await table.get("parent"))?.csize).toBe(2)
    })

    test("同一批次新建节点时应拒绝形成循环父级关系", async () => {
        const table = await createDefinedTreeTable("guard-batch-cycle-parent")

        await expect(
            table.setNodes([
                { id: "a", parentId: "b", name: "a", isDir: true },
                { id: "b", parentId: "a", name: "b", isDir: true },
            ]),
        ).rejects.toThrow()
        expect(await table.get("a", { ignoreMarkDelete: true })).toBeUndefined()
        expect(await table.get("b", { ignoreMarkDelete: true })).toBeUndefined()
    })

    test("默认 setMode 应浅合并已有节点字段", async () => {
        const table = await createDefinedTreeTable("set-mode-default")

        await table.createNodes(
            [{ id: "node", name: "node", isDir: false, tag: "keep", meta: { old: true, nested: { a: 1 } } }],
            "/",
        )
        await table.setNodes([{ id: "node", parentId: "/", name: "node", isDir: false, meta: { next: true } }])

        const node = await table.get("node")
        expect(node?.tag).toBe("keep")
        expect(node?.meta).toEqual({ next: true })
    })

    test("setMode overwrite 应整体替换已有节点字段", async () => {
        const table = await createDefinedTreeTable("set-mode-overwrite")

        await table.createNodes([{ id: "node", name: "node", isDir: false, tag: "old", meta: { keep: true } }], "/")
        await table.setNodes([{ id: "node", parentId: "/", name: "node", isDir: false }], { setMode: "overwrite" })

        const node = await table.get("node")
        expect(node?.tag).toBeUndefined()
        expect(node?.meta).toBeUndefined()
        expect(node?.parentId).toBe("/")
        expect(node?.name).toBe("node")
    })

    test("setMode overwrite 覆盖已有目录时不应丢失目录自身 metadata", async () => {
        const table = await createDefinedTreeTable("set-mode-overwrite-dir-metadata")

        await table.setNodes(
            [
                { id: "dir", name: "dir", isDir: true, parentId: "/", tag: "old", meta: { keep: true } },
                { id: "child", name: "child.txt", isDir: false, size: 4, parentId: "dir" },
                { id: "sub", name: "sub", isDir: true, parentId: "dir" },
                { id: "deep", name: "deep.txt", isDir: false, size: 6, parentId: "sub" },
            ],
            { index: { toEnd: true } },
        )

        await table.setNodes(
            [{ id: "dir", name: "dir-new", isDir: true, parentId: "/", tag: "new" }],
            { setMode: "overwrite" },
        )

        const dir = await table.get("dir")
        expect(dir?.name).toBe("dir-new")
        expect(dir?.tag).toBe("new")
        expect(dir?.meta).toBeUndefined()
        expect(dir?.ctotal).toBe(3)
        expect(dir?.cftotal).toBe(2)
        expect(dir?.csize).toBe(10)
        expect(await listChildIds(table, "dir")).toEqual(["child", "sub"])
    })

    test("更新已有目录自身字段时不应把目录 cmodif 当作子树变更推进", async () => {
        const table = await createDefinedTreeTable("update-dir-own-field-keep-cmodif")

        await table.setNodes(
            [
                { id: "dir", name: "dir", isDir: true, parentId: "/", tag: "old" },
                { id: "child", name: "child.txt", isDir: false, size: 4, parentId: "dir" },
            ],
            { index: { toEnd: true } },
        )
        const before = await table.get("dir")

        await table.setNodes([{ id: "dir", name: "dir", isDir: true, parentId: "/", tag: "new" }])

        const after = await table.get("dir")
        expect(after?.tag).toBe("new")
        expect(after?.ctotal).toBe(1)
        expect(after?.csize).toBe(4)
        expect(after?.modif).toBeGreaterThanOrEqual(before!.modif)
        expect(after?.cmodif).toBe(before?.cmodif)
    })

    test("setMode merge 应深度合并已有节点字段", async () => {
        const table = await createDefinedTreeTable("set-mode-merge")

        await table.createNodes(
            [{ id: "node", name: "node", isDir: false, meta: { keep: true, nested: { a: 1 } } }],
            "/",
        )
        await table.setNodes([{ id: "node", parentId: "/", name: "node", isDir: false, meta: { nested: { b: 2 } } }], {
            setMode: "merge",
        })

        expect((await table.get("node"))?.meta).toEqual({
            keep: true,
            nested: { a: 1, b: 2 },
        })
    })

    test("updateOnly 应只更新已有节点且不创建缺失节点", async () => {
        const table = await createDefinedTreeTable("update-only")

        await table.createNodes([{ id: "exists", name: "exists.txt", isDir: false, tag: "old" }], "/")
        const result = await table.setNodes(
            [
                { id: "exists", parentId: "/", name: "exists.txt", isDir: false, tag: "new" },
                { id: "missing", parentId: "/", name: "missing.txt", isDir: false },
            ],
            { updateOnly: true, returnChangedNodesIds: true },
        )

        expect(result.changedNodeIds).toEqual(["exists"])
        expect((await table.get("exists"))?.tag).toBe("new")
        expect(await table.get("missing")).toBeUndefined()
    })

    test("updateOnly 完全没有实际写入时不应返回变更时间", async () => {
        const table = await createDefinedTreeTable("update-only-no-change")

        const result = await table.setNodes(
            [{ id: "missing", parentId: "/", name: "missing.txt", isDir: false }],
            { updateOnly: true, returnChangedNodesIds: true },
        )

        expect(result).toEqual({ changedNodeIds: [] })
        expect(await table.get("missing")).toBeUndefined()
    })

    test("updateOnly 不应把已标记删除的同 ID 节点恢复为可见节点", async () => {
        const table = await createDefinedTreeTable("update-only-skip-mark-deleted")

        await table.createNodes([{ id: "deleted", name: "old.txt", isDir: false, size: 1, tag: "old" }], "/")
        await table.deleteNodes(["deleted"])

        const result = await table.setNodes(
            [{ id: "deleted", parentId: "/", name: "new.txt", isDir: false, size: 5, tag: "new" }],
            { updateOnly: true, returnChangedNodesIds: true },
        )

        expect(result.changedNodeIds).toEqual([])
        expect(await table.get("deleted")).toBeUndefined()
        expect((await table.get("deleted", { ignoreMarkDelete: true }))?.tag).toBe("old")
    })

    test("写入已标记删除的同 ID 节点时应恢复为可见节点并更新父级统计", async () => {
        const table = await createDefinedTreeTable("restore-mark-deleted-same-id")

        await table.createNodes([{ id: "node", name: "old.txt", isDir: false, size: 1, tag: "old" }], "/")
        await table.deleteNodes(["node"])

        await table.setNodes([{ id: "node", parentId: "/", name: "new.txt", isDir: false, size: 5, tag: "new" }])

        const node = await table.get("node")
        expect(node?.name).toBe("new.txt")
        expect(node?.tag).toBe("new")
        expect((node as any)?._isDeleted).toBeUndefined()
    })

    test("同一批次多个 parentId 恢复已删除父级并写入新子树时不应恢复旧删除后代", async () => {
        const table = await createDefinedTreeTable("restore-deleted-parent-with-new-children")

        await table.setNodes(
            [
                { id: "workspace", parentId: "/", name: "workspace", isDir: true },
                { id: "archive", parentId: "/", name: "archive", isDir: true },
                { id: "deleted-dir", parentId: "workspace", name: "pkg", isDir: true },
                { id: "deleted-old-file", parentId: "deleted-dir", name: "old.ts", isDir: false, size: 2 },
            ],
            { index: { toEnd: true } },
        )
        await table.deleteNodes(["deleted-dir"])

        await table.setNodes(
            [
                { id: "deleted-dir", parentId: "archive", name: "pkg", isDir: true, tag: "restored" },
                { id: "new-dir", parentId: "deleted-dir", name: "src", isDir: true },
                { id: "new-file", parentId: "new-dir", name: "index.ts", isDir: false, size: 5 },
                { id: "workspace-note", parentId: "workspace", name: "note.md", isDir: false, size: 3 },
            ],
            { index: { toEnd: true } },
        )

        expect((await table.get("deleted-dir"))?.parentId).toBe("archive")
        expect((await table.get("deleted-dir"))?.tag).toBe("restored")
        expect(await table.get("deleted-old-file")).toBeUndefined()
        expect((await table.get("deleted-old-file", { ignoreMarkDelete: true }) as any)?._isDeleted).toBe(true)
        expect(await listChildIds(table, "deleted-dir")).toEqual(["new-dir"])
        expect((await table.get("deleted-dir"))?.ctotal).toBe(2)
        expect((await table.get("deleted-dir"))?.csize).toBe(5)
        expect((await table.get("archive"))?.ctotal).toBe(3)
        expect((await table.get("archive"))?.csize).toBe(5)
        expect((await table.get("workspace"))?.ctotal).toBe(1)
        expect((await table.get("workspace"))?.csize).toBe(3)
    })

    test("同一批次多个 parentId 引用已删除且未恢复的父级时应整体失败", async () => {
        const table = await createDefinedTreeTable("missing-deleted-parent-atomic")

        await table.setNodes(
            [
                { id: "visible", parentId: "/", name: "visible", isDir: true },
                { id: "deleted-parent", parentId: "/", name: "deleted", isDir: true },
            ],
            { index: { toEnd: true } },
        )
        await table.deleteNodes(["deleted-parent"])

        await expect(
            table.setNodes([
                { id: "valid-child", parentId: "visible", name: "valid.txt", isDir: false, size: 1 },
                { id: "invalid-child", parentId: "deleted-parent", name: "invalid.txt", isDir: false, size: 2 },
            ]),
        ).rejects.toThrow("父节点不存在")

        expect(await table.get("valid-child", { ignoreMarkDelete: true })).toBeUndefined()
        expect(await table.get("invalid-child", { ignoreMarkDelete: true })).toBeUndefined()
        expect((await table.get("visible"))?.ctotal ?? 0).toBe(0)
        expect(await table.get("deleted-parent")).toBeUndefined()
    })

    test("replace 覆盖策略应命中冲突节点并保留目标节点 ID", async () => {
        const table = await createDefinedTreeTable("replace")

        await table.createNodes([{ id: "old", name: "same.txt", isDir: false, tag: "old" }], "/")
        const result = await table.setNodes(
            [{ id: "incoming", parentId: "/", name: "same.txt", isDir: false, tag: "new" }],
            { uniqueBy: "name", overwriteMode: "replace", returnChangedNodesIds: true },
        )

        expect(result.changedNodeIds).toEqual(["old"])
        expect((await table.get("old"))?.tag).toBe("new")
        expect(await table.get("incoming")).toBeUndefined()
    })

    test("replace 覆盖策略应处理批次内部同名冲突并只保留最后一个写入节点", async () => {
        const table = await createDefinedTreeTable("replace-batch-conflict")

        await table.setNodes(
            [
                { id: "first", parentId: "/", name: "same.txt", isDir: false, tag: "first" },
                { id: "last", parentId: "/", name: "same.txt", isDir: false, tag: "last" },
            ],
            { uniqueBy: "name", overwriteMode: "replace", returnChangedNodesIds: true },
        )

        const activeNodes = await table.findMany({ parentId: "/", name: "same.txt" })
        expect(activeNodes).toHaveLength(1)
        expect(activeNodes[0].id).toBe("last")
        expect(activeNodes[0].tag).toBe("last")
        expect(await table.get("first")).toBeUndefined()
    })

    test("replace 覆盖策略在多个 parentId 中应只处理同一父级内的同名冲突", async () => {
        const table = await createDefinedTreeTable("replace-batch-conflict-by-parent")

        await table.setNodes(
            [
                { id: "left", parentId: "/", name: "left", isDir: true },
                { id: "right", parentId: "/", name: "right", isDir: true },
                { id: "left-old", parentId: "left", name: "same.txt", isDir: false, size: 1, tag: "left-old" },
                { id: "right-old", parentId: "right", name: "same.txt", isDir: false, size: 2, tag: "right-old" },
            ],
            { index: { toEnd: true } },
        )

        await table.setNodes(
            [
                { id: "left-new-a", parentId: "left", name: "same.txt", isDir: false, size: 3, tag: "left-a" },
                { id: "left-new-b", parentId: "left", name: "same.txt", isDir: false, size: 4, tag: "left-b" },
                { id: "right-new", parentId: "right", name: "same.txt", isDir: false, size: 5, tag: "right-new" },
            ],
            { uniqueBy: "name", overwriteMode: "replace", index: { toEnd: true } },
        )

        const leftNodes = await table.findMany({ parentId: "left", name: "same.txt" })
        const rightNodes = await table.findMany({ parentId: "right", name: "same.txt" })
        expect(leftNodes).toHaveLength(1)
        expect(rightNodes).toHaveLength(1)
        expect(leftNodes[0].id).toBe("left-old")
        expect(leftNodes[0].tag).toBe("left-b")
        expect(rightNodes[0].id).toBe("right-old")
        expect(rightNodes[0].tag).toBe("right-new")
        expect(await table.get("left-new-a")).toBeUndefined()
        expect(await table.get("left-new-b")).toBeUndefined()
        expect(await table.get("right-new")).toBeUndefined()
        expect((await table.get("left"))?.ctotal).toBe(1)
        expect((await table.get("left"))?.csize).toBe(4)
        expect((await table.get("right"))?.ctotal).toBe(1)
        expect((await table.get("right"))?.csize).toBe(5)
    })

    test("replace 覆盖策略处理批次内部同名目录冲突时应跳过被替换目录的整棵子树", async () => {
        const table = await createDefinedTreeTable("replace-batch-dir-conflict-children")

        await table.createNodes([{ id: "root", name: "根", isDir: true }], "/")
        await table.setNodes(
            [
                { id: "dir-a", parentId: "root", name: "same", isDir: true, tag: "first" },
                { id: "a-file", parentId: "dir-a", name: "first.txt", isDir: false, size: 1 },
                { id: "dir-b", parentId: "root", name: "same", isDir: true, tag: "second" },
                { id: "b-file", parentId: "dir-b", name: "second.txt", isDir: false, size: 2 },
                { id: "b-sub", parentId: "dir-b", name: "sub", isDir: true },
                { id: "b-deep", parentId: "b-sub", name: "deep.txt", isDir: false, size: 3 },
            ],
            { uniqueBy: "name", overwriteMode: "replace", index: { toEnd: true } },
        )

        expect(await table.get("dir-a")).toBeUndefined()
        expect(await table.get("a-file")).toBeUndefined()
        expect((await table.get("dir-b"))?.parentId).toBe("root")
        expect((await table.get("b-file"))?.parentId).toBe("dir-b")
        expect((await table.get("b-deep"))?.parentId).toBe("b-sub")
        expect(await listChildIds(table, "root")).toEqual(["dir-b"])
        expect((await table.get("dir-b"))?.ctotal).toBe(3)
        expect((await table.get("dir-b"))?.csize).toBe(5)
    })

    test("replace 覆盖策略同时遇到已有目标和批次内部冲突时应复用已有目标 ID", async () => {
        const table = await createDefinedTreeTable("replace-existing-and-batch-conflict")

        await table.createNodes([{ id: "old", name: "same.txt", isDir: false, tag: "old" }], "/")
        await table.setNodes(
            [
                { id: "incoming-a", parentId: "/", name: "same.txt", isDir: false, tag: "incoming-a" },
                { id: "incoming-b", parentId: "/", name: "same.txt", isDir: false, tag: "incoming-b" },
            ],
            { uniqueBy: "name", overwriteMode: "replace" },
        )

        const activeNodes = await table.findMany({ parentId: "/", name: "same.txt" })
        expect(activeNodes).toHaveLength(1)
        expect((await table.get("old"))?.tag).toBe("incoming-b")
        expect(await table.get("incoming-a")).toBeUndefined()
        expect(await table.get("incoming-b")).toBeUndefined()
    })

    test("replace 覆盖同名目录并复用目标 ID 时应递归删除目标目录原有子树", async () => {
        const table = await createDefinedTreeTable("replace-dir-clean-children")

        await table.createNodes([{ id: "dir", name: "same", isDir: true, tag: "old" }], "/")
        await table.createNodes([{ id: "old-child", name: "old-child.txt", isDir: false, size: 3 }], "dir")
        await table.createNodes([{ id: "old-deep-dir", name: "old-deep", isDir: true }], "dir")
        await table.createNodes([{ id: "old-deep-file", name: "old-deep.txt", isDir: false, size: 5 }], "old-deep-dir")

        const result = await table.setNodes(
            [{ id: "incoming", parentId: "/", name: "same", isDir: true, tag: "new" }],
            { uniqueBy: "name", overwriteMode: "replace", returnChangedNodesIds: true },
        )

        expect(result.changedNodeIds).toEqual(expect.arrayContaining(["dir", "old-child", "old-deep-dir", "old-deep-file"]))
        expect((await table.get("dir"))?.tag).toBe("new")
        expect(await table.get("incoming")).toBeUndefined()
        expect(await table.get("old-child")).toBeUndefined()
        expect(await table.get("old-deep-dir")).toBeUndefined()
        expect(await table.get("old-deep-file")).toBeUndefined()
        expect((await table.get("dir"))?.ctotal ?? 0).toBe(0)
    })

    test("replace 覆盖同名目录并复用目标 ID 时应将本批次来源子节点改挂到目标目录下", async () => {
        const table = await createDefinedTreeTable("replace-dir-reparent-incoming-children")

        await table.createNodes([{ id: "target", name: "same", isDir: true, tag: "old" }], "/")
        await table.createNodes([{ id: "old-child", name: "old.txt", isDir: false, size: 2 }], "target")

        await table.setNodes(
            [
                { id: "incoming", parentId: "/", name: "same", isDir: true, tag: "new" },
                { id: "incoming-child", parentId: "incoming", name: "new.txt", isDir: false, size: 5 },
                { id: "incoming-dir", parentId: "incoming", name: "sub", isDir: true },
                { id: "incoming-deep", parentId: "incoming-dir", name: "deep.txt", isDir: false, size: 7 },
            ],
            { uniqueBy: "name", overwriteMode: "replace" },
        )

        expect(await table.get("incoming")).toBeUndefined()
        expect((await table.get("target"))?.tag).toBe("new")
        expect((await table.get("incoming-child"))?.parentId).toBe("target")
        expect((await table.get("incoming-dir"))?.parentId).toBe("target")
        expect((await table.get("incoming-deep"))?.parentId).toBe("incoming-dir")
        expect(await table.get("old-child")).toBeUndefined()
        expect((await table.get("target"))?.ctotal).toBe(3)
        expect((await table.get("target"))?.csize).toBe(12)
    })

    test("replace 清理目标旧子树时不应删除本批次会重写的同 ID 子节点", async () => {
        const table = await createDefinedTreeTable("replace-dir-keep-overwritten-child")

        await table.createNodes([{ id: "target", name: "same", isDir: true, tag: "old" }], "/")
        await table.createNodes([{ id: "child", name: "old-child.txt", isDir: false, size: 2, tag: "old-child" }], "target")
        await table.createNodes([{ id: "stale", name: "stale.txt", isDir: false, size: 3 }], "target")

        await table.setNodes(
            [
                { id: "incoming", parentId: "/", name: "same", isDir: true, tag: "new" },
                { id: "child", parentId: "incoming", name: "new-child.txt", isDir: false, size: 5, tag: "new-child" },
            ],
            { uniqueBy: "name", overwriteMode: "replace" },
        )

        const child = await table.get("child")
        expect(child?.parentId).toBe("target")
        expect(child?.name).toBe("new-child.txt")
        expect(child?.tag).toBe("new-child")
        expect((child as any)?._isDeleted).toBeUndefined()
        expect(await table.get("stale")).toBeUndefined()
        expect((await table.get("target"))?.ctotal).toBe(1)
        expect((await table.get("target"))?.csize).toBe(5)
    })

    test("skip 覆盖策略应跳过冲突节点", async () => {
        const table = await createDefinedTreeTable("skip")

        await table.createNodes([{ id: "old", name: "same.txt", isDir: false, tag: "old" }], "/")
        const result = await table.setNodes(
            [{ id: "incoming", parentId: "/", name: "same.txt", isDir: false, tag: "new" }],
            { uniqueBy: "name", overwriteMode: "skip", returnChangedNodesIds: true },
        )

        expect(result.changedNodeIds).toEqual([])
        expect((await table.get("old"))?.tag).toBe("old")
        expect(await table.get("incoming")).toBeUndefined()
    })

    test("skip 覆盖策略在多个 parentId 中跳过冲突目录时也应跳过它的批次子树", async () => {
        const table = await createDefinedTreeTable("skip-conflict-dir-with-batch-subtree")

        await table.setNodes(
            [
                { id: "left", parentId: "/", name: "left", isDir: true },
                { id: "right", parentId: "/", name: "right", isDir: true },
                { id: "left-target", parentId: "left", name: "pkg", isDir: true, tag: "old" },
                { id: "left-old", parentId: "left-target", name: "old.ts", isDir: false, size: 1 },
            ],
            { index: { toEnd: true } },
        )

        await table.setNodes(
            [
                { id: "left-source", parentId: "left", name: "pkg", isDir: true, tag: "source" },
                { id: "left-source-child", parentId: "left-source", name: "new.ts", isDir: false, size: 5 },
                { id: "right-new", parentId: "right", name: "right.txt", isDir: false, size: 7 },
            ],
            { uniqueBy: "name", overwriteMode: "skip", index: { toEnd: true } },
        )

        expect(await table.get("left-source", { ignoreMarkDelete: true })).toBeUndefined()
        expect(await table.get("left-source-child", { ignoreMarkDelete: true })).toBeUndefined()
        expect((await table.get("left-target"))?.tag).toBe("old")
        expect(await listChildIds(table, "left-target")).toEqual(["left-old"])
        expect((await table.get("right-new"))?.parentId).toBe("right")
        expect((await table.get("left"))?.ctotal).toBe(2)
        expect((await table.get("left"))?.csize).toBe(1)
        expect((await table.get("right"))?.ctotal).toBe(1)
        expect((await table.get("right"))?.csize).toBe(7)
    })

    test("newName 覆盖策略应为冲突文件名自动递增后缀", async () => {
        const table = await createDefinedTreeTable("new-name")

        await table.createNodes(
            [
                { id: "old", name: "文件.txt", isDir: false },
                { id: "old-1", name: "文件 (1).txt", isDir: false },
            ],
            "/",
        )
        await table.setNodes([{ id: "incoming", parentId: "/", name: "文件.txt", isDir: false }], {
            uniqueBy: "name",
            overwriteMode: "newName",
        })

        expect((await table.get("incoming"))?.name).toBe("文件 (2).txt")
    })

    test("newName 覆盖策略应处理批次内部重名并生成互不冲突的名称", async () => {
        const table = await createDefinedTreeTable("new-name-batch-conflict")

        await table.setNodes(
            [
                { id: "file-a", parentId: "/", name: "文件.txt", isDir: false },
                { id: "file-b", parentId: "/", name: "文件.txt", isDir: false },
            ],
            { uniqueBy: "name", overwriteMode: "newName" },
        )

        const names = (await table.findMany({ parentId: "/" }, { sort: { name: 1 } })).map((node) => node.name)
        expect(names).toEqual(["文件 (1).txt", "文件.txt"])
    })

    test("newName 覆盖策略在多个 parentId 中应分别按各自父级生成不冲突名称", async () => {
        const table = await createDefinedTreeTable("new-name-multi-parent")

        await table.setNodes(
            [
                { id: "left", parentId: "/", name: "left", isDir: true },
                { id: "right", parentId: "/", name: "right", isDir: true },
                { id: "left-old", parentId: "left", name: "note.md", isDir: false },
                { id: "right-old", parentId: "right", name: "note.md", isDir: false },
                { id: "right-old-1", parentId: "right", name: "note (1).md", isDir: false },
            ],
            { index: { toEnd: true } },
        )

        await table.setNodes(
            [
                { id: "left-new", parentId: "left", name: "note.md", isDir: false },
                { id: "right-new", parentId: "right", name: "note.md", isDir: false },
            ],
            { uniqueBy: "name", overwriteMode: "newName", index: { toEnd: true } },
        )

        expect((await table.get("left-new"))?.name).toBe("note (1).md")
        expect((await table.get("right-new"))?.name).toBe("note (2).md")
        expect((await listChildIds(table, "left"))).toEqual(["left-old", "left-new"])
        expect((await listChildIds(table, "right"))).toEqual(["right-old", "right-old-1", "right-new"])
    })

    test("merge 覆盖策略应递归合并目录子节点", async () => {
        const table = await createDefinedTreeTable("merge")

        await table.createNodes([{ id: "target", name: "src", isDir: true, tag: "old" }], "/")
        await table.createNodes([{ id: "old-file", name: "old.ts", isDir: false, size: 3 }], "target")
        await table.setNodes(
            [
                { id: "incoming", parentId: "/", name: "src", isDir: true, tag: "new" },
                { id: "incoming-file", parentId: "incoming", name: "index.ts", isDir: false, size: 9 },
            ],
            { uniqueBy: "name", overwriteMode: "merge" },
        )

        expect(await table.get("incoming")).toBeUndefined()
        expect((await table.get("target"))?.tag).toBe("new")
        expect((await table.get("incoming-file"))?.parentId).toBe("target")
        expect((await table.get("target"))?.ctotal).toBe(2)
        expect((await table.get("target"))?.csize).toBe(12)
    })

    test("merge 覆盖策略应支持局部更新已有源目录并迁移数据库中的子节点", async () => {
        const table = await createDefinedTreeTable("merge-existing-source-partial")

        await table.createNodes([{ id: "src", name: "src", isDir: true, tag: "source" }], "/")
        await table.createNodes([{ id: "source-file", name: "source.txt", isDir: false, size: 7 }], "src")
        await table.createNodes([{ id: "target", name: "target", isDir: true, tag: "target" }], "/")
        await table.createNodes([{ id: "target-file", name: "target.txt", isDir: false, size: 5 }], "target")

        await table.setNodes([{ id: "src", parentId: "/", name: "target", tag: "source-new" }], {
            uniqueBy: "name",
            overwriteMode: "merge",
        })

        expect(await table.get("src")).toBeUndefined()
        expect((await table.get("source-file"))?.parentId).toBe("target")
        expect((await table.get("target"))?.tag).toBe("source-new")
        expect((await table.get("target"))?.isDir).toBe(true)
        expect((await table.get("target"))?.ctotal).toBe(2)
        expect((await table.get("target"))?.csize).toBe(12)
    })

    test("merge 覆盖策略应同时迁移数据库子节点和本次传入的新增子节点", async () => {
        const table = await createDefinedTreeTable("merge-db-and-incoming-children")

        await table.createNodes([{ id: "src", name: "src", isDir: true }], "/")
        await table.createNodes([{ id: "db-child", name: "db.txt", isDir: false, size: 3 }], "src")
        await table.createNodes([{ id: "target", name: "target", isDir: true }], "/")

        await table.setNodes(
            [
                { id: "src", parentId: "/", name: "target" },
                { id: "incoming-child", parentId: "src", name: "incoming.txt", isDir: false, size: 4 },
            ],
            { uniqueBy: "name", overwriteMode: "merge" },
        )

        expect(await table.get("src")).toBeUndefined()
        expect((await table.get("db-child"))?.parentId).toBe("target")
        expect((await table.get("incoming-child"))?.parentId).toBe("target")
        expect((await table.get("target"))?.ctotal).toBe(2)
        expect((await table.get("target"))?.csize).toBe(7)
    })

    test("merge 覆盖策略递归合并本批次多层同名目录时应把孙节点挂到最终目标目录", async () => {
        const table = await createDefinedTreeTable("merge-nested-incoming-dir-conflict")

        await table.setNodes(
            [
                { id: "target", parentId: "/", name: "pkg", isDir: true, tag: "target" },
                { id: "target-sub", parentId: "target", name: "src", isDir: true, tag: "target-sub" },
                { id: "target-old", parentId: "target-sub", name: "old.ts", isDir: false, size: 1 },
            ],
            { index: { toEnd: true } },
        )

        await table.setNodes(
            [
                { id: "incoming", parentId: "/", name: "pkg", isDir: true, tag: "incoming" },
                { id: "incoming-sub", parentId: "incoming", name: "src", isDir: true, tag: "incoming-sub" },
                { id: "incoming-deep", parentId: "incoming-sub", name: "deep.ts", isDir: false, size: 5 },
            ],
            { uniqueBy: "name", overwriteMode: "merge", index: { toEnd: true } },
        )

        expect(await table.get("incoming")).toBeUndefined()
        expect(await table.get("incoming-sub")).toBeUndefined()
        expect((await table.get("target"))?.tag).toBe("incoming")
        expect((await table.get("target-sub"))?.tag).toBe("incoming-sub")
        expect((await table.get("incoming-deep"))?.parentId).toBe("target-sub")
        expect(await listChildIds(table, "target-sub")).toEqual(["target-old", "incoming-deep"])
        expect((await table.get("target"))?.ctotal).toBe(3)
        expect((await table.get("target"))?.csize).toBe(6)
    })

    test("merge 覆盖策略中来源子目录覆盖目标同名文件时应复用目标 ID 并迁移来源子树", async () => {
        const table = await createDefinedTreeTable("merge-child-dir-replace-file")

        await table.setNodes(
            [
                { id: "target", parentId: "/", name: "pkg", isDir: true, tag: "target" },
                { id: "target-file", parentId: "target", name: "src", isDir: false, size: 1, tag: "old-file" },
            ],
            { index: { toEnd: true } },
        )

        await table.setNodes(
            [
                { id: "incoming", parentId: "/", name: "pkg", isDir: true, tag: "incoming" },
                { id: "incoming-dir", parentId: "incoming", name: "src", isDir: true, tag: "new-dir" },
                { id: "incoming-deep", parentId: "incoming-dir", name: "index.ts", isDir: false, size: 5 },
            ],
            { uniqueBy: "name", overwriteMode: "merge", index: { toEnd: true } },
        )

        expect(await table.get("incoming")).toBeUndefined()
        expect(await table.get("incoming-dir")).toBeUndefined()
        expect((await table.get("target-file"))?.isDir).toBe(true)
        expect((await table.get("target-file"))?.tag).toBe("new-dir")
        expect((await table.get("incoming-deep"))?.parentId).toBe("target-file")
        expect(await listChildIds(table, "target")).toEqual(["target-file"])
        expect(await listChildIds(table, "target-file")).toEqual(["incoming-deep"])
        expect((await table.get("target"))?.ctotal).toBe(2)
        expect((await table.get("target"))?.csize).toBe(5)
    })

    test("merge 覆盖策略中连续多层来源目录覆盖目标文件时应持续迁移后代子树", async () => {
        const table = await createDefinedTreeTable("merge-nested-dir-replace-file-chain")

        await table.setNodes(
            [
                { id: "target", parentId: "/", name: "pkg", isDir: true, tag: "target" },
                { id: "target-src-file", parentId: "target", name: "src", isDir: false, size: 1, tag: "old-src-file" },
                { id: "target-lib-file", parentId: "target-src-file", name: "lib", isDir: false, size: 2, tag: "old-lib-file" },
            ],
            { index: { toEnd: true } },
        )

        await table.setNodes(
            [
                { id: "incoming", parentId: "/", name: "pkg", isDir: true, tag: "incoming" },
                { id: "incoming-src", parentId: "incoming", name: "src", isDir: true, tag: "new-src-dir" },
                { id: "incoming-lib", parentId: "incoming-src", name: "lib", isDir: true, tag: "new-lib-dir" },
                { id: "incoming-deep", parentId: "incoming-lib", name: "index.ts", isDir: false, size: 5 },
            ],
            { uniqueBy: "name", overwriteMode: "merge", index: { toEnd: true } },
        )

        expect(await table.get("incoming")).toBeUndefined()
        expect(await table.get("incoming-src")).toBeUndefined()
        expect(await table.get("incoming-lib")).toBeUndefined()
        expect((await table.get("target-src-file"))?.isDir).toBe(true)
        expect((await table.get("target-src-file"))?.tag).toBe("new-src-dir")
        expect((await table.get("target-lib-file"))?.isDir).toBe(true)
        expect((await table.get("target-lib-file"))?.tag).toBe("new-lib-dir")
        expect((await table.get("incoming-deep"))?.parentId).toBe("target-lib-file")
        expect(await listChildIds(table, "target")).toEqual(["target-src-file"])
        expect(await listChildIds(table, "target-src-file")).toEqual(["target-lib-file"])
        expect(await listChildIds(table, "target-lib-file")).toEqual(["incoming-deep"])
        expect((await table.get("target-src-file"))?.ctotal).toBe(2)
        expect((await table.get("target-src-file"))?.csize).toBe(5)
        expect((await table.get("target"))?.ctotal).toBe(3)
        expect((await table.get("target"))?.csize).toBe(5)
    })

    test("merge 覆盖策略中来源文件允许覆盖目标子目录时应删除目标旧子树", async () => {
        const table = await createDefinedTreeTable("merge-child-file-replace-dir")

        await table.setNodes(
            [
                { id: "target", parentId: "/", name: "pkg", isDir: true, tag: "target" },
                { id: "target-dir", parentId: "target", name: "src", isDir: true, tag: "old-dir" },
                { id: "target-old-file", parentId: "target-dir", name: "old.ts", isDir: false, size: 7 },
            ],
            { index: { toEnd: true } },
        )

        await table.setNodes(
            [
                { id: "incoming", parentId: "/", name: "pkg", isDir: true, tag: "incoming" },
                { id: "incoming-file", parentId: "incoming", name: "src", isDir: false, size: 5, tag: "new-file" },
            ],
            {
                uniqueBy: "name",
                overwriteMode: "merge",
                enableFileOverwriteDir: true,
                index: { toEnd: true },
            },
        )

        expect(await table.get("incoming")).toBeUndefined()
        expect(await table.get("incoming-file")).toBeUndefined()
        expect((await table.get("target-dir"))?.isDir).toBe(false)
        expect((await table.get("target-dir"))?.tag).toBe("new-file")
        expect((await table.get("target-dir"))?.size).toBe(5)
        expect(await table.get("target-old-file")).toBeUndefined()
        expect(await listChildIds(table, "target")).toEqual(["target-dir"])
        expect((await table.get("target"))?.ctotal).toBe(1)
        expect((await table.get("target"))?.csize).toBe(5)
    })

    test("merge 覆盖策略在多个 parentId 中应分别合并同名目录且不串线子树", async () => {
        const table = await createDefinedTreeTable("merge-multi-parent")

        await table.setNodes(
            [
                { id: "left", parentId: "/", name: "left", isDir: true },
                { id: "right", parentId: "/", name: "right", isDir: true },
                { id: "left-target", parentId: "left", name: "pkg", isDir: true, tag: "left-target" },
                { id: "left-old", parentId: "left-target", name: "old-left.ts", isDir: false, size: 1 },
                { id: "right-target", parentId: "right", name: "pkg", isDir: true, tag: "right-target" },
                { id: "right-old", parentId: "right-target", name: "old-right.ts", isDir: false, size: 2 },
            ],
            { index: { toEnd: true } },
        )

        await table.setNodes(
            [
                { id: "left-source", parentId: "left", name: "pkg", isDir: true, tag: "left-source" },
                { id: "left-new", parentId: "left-source", name: "new-left.ts", isDir: false, size: 3 },
                { id: "right-source", parentId: "right", name: "pkg", isDir: true, tag: "right-source" },
                { id: "right-new", parentId: "right-source", name: "new-right.ts", isDir: false, size: 4 },
            ],
            { uniqueBy: "name", overwriteMode: "merge", index: { toEnd: true } },
        )

        expect(await table.get("left-source")).toBeUndefined()
        expect(await table.get("right-source")).toBeUndefined()
        expect((await table.get("left-target"))?.tag).toBe("left-source")
        expect((await table.get("right-target"))?.tag).toBe("right-source")
        expect(await listChildIds(table, "left-target")).toEqual(["left-old", "left-new"])
        expect(await listChildIds(table, "right-target")).toEqual(["right-old", "right-new"])
        expect((await table.get("left"))?.csize).toBe(4)
        expect((await table.get("right"))?.csize).toBe(6)
    })

    test("mergeByModif 应保留较新的目标目录字段并继续合并子节点", async () => {
        const table = await createDefinedTreeTable("merge-by-modif-older")

        await table.createNodes([{ id: "target", name: "src", isDir: true, tag: "newer", modif: 20 }], "/")
        await table.setNodes(
            [
                { id: "incoming", parentId: "/", name: "src", isDir: true, tag: "older", modif: 10 },
                { id: "incoming-file", parentId: "incoming", name: "index.ts", isDir: false, size: 4 },
            ],
            { uniqueBy: "name", overwriteMode: "mergeByModif" },
        )

        expect((await table.get("target"))?.tag).toBe("newer")
        expect((await table.get("incoming-file"))?.parentId).toBe("target")
    })

    test("mergeByModif 应使用较新的来源目录字段覆盖目标目录", async () => {
        const table = await createDefinedTreeTable("merge-by-modif-newer")

        await table.createNodes([{ id: "target", name: "src", isDir: true, tag: "older", modif: 10 }], "/")
        await table.setNodes([{ id: "incoming", parentId: "/", name: "src", isDir: true, tag: "newer", modif: 20 }], {
            uniqueBy: "name",
            overwriteMode: "mergeByModif",
        })

        expect((await table.get("target"))?.tag).toBe("newer")
        expect((await table.get("target"))?.modif).toBe(20)
    })

    test("mergeByModif 应跳过较旧的非目录来源节点", async () => {
        const table = await createDefinedTreeTable("merge-by-modif-file")

        await table.createNodes([{ id: "target", name: "same.txt", isDir: false, tag: "newer", modif: 20 }], "/")
        await table.setNodes(
            [{ id: "incoming", parentId: "/", name: "same.txt", isDir: false, tag: "older", modif: 10 }],
            { uniqueBy: "name", overwriteMode: "mergeByModif" },
        )

        expect((await table.get("target"))?.tag).toBe("newer")
        expect(await table.get("incoming")).toBeUndefined()
    })

    test("mergeByModif 递归合并多层目录时应逐层按 modif 保留字段并继续迁移子树", async () => {
        const table = await createDefinedTreeTable("merge-by-modif-nested-mixed")

        await table.setNodes(
            [
                { id: "target", parentId: "/", name: "pkg", isDir: true, tag: "target-newer", modif: 40 },
                { id: "target-sub", parentId: "target", name: "src", isDir: true, tag: "target-sub-older", modif: 10 },
                { id: "target-old", parentId: "target-sub", name: "old.ts", isDir: false, size: 1 },
            ],
            { index: { toEnd: true } },
        )
        await table.updateNodes({ id: "target" }, { $set: { modif: 40 } })
        await table.updateNodes({ id: "target-sub" }, { $set: { modif: 10 } })

        await table.setNodes(
            [
                { id: "incoming", parentId: "/", name: "pkg", isDir: true, tag: "incoming-older", modif: 20 },
                { id: "incoming-sub", parentId: "incoming", name: "src", isDir: true, tag: "incoming-sub-newer", modif: 50 },
                { id: "incoming-new", parentId: "incoming-sub", name: "new.ts", isDir: false, size: 5 },
            ],
            { uniqueBy: "name", overwriteMode: "mergeByModif", index: { toEnd: true } },
        )

        expect(await table.get("incoming")).toBeUndefined()
        expect(await table.get("incoming-sub")).toBeUndefined()
        expect((await table.get("target"))?.tag).toBe("target-newer")
        expect((await table.get("target-sub"))?.tag).toBe("incoming-sub-newer")
        expect((await table.get("incoming-new"))?.parentId).toBe("target-sub")
        expect(await listChildIds(table, "target-sub")).toEqual(["target-old", "incoming-new"])
        expect((await table.get("target"))?.ctotal).toBe(3)
        expect((await table.get("target"))?.csize).toBe(6)
    })

    test("mergeByModif 在多个 parentId 中应分别按各自冲突节点的 modif 决定保留字段", async () => {
        const table = await createDefinedTreeTable("merge-by-modif-multi-parent")

        await table.setNodes(
            [
                { id: "left", parentId: "/", name: "left", isDir: true },
                { id: "right", parentId: "/", name: "right", isDir: true },
                { id: "left-target", parentId: "left", name: "pkg", isDir: true, tag: "left-newer-target", modif: 30 },
                { id: "left-old-file", parentId: "left-target", name: "old-left.ts", isDir: false, size: 1 },
                { id: "right-target", parentId: "right", name: "pkg", isDir: true, tag: "right-older-target", modif: 10 },
                { id: "right-old-file", parentId: "right-target", name: "old-right.ts", isDir: false, size: 2 },
            ],
            { index: { toEnd: true } },
        )
        await table.updateNodes({ id: "left-target" }, { $set: { modif: 30 } })
        await table.updateNodes({ id: "right-target" }, { $set: { modif: 10 } })

        await table.setNodes(
            [
                { id: "left-source", parentId: "left", name: "pkg", isDir: true, tag: "left-older-source", modif: 20 },
                { id: "left-new-file", parentId: "left-source", name: "new-left.ts", isDir: false, size: 3 },
                { id: "right-source", parentId: "right", name: "pkg", isDir: true, tag: "right-newer-source", modif: 40 },
                { id: "right-new-file", parentId: "right-source", name: "new-right.ts", isDir: false, size: 4 },
            ],
            { uniqueBy: "name", overwriteMode: "mergeByModif", index: { toEnd: true } },
        )

        expect(await table.get("left-source")).toBeUndefined()
        expect(await table.get("right-source")).toBeUndefined()
        expect((await table.get("left-target"))?.tag).toBe("left-newer-target")
        expect((await table.get("right-target"))?.tag).toBe("right-newer-source")
        expect(await listChildIds(table, "left-target")).toEqual(["left-old-file", "left-new-file"])
        expect(await listChildIds(table, "right-target")).toEqual(["right-old-file", "right-new-file"])
        expect((await table.get("left"))?.csize).toBe(4)
        expect((await table.get("right"))?.csize).toBe(6)
    })

    test("默认不允许文件覆盖目录，开启 enableFileOverwriteDir 后应允许覆盖", async () => {
        const table = await createDefinedTreeTable("file-overwrite-dir")

        await table.createNodes([{ id: "dir", name: "same", isDir: true }], "/")
        await table.setNodes([{ id: "file", parentId: "/", name: "same", isDir: false, size: 5 }], {
            uniqueBy: "name",
            overwriteMode: "replace",
        })
        expect((await table.get("dir"))?.isDir).toBe(true)
        expect(await table.get("file")).toBeUndefined()

        await table.setNodes([{ id: "file", parentId: "/", name: "same", isDir: false, size: 5 }], {
            uniqueBy: "name",
            overwriteMode: "replace",
            enableFileOverwriteDir: true,
        })
        expect((await table.get("dir"))?.isDir).toBe(false)
        expect(await table.get("file")).toBeUndefined()
    })

    test("uniqueBy 应支持点路径字段", async () => {
        const table = await createDefinedTreeTable("unique-path")

        await table.createNodes(
            [{ id: "old", name: "old.txt", isDir: false, meta: { hash_md5: "hash-1" }, tag: "old" }],
            "/",
        )
        await table.setNodes(
            [
                {
                    id: "incoming",
                    parentId: "/",
                    name: "new.txt",
                    isDir: false,
                    meta: { hash_md5: "hash-1" },
                    tag: "new",
                },
            ],
            { uniqueBy: "meta.hash_md5", overwriteMode: "replace" },
        )

        const node = await table.get("old")
        expect(node?.name).toBe("old.txt")
        expect(node?.tag).toBe("new")
        expect(await table.get("incoming")).toBeUndefined()
    })

    test("uniqueBy 点路径在 replace 模式下应处理批次内部冲突", async () => {
        const table = await createDefinedTreeTable("unique-path-batch-conflict")

        await table.setNodes(
            [
                {
                    id: "incoming-a",
                    parentId: "/",
                    name: "a.txt",
                    isDir: false,
                    meta: { hash_md5: "same-hash" },
                    tag: "a",
                },
                {
                    id: "incoming-b",
                    parentId: "/",
                    name: "b.txt",
                    isDir: false,
                    meta: { hash_md5: "same-hash" },
                    tag: "b",
                },
            ],
            { uniqueBy: "meta.hash_md5", overwriteMode: "replace" },
        )

        const activeNodes = await table.findMany({ "meta.hash_md5": "same-hash" } as any)
        expect(activeNodes).toHaveLength(1)
        expect(activeNodes[0].id).toBe("incoming-b")
        expect(activeNodes[0].tag).toBe("b")
        expect(await table.get("incoming-a")).toBeUndefined()
    })

    test("presync 应返回过期和已删除节点信息并剥离 oldModif 字段", async () => {
        const table = await createDefinedTreeTable("presync")

        await table.createNodes([{ id: "node", name: "node", isDir: false, modif: 10 }], "/")
        const result = await table.setNodes(
            [
                { id: "node", parentId: "/", name: "node", isDir: false, oldModif: 9 } as any,
                { id: "missing", parentId: "/", name: "missing", isDir: false, oldModif: 1 } as any,
            ],
            { presync: true },
        )

        expect(result.needSync).toBe(true)
        expect(result.syncNodeIds).toEqual(["node"])
        expect(result.deletedNodeIds).toEqual(["missing"])
        expect((await table.get("node")) as any).not.toHaveProperty("oldModif")
        expect((await table.get("missing")) as any).not.toHaveProperty("oldModif")
    })

    test("移动已有节点父级时应刷新新旧父级统计信息", async () => {
        const table = await createDefinedTreeTable("move-parent")

        await table.createNodes(
            [
                { id: "a", name: "A", isDir: true },
                { id: "b", name: "B", isDir: true },
            ],
            "/",
        )
        await table.createNodes([{ id: "file", name: "file.txt", isDir: false, size: 8 }], "a")

        await table.setNodes([{ id: "file", parentId: "b", name: "file.txt", isDir: false, size: 8 }])

        expect((await table.get("file"))?.parentId).toBe("b")
        expect((await table.get("a"))?.ctotal ?? 0).toBe(0)
        expect((await table.get("b"))?.ctotal).toBe(1)
        expect((await table.get("b"))?.csize).toBe(8)
    })

    test("设置 index.toEnd 时应追加到父级末尾并维护 childLastIndex", async () => {
        const table = await createDefinedTreeTable("index-to-end")

        await table.createNodes([{ id: "dir", name: "目录", isDir: true }], "/")
        await table.setNodes([{ id: "a", parentId: "dir", name: "a", isDir: false }], { index: { toEnd: true } })
        await table.setNodes([{ id: "b", parentId: "dir", name: "b", isDir: false }], { index: { toEnd: true } })

        expect(await listChildIds(table, "dir")).toEqual(["a", "b"])
        expect((await table.get("dir"))?.childLastIndex).toBe((await table.get("b"))?.index)
    })

    test("未指定 index 且父级已有 childLastIndex 时应默认追加到末尾", async () => {
        const table = await createDefinedTreeTable("index-default-end")

        await table.createNodes([{ id: "dir", name: "目录", isDir: true }], "/")
        await table.setNodes([{ id: "a", parentId: "dir", name: "a", isDir: false }], { index: { toEnd: true } })
        await table.setNodes([{ id: "b", parentId: "dir", name: "b", isDir: false }])

        expect(await listChildIds(table, "dir")).toEqual(["a", "b"])
        expect((await table.get("b"))?.index).toBeTruthy()
    })

    test("更新同父级已有节点时未指定 index 应保留原排序", async () => {
        const table = await createDefinedTreeTable("keep-index")

        await table.createNodes([{ id: "dir", name: "目录", isDir: true }], "/")
        await table.setNodes(
            [
                { id: "a", parentId: "dir", name: "a", isDir: false },
                { id: "b", parentId: "dir", name: "b", isDir: false },
            ],
            { index: { toEnd: true } },
        )
        const oldIndex = (await table.get("a"))?.index

        await table.setNodes([{ id: "a", parentId: "dir", name: "a-new", isDir: false }])

        expect((await table.get("a"))?.index).toBe(oldIndex)
        expect(await listChildIds(table, "dir")).toEqual(["a", "b"])
    })

    test("外部传入的树统计字段不应覆盖系统维护字段", async () => {
        const table = await createDefinedTreeTable("managed-fields")

        await table.setNodes([
            {
                id: "dir",
                parentId: "/",
                name: "目录",
                isDir: true,
                ctotal: 99,
                cftotal: 88,
                csize: 77,
                childLastIndex: "ZZ",
            } as any,
        ])

        const dir = await table.get("dir")
        expect(dir?.ctotal).not.toBe(99)
        expect(dir?.cftotal).not.toBe(88)
        expect(dir?.csize).not.toBe(77)
        expect(dir?.childLastIndex).toBeUndefined()
    })
})
