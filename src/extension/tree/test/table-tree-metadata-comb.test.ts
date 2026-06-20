import { SQLiteAdapter } from "../../../adapter/SQLite"
import { TableTree, defineTableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"

interface ITestTreeNode extends ITreeNode {
    tag?: string
    meta?: {
        hash?: string
    }
}

let tableIndex = 0

async function createDefinedTreeTable(name: string) {
    const useTreeTable = defineTableTree<ITestTreeNode>({
        name: `test-tree-metadata-comb-${tableIndex++}-${name}`,
        adapter: SQLiteAdapter({ filename: ":memory:", driver: "better-sqlite3" }),
        enableMarkDelete: true,
    })

    return await useTreeTable()
}

async function expectAllVisibleMetadataAccurate(table: TableTree<ITestTreeNode>) {
    const nodes = await table.findMany({}) as ITestTreeNode[]
    const nodeIds = new Set(nodes.map((node) => node.id))
    const nodesByParentId = new Map<string, ITestTreeNode[]>()
    for (const node of nodes) {
        if (node.parentId !== "/") {
            expect(nodeIds.has(node.parentId)).toBe(true)
        }
        const children = nodesByParentId.get(node.parentId) ?? []
        children.push(node)
        nodesByParentId.set(node.parentId, children)
    }

    function collectDescendants(nodeId: string): ITestTreeNode[] {
        const children = nodesByParentId.get(nodeId) ?? []
        return children.flatMap((child) => [child, ...collectDescendants(child.id)])
    }

    for (const node of nodes) {
        if (!node.isDir) continue

        const children = nodesByParentId.get(node.id) ?? []
        const descendants = collectDescendants(node.id)
        const childLastIndex = children
            .map((child) => child.index)
            .filter((index): index is string => Boolean(index))
            .sort()
            .at(-1)

        expect(node.ctotal ?? 0).toBe(descendants.length)
        expect(node.cftotal ?? 0).toBe(descendants.filter((child) => !child.isDir).length)
        expect(node.csize ?? 0).toBe(descendants.reduce((total, child) => total + (child.size ?? 0), 0))
        expect(node.childLastIndex).toBe(childLastIndex)
    }
}

describe("TableTree 目录树 metadata 组合一致性", () => {
    test("连续混合创建、移动、复制、更新、删除和恢复后目录统计字段应与实际可见子树一致", async () => {
        const table = await createDefinedTreeTable("mixed-visible-metadata")

        await table.setNodes(
            [
                { id: "root", parentId: "/", name: "root", isDir: true },
                { id: "src", parentId: "root", name: "src", isDir: true },
                { id: "assets", parentId: "root", name: "assets", isDir: true },
                { id: "archive", parentId: "root", name: "archive", isDir: true },
                { id: "main", parentId: "src", name: "main.ts", isDir: false, size: 10, meta: { hash: "main" } },
                { id: "util", parentId: "src", name: "util.ts", isDir: false, size: 5, meta: { hash: "util" } },
                { id: "logo", parentId: "assets", name: "logo.png", isDir: false, size: 7, meta: { hash: "logo" } },
            ],
            { index: { toEnd: true } },
        )
        await expectAllVisibleMetadataAccurate(table)

        await table.moveNodes(["logo"], "src", { index: { toStart: true } })
        await table.updateNodes({ id: "util" }, { $inc: { size: 3 } as any })
        await table.copyNodes(["src"], "archive", { deep: true, renameOnCopy: false, index: { toEnd: true } })
        await table.deleteNodes(["main"])
        await table.unDeleteNodes(["main"])
        await table.setNodes(
            [
                { id: "incoming-assets", parentId: "root", name: "assets", isDir: true, tag: "new-assets" },
                { id: "incoming-icon", parentId: "incoming-assets", name: "icon.svg", isDir: false, size: 2 },
            ],
            { uniqueBy: "name", overwriteMode: "replace", index: { toEnd: true } },
        )
        await table.updateNodes({ id: "logo" }, { $set: { index: "zzzz" } })
        await table.deleteNodes(["incoming-icon"], { realDelete: true })

        expect(await table.get("incoming-icon", { ignoreMarkDelete: true })).toBeUndefined()
        await expectAllVisibleMetadataAccurate(table)
    })

    test("仅 cftotal 发生变化时父目录的 metadata 修改计数也应更新", async () => {
        const table = await createDefinedTreeTable("cftotal-only-modif")

        await table.createNodes([{ id: "dir", name: "dir", isDir: true }], "/")
        await table.createNodes([{ id: "child", name: "child", isDir: true, size: 0 }], "dir")
        const dirBefore = await table.get("dir")

        await new Promise((resolve) => setTimeout(resolve, 5))
        await table.updateNodes({ id: "child" }, { $set: { isDir: false } })

        const dirAfter = await table.get("dir")
        expect(dirAfter?.ctotal).toBe(1)
        expect(dirAfter?.cftotal).toBe(1)
        expect(dirAfter?.csize ?? 0).toBe(0)
        expect(dirAfter?.modif).toBeGreaterThan(dirBefore!.modif)
        expect(dirAfter?.cmodif).toBeGreaterThan(dirBefore!.cmodif ?? 0)
    })

    test("多种移动覆盖策略和排序参数组合后 metadata 应保持正确", async () => {
        const table = await createDefinedTreeTable("move-overwrite-index-metadata")

        await table.setNodes(
            [
                { id: "workspace", parentId: "/", name: "workspace", isDir: true },
                { id: "downloads", parentId: "workspace", name: "downloads", isDir: true },
                { id: "library", parentId: "workspace", name: "library", isDir: true },
                { id: "trash", parentId: "workspace", name: "trash", isDir: true },
                { id: "book-old", parentId: "library", name: "book.pdf", isDir: false, size: 10, meta: { hash: "book" } },
                { id: "book-new", parentId: "downloads", name: "book.pdf", isDir: false, size: 12, meta: { hash: "book" } },
                { id: "album-src", parentId: "downloads", name: "album", isDir: true },
                { id: "photo-src", parentId: "album-src", name: "a.jpg", isDir: false, size: 4 },
                { id: "album-target", parentId: "library", name: "album", isDir: true },
                { id: "photo-old", parentId: "album-target", name: "old.jpg", isDir: false, size: 2 },
                { id: "note-a", parentId: "downloads", name: "note.txt", isDir: false, size: 1 },
                { id: "note-b", parentId: "library", name: "note.txt", isDir: false, size: 2 },
                { id: "skip-src", parentId: "downloads", name: "skip.txt", isDir: false, size: 3 },
                { id: "skip-target", parentId: "library", name: "skip.txt", isDir: false, size: 5 },
            ],
            { index: { toEnd: true } },
        )
        await expectAllVisibleMetadataAccurate(table)

        await table.moveNodes(["book-new"], "library", {
            uniqueBy: "meta.hash",
            overwriteMode: "replace",
            index: { toStart: true },
        })
        await expectAllVisibleMetadataAccurate(table)

        await table.moveNodes(["album-src"], "library", {
            uniqueBy: "name",
            overwriteMode: "merge",
            index: { toEnd: true },
        })
        await expectAllVisibleMetadataAccurate(table)

        await table.moveNodes(["note-a"], "library", {
            uniqueBy: "name",
            overwriteMode: "newName",
            index: { prevNodeId: "book-new", nextNodeId: "album-target" },
        })
        await expectAllVisibleMetadataAccurate(table)

        await table.moveNodes(["skip-src"], "library", {
            uniqueBy: "name",
            overwriteMode: "skip",
        })

        expect((await table.get("book-old"))).toBeUndefined()
        expect((await table.get("book-new"))?.parentId).toBe("library")
        expect((await table.get("photo-src"))?.parentId).toBe("album-target")
        expect((await table.get("note-a"))?.name).toBe("note (1).txt")
        expect((await table.get("skip-src"))?.parentId).toBe("downloads")
        await expectAllVisibleMetadataAccurate(table)
    })

    test("setNodes 的 setMode、updateOnly、mergeByModif 和索引参数组合后 metadata 应保持正确", async () => {
        const table = await createDefinedTreeTable("set-options-metadata")

        await table.setNodes(
            [
                { id: "root", parentId: "/", name: "root", isDir: true },
                { id: "draft", parentId: "root", name: "draft", isDir: true, tag: "old" },
                { id: "file", parentId: "draft", name: "config.json", isDir: false, size: 2 },
                { id: "target", parentId: "root", name: "target", isDir: true },
            ],
            { index: { toEnd: true } },
        )
        await expectAllVisibleMetadataAccurate(table)

        await table.setNodes([{ id: "file", parentId: "draft", name: "config.json", isDir: false, size: 5, tag: "merge" }], {
            setMode: "merge",
        })
        await table.setNodes([{ id: "file", parentId: "target", name: "config.json", isDir: false, size: 8, tag: "published" }], {
            updateOnly: true,
            index: { toEnd: true },
        })
        await table.setNodes([{ id: "missing", parentId: "target", name: "missing.json", isDir: false, size: 99 }], {
            updateOnly: true,
        })
        await expectAllVisibleMetadataAccurate(table)

        await table.setNodes(
            [
                { id: "incoming-old", parentId: "root", name: "target", isDir: true, tag: "older", modif: 1 },
                { id: "incoming-old-file", parentId: "incoming-old", name: "old.txt", isDir: false, size: 100 },
            ],
            { uniqueBy: "name", overwriteMode: "mergeByModif" },
        )
        await table.setNodes(
            [
                { id: "incoming-new", parentId: "root", name: "target", isDir: true, tag: "newer", modif: Date.now() + 1000 },
                { id: "incoming-new-file", parentId: "incoming-new", name: "new.txt", isDir: false, size: 4 },
            ],
            { uniqueBy: "name", overwriteMode: "mergeByModif", index: { toEnd: true } },
        )
        await table.setNodes([{ id: "file", parentId: "target", name: "config.json", isDir: false, size: 9 }], {
            setMode: "overwrite",
        })

        expect(await table.get("missing")).toBeUndefined()
        expect((await table.get("file"))?.parentId).toBe("target")
        expect((await table.get("target"))?.tag).toBe("newer")
        expect((await table.get("incoming-new-file"))?.parentId).toBe("target")
        await expectAllVisibleMetadataAccurate(table)
    })

    test("复制目录的 deep、renameOnCopy 和覆盖策略组合后 metadata 应保持正确", async () => {
        const table = await createDefinedTreeTable("copy-options-metadata")

        await table.setNodes(
            [
                { id: "source", parentId: "/", name: "source", isDir: true },
                { id: "target", parentId: "/", name: "target", isDir: true },
                { id: "src-dir", parentId: "source", name: "pkg", isDir: true },
                { id: "src-file", parentId: "src-dir", name: "index.ts", isDir: false, size: 6 },
                { id: "src-sub", parentId: "src-dir", name: "sub", isDir: true },
                { id: "src-deep", parentId: "src-sub", name: "deep.ts", isDir: false, size: 4 },
                { id: "target-dir", parentId: "target", name: "pkg", isDir: true },
                { id: "target-old", parentId: "target-dir", name: "old.ts", isDir: false, size: 2 },
            ],
            { index: { toEnd: true } },
        )
        await expectAllVisibleMetadataAccurate(table)

        const renamedCopy = await table.copyNodes(["src-dir"], "target", {
            deep: true,
            renameOnCopy: true,
            index: { toStart: true },
        })
        await expectAllVisibleMetadataAccurate(table)

        const skippedCopy = await table.copyNodes(["src-dir"], "target", {
            deep: true,
            renameOnCopy: false,
            uniqueBy: "name",
            overwriteMode: "skip",
        })
        await table.copyNodes(["src-dir"], "target", {
            deep: true,
            renameOnCopy: false,
            uniqueBy: "name",
            overwriteMode: "merge",
            index: { toEnd: true },
        })

        expect(renamedCopy.createdNodeIds).toHaveLength(1)
        expect(skippedCopy.createdNodeIds).toEqual([])
        expect((await table.get("target-old"))?.parentId).toBe("target-dir")
        expect(await table.findMany({ parentId: "target-dir", name: "index.ts" })).toHaveLength(1)
        expect(await table.findMany({ parentId: "target-dir", name: "sub" })).toHaveLength(1)
        await expectAllVisibleMetadataAccurate(table)
    })

    test("批量 updateNodes 移动、deep 更新、软删除和物理删除组合后 metadata 应保持正确", async () => {
        const table = await createDefinedTreeTable("update-delete-options-metadata")

        await table.setNodes(
            [
                { id: "root", parentId: "/", name: "root", isDir: true },
                { id: "a", parentId: "root", name: "a", isDir: true },
                { id: "b", parentId: "root", name: "b", isDir: true },
                { id: "trash", parentId: "root", name: "trash", isDir: true },
                { id: "a1", parentId: "a", name: "a1.txt", isDir: false, size: 1, tag: "move" },
                { id: "a2", parentId: "a", name: "a2.txt", isDir: false, size: 2, tag: "move" },
                { id: "b1", parentId: "b", name: "b1.txt", isDir: false, size: 3 },
                { id: "dir", parentId: "a", name: "dir", isDir: true },
                { id: "deep", parentId: "dir", name: "deep.txt", isDir: false, size: 4 },
            ],
            { index: { toEnd: true } },
        )
        await expectAllVisibleMetadataAccurate(table)

        await table.createNodes([{ id: "anchor", name: "anchor.txt", isDir: false }], "b", { index: { toEnd: true } })
        await table.updateNodes({ tag: "move" }, { $set: { parentId: "b" } })
        await table.updateNodes({ id: "dir" }, { $set: { tag: "deep-updated" } }, { deep: true })
        await table.updateNodes({ id: "deep" }, { $inc: { size: 6 } as any })
        await expectAllVisibleMetadataAccurate(table)

        await table.deleteNodes(["dir"])
        await table.unDeleteNodes(["deep"])
        await table.moveNodes(["a1"], "trash", { index: { toEnd: true } })
        await table.deleteNodes(["a2"], { realDelete: true })

        expect(await table.get("a2", { ignoreMarkDelete: true })).toBeUndefined()
        expect((await table.get("dir"))?.parentId).toBe("a")
        expect((await table.get("deep"))?.size).toBe(10)
        expect((await table.get("a1"))?.parentId).toBe("trash")
        await expectAllVisibleMetadataAccurate(table)
    })
})
