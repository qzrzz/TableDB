import { SQLiteAdapter } from "../../../adapter/SQLite/SQLiteAdapter"
import { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"

function createTestTreeTable(tableName: string) {
    return new TableTree<ITreeNode>({
        name: tableName,
        adapter: SQLiteAdapter({ filename: ":memory:" }),
    })
}

test("checkNodes 会在目标父节点下按 id 检测直属冲突", async () => {
    const table = createTestTreeTable(`tree_check_nodes_id_${Date.now()}`)
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
                    type: "dir",
                },
            ],
            "/",
        )

        const result = await table.checkNodes(
            [
                {
                    id: "dir-a",
                    name: "另一个目录A",
                },
                {
                    id: "dir-b",
                    name: "目录B",
                },
            ],
            "/",
        )

        expect(result.isConflict).toBe(true)
        expect(result.existNodes.map((node) => node.id)).toEqual(["dir-a"])
    } finally {
        await table.close()
    }
})

test("checkNodes 在 replace 语义下会跳过文件覆盖目录被禁止的情况", async () => {
    const table = createTestTreeTable(`tree_check_nodes_replace_skip_${Date.now()}`)
    await table.inited

    try {
        await table.createNodes(
            [
                {
                    id: "file-a",
                    parentId: "/",
                    name: "同名节点",
                    modif: 0,
                    isDir: false,
                    size: 1,
                    type: "file",
                },
                {
                    id: "dir-a",
                    parentId: "/",
                    name: "同名节点",
                    modif: 0,
                    isDir: true,
                    size: 1,
                    type: "dir",
                },
            ],
            "/",
        )

        const result = await table.checkNodes(
            [
                {
                    id: "new-node",
                    name: "同名节点",
                    isDir: false,
                    modif: 0,
                },
            ],
            "/",
            {
                uniqueBy: "name",
            },
        )

        expect(result.isConflict).toBe(false)
        expect(result.existNodes).toEqual([])
    } finally {
        await table.close()
    }
})

test("checkNodes 在 replace 语义下允许文件覆盖目录时会返回将被影响的节点", async () => {
    const table = createTestTreeTable(`tree_check_nodes_replace_allow_dir_${Date.now()}`)
    await table.inited

    try {
        await table.createNodes(
            [
                {
                    id: "file-a",
                    parentId: "/",
                    name: "同名节点",
                    modif: 0,
                    isDir: false,
                    size: 1,
                    type: "file",
                },
                {
                    id: "dir-a",
                    parentId: "/",
                    name: "同名节点",
                    modif: 0,
                    isDir: true,
                    size: 1,
                    type: "dir",
                },
            ],
            "/",
        )

        const result = await table.checkNodes(
            [
                {
                    id: "new-node",
                    name: "同名节点",
                    isDir: false,
                    modif: 0,
                },
            ],
            "/",
            {
                uniqueBy: "name",
                enableFileOverwriteDir: true,
            },
        )

        expect(result.isConflict).toBe(true)
        expect(result.existNodes.map((node) => node.id).sort()).toEqual(["dir-a", "file-a"])
    } finally {
        await table.close()
    }
})

test("checkNodes 在 newName 模式下不会把重名节点视为实际覆盖冲突", async () => {
    const table = createTestTreeTable(`tree_check_nodes_new_name_${Date.now()}`)
    await table.inited

    try {
        await table.createNodes(
            [
                {
                    id: "file-a",
                    parentId: "/",
                    name: "同名节点",
                    modif: 0,
                    isDir: false,
                    size: 1,
                },
            ],
            "/",
        )

        const result = await table.checkNodes(
            [
                {
                    id: "new-node",
                    name: "同名节点",
                    isDir: false,
                    modif: 0,
                },
            ],
            "/",
            {
                uniqueBy: "name",
                overwriteMode: "newName",
            },
        )

        expect(result.isConflict).toBe(false)
        expect(result.existNodes).toEqual([])
    } finally {
        await table.close()
    }
})

test("checkNodes 在 merge 模式下会返回将被合并的目标目录", async () => {
    const table = createTestTreeTable(`tree_check_nodes_merge_${Date.now()}`)
    await table.inited

    try {
        await table.createNodes(
            [
                {
                    id: "dir-a",
                    parentId: "/",
                    name: "公共目录",
                    modif: 1,
                    isDir: true,
                    size: 1,
                },
            ],
            "/",
        )

        const result = await table.checkNodes(
            [
                {
                    id: "dir-b",
                    name: "公共目录",
                    isDir: true,
                    modif: 2,
                },
            ],
            "/",
            {
                uniqueBy: "name",
                overwriteMode: "merge",
            },
        )

        expect(result.isConflict).toBe(true)
        expect(result.existNodes).toHaveLength(1)
        expect(result.existNodes[0]).toMatchObject({
            id: "dir-a",
            isDir: true,
            name: "公共目录",
        })
    } finally {
        await table.close()
    }
})

test("checkNodes 在 mergeByModif 模式下会跳过较新的目标节点", async () => {
    const table = createTestTreeTable(`tree_check_nodes_merge_by_modif_${Date.now()}`)
    await table.inited

    try {
        await table.createNodes(
            [
                {
                    id: "file-a",
                    parentId: "/",
                    name: "冲突文件",
                    modif: 9,
                    isDir: false,
                    size: 1,
                },
            ],
            "/",
        )

        const result = await table.checkNodes(
            [
                {
                    id: "file-b",
                    name: "冲突文件",
                    modif: 3,
                    isDir: false,
                },
            ],
            "/",
            {
                uniqueBy: "name",
                overwriteMode: "mergeByModif",
            },
        )

        expect(result.isConflict).toBe(false)
        expect(result.existNodes).toEqual([])
    } finally {
        await table.close()
    }
})

test("checkNodes 在 merge 模式下会递归返回批量写入子树里真正会受影响的目标节点", async () => {
    const table = createTestTreeTable(`tree_check_nodes_merge_deep_batch_${Date.now()}`)
    await table.inited

    try {
        await table.createNodes(
            [
                {
                    id: "dir-target",
                    parentId: "/",
                    name: "公共目录",
                    modif: 1,
                    isDir: true,
                    size: 1,
                },
            ],
            "/",
        )

        await table.createNodes(
            [
                {
                    id: "dir-target-child",
                    parentId: "dir-target",
                    name: "子目录",
                    modif: 1,
                    isDir: true,
                    size: 1,
                },
            ],
            "dir-target",
        )

        await table.createNodes(
            [
                {
                    id: "file-target",
                    parentId: "dir-target-child",
                    name: "冲突文件",
                    modif: 1,
                    isDir: false,
                    size: 1,
                },
            ],
            "dir-target-child",
        )

        const result = await table.checkNodes(
            [
                {
                    id: "dir-source",
                    parentId: "/",
                    name: "公共目录",
                    modif: 2,
                    isDir: true,
                },
                {
                    id: "dir-source-child",
                    parentId: "dir-source",
                    name: "子目录",
                    modif: 2,
                    isDir: true,
                },
                {
                    id: "file-source",
                    parentId: "dir-source-child",
                    name: "冲突文件",
                    modif: 3,
                    isDir: false,
                },
            ],
            "/",
            {
                uniqueBy: "name",
                overwriteMode: "merge",
            },
        )

        expect(result.isConflict).toBe(true)
        expect(result.existNodes.map((node) => node.id).sort()).toEqual([
            "dir-target",
            "dir-target-child",
            "file-target",
        ])
    } finally {
        await table.close()
    }
})

test("checkNodes 在 merge 模式下会按现有表内子树继续展开深层预检", async () => {
    const table = createTestTreeTable(`tree_check_nodes_merge_deep_db_${Date.now()}`)
    await table.inited

    try {
        await table.createNodes(
            [
                {
                    id: "dir-source",
                    parentId: "/",
                    name: "源目录",
                    modif: 1,
                    isDir: true,
                    size: 1,
                },
                {
                    id: "dir-target-parent",
                    parentId: "/",
                    name: "目标父目录",
                    modif: 1,
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
                    parentId: "dir-target-parent",
                    name: "源目录",
                    modif: 1,
                    isDir: true,
                    size: 1,
                },
            ],
            "dir-target-parent",
        )

        await table.createNodes(
            [
                {
                    id: "dir-target-child",
                    parentId: "dir-target",
                    name: "子目录",
                    modif: 1,
                    isDir: true,
                    size: 1,
                },
            ],
            "dir-target",
        )

        await table.createNodes(
            [
                {
                    id: "file-target",
                    parentId: "dir-target-child",
                    name: "冲突文件",
                    modif: 1,
                    isDir: false,
                    size: 1,
                },
            ],
            "dir-target-child",
        )

        await table.createNodes(
            [
                {
                    id: "dir-source-child",
                    parentId: "dir-source",
                    name: "子目录",
                    modif: 2,
                    isDir: true,
                    size: 1,
                },
            ],
            "dir-source",
        )

        await table.createNodes(
            [
                {
                    id: "file-source",
                    parentId: "dir-source-child",
                    name: "冲突文件",
                    modif: 3,
                    isDir: false,
                    size: 1,
                },
            ],
            "dir-source-child",
        )

        const sourceRoot = await table.get("dir-source")
        expect(sourceRoot).toBeDefined()

        const result = await table.checkNodes(
            [sourceRoot!],
            "dir-target-parent",
            {
                uniqueBy: "name",
                overwriteMode: "merge",
            },
        )

        expect(result.isConflict).toBe(true)
        expect(result.existNodes.map((node) => node.id).sort()).toEqual([
            "dir-target",
            "dir-target-child",
            "file-target",
        ])
    } finally {
        await table.close()
    }
})

test("checkNodes 在 mergeByModif 模式下会递归跳过较新的深层目标文件", async () => {
    const table = createTestTreeTable(`tree_check_nodes_merge_by_modif_deep_${Date.now()}`)
    await table.inited

    try {
        await table.createNodes(
            [
                {
                    id: "dir-target",
                    parentId: "/",
                    name: "公共目录",
                    modif: 9,
                    isDir: true,
                    size: 1,
                },
            ],
            "/",
        )

        await table.createNodes(
            [
                {
                    id: "dir-target-child",
                    parentId: "dir-target",
                    name: "子目录",
                    modif: 9,
                    isDir: true,
                    size: 1,
                },
            ],
            "dir-target",
        )

        await table.createNodes(
            [
                {
                    id: "file-target",
                    parentId: "dir-target-child",
                    name: "冲突文件",
                    modif: 9,
                    isDir: false,
                    size: 1,
                },
            ],
            "dir-target-child",
        )

        const result = await table.checkNodes(
            [
                {
                    id: "dir-source",
                    parentId: "/",
                    name: "公共目录",
                    modif: 2,
                    isDir: true,
                },
                {
                    id: "dir-source-child",
                    parentId: "dir-source",
                    name: "子目录",
                    modif: 3,
                    isDir: true,
                },
                {
                    id: "file-source",
                    parentId: "dir-source-child",
                    name: "冲突文件",
                    modif: 1,
                    isDir: false,
                },
            ],
            "/",
            {
                uniqueBy: "name",
                overwriteMode: "mergeByModif",
            },
        )

        expect(result.isConflict).toBe(true)
        expect(result.existNodes.map((node) => node.id).sort()).toEqual([
            "dir-target",
            "dir-target-child",
        ])
    } finally {
        await table.close()
    }
})

test("checkNodes 在混合批次里也会继续展开表内已有目录的深层预检", async () => {
    const table = createTestTreeTable(`tree_check_nodes_merge_mixed_batch_${Date.now()}`)
    await table.inited

    try {
        await table.createNodes(
            [
                {
                    id: "dir-source-existing",
                    parentId: "/",
                    name: "源目录",
                    modif: 5,
                    isDir: true,
                    size: 1,
                },
                {
                    id: "dir-target-parent",
                    parentId: "/",
                    name: "目标父目录",
                    modif: 1,
                    isDir: true,
                    size: 1,
                },
            ],
            "/",
        )

        await table.createNodes(
            [
                {
                    id: "dir-source-existing-child",
                    parentId: "dir-source-existing",
                    name: "深层目录",
                    modif: 6,
                    isDir: true,
                    size: 1,
                },
            ],
            "dir-source-existing",
        )

        await table.createNodes(
            [
                {
                    id: "file-source-existing",
                    parentId: "dir-source-existing-child",
                    name: "深层冲突文件",
                    modif: 7,
                    isDir: false,
                    size: 1,
                },
            ],
            "dir-source-existing-child",
        )

        await table.createNodes(
            [
                {
                    id: "dir-target-existing",
                    parentId: "dir-target-parent",
                    name: "源目录",
                    modif: 1,
                    isDir: true,
                    size: 1,
                },
            ],
            "dir-target-parent",
        )

        await table.createNodes(
            [
                {
                    id: "dir-target-existing-child",
                    parentId: "dir-target-existing",
                    name: "深层目录",
                    modif: 1,
                    isDir: true,
                    size: 1,
                },
            ],
            "dir-target-existing",
        )

        await table.createNodes(
            [
                {
                    id: "file-target-existing",
                    parentId: "dir-target-existing-child",
                    name: "深层冲突文件",
                    modif: 1,
                    isDir: false,
                    size: 1,
                },
            ],
            "dir-target-existing-child",
        )

        const sourceRoot = await table.get("dir-source-existing")
        expect(sourceRoot).toBeDefined()

        const result = await table.checkNodes(
            [
                sourceRoot!,
                {
                    id: "dir-source-batch",
                    parentId: "/",
                    name: "另一目录",
                    modif: 3,
                    isDir: true,
                },
                {
                    id: "file-source-batch",
                    parentId: "dir-source-batch",
                    name: "批次文件",
                    modif: 4,
                    isDir: false,
                },
            ],
            "dir-target-parent",
            {
                uniqueBy: "name",
                overwriteMode: "merge",
            },
        )

        expect(result.isConflict).toBe(true)
        expect(result.existNodes.map((node) => node.id).sort()).toEqual([
            "dir-target-existing",
            "dir-target-existing-child",
            "file-target-existing",
        ])
    } finally {
        await table.close()
    }
})