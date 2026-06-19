import { SQLiteAdapter } from "../../../adapter/SQLite"
import { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"

function createTreeTable(name: string) {
    return new TableTree<ITreeNode>({
        name,
        adapter: SQLiteAdapter({ filename: ":memory:", driver: "better-sqlite3" }),
        enableMarkDelete: true,
    })
}

describe("TableTree 目录树核心接口", () => {
    test("创建节点后应维护父节点统计信息", async () => {
        const table = createTreeTable("tree_create_metadata")
        await table.inited

        await table.createNodes([{ id: "dir", name: "目录", isDir: true }], "/")
        await table.createNodes(
            [
                { id: "file-a", name: "a.txt", size: 10, isDir: false },
                { id: "file-b", name: "b.txt", size: 20, isDir: false },
            ],
            "dir",
            { index: { toEnd: true } },
        )

        const dir = await table.get("dir")
        expect(dir?.ctotal).toBe(2)
        expect(dir?.cftotal).toBe(2)
        expect(dir?.csize).toBe(30)
        expect(dir?.childLastIndex).toBeTruthy()
    })

    test("移动节点后应更新新旧父级统计信息", async () => {
        const table = createTreeTable("tree_move_metadata")
        await table.inited

        await table.createNodes(
            [
                { id: "a", name: "A", isDir: true },
                { id: "b", name: "B", isDir: true },
            ],
            "/",
        )
        await table.createNodes([{ id: "file", name: "file.txt", size: 8, isDir: false }], "a")

        await table.moveNodes(["file"], "b")

        const oldParent = await table.get("a")
        const newParent = await table.get("b")
        const file = await table.get("file")
        expect(file?.parentId).toBe("b")
        expect(oldParent?.ctotal).toBeUndefined()
        expect(oldParent?.cftotal).toBeUndefined()
        expect(oldParent?.csize).toBeUndefined()
        expect(newParent?.ctotal).toBe(1)
        expect(newParent?.csize).toBe(8)
    })

    test("标记删除和恢复应维护统计信息", async () => {
        const table = createTreeTable("tree_delete_undelete")
        await table.inited

        await table.createNodes([{ id: "dir", name: "目录", isDir: true }], "/")
        await table.createNodes([{ id: "file", name: "file.txt", size: 5, isDir: false }], "dir")

        await table.deleteNodes(["file"])
        expect(await table.get("file")).toBeUndefined()
        expect((await table.get("dir"))?.ctotal).toBeUndefined()

        await table.unDeleteNodes(["file"])
        expect((await table.get("file"))?.parentId).toBe("dir")
        expect((await table.get("dir"))?.ctotal).toBe(1)
    })

    test("复制节点应生成新 ID 并支持递归复制子节点", async () => {
        const table = createTreeTable("tree_copy")
        await table.inited

        await table.createNodes([{ id: "src", name: "src", isDir: true }], "/")
        await table.createNodes([{ id: "child", name: "index.ts", size: 12, isDir: false }], "src")

        const result = await table.copyNodes(["src"], "/", { deep: true, renameOnCopy: true })
        expect(result.createdNodeIds.length).toBe(1)

        const copiedRoot = await table.get(result.createdNodeIds[0])
        const copiedChildren = await table.findMany({ parentId: result.createdNodeIds[0] })
        expect(copiedRoot?.name).toBe("src (1)")
        expect(copiedChildren.length).toBe(1)
        expect(copiedChildren[0].name).toBe("index.ts")
    })

    test("预同步应区分需要同步和线上不存在的节点", async () => {
        const table = createTreeTable("tree_presync")
        await table.inited

        await table.createNodes([{ id: "node", name: "node", isDir: false, modif: 10 }], "/")

        const result = await table.presyncNodes([
            { id: "node", modif: 9 },
            { id: "missing", modif: 1 },
        ])
        expect(result.needSync).toBe(true)
        expect(result.syncNodeIds).toEqual(["node"])
        expect(result.deletedNodeIds).toEqual(["missing"])
    })

    test("移动目录使用 merge 时应把子节点合并到目标目录", async () => {
        const table = createTreeTable("tree_move_merge")
        await table.inited

        await table.createNodes(
            [
                { id: "src", name: "same", isDir: true },
                { id: "target", name: "same", isDir: true },
            ],
            "/",
        )
        await table.createNodes([{ id: "file", name: "file.txt", isDir: false, size: 3 }], "src")

        await table.moveNodes(["src"], "/", { uniqueBy: "name", overwriteMode: "merge" })

        expect(await table.get("src")).toBeUndefined()
        const movedFile = await table.get("file")
        const target = await table.get("target")
        expect(movedFile?.parentId).toBe("target")
        expect(target?.ctotal).toBe(1)
        expect(target?.csize).toBe(3)
    })

    test("setNodes 使用 newName 时应自动生成不冲突名称", async () => {
        const table = createTreeTable("tree_set_new_name")
        await table.inited

        await table.createNodes([{ id: "old", name: "文件.txt", isDir: false }], "/")
        await table.setNodes(
            [{ id: "new", parentId: "/", name: "文件.txt", isDir: false }],
            { uniqueBy: "name", overwriteMode: "newName" },
        )

        expect((await table.get("new"))?.name).toBe("文件 (1).txt")
    })

    test("setNodes 开启 returnChangedNodesIds 时应返回被命中的目标节点 ID", async () => {
        const table = createTreeTable("tree_set_changed_node_ids")
        await table.inited

        await table.createNodes([{ id: "old", name: "same.txt", isDir: false }], "/")
        const result = await table.setNodes(
            [{ id: "new", parentId: "/", name: "same.txt", isDir: false }],
            { uniqueBy: "name", overwriteMode: "replace", returnChangedNodesIds: true },
        )

        expect(result.changedNodeIds).toEqual(["old"])
        expect((await table.get("old"))?.name).toBe("same.txt")
        expect(await table.get("new")).toBeUndefined()
    })

    test("setNodes 开启 returnChangedNodesIds 且 updateOnly 时不应返回未创建节点", async () => {
        const table = createTreeTable("tree_set_changed_node_ids_update_only")
        await table.inited

        const result = await table.setNodes(
            [{ id: "missing", parentId: "/", name: "missing.txt", isDir: false }],
            { updateOnly: true, returnChangedNodesIds: true },
        )

        expect(result.changedNodeIds).toEqual([])
        expect(await table.get("missing")).toBeUndefined()
    })

    test("setNodes 默认 setMode 应命中冲突节点并进行浅合并", async () => {
        const table = createTreeTable("tree_set_mode_default")
        await table.inited

        await table.createNodes(
            [{ id: "old", name: "same.txt", isDir: false, tag: "keep", meta: { old: true } }],
            "/",
        )
        await table.setNodes(
            [{ id: "new", parentId: "/", name: "same.txt", isDir: false, meta: { next: true } }],
            { uniqueBy: "name", overwriteMode: "replace" },
        )

        const node = await table.get("old")
        expect((node as any)?.tag).toBe("keep")
        expect((node as any)?.meta).toEqual({ next: true })
        expect(await table.get("new")).toBeUndefined()
    })

    test("setNodes 使用 setMode overwrite 时应整体替换已有节点字段", async () => {
        const table = createTreeTable("tree_set_mode_overwrite")
        await table.inited

        await table.createNodes([{ id: "node", name: "node", isDir: false, tag: "old", meta: { keep: true } }], "/")
        await table.setNodes([{ id: "node", parentId: "/", name: "node", isDir: false }], { setMode: "overwrite" })

        const node = await table.get("node")
        expect((node as any)?.tag).toBeUndefined()
        expect((node as any)?.meta).toBeUndefined()
        expect(node?.parentId).toBe("/")
        expect(node?.name).toBe("node")
    })

    test("setNodes 使用 setMode merge 时应深度合并已有节点字段", async () => {
        const table = createTreeTable("tree_set_mode_merge")
        await table.inited

        await table.createNodes(
            [{ id: "node", name: "node", isDir: false, meta: { keep: true, nested: { a: 1 } } }],
            "/",
        )
        await table.setNodes(
            [{ id: "node", parentId: "/", name: "node", isDir: false, meta: { nested: { b: 2 } } }],
            { setMode: "merge" },
        )

        expect((await table.get("node")) as any).toMatchObject({
            meta: { keep: true, nested: { a: 1, b: 2 } },
        })
    })

    test("setNodes 使用 merge 时应递归合并目录子节点", async () => {
        const table = createTreeTable("tree_set_merge")
        await table.inited

        await table.createNodes([{ id: "target", name: "src", isDir: true, type: "old" }], "/")
        await table.setNodes(
            [
                { id: "incoming", parentId: "/", name: "src", isDir: true, type: "new" },
                { id: "incoming-file", parentId: "incoming", name: "index.ts", isDir: false, size: 9 },
            ],
            { uniqueBy: "name", overwriteMode: "merge" },
        )

        expect(await table.get("incoming")).toBeUndefined()
        expect((await table.get("target"))?.type).toBe("new")
        expect((await table.get("incoming-file"))?.parentId).toBe("target")
        expect((await table.get("target"))?.ctotal).toBe(1)
    })

    test("setNodes 使用 mergeByModif 时应保留较新的目录字段", async () => {
        const table = createTreeTable("tree_set_merge_by_modif")
        await table.inited

        await table.createNodes([{ id: "target", name: "src", isDir: true, type: "newer", modif: 20 }], "/")
        await table.setNodes(
            [
                { id: "incoming", parentId: "/", name: "src", isDir: true, type: "older", modif: 10 },
                { id: "incoming-file", parentId: "incoming", name: "index.ts", isDir: false, size: 4 },
            ],
            { uniqueBy: "name", overwriteMode: "mergeByModif" },
        )

        expect((await table.get("target"))?.type).toBe("newer")
        expect((await table.get("incoming-file"))?.parentId).toBe("target")
    })

    test("创建节点时用户指定的 modif 不应被 metadata 刷新覆盖", async () => {
        const table = createTreeTable("tree_keep_user_modif")
        await table.inited

        await table.createNodes([{ id: "node", name: "node", isDir: false, modif: 123 }], "/")

        expect((await table.get("node"))?.modif).toBe(123)
        expect((await table.get("node"))?.cmodif).toBeUndefined()
        expect((await table.get("node"))?.ctotal).toBeUndefined()
        expect((await table.get("node"))?.cftotal).toBeUndefined()
        expect((await table.get("node"))?.csize).toBeUndefined()
    })

    test("游标分页默认不应因空 index 漏掉同级节点", async () => {
        const table = createTreeTable("tree_cursor_empty_index")
        await table.inited

        await table.createNodes(
            [
                { id: "a", name: "a", isDir: false },
                { id: "b", name: "b", isDir: false },
                { id: "c", name: "c", isDir: false },
            ],
            "/",
        )

        const first = await table.listNodesByCursor("/", { pageSize: 2 })
        const second = await table.listNodesByCursor("/", { pageSize: 2, cursor: first.nextCursor })
        expect([...first.list, ...second.list].map((node) => node.id).sort()).toEqual(["a", "b", "c"])
    })

    test("setNodes 应拒绝不存在的父级", async () => {
        const table = createTreeTable("tree_set_invalid_parent")
        await table.inited

        await expect(table.setNodes([{ id: "node", parentId: "missing", name: "node", isDir: false }])).rejects.toThrow(
            "父节点不存在",
        )
    })

    test("updateNodes 应拒绝非法名称和循环 parentId", async () => {
        const table = createTreeTable("tree_update_guard")
        await table.inited

        await table.createNodes([{ id: "dir", name: "dir", isDir: true }], "/")
        await table.createNodes([{ id: "child", name: "child", isDir: true }], "dir")

        await expect(table.updateNodes({ id: "dir" }, { $set: { name: "bad/name" } })).rejects.toThrow("/")
        await expect(table.updateNodes({ id: "dir" }, { $set: { parentId: "child" } })).rejects.toThrow("后代")
    })

    test("copyNodes 应遵守 skip 覆盖策略", async () => {
        const table = createTreeTable("tree_copy_skip")
        await table.inited

        await table.createNodes([{ id: "src", name: "same.txt", isDir: false }], "/")
        await table.createNodes([{ id: "target", name: "same.txt", isDir: false }], "/")

        const result = await table.copyNodes(["src"], "/", {
            uniqueBy: "name",
            overwriteMode: "skip",
        })

        expect(result.createdNodeIds).toEqual([])
        expect((await table.listNodes("/", { pageSize: 10 })).list.length).toBe(2)
    })
})
