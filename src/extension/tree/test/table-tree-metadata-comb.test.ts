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
    const nodesByParentId = new Map<string, ITestTreeNode[]>()
    for (const node of nodes) {
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
})
