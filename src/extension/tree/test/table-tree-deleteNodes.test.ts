import { SQLiteAdapter } from "../../../adapter/SQLite"
import { TableTree, defineTableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"

interface ITestTreeNode extends ITreeNode {
    tag?: string
}

let tableIndex = 0

async function createDefinedTreeTable(name: string, enableMarkDelete: boolean) {
    const useTreeTable = defineTableTree<ITestTreeNode>({
        name: `test-tree-delete-${tableIndex++}-${name}`,
        adapter: SQLiteAdapter({ filename: ":memory:", driver: "better-sqlite3" }),
        enableMarkDelete,
    })

    return await useTreeTable()
}

async function createDeleteFixture(table: TableTree<ITestTreeNode>) {
    await table.createNodes([{ id: "root", name: "根目录", isDir: true }], "/")
    await table.createNodes(
        [
            { id: "dir", name: "目录", isDir: true },
            { id: "root-file", name: "root.txt", isDir: false, size: 5 },
        ],
        "root",
    )
    await table.createNodes(
        [
            { id: "child-file", name: "child.txt", isDir: false, size: 10 },
            { id: "child-dir", name: "子目录", isDir: true },
        ],
        "dir",
    )
    await table.createNodes([{ id: "deep-file", name: "deep.txt", isDir: false, size: 20 }], "child-dir")
}

async function listChildIds(table: TableTree<ITestTreeNode>, parentId: string, ignoreMarkDelete = false) {
    const result = await table.listNodes(parentId, { pageSize: 50, ignoreMarkDelete })
    return result.list.map((node) => node.id)
}

describe("TableTree deleteNodes / unDeleteNodes 标记删除模式", () => {
    test("空节点列表和不存在节点应返回空删除结果", async () => {
        const table = await createDefinedTreeTable("mark-empty", true)

        await expect(table.deleteNodes([])).resolves.toEqual({
            hasDeleted: false,
            hasChildDeleted: false,
            deletedCount: 0,
        })
        await expect(table.deleteNodes(["", "missing"])).resolves.toEqual({
            hasDeleted: false,
            hasChildDeleted: false,
            deletedCount: 0,
        })
    })

    test("删除单个文件应标记删除并刷新父级统计信息", async () => {
        const table = await createDefinedTreeTable("mark-file", true)
        await createDeleteFixture(table)

        const result = await table.deleteNodes(["child-file"])

        expect(result).toEqual({
            hasDeleted: true,
            hasChildDeleted: false,
            deletedCount: 1,
        })
        expect(await table.get("child-file")).toBeUndefined()
        expect((await table.get("child-file", { ignoreMarkDelete: true }))?._isDeleted).toBe(true)
        expect((await table.get("dir"))?.ctotal).toBe(2)
        expect((await table.get("dir"))?.cftotal).toBe(1)
        expect((await table.get("dir"))?.csize).toBe(20)
        expect((await table.get("root"))?.ctotal).toBe(4)
        expect((await table.get("root"))?.csize).toBe(25)
    })

    test("删除目录应递归标记删除全部后代并从普通查询中隐藏", async () => {
        const table = await createDefinedTreeTable("mark-dir", true)
        await createDeleteFixture(table)

        const result = await table.deleteNodes(["dir"])

        expect(result).toEqual({
            hasDeleted: true,
            hasChildDeleted: true,
            deletedCount: 4,
        })
        expect(await table.get("dir")).toBeUndefined()
        expect(await table.get("child-file")).toBeUndefined()
        expect(await table.get("child-dir")).toBeUndefined()
        expect(await table.get("deep-file")).toBeUndefined()
        expect((await table.get("dir", { ignoreMarkDelete: true }))?._isDeleted).toBe(true)
        expect((await table.get("deep-file", { ignoreMarkDelete: true }))?._isDeleted).toBe(true)
        expect(await listChildIds(table, "root")).toEqual(["root-file"])
        expect((await table.get("root"))?.ctotal).toBe(1)
        expect((await table.get("root"))?.cftotal).toBe(1)
        expect((await table.get("root"))?.csize).toBe(5)
    })

    test("删除节点 ID 应去重并忽略空 ID", async () => {
        const table = await createDefinedTreeTable("mark-dedupe", true)
        await createDeleteFixture(table)

        const result = await table.deleteNodes(["", "child-file", "child-file"])

        expect(result.deletedCount).toBe(1)
        expect(result.hasChildDeleted).toBe(false)
        expect((await table.get("child-file", { ignoreMarkDelete: true }))?._isDeleted).toBe(true)
    })

    test("unDeleteNodes 应恢复被标记删除的目录和全部后代", async () => {
        const table = await createDefinedTreeTable("mark-undelete-dir", true)
        await createDeleteFixture(table)

        await table.deleteNodes(["dir"])
        await table.unDeleteNodes(["dir"])

        expect((await table.get("dir"))?.parentId).toBe("root")
        expect((await table.get("child-file"))?.parentId).toBe("dir")
        expect((await table.get("child-dir"))?.parentId).toBe("dir")
        expect((await table.get("deep-file"))?.parentId).toBe("child-dir")
        expect((await table.get("dir") as any)?._isDeleted).toBeUndefined()
        expect((await table.get("deep-file") as any)?._isDeleted).toBeUndefined()
        expect(await listChildIds(table, "root")).toEqual(["dir", "root-file"])
        expect((await table.get("root"))?.ctotal).toBe(5)
        expect((await table.get("root"))?.cftotal).toBe(3)
        expect((await table.get("root"))?.csize).toBe(35)
        expect((await table.get("dir"))?.ctotal).toBe(3)
        expect((await table.get("dir"))?.csize).toBe(30)
    })

    test("unDeleteNodes 只恢复已删除节点，不应改变未删除同级节点", async () => {
        const table = await createDefinedTreeTable("mark-undelete-file", true)
        await createDeleteFixture(table)

        const oldRootFileModif = (await table.get("root-file"))?.modif
        await table.deleteNodes(["child-file"])
        await table.unDeleteNodes(["child-file"])

        expect((await table.get("child-file"))?.parentId).toBe("dir")
        expect((await table.get("root-file"))?.modif).toBe(oldRootFileModif)
        expect((await table.get("dir"))?.ctotal).toBe(3)
        expect((await table.get("dir"))?.cftotal).toBe(2)
        expect((await table.get("dir"))?.csize).toBe(30)
    })

    test("开启 realDelete 时应在标记删除模式下强制物理删除", async () => {
        const table = await createDefinedTreeTable("mark-real-delete", true)
        await createDeleteFixture(table)

        await table.deleteNodes(["dir"], { realDelete: true })

        expect(await table.get("dir", { ignoreMarkDelete: true })).toBeUndefined()
        expect(await table.get("child-file", { ignoreMarkDelete: true })).toBeUndefined()
        expect(await table.get("deep-file", { ignoreMarkDelete: true })).toBeUndefined()
        expect((await table.get("root"))?.ctotal).toBe(1)
        expect((await table.get("root"))?.csize).toBe(5)
    })
})

describe("TableTree deleteNodes / unDeleteNodes 非标记删除模式", () => {
    test("删除文件应物理删除并刷新父级统计信息", async () => {
        const table = await createDefinedTreeTable("real-file", false)
        await createDeleteFixture(table)

        const result = await table.deleteNodes(["child-file"])

        expect(result).toEqual({
            hasDeleted: true,
            hasChildDeleted: false,
            deletedCount: 1,
        })
        expect(await table.get("child-file")).toBeUndefined()
        expect(await table.get("child-file", { ignoreMarkDelete: true })).toBeUndefined()
        expect((await table.get("dir"))?.ctotal).toBe(2)
        expect((await table.get("dir"))?.cftotal).toBe(1)
        expect((await table.get("dir"))?.csize).toBe(20)
    })

    test("删除目录应物理删除目录和全部后代", async () => {
        const table = await createDefinedTreeTable("real-dir", false)
        await createDeleteFixture(table)

        const result = await table.deleteNodes(["dir"])

        expect(result).toEqual({
            hasDeleted: true,
            hasChildDeleted: true,
            deletedCount: 4,
        })
        expect(await table.get("dir", { ignoreMarkDelete: true })).toBeUndefined()
        expect(await table.get("child-file", { ignoreMarkDelete: true })).toBeUndefined()
        expect(await table.get("child-dir", { ignoreMarkDelete: true })).toBeUndefined()
        expect(await table.get("deep-file", { ignoreMarkDelete: true })).toBeUndefined()
        expect(await listChildIds(table, "root")).toEqual(["root-file"])
        expect((await table.get("root"))?.ctotal).toBe(1)
        expect((await table.get("root"))?.cftotal).toBe(1)
        expect((await table.get("root"))?.csize).toBe(5)
    })

    test("物理删除后 unDeleteNodes 不应恢复节点", async () => {
        const table = await createDefinedTreeTable("real-undelete", false)
        await createDeleteFixture(table)

        await table.deleteNodes(["dir"])
        await table.unDeleteNodes(["dir"])

        expect(await table.get("dir", { ignoreMarkDelete: true })).toBeUndefined()
        expect(await table.get("deep-file", { ignoreMarkDelete: true })).toBeUndefined()
        expect(await listChildIds(table, "root")).toEqual(["root-file"])
        expect((await table.get("root"))?.ctotal).toBe(1)
        expect((await table.get("root"))?.csize).toBe(5)
    })

    test("非标记删除模式下 realDelete 选项应保持物理删除语义", async () => {
        const table = await createDefinedTreeTable("real-option", false)
        await createDeleteFixture(table)

        await table.deleteNodes(["child-file"], { realDelete: true })

        expect(await table.get("child-file", { ignoreMarkDelete: true })).toBeUndefined()
        expect((await table.get("dir"))?.ctotal).toBe(2)
        expect((await table.get("dir"))?.csize).toBe(20)
    })
})
