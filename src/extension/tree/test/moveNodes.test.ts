import { SQLiteAdapter } from "../../../adapter/SQLite/SQLiteAdapter"
import { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"

function createTestTreeTable(tableName: string) {
    return new TableTree<ITreeNode>({
        name: tableName,
        adapter: SQLiteAdapter({ filename: ":memory:" }),
    })
}

test("moveNodes 会移动子树并同步更新新旧祖先统计字段", async () => {
    const table = createTestTreeTable(`tree_move_nodes_${Date.now()}`)
    await table.inited

    try {
        await table.createNodes(
            [
                {
                    id: "dir-a",
                    parentId: "/",
                    name: "目录A",
                    modif: 0,
                    isDir: true,
                    size: 1,
                },
                {
                    id: "dir-c",
                    parentId: "/",
                    name: "目录C",
                    modif: 0,
                    isDir: true,
                    size: 4,
                },
            ],
            "/",
        )

        await table.createNodes(
            [
                {
                    id: "dir-b",
                    parentId: "dir-a",
                    name: "目录B",
                    modif: 0,
                    isDir: true,
                    size: 5,
                },
            ],
            "dir-a",
        )

        await table.createNodes(
            [
                {
                    id: "file-a",
                    parentId: "dir-b",
                    name: "文件A",
                    modif: 0,
                    isDir: false,
                    size: 2,
                },
            ],
            "dir-b",
        )

        await table.moveNodes(["dir-b"], "dir-c")

        const dirANode = await table.get("dir-a")
        const dirBNode = await table.get("dir-b")
        const dirCNode = await table.get("dir-c")

        expect(dirANode).toMatchObject({
            id: "dir-a",
            csize: 0,
            ctotal: 0,
            cftotal: 0,
        })

        expect(dirBNode).toMatchObject({
            id: "dir-b",
            parentId: "dir-c",
            csize: 2,
            ctotal: 1,
            cftotal: 1,
        })

        expect(dirCNode).toMatchObject({
            id: "dir-c",
            csize: 7,
            ctotal: 2,
            cftotal: 1,
        })
    } finally {
        await table.close()
    }
})

test("moveNodes 支持按 name 替换目标父节点下的冲突节点", async () => {
    const table = createTestTreeTable(`tree_move_nodes_replace_${Date.now()}`)
    await table.inited

    try {
        await table.createNodes(
            [
                {
                    id: "dir-source",
                    parentId: "/",
                    name: "源目录",
                    modif: 0,
                    isDir: true,
                    size: 1,
                },
                {
                    id: "dir-target",
                    parentId: "/",
                    name: "目标目录",
                    modif: 0,
                    isDir: true,
                    size: 2,
                },
            ],
            "/",
        )

        await table.createNodes(
            [
                {
                    id: "file-source",
                    parentId: "dir-source",
                    name: "同名文件",
                    modif: 0,
                    isDir: false,
                    size: 3,
                    type: "file",
                },
            ],
            "dir-source",
        )

        await table.createNodes(
            [
                {
                    id: "file-target",
                    parentId: "dir-target",
                    name: "同名文件",
                    modif: 0,
                    isDir: false,
                    size: 5,
                    type: "file",
                },
            ],
            "dir-target",
        )

        await table.moveNodes(["file-source"], "dir-target", {
            uniqueBy: "name",
        })

        expect(await table.get("file-target")).toBeUndefined()

        const movedNode = await table.get("file-source")
        const dirSource = await table.get("dir-source")
        const dirTarget = await table.get("dir-target")

        expect(movedNode).toMatchObject({
            id: "file-source",
            parentId: "dir-target",
            name: "同名文件",
            size: 3,
        })

        expect(dirSource).toMatchObject({
            id: "dir-source",
            csize: 0,
            ctotal: 0,
            cftotal: 0,
        })

        expect(dirTarget).toMatchObject({
            id: "dir-target",
            csize: 3,
            ctotal: 1,
            cftotal: 1,
        })
    } finally {
        await table.close()
    }
})

test("moveNodes 支持在 newName 模式下自动改名后再移动", async () => {
    const table = createTestTreeTable(`tree_move_nodes_new_name_${Date.now()}`)
    await table.inited

    try {
        await table.createNodes(
            [
                {
                    id: "dir-source",
                    parentId: "/",
                    name: "源目录",
                    modif: 0,
                    isDir: true,
                    size: 1,
                },
                {
                    id: "dir-target",
                    parentId: "/",
                    name: "目标目录",
                    modif: 0,
                    isDir: true,
                    size: 2,
                },
            ],
            "/",
        )

        await table.createNodes(
            [
                {
                    id: "file-source",
                    parentId: "dir-source",
                    name: "同名文件",
                    modif: 0,
                    isDir: false,
                    size: 3,
                    type: "file",
                },
            ],
            "dir-source",
        )

        await table.createNodes(
            [
                {
                    id: "file-target",
                    parentId: "dir-target",
                    name: "同名文件",
                    modif: 0,
                    isDir: false,
                    size: 5,
                    type: "file",
                },
            ],
            "dir-target",
        )

        await table.moveNodes(["file-source"], "dir-target", {
            overwriteMode: "newName",
        })

        const originalTarget = await table.get("file-target")
        const movedNode = await table.get("file-source")
        const targetChildren = await table.listNodes("dir-target", { pageSize: 20 })

        expect(originalTarget).toMatchObject({
            id: "file-target",
            parentId: "dir-target",
            name: "同名文件",
            size: 5,
        })

        expect(movedNode).toMatchObject({
            id: "file-source",
            parentId: "dir-target",
            name: "同名文件 (1)",
            size: 3,
        })

        expect(targetChildren.list.map((node) => node.name).sort()).toEqual(["同名文件", "同名文件 (1)"])
    } finally {
        await table.close()
    }
})

test("moveNodes 支持在 merge 模式下把同名目录的子节点合并到目标目录", async () => {
    const table = createTestTreeTable(`tree_move_nodes_merge_${Date.now()}`)
    await table.inited

    try {
        await table.createNodes(
            [
                {
                    id: "dir-source-parent",
                    parentId: "/",
                    name: "源父目录",
                    modif: 0,
                    isDir: true,
                    size: 1,
                },
                {
                    id: "dir-target-parent",
                    parentId: "/",
                    name: "目标父目录",
                    modif: 0,
                    isDir: true,
                    size: 2,
                },
            ],
            "/",
        )

        await table.createNodes(
            [
                {
                    id: "dir-source",
                    parentId: "dir-source-parent",
                    name: "公共目录",
                    modif: 0,
                    isDir: true,
                    size: 4,
                    type: "dir",
                },
            ],
            "dir-source-parent",
        )

        await table.createNodes(
            [
                {
                    id: "dir-target",
                    parentId: "dir-target-parent",
                    name: "公共目录",
                    modif: 0,
                    isDir: true,
                    size: 5,
                    type: "dir",
                },
            ],
            "dir-target-parent",
        )

        await table.createNodes(
            [
                {
                    id: "file-source",
                    parentId: "dir-source",
                    name: "源文件",
                    modif: 0,
                    isDir: false,
                    size: 3,
                    type: "file",
                },
            ],
            "dir-source",
        )

        await table.createNodes(
            [
                {
                    id: "file-target",
                    parentId: "dir-target",
                    name: "目标文件",
                    modif: 0,
                    isDir: false,
                    size: 6,
                    type: "file",
                },
            ],
            "dir-target",
        )

        await table.moveNodes(["dir-source"], "dir-target-parent", {
            overwriteMode: "merge",
            uniqueBy: "name",
        })

        expect(await table.get("dir-source")).toBeUndefined()

        const fileSource = await table.get("file-source")
        const dirTarget = await table.get("dir-target")
        const dirSourceParent = await table.get("dir-source-parent")
        const dirTargetParent = await table.get("dir-target-parent")
        const mergedChildren = await table.listNodes("dir-target", { pageSize: 20 })

        expect(fileSource).toMatchObject({
            id: "file-source",
            parentId: "dir-target",
            name: "源文件",
            size: 3,
        })

        expect(mergedChildren.list.map((node) => node.name).sort()).toEqual(["源文件", "目标文件"])

        expect(dirTarget).toMatchObject({
            id: "dir-target",
            csize: 9,
            ctotal: 2,
            cftotal: 2,
        })

        expect(dirSourceParent).toMatchObject({
            id: "dir-source-parent",
            csize: 0,
            ctotal: 0,
            cftotal: 0,
        })

        expect(dirTargetParent).toMatchObject({
            id: "dir-target-parent",
            csize: 14,
            ctotal: 3,
            cftotal: 2,
        })
    } finally {
        await table.close()
    }
})

test("moveNodes 支持在 mergeByModif 模式下按 modif 决定是否覆盖冲突节点", async () => {
    const table = createTestTreeTable(`tree_move_nodes_merge_by_modif_${Date.now()}`)
    await table.inited

    try {
        await table.createNodes(
            [
                {
                    id: "dir-source-parent",
                    parentId: "/",
                    name: "源父目录",
                    modif: 0,
                    isDir: true,
                    size: 1,
                },
                {
                    id: "dir-target-parent",
                    parentId: "/",
                    name: "目标父目录",
                    modif: 0,
                    isDir: true,
                    size: 2,
                },
            ],
            "/",
        )

        await table.createNodes(
            [
                {
                    id: "dir-source",
                    parentId: "dir-source-parent",
                    name: "公共目录",
                    modif: 1,
                    isDir: true,
                    size: 4,
                    type: "dir",
                },
            ],
            "dir-source-parent",
        )

        await table.createNodes(
            [
                {
                    id: "dir-target",
                    parentId: "dir-target-parent",
                    name: "公共目录",
                    modif: 9,
                    isDir: true,
                    size: 5,
                    type: "dir",
                },
            ],
            "dir-target-parent",
        )

        await table.createNodes(
            [
                {
                    id: "file-source-newer",
                    parentId: "dir-source",
                    name: "冲突文件",
                    modif: 20,
                    isDir: false,
                    size: 3,
                    type: "file",
                },
                {
                    id: "file-source-older",
                    parentId: "dir-source",
                    name: "旧文件",
                    modif: 5,
                    isDir: false,
                    size: 4,
                    type: "file",
                },
                {
                    id: "file-source-only",
                    parentId: "dir-source",
                    name: "源独有文件",
                    modif: 1,
                    isDir: false,
                    size: 2,
                    type: "file",
                },
            ],
            "dir-source",
        )

        await table.createNodes(
            [
                {
                    id: "file-target-old",
                    parentId: "dir-target",
                    name: "冲突文件",
                    modif: 10,
                    isDir: false,
                    size: 6,
                    type: "file",
                },
                {
                    id: "file-target-new",
                    parentId: "dir-target",
                    name: "旧文件",
                    modif: 8,
                    isDir: false,
                    size: 7,
                    type: "file",
                },
            ],
            "dir-target",
        )

        await table.moveNodes(["dir-source"], "dir-target-parent", {
            overwriteMode: "mergeByModif",
            uniqueBy: "name",
        })

        expect(await table.get("dir-source")).toBeUndefined()
        expect(await table.get("file-target-old")).toBeUndefined()
        expect(await table.get("file-source-older")).toBeUndefined()

        const fileSourceNewer = await table.get("file-source-newer")
        const fileTargetNew = await table.get("file-target-new")
        const fileSourceOnly = await table.get("file-source-only")
        const dirTarget = await table.get("dir-target")
        const dirSourceParent = await table.get("dir-source-parent")
        const dirTargetParent = await table.get("dir-target-parent")
        const mergedChildren = await table.listNodes("dir-target", { pageSize: 20 })

        expect(fileSourceNewer).toMatchObject({
            id: "file-source-newer",
            parentId: "dir-target",
            name: "冲突文件",
            size: 3,
        })

        expect(fileTargetNew).toMatchObject({
            id: "file-target-new",
            parentId: "dir-target",
            name: "旧文件",
            size: 7,
        })

        expect(fileSourceOnly).toMatchObject({
            id: "file-source-only",
            parentId: "dir-target",
            name: "源独有文件",
            size: 2,
        })

        expect(mergedChildren.list.map((node) => node.name).sort()).toEqual(["冲突文件", "旧文件", "源独有文件"])

        expect(dirTarget).toMatchObject({
            id: "dir-target",
            csize: 12,
            ctotal: 3,
            cftotal: 3,
        })

        expect(dirSourceParent).toMatchObject({
            id: "dir-source-parent",
            csize: 0,
            ctotal: 0,
            cftotal: 0,
        })

        expect(dirTargetParent).toMatchObject({
            id: "dir-target-parent",
            csize: 17,
            ctotal: 4,
            cftotal: 3,
        })
    } finally {
        await table.close()
    }
})

test("moveNodes 支持把节点按 index 插入到目标父节点指定位置", async () => {
    const table = createTestTreeTable(`tree_move_nodes_index_insert_${Date.now()}`)
    await table.inited

    try {
        await table.createNodes(
            [
                {
                    id: "dir-source",
                    parentId: "/",
                    name: "源目录",
                    modif: 0,
                    isDir: true,
                    size: 1,
                },
                {
                    id: "dir-target",
                    parentId: "/",
                    name: "目标目录",
                    modif: 0,
                    isDir: true,
                    size: 2,
                },
            ],
            "/",
        )

        await table.createNodes(
            [
                {
                    id: "target-a",
                    parentId: "dir-target",
                    name: "A",
                    modif: 0,
                    isDir: false,
                    size: 1,
                },
                {
                    id: "target-c",
                    parentId: "dir-target",
                    name: "C",
                    modif: 0,
                    isDir: false,
                    size: 1,
                },
            ],
            "dir-target",
            { index: { toEnd: true } },
        )

        await table.createNodes(
            [
                {
                    id: "source-b",
                    parentId: "dir-source",
                    name: "B",
                    modif: 0,
                    isDir: false,
                    size: 3,
                },
            ],
            "dir-source",
        )

        await table.moveNodes(["source-b"], "dir-target", {
            index: { prevNodeId: "target-a" },
        })

        const targetChildren = await table.listNodes("dir-target", { pageSize: 20 })
        const sourceDir = await table.get("dir-source")
        const targetDir = await table.get("dir-target")
        const movedNode = await table.get("source-b")

        expect(targetChildren.list.map((node) => node.id)).toEqual(["target-a", "source-b", "target-c"])
        expect(movedNode).toMatchObject({
            id: "source-b",
            parentId: "dir-target",
            size: 3,
        })
        expect(sourceDir).toMatchObject({
            id: "dir-source",
            csize: 0,
            ctotal: 0,
            cftotal: 0,
        })
        expect(targetDir).toMatchObject({
            id: "dir-target",
            csize: 5,
            ctotal: 3,
            cftotal: 3,
        })
    } finally {
        await table.close()
    }
})

test("moveNodes 支持在同一父节点下按 index 重新排序", async () => {
    const table = createTestTreeTable(`tree_move_nodes_index_reorder_${Date.now()}`)
    await table.inited

    try {
        await table.createNodes(
            [
                {
                    id: "root-a",
                    parentId: "/",
                    name: "A",
                    modif: 0,
                    isDir: false,
                    size: 1,
                },
                {
                    id: "root-b",
                    parentId: "/",
                    name: "B",
                    modif: 0,
                    isDir: false,
                    size: 1,
                },
                {
                    id: "root-c",
                    parentId: "/",
                    name: "C",
                    modif: 0,
                    isDir: false,
                    size: 1,
                },
            ],
            "/",
            { index: { toEnd: true } },
        )

        await table.moveNodes(["root-c"], "/", {
            index: { toStart: true },
        })

        const rootNodes = await table.listNodes("/", { pageSize: 20 })
        expect(rootNodes.list.map((node) => node.id)).toEqual(["root-c", "root-a", "root-b"])
    } finally {
        await table.close()
    }
})

test("moveNodes 会在目标父节点下维护 clidLastIndex", async () => {
    const table = createTestTreeTable(`tree_move_nodes_clid_last_index_${Date.now()}`)
    await table.inited

    try {
        await table.createNodes(
            [
                {
                    id: "dir-source",
                    parentId: "/",
                    name: "源目录",
                    modif: 0,
                    isDir: true,
                    size: 1,
                },
                {
                    id: "dir-target",
                    parentId: "/",
                    name: "目标目录",
                    modif: 0,
                    isDir: true,
                    size: 1,
                },
            ],
            "/",
        )

        await table.createNodes(
            [
                {
                    id: "target-a",
                    parentId: "dir-target",
                    name: "A",
                    modif: 0,
                    isDir: false,
                    size: 1,
                },
            ],
            "dir-target",
            { index: { toEnd: true } },
        )

        await table.createNodes(
            [
                {
                    id: "source-b",
                    parentId: "dir-source",
                    name: "B",
                    modif: 0,
                    isDir: false,
                    size: 1,
                },
            ],
            "dir-source",
        )

        await table.moveNodes(["source-b"], "dir-target", {
            index: { toEnd: true },
        })

        const targetDir = await table.get("dir-target")
        const targetChildren = await table.listNodes("dir-target", { pageSize: 20 })

        expect(targetChildren.list.map((node) => node.id)).toEqual(["target-a", "source-b"])
        expect(targetDir?.clidLastIndex).toBe(targetChildren.list[1].index)
    } finally {
        await table.close()
    }
})

test("moveNodes 在已进入索引模式的父节点下会默认追加 index", async () => {
    const table = createTestTreeTable(`tree_move_nodes_auto_append_index_${Date.now()}`)
    await table.inited

    try {
        await table.createNodes(
            [
                {
                    id: "dir-source",
                    parentId: "/",
                    name: "源目录",
                    modif: 0,
                    isDir: true,
                    size: 1,
                },
                {
                    id: "dir-target",
                    parentId: "/",
                    name: "目标目录",
                    modif: 0,
                    isDir: true,
                    size: 1,
                },
            ],
            "/",
        )

        await table.createNodes(
            [
                {
                    id: "target-a",
                    parentId: "dir-target",
                    name: "A",
                    modif: 0,
                    isDir: false,
                    size: 1,
                },
            ],
            "dir-target",
            { index: { toEnd: true } },
        )

        await table.createNodes(
            [
                {
                    id: "source-b",
                    parentId: "dir-source",
                    name: "B",
                    modif: 0,
                    isDir: false,
                    size: 1,
                },
            ],
            "dir-source",
        )

        await table.moveNodes(["source-b"], "dir-target")

        const targetChildren = await table.listNodes("dir-target", { pageSize: 20 })
        expect(targetChildren.list.map((node) => node.id)).toEqual(["target-a", "source-b"])
        expect(targetChildren.list.every((node) => typeof node.index === "number")).toBe(true)
    } finally {
        await table.close()
    }
})