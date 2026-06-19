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

    test("应该拒绝不存在的父级和非法节点名称", async () => {
        const table = await createDefinedTreeTable("guard")

        await expect(
            table.setNodes([{ id: "missing", parentId: "missing-parent", name: "x", isDir: false }]),
        ).rejects.toThrow("父节点不存在")
        await expect(table.setNodes([{ id: "bad", parentId: "/", name: "bad/name", isDir: false }])).rejects.toThrow(
            "/",
        )
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
