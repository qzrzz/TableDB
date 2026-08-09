import { SQLiteAdapter } from "../../../adapter/SQLite"
import { defineTableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"

interface ITestTreeNode extends ITreeNode {
    tag?: string
    meta?: {
        hash_md5?: string
        group?: string
    }
}

let tableIndex = 0

async function createDefinedTreeTable(name: string) {
    const useTreeTable = defineTableTree<ITestTreeNode>({
        name: `test-tree-pre-overwrite-${tableIndex++}-${name}`,
        adapter: SQLiteAdapter({ filename: ":memory:", driver: "better-sqlite3" }),
        enableMarkDelete: true,
    })

    return await useTreeTable()
}

async function createOverwriteFixture() {
    const table = await createDefinedTreeTable("fixture")
    await table.createNodes(
        [
            { id: "target", name: "目标目录", isDir: true },
            { id: "other", name: "其他目录", isDir: true },
            { id: "src", name: "来源目录", isDir: true },
        ],
        "/",
    )
    await table.createNodes(
        [
            {
                id: "target-same",
                name: "same.txt",
                isDir: false,
                type: "text",
                tag: "target",
                meta: { hash_md5: "hash-1", group: "target" },
            },
            {
                id: "target-image",
                name: "image.png",
                isDir: false,
                type: "image",
                tag: "target",
                meta: { hash_md5: "hash-2", group: "target" },
            },
            {
                id: "target-dir",
                name: "same-dir",
                isDir: true,
                type: "dir",
                tag: "target",
                meta: { hash_md5: "hash-dir", group: "target" },
            },
        ],
        "target",
    )
    await table.createNodes(
        [
            {
                id: "other-same",
                name: "same.txt",
                isDir: false,
                type: "text",
                tag: "other",
                meta: { hash_md5: "hash-1", group: "other" },
            },
        ],
        "other",
    )
    await table.createNodes(
        [
            {
                id: "source-same",
                name: "same.txt",
                isDir: false,
                type: "text",
                tag: "source",
                meta: { hash_md5: "hash-1", group: "source" },
            },
            {
                id: "source-new",
                name: "new.txt",
                isDir: false,
                type: "text",
                tag: "source",
                meta: { hash_md5: "hash-new", group: "source" },
            },
        ],
        "src",
    )
    return table
}

describe("TableTree preOverwriteNodes", () => {
    test("没有可检测值时应返回无冲突", async () => {
        const table = await createDefinedTreeTable("empty-values")

        await expect(table.preOverwriteNodes([{}], [], "/")).resolves.toEqual({
            isConflict: false,
            existNodes: [],
        })
        await expect(table.preOverwriteNodes([], ["missing"], "/")).resolves.toEqual({
            isConflict: false,
            existNodes: [],
        })
    })

    test("默认应按 id 检测目标父级下的冲突节点", async () => {
        const table = await createOverwriteFixture()

        const result = await table.preOverwriteNodes(
            [
                { id: "target-same", name: "incoming.txt", parentId: "/", isDir: false },
                { id: "missing", name: "missing.txt", parentId: "/", isDir: false },
            ],
            [],
            "target",
        )

        expect(result.isConflict).toBe(true)
        expect(result.existNodes.map((node) => node.id)).toEqual(["target-same"])
    })

    test("只应检测目标父级的直属子节点", async () => {
        const table = await createOverwriteFixture()

        const result = await table.preOverwriteNodes(
            [{ id: "other-same", name: "same.txt", parentId: "/", isDir: false }],
            [],
            "target",
        )

        expect(result.isConflict).toBe(false)
        expect(result.existNodes).toEqual([])
    })

    test("uniqueBy name 应按名称检测节点数据冲突", async () => {
        const table = await createOverwriteFixture()

        const result = await table.preOverwriteNodes(
            [
                { id: "incoming", name: "same.txt", parentId: "/", isDir: false },
                { id: "incoming-new", name: "not-exists.txt", parentId: "/", isDir: false },
            ],
            [],
            "target",
            { uniqueBy: "name" },
        )

        expect(result.isConflict).toBe(true)
        expect(result.existNodes.map((node) => node.id)).toEqual(["target-same"])
    })

    test("nodeIds 应读取来源节点并参与冲突检测", async () => {
        const table = await createOverwriteFixture()

        const result = await table.preOverwriteNodes([], ["source-same", "source-new"], "target", {
            uniqueBy: "name",
        })

        expect(result.isConflict).toBe(true)
        expect(result.existNodes.map((node) => node.id)).toEqual(["target-same"])
    })

    test("预检移动父子混合选择时不应把后代节点当作目标父级直属冲突", async () => {
        const table = await createDefinedTreeTable("nested-move-roots")

        await table.createNodes(
            [
                { id: "source", name: "来源", isDir: true },
                { id: "target", name: "目标", isDir: true },
            ],
            "/",
        )
        await table.createNodes([{ id: "source-dir", name: "目录", isDir: true }], "source")
        await table.createNodes([{ id: "source-child", name: "same.txt", isDir: false, size: 1 }], "source-dir")
        await table.createNodes([{ id: "target-same", name: "same.txt", isDir: false, size: 2 }], "target")

        const result = await table.preOverwriteNodes([], ["source-dir", "source-child"], "target", {
            uniqueBy: "name",
        })

        expect(result).toEqual({ isConflict: false, existNodes: [] })

        await table.moveNodes(["source-dir", "source-child"], "target", { uniqueBy: "name", overwriteMode: "skip" })
        expect((await table.get("source-dir"))?.parentId).toBe("target")
        expect((await table.get("source-child"))?.parentId).toBe("source-dir")
        expect((await table.get("target-same"))?.parentId).toBe("target")
    })

    test("nodes 和 nodeIds 的检测值应合并去重", async () => {
        const table = await createOverwriteFixture()

        const result = await table.preOverwriteNodes(
            [{ id: "incoming", name: "same.txt", parentId: "/", isDir: false }],
            ["source-same"],
            "target",
            { uniqueBy: "name" },
        )

        expect(result.isConflict).toBe(true)
        expect(result.existNodes.map((node) => node.id)).toEqual(["target-same"])
    })

    test("uniqueBy 应支持点路径字段", async () => {
        const table = await createOverwriteFixture()

        const result = await table.preOverwriteNodes(
            [{ id: "incoming", name: "hash-file.txt", parentId: "/", isDir: false, meta: { hash_md5: "hash-2" } }],
            [],
            "target",
            { uniqueBy: "meta.hash_md5" },
        )

        expect(result.isConflict).toBe(true)
        expect(result.existNodes.map((node) => node.id)).toEqual(["target-image"])
    })

    test("projection 应限制返回的 existNodes 字段", async () => {
        const table = await createOverwriteFixture()

        const result = await table.preOverwriteNodes(
            [{ id: "incoming", name: "same.txt", parentId: "/", isDir: false }],
            [],
            "target",
            { uniqueBy: "name", projection: ["id", "name"] },
        )

        expect(result.isConflict).toBe(true)
        expect(result.existNodes).toEqual([{ id: "target-same", name: "same.txt" }])
    })

    test("overwriteMode 不应影响预检冲突结果", async () => {
        const table = await createOverwriteFixture()

        const skipResult = await table.preOverwriteNodes(
            [{ id: "incoming", name: "same.txt", parentId: "/", isDir: false }],
            [],
            "target",
            { uniqueBy: "name", overwriteMode: "skip" },
        )
        const newNameResult = await table.preOverwriteNodes(
            [{ id: "incoming", name: "same.txt", parentId: "/", isDir: false }],
            [],
            "target",
            { uniqueBy: "name", overwriteMode: "newName" },
        )

        expect(skipResult.isConflict).toBe(true)
        expect(newNameResult.isConflict).toBe(true)
        expect(skipResult.existNodes.map((node) => node.id)).toEqual(["target-same"])
        expect(newNameResult.existNodes.map((node) => node.id)).toEqual(["target-same"])
    })

    test("预检不应修改现有节点和来源节点", async () => {
        const table = await createOverwriteFixture()

        await table.preOverwriteNodes([], ["source-same"], "target", { uniqueBy: "name" })

        expect((await table.get("source-same"))?.parentId).toBe("src")
        expect((await table.get("target-same"))?.parentId).toBe("target")
        expect((await table.get("target-same"))?.tag).toBe("target")
    })

    test("标记删除模式下默认不返回已删除冲突节点", async () => {
        const table = await createOverwriteFixture()

        await table.deleteNodes(["target-same"])
        const result = await table.preOverwriteNodes(
            [{ id: "incoming", name: "same.txt", parentId: "/", isDir: false }],
            [],
            "target",
            { uniqueBy: "name" },
        )

        expect(result.isConflict).toBe(false)
        expect(result.existNodes).toEqual([])
    })
})
