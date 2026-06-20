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

    test("应该拒绝不存在的父级和非法节点名称", async () => {
        const table = await createDefinedTreeTable("guard")

        await expect(
            table.setNodes([{ id: "missing", parentId: "missing-parent", name: "x", isDir: false }]),
        ).rejects.toThrow("父节点不存在")
        await expect(table.setNodes([{ id: "bad", parentId: "/", name: "bad/name", isDir: false }])).rejects.toThrow(
            "/",
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
