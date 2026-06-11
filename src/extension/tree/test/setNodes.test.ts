import { SQLiteAdapter } from "../../../adapter/SQLite/SQLiteAdapter"
import { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"

function createTestTreeTable(tableName: string) {
    return new TableTree<ITreeNode>({
        name: tableName,
        adapter: SQLiteAdapter({ filename: ":memory:" }),
    })
}

test("setNodes 会忽略外部统计字段并在改 parentId 后重建新旧祖先统计", async () => {
    const table = createTestTreeTable(`tree_set_nodes_${Date.now()}`)
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
                    id: "dir-b",
                    parentId: "/",
                    name: "目录B",
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
                    id: "file-a",
                    parentId: "dir-a",
                    name: "文件A",
                    modif: 0,
                    isDir: false,
                    size: 3,
                },
            ],
            "dir-a",
        )

        await table.setNodes([
            {
                id: "file-a",
                parentId: "dir-b",
                size: 7,
                csize: 999,
                ctotal: 888,
                cftotal: 777,
            } as any,
        ])

        const dirANode = await table.get("dir-a")
        const dirBNode = await table.get("dir-b")
        const fileNode = await table.get("file-a")

        expect(fileNode).toMatchObject({
            id: "file-a",
            parentId: "dir-b",
            size: 7,
            csize: 0,
            ctotal: 0,
            cftotal: 0,
        })

        expect(dirANode).toMatchObject({
            id: "dir-a",
            csize: 0,
            ctotal: 0,
            cftotal: 0,
        })

        expect(dirBNode).toMatchObject({
            id: "dir-b",
            csize: 7,
            ctotal: 1,
            cftotal: 1,
        })
    } finally {
        await table.close()
    }
})

test("setNodes 支持按 name 替换目标父节点下的冲突节点", async () => {
    const table = createTestTreeTable(`tree_set_nodes_replace_${Date.now()}`)
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
            ],
            "/",
        )

        await table.createNodes(
            [
                {
                    id: "file-old",
                    parentId: "dir-a",
                    name: "同名文件",
                    modif: 1,
                    isDir: false,
                    size: 5,
                },
            ],
            "dir-a",
        )

        await table.setNodes(
            [
                {
                    id: "file-new",
                    parentId: "dir-a",
                    name: "同名文件",
                    modif: 2,
                    isDir: false,
                    size: 3,
                },
            ],
            {
                uniqueBy: "name",
            },
        )

        expect(await table.get("file-old")).toBeUndefined()

        const dirNode = await table.get("dir-a")
        const newNode = await table.get("file-new")

        expect(newNode).toMatchObject({
            id: "file-new",
            parentId: "dir-a",
            name: "同名文件",
            size: 3,
        })

        expect(dirNode).toMatchObject({
            id: "dir-a",
            csize: 3,
            ctotal: 1,
            cftotal: 1,
        })
    } finally {
        await table.close()
    }
})

test("setNodes 支持在 newName 模式下自动改名后再写入", async () => {
    const table = createTestTreeTable(`tree_set_nodes_new_name_${Date.now()}`)
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
            ],
            "/",
        )

        await table.createNodes(
            [
                {
                    id: "file-old",
                    parentId: "dir-a",
                    name: "同名文件",
                    modif: 1,
                    isDir: false,
                    size: 5,
                },
            ],
            "dir-a",
        )

        await table.setNodes(
            [
                {
                    id: "file-new",
                    parentId: "dir-a",
                    name: "同名文件",
                    modif: 2,
                    isDir: false,
                    size: 3,
                },
            ],
            {
                overwriteMode: "newName",
            },
        )

        const oldNode = await table.get("file-old")
        const newNode = await table.get("file-new")
        const children = await table.listNodes("dir-a", { pageSize: 20 })

        expect(oldNode).toMatchObject({
            id: "file-old",
            parentId: "dir-a",
            name: "同名文件",
            size: 5,
        })

        expect(newNode).toMatchObject({
            id: "file-new",
            parentId: "dir-a",
            name: "同名文件 (1)",
            size: 3,
        })

        expect(children.list.map((node) => node.name).sort()).toEqual(["同名文件", "同名文件 (1)"])
    } finally {
        await table.close()
    }
})

test("setNodes 支持在 merge 模式下把同名目录折叠到目标目录并写入子节点", async () => {
    const table = createTestTreeTable(`tree_set_nodes_merge_${Date.now()}`)
    await table.inited

    try {
        await table.createNodes(
            [
                {
                    id: "dir-parent",
                    parentId: "/",
                    name: "父目录",
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
                    id: "dir-target",
                    parentId: "dir-parent",
                    name: "公共目录",
                    modif: 1,
                    isDir: true,
                    size: 5,
                },
            ],
            "dir-parent",
        )

        await table.createNodes(
            [
                {
                    id: "file-old",
                    parentId: "dir-target",
                    name: "旧文件",
                    modif: 1,
                    isDir: false,
                    size: 6,
                },
            ],
            "dir-target",
        )

        await table.setNodes(
            [
                {
                    id: "dir-source",
                    parentId: "dir-parent",
                    name: "公共目录",
                    modif: 9,
                    isDir: true,
                    size: 4,
                },
                {
                    id: "file-new",
                    parentId: "dir-source",
                    name: "新文件",
                    modif: 2,
                    isDir: false,
                    size: 3,
                },
            ],
            {
                overwriteMode: "merge",
                uniqueBy: "name",
            },
        )

        expect(await table.get("dir-source")).toBeUndefined()

        const dirTarget = await table.get("dir-target")
        const fileNew = await table.get("file-new")
        const dirParent = await table.get("dir-parent")
        const children = await table.listNodes("dir-target", { pageSize: 20 })

        expect(dirTarget).toMatchObject({
            id: "dir-target",
            parentId: "dir-parent",
            name: "公共目录",
            modif: 9,
            size: 4,
            csize: 9,
            ctotal: 2,
            cftotal: 2,
        })

        expect(fileNew).toMatchObject({
            id: "file-new",
            parentId: "dir-target",
            name: "新文件",
            size: 3,
        })

        expect(children.list.map((node) => node.name).sort()).toEqual(["新文件", "旧文件"])

        expect(dirParent).toMatchObject({
            id: "dir-parent",
            csize: 13,
            ctotal: 3,
            cftotal: 2,
        })
    } finally {
        await table.close()
    }
})

test("setNodes 支持在 mergeByModif 模式下仅用较新的目录元数据覆盖目标目录", async () => {
    const table = createTestTreeTable(`tree_set_nodes_merge_by_modif_${Date.now()}`)
    await table.inited

    try {
        await table.createNodes(
            [
                {
                    id: "dir-parent",
                    parentId: "/",
                    name: "父目录",
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
                    id: "dir-target",
                    parentId: "dir-parent",
                    name: "公共目录",
                    modif: 10,
                    isDir: true,
                    size: 7,
                },
            ],
            "dir-parent",
        )

        await table.createNodes(
            [
                {
                    id: "file-old",
                    parentId: "dir-target",
                    name: "旧文件",
                    modif: 8,
                    isDir: false,
                    size: 6,
                },
            ],
            "dir-target",
        )

        await table.setNodes(
            [
                {
                    id: "dir-source",
                    parentId: "dir-parent",
                    name: "公共目录",
                    modif: 5,
                    isDir: true,
                    size: 4,
                },
                {
                    id: "file-newer",
                    parentId: "dir-source",
                    name: "冲突文件",
                    modif: 20,
                    isDir: false,
                    size: 3,
                },
                {
                    id: "file-older",
                    parentId: "dir-source",
                    name: "旧文件",
                    modif: 2,
                    isDir: false,
                    size: 9,
                },
            ],
            {
                overwriteMode: "mergeByModif",
                uniqueBy: "name",
            },
        )

        expect(await table.get("dir-source")).toBeUndefined()
        expect(await table.get("file-older")).toBeUndefined()

        const dirTarget = await table.get("dir-target")
        const fileNewer = await table.get("file-newer")
        const fileOld = await table.get("file-old")
        const children = await table.listNodes("dir-target", { pageSize: 20 })

        expect(dirTarget).toMatchObject({
            id: "dir-target",
            parentId: "dir-parent",
            name: "公共目录",
            modif: 10,
            size: 7,
            csize: 9,
            ctotal: 2,
            cftotal: 2,
        })

        expect(fileNewer).toMatchObject({
            id: "file-newer",
            parentId: "dir-target",
            name: "冲突文件",
            size: 3,
        })

        expect(fileOld).toMatchObject({
            id: "file-old",
            parentId: "dir-target",
            name: "旧文件",
            size: 6,
        })

        expect(children.list.map((node) => node.name).sort()).toEqual(["冲突文件", "旧文件"])
    } finally {
        await table.close()
    }
})

test("setNodes 支持按 index 把新节点插入到指定位置", async () => {
    const table = createTestTreeTable(`tree_set_nodes_index_insert_${Date.now()}`)
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

        await table.setNodes(
            [
                {
                    id: "root-b",
                    parentId: "/",
                    name: "B",
                    modif: 0,
                    isDir: false,
                    size: 1,
                },
            ],
            {
                index: { prevNodeId: "root-a" },
            },
        )

        const rootNodes = await table.listNodes("/", { pageSize: 20 })
        expect(rootNodes.list.map((node) => node.id)).toEqual(["root-a", "root-b", "root-c"])
    } finally {
        await table.close()
    }
})

test("setNodes 支持在同一父节点下仅通过 index 重新排序现有节点", async () => {
    const table = createTestTreeTable(`tree_set_nodes_index_reorder_${Date.now()}`)
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

        await table.setNodes(
            [
                {
                    id: "root-c",
                },
            ],
            {
                index: { toStart: true },
            },
        )

        const rootNodes = await table.listNodes("/", { pageSize: 20 })
        expect(rootNodes.list.map((node) => node.id)).toEqual(["root-c", "root-a", "root-b"])
    } finally {
        await table.close()
    }
})

test("setNodes 会在目标父节点下维护 clidLastIndex", async () => {
    const table = createTestTreeTable(`tree_set_nodes_clid_last_index_${Date.now()}`)
    await table.inited

    try {
        await table.createNodes(
            [
                {
                    id: "dir-parent",
                    parentId: "/",
                    name: "父目录",
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
                    id: "child-a",
                    parentId: "dir-parent",
                    name: "A",
                    modif: 0,
                    isDir: false,
                    size: 1,
                },
            ],
            "dir-parent",
            { index: { toEnd: true } },
        )

        await table.setNodes(
            [
                {
                    id: "child-b",
                    parentId: "dir-parent",
                    name: "B",
                    modif: 0,
                    isDir: false,
                    size: 1,
                    clidLastIndex: 888,
                } as any,
            ],
            {
                index: { toEnd: true },
            },
        )

        const parentNode = await table.get("dir-parent")
        const children = await table.listNodes("dir-parent", { pageSize: 20 })

        expect(children.list.map((node) => node.id)).toEqual(["child-a", "child-b"])
        expect(parentNode?.clidLastIndex).toBe(children.list[1].index)
        expect(children.list.find((node) => node.id === "child-b")?.clidLastIndex).toBeUndefined()
    } finally {
        await table.close()
    }
})

test("setNodes 在已进入索引模式的父节点下会默认追加 index", async () => {
    const table = createTestTreeTable(`tree_set_nodes_auto_append_index_${Date.now()}`)
    await table.inited

    try {
        await table.createNodes(
            [
                {
                    id: "dir-parent",
                    parentId: "/",
                    name: "父目录",
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
                    id: "child-a",
                    parentId: "dir-parent",
                    name: "A",
                    modif: 0,
                    isDir: false,
                    size: 1,
                },
            ],
            "dir-parent",
            { index: { toEnd: true } },
        )

        await table.setNodes([
            {
                id: "child-b",
                parentId: "dir-parent",
                name: "B",
                modif: 0,
                isDir: false,
                size: 1,
            },
        ])

        const children = await table.listNodes("dir-parent", { pageSize: 20 })
        expect(children.list.map((node) => node.id)).toEqual(["child-a", "child-b"])
        expect(children.list.every((node) => typeof node.index === "number")).toBe(true)
    } finally {
        await table.close()
    }
})