import { join } from "path"
import { tmpdir } from "os"
import { SQLiteAdapter } from "../../../adapter/SQLite"
import { TableTree, defineTableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"

interface ITestTreeNode extends ITreeNode {
    tag?: string
    owner?: string
    meta?: {
        hash?: string
        from?: string
    }
}

let tableIndex = 0

async function createMultiUserTables(name: string, userCount = 3) {
    const tableName = `test-tree-multi-user-comb-${tableIndex++}-${name}`
    const filename = join(tmpdir(), `${tableName}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`)
    const useTreeTable = defineTableTree<ITestTreeNode>({
        name: tableName,
        enableMarkDelete: true,
    })

    return await Promise.all(
        Array.from({ length: userCount }, async () => {
            return await useTreeTable({
                adapter: SQLiteAdapter({
                    filename,
                    driver: "better-sqlite3",
                    multi: true,
                }),
            })
        }),
    )
}

async function seedSharedWorkspace(table: TableTree<ITestTreeNode>) {
    await table.setNodes(
        [
            { id: "workspace", parentId: "/", name: "workspace", isDir: true },
            { id: "inbox", parentId: "/", name: "inbox", isDir: true },
            { id: "templates", parentId: "/", name: "templates", isDir: true },
            { id: "archive", parentId: "/", name: "archive", isDir: true },
            { id: "trash", parentId: "/", name: "trash", isDir: true },
            { id: "draft", parentId: "inbox", name: "draft.md", isDir: false, size: 2, owner: "alice" },
            { id: "old-log", parentId: "inbox", name: "old.log", isDir: false, size: 1, owner: "bob" },
            { id: "template-dir", parentId: "templates", name: "pkg", isDir: true },
            { id: "template-file", parentId: "template-dir", name: "index.ts", isDir: false, size: 4 },
            { id: "anchor-a", parentId: "workspace", name: "a.txt", isDir: false, size: 1 },
            { id: "anchor-b", parentId: "workspace", name: "b.txt", isDir: false, size: 1 },
        ],
        { index: { toEnd: true } },
    )
}

async function listChildIds(table: TableTree<ITestTreeNode>, parentId: string) {
    const result = await table.listNodes(parentId, { pageSize: 100 })
    return result.list.map((node) => node.id)
}

async function listChildNames(table: TableTree<ITestTreeNode>, parentId: string) {
    const result = await table.listNodes(parentId, { pageSize: 100 })
    return result.list.map((node) => node.name)
}

async function visibleSnapshot(table: TableTree<ITestTreeNode>) {
    const nodes = await table.findMany({}, { sort: { parentId: 1, index: 1, name: 1 } }) as ITestTreeNode[]
    return nodes.map((node) => ({
        id: node.id,
        parentId: node.parentId,
        name: node.name,
        isDir: node.isDir,
        size: node.size ?? 0,
        owner: node.owner,
        tag: node.tag,
    }))
}

async function visiblePathSnapshot(table: TableTree<ITestTreeNode>) {
    const nodes = await table.findMany({}) as ITestTreeNode[]
    const nodeById = new Map(nodes.map((node) => [node.id, node]))

    function getPath(node: ITestTreeNode): string {
        const names = [node.name]
        let parentId = node.parentId
        while (parentId && parentId !== "/") {
            const parent = nodeById.get(parentId)
            if (!parent) break
            names.push(parent.name)
            parentId = parent.parentId
        }
        return `/${names.reverse().join("/")}`
    }

    return nodes
        .map((node) => ({
            path: getPath(node),
            isDir: node.isDir,
            size: node.size ?? 0,
            owner: node.owner,
            tag: node.tag,
        }))
        .sort((left, right) => left.path.localeCompare(right.path))
}

function compareIndex(left: string, right: string): number {
    if (left < right) return -1
    if (left > right) return 1
    return 0
}

async function expectAllVisibleTreeStateAccurate(table: TableTree<ITestTreeNode>) {
    const nodes = await table.findMany({}) as ITestTreeNode[]
    const nodeIds = new Set(nodes.map((node) => node.id))
    const nodesByParentId = new Map<string, ITestTreeNode[]>()
    for (const node of nodes) {
        if (node.parentId !== "/") {
            expect(nodeIds.has(node.parentId)).toBe(true)
        }
        const siblings = nodesByParentId.get(node.parentId) ?? []
        siblings.push(node)
        nodesByParentId.set(node.parentId, siblings)
    }

    function collectDescendants(nodeId: string): ITestTreeNode[] {
        const children = nodesByParentId.get(nodeId) ?? []
        return children.flatMap((child) => [child, ...collectDescendants(child.id)])
    }

    for (const [parentId, siblings] of nodesByParentId) {
        const indexes = siblings.map((node) => node.index).filter((index): index is string => Boolean(index))
        const uniqueIndexes = new Set(indexes)
        expect(uniqueIndexes.size).toBe(indexes.length)
        expect((await listChildIds(table, parentId))).toEqual(
            [...siblings].sort((a, b) => compareIndex(a.index ?? "", b.index ?? "")).map((node) => node.id),
        )
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

async function expectNoParentCycles(table: TableTree<ITestTreeNode>) {
    const nodes = await table.findMany({}) as ITestTreeNode[]
    const nodeById = new Map(nodes.map((node) => [node.id, node]))

    for (const node of nodes) {
        const visitedIds = new Set<string>([node.id])
        let parentId = node.parentId
        while (parentId && parentId !== "/") {
            expect(visitedIds.has(parentId)).toBe(false)
            visitedIds.add(parentId)
            parentId = nodeById.get(parentId)?.parentId ?? "/"
        }
    }
}

describe("TableTree 多用户连续操作组合", () => {
    test("多个用户实例连接同一目录树时应看到一致的操作结果和 metadata", async () => {
        const [alice, bob, chen] = await createMultiUserTables("shared-visibility")
        await seedSharedWorkspace(alice)

        await bob.moveNodes(["draft"], "workspace", { index: { prevNodeId: "anchor-a", nextNodeId: "anchor-b" } })
        await chen.updateNodes({ id: "draft" }, { $set: { size: 8, tag: "reviewed" } })
        const copyResult = await alice.copyNodes(["template-dir"], "workspace", {
            deep: true,
            renameOnCopy: false,
            index: { toEnd: true },
        })
        await bob.deleteNodes(["old-log"])
        await chen.unDeleteNodes(["old-log"])
        await alice.moveNodes(["old-log"], "trash", { index: { toEnd: true } })

        expect(await listChildIds(alice, "workspace")).toEqual(["anchor-a", "draft", "anchor-b", copyResult.createdNodeIds[0]])
        expect(await visibleSnapshot(alice)).toEqual(await visibleSnapshot(bob))
        expect(await visibleSnapshot(bob)).toEqual(await visibleSnapshot(chen))
        await expectAllVisibleTreeStateAccurate(alice)
        await expectAllVisibleTreeStateAccurate(bob)
        await expectAllVisibleTreeStateAccurate(chen)
    })

    test("同一批相互独立的用户操作按不同顺序执行后应得到同一棵可见目录树", async () => {
        const orders = [
            ["alice", "bob", "chen"],
            ["chen", "alice", "bob"],
            ["bob", "chen", "alice"],
        ] as const
        const snapshots: Awaited<ReturnType<typeof visiblePathSnapshot>>[] = []

        for (const order of orders) {
            const [alice, bob, chen] = await createMultiUserTables(`independent-order-${order.join("-")}`)
            await seedSharedWorkspace(alice)
            const users = { alice, bob, chen }
            const operations = {
                alice: async () => {
                    await alice.moveNodes(["draft"], "workspace", { index: { prevNodeId: "anchor-a", nextNodeId: "anchor-b" } })
                    await alice.updateNodes({ id: "draft" }, { $set: { size: 10, owner: "alice", tag: "moved" } })
                },
                bob: async () => {
                    await bob.copyNodes(["template-dir"], "archive", {
                        deep: true,
                        renameOnCopy: false,
                        index: { toEnd: true },
                    })
                    await bob.updateNodes({ id: "template-dir" }, { $set: { tag: "source-kept" } }, { deep: true })
                },
                chen: async () => {
                    await chen.deleteNodes(["old-log"])
                    await chen.unDeleteNodes(["old-log"])
                    await chen.moveNodes(["old-log"], "trash", { index: { toEnd: true } })
                },
            }

            for (const user of order) {
                await operations[user]()
                await expectAllVisibleTreeStateAccurate(users[user])
            }

            snapshots.push(await visiblePathSnapshot(alice))
            await expectAllVisibleTreeStateAccurate(bob)
            await expectAllVisibleTreeStateAccurate(chen)
        }

        expect(snapshots[1]).toEqual(snapshots[0])
        expect(snapshots[2]).toEqual(snapshots[0])
    })

    test("用户使用已失效的排序参考节点时应抛错且不留下半写入节点", async () => {
        const [alice, bob] = await createMultiUserTables("stale-index-anchor", 2)
        await seedSharedWorkspace(alice)

        await bob.moveNodes(["anchor-b"], "archive", { index: { toEnd: true } })

        await expect(
            alice.createNodes([{ id: "late-note", name: "late.md", isDir: false, size: 3 }], "workspace", {
                index: { prevNodeId: "anchor-b" },
            }),
        ).rejects.toThrow("排序参考节点不属于目标父级")
        expect(await alice.get("late-note")).toBeUndefined()

        await alice.createNodes([{ id: "late-note", name: "late.md", isDir: false, size: 3 }], "workspace", {
            index: { toEnd: true },
        })

        expect(await listChildIds(alice, "workspace")).toEqual(["anchor-a", "late-note"])
        expect(await listChildIds(bob, "archive")).toEqual(["anchor-b"])
        await expectAllVisibleTreeStateAccurate(alice)
        await expectAllVisibleTreeStateAccurate(bob)
    })

    test("多个用户同时向同一父级追加节点后不应出现重复 index 或错误 childLastIndex", async () => {
        const [alice, bob, chen] = await createMultiUserTables("parallel-append")
        await alice.createNodes([{ id: "workspace", name: "workspace", isDir: true }], "/")
        await alice.createNodes([{ id: "seed", name: "seed.txt", isDir: false, size: 1 }], "workspace", {
            index: { toEnd: true },
        })

        await Promise.all([
            alice.createNodes(
                [
                    { id: "alice-a", name: "alice-a.txt", isDir: false, size: 1 },
                    { id: "alice-b", name: "alice-b.txt", isDir: false, size: 1 },
                ],
                "workspace",
                { index: { toEnd: true } },
            ),
            bob.createNodes(
                [
                    { id: "bob-a", name: "bob-a.txt", isDir: false, size: 1 },
                    { id: "bob-b", name: "bob-b.txt", isDir: false, size: 1 },
                ],
                "workspace",
                { index: { toEnd: true } },
            ),
            chen.createNodes([{ id: "chen-a", name: "chen-a.txt", isDir: false, size: 1 }], "workspace", {
                index: { toEnd: true },
            }),
        ])

        expect((await alice.listNodes("workspace", { pageSize: 100 })).list).toHaveLength(6)
        await expectAllVisibleTreeStateAccurate(alice)
        await expectAllVisibleTreeStateAccurate(bob)
        await expectAllVisibleTreeStateAccurate(chen)
    })

    test("多个用户同时写入同一节点到不同父级后只能保留一个位置且 metadata 正确", async () => {
        const [alice, bob, chen] = await createMultiUserTables("parallel-same-id-set")
        await alice.setNodes(
            [
                { id: "workspace", parentId: "/", name: "workspace", isDir: true },
                { id: "archive", parentId: "/", name: "archive", isDir: true },
                { id: "trash", parentId: "/", name: "trash", isDir: true },
            ],
            { index: { toEnd: true } },
        )

        await Promise.all([
            alice.setNodes([{ id: "shared", parentId: "workspace", name: "shared.txt", isDir: false, size: 1, owner: "alice" }], {
                index: { toEnd: true },
            }),
            bob.setNodes([{ id: "shared", parentId: "archive", name: "shared.txt", isDir: false, size: 2, owner: "bob" }], {
                index: { toEnd: true },
            }),
            chen.setNodes([{ id: "shared", parentId: "trash", name: "shared.txt", isDir: false, size: 3, owner: "chen" }], {
                index: { toEnd: true },
            }),
        ])

        const shared = await alice.get("shared")
        expect(["workspace", "archive", "trash"]).toContain(shared?.parentId)
        const visibleParents = await Promise.all(
            ["workspace", "archive", "trash"].map(async (parentId) => ({
                parentId,
                ids: await listChildIds(alice, parentId),
            })),
        )
        expect(visibleParents.flatMap((entry) => entry.ids).filter((id) => id === "shared")).toHaveLength(1)
        await expectAllVisibleTreeStateAccurate(alice)
        await expectAllVisibleTreeStateAccurate(bob)
        await expectAllVisibleTreeStateAccurate(chen)
    })

    test("同一节点被多个用户同时移动到不同目录时不应残留在旧目录或产生错误统计", async () => {
        const [alice, bob, chen] = await createMultiUserTables("parallel-same-node-move")
        await alice.setNodes(
            [
                { id: "workspace", parentId: "/", name: "workspace", isDir: true },
                { id: "archive", parentId: "/", name: "archive", isDir: true },
                { id: "trash", parentId: "/", name: "trash", isDir: true },
                { id: "downloads", parentId: "/", name: "downloads", isDir: true },
                { id: "moving", parentId: "downloads", name: "moving.txt", isDir: false, size: 5 },
            ],
            { index: { toEnd: true } },
        )

        await Promise.all([
            alice.moveNodes(["moving"], "workspace", { index: { toEnd: true } }),
            bob.moveNodes(["moving"], "archive", { index: { toEnd: true } }),
            chen.moveNodes(["moving"], "trash", { index: { toEnd: true } }),
        ])

        const moving = await alice.get("moving")
        expect(["workspace", "archive", "trash"]).toContain(moving?.parentId)
        expect(await listChildIds(alice, "downloads")).toEqual([])
        expect(
            (await Promise.all(["workspace", "archive", "trash"].map((parentId) => listChildIds(alice, parentId))))
                .flat()
                .filter((id) => id === "moving"),
        ).toHaveLength(1)
        await expectAllVisibleTreeStateAccurate(alice)
        await expectAllVisibleTreeStateAccurate(bob)
        await expectAllVisibleTreeStateAccurate(chen)
    })

    test("覆盖、删除和恢复交错后不应把旧冲突节点或已删除节点计入可见 metadata", async () => {
        const [alice, bob, chen] = await createMultiUserTables("overwrite-delete-restore")
        await alice.setNodes(
            [
                { id: "workspace", parentId: "/", name: "workspace", isDir: true },
                { id: "incoming", parentId: "/", name: "incoming", isDir: true },
                { id: "archive", parentId: "/", name: "archive", isDir: true },
                { id: "old-report", parentId: "workspace", name: "report.md", isDir: false, size: 1, meta: { hash: "report" } },
                { id: "new-report", parentId: "incoming", name: "report.md", isDir: false, size: 9, meta: { hash: "report" } },
                { id: "keep", parentId: "workspace", name: "keep.md", isDir: false, size: 2 },
            ],
            { index: { toEnd: true } },
        )

        await bob.deleteNodes(["keep"])
        await alice.moveNodes(["new-report"], "workspace", {
            uniqueBy: "meta.hash",
            overwriteMode: "replace",
            index: { toEnd: true },
        })
        await chen.unDeleteNodes(["keep"])
        await bob.moveNodes(["keep"], "archive", { index: { toEnd: true } })

        expect(await alice.get("old-report")).toBeUndefined()
        expect((await alice.get("new-report"))?.parentId).toBe("workspace")
        expect((await alice.get("new-report"))?.size).toBe(9)
        expect((await alice.get("keep"))?.parentId).toBe("archive")
        expect(await listChildIds(alice, "workspace")).toEqual(["new-report"])
        expect(await listChildIds(alice, "archive")).toEqual(["keep"])
        await expectAllVisibleTreeStateAccurate(alice)
        await expectAllVisibleTreeStateAccurate(bob)
        await expectAllVisibleTreeStateAccurate(chen)
    })

    test("多用户交替重命名、移动目录和深度更新后子树不应断链", async () => {
        const [alice, bob, chen] = await createMultiUserTables("rename-move-deep-update")
        await alice.setNodes(
            [
                { id: "workspace", parentId: "/", name: "workspace", isDir: true },
                { id: "archive", parentId: "/", name: "archive", isDir: true },
                { id: "pkg", parentId: "workspace", name: "pkg", isDir: true },
                { id: "src", parentId: "pkg", name: "src", isDir: true },
                { id: "index", parentId: "src", name: "index.ts", isDir: false, size: 4 },
                { id: "readme", parentId: "pkg", name: "README.md", isDir: false, size: 2 },
            ],
            { index: { toEnd: true } },
        )

        await alice.updateNodes({ id: "pkg" }, { $set: { name: "pkg-renamed", tag: "renamed" } })
        await bob.moveNodes(["pkg"], "archive", { index: { toEnd: true } })
        await chen.updateNodes({ id: "pkg" }, { $set: { owner: "team" } }, { deep: true })
        await alice.updateNodes({ id: "index" }, { $inc: { size: 6 } as any })

        expect((await alice.get("pkg"))?.parentId).toBe("archive")
        expect((await alice.get("pkg"))?.name).toBe("pkg-renamed")
        expect((await alice.get("src"))?.parentId).toBe("pkg")
        expect((await alice.get("index"))?.parentId).toBe("src")
        expect((await alice.get("index"))?.owner).toBe("team")
        expect((await alice.get("index"))?.size).toBe(10)
        expect(await listChildIds(alice, "workspace")).toEqual([])
        await expectAllVisibleTreeStateAccurate(alice)
        await expectAllVisibleTreeStateAccurate(bob)
        await expectAllVisibleTreeStateAccurate(chen)
    })

    test("多个用户同时复制到同一父级并自动重命名时不应产生同名可见节点", async () => {
        const [alice, bob, chen] = await createMultiUserTables("parallel-copy-rename")
        await alice.setNodes(
            [
                { id: "workspace", parentId: "/", name: "workspace", isDir: true },
                { id: "source", parentId: "/", name: "source", isDir: true },
                { id: "report", parentId: "workspace", name: "report.md", isDir: false, size: 1 },
                { id: "source-report", parentId: "source", name: "report.md", isDir: false, size: 2 },
            ],
            { index: { toEnd: true } },
        )

        await Promise.all([
            alice.copyNodes(["source-report"], "workspace"),
            bob.copyNodes(["source-report"], "workspace"),
            chen.copyNodes(["source-report"], "workspace"),
        ])

        const names = await listChildNames(alice, "workspace")
        expect(new Set(names).size).toBe(names.length)
        expect(names.filter((name) => name.startsWith("report"))).toHaveLength(4)
        await expectAllVisibleTreeStateAccurate(alice)
        await expectAllVisibleTreeStateAccurate(bob)
        await expectAllVisibleTreeStateAccurate(chen)
    })

    test("多个用户同时用 newName 移动同名文件到同一目录时不应产生同名可见节点", async () => {
        const [alice, bob, chen] = await createMultiUserTables("parallel-move-new-name")
        await alice.setNodes(
            [
                { id: "target", parentId: "/", name: "target", isDir: true },
                { id: "a", parentId: "/", name: "a", isDir: true },
                { id: "b", parentId: "/", name: "b", isDir: true },
                { id: "c", parentId: "/", name: "c", isDir: true },
                { id: "existing", parentId: "target", name: "report.md", isDir: false, size: 1 },
                { id: "from-a", parentId: "a", name: "report.md", isDir: false, size: 2 },
                { id: "from-b", parentId: "b", name: "report.md", isDir: false, size: 3 },
                { id: "from-c", parentId: "c", name: "report.md", isDir: false, size: 4 },
            ],
            { index: { toEnd: true } },
        )

        await Promise.all([
            alice.moveNodes(["from-a"], "target", { uniqueBy: "name", overwriteMode: "newName", index: { toEnd: true } }),
            bob.moveNodes(["from-b"], "target", { uniqueBy: "name", overwriteMode: "newName", index: { toEnd: true } }),
            chen.moveNodes(["from-c"], "target", { uniqueBy: "name", overwriteMode: "newName", index: { toEnd: true } }),
        ])

        const names = await listChildNames(alice, "target")
        expect(new Set(names).size).toBe(names.length)
        expect(names.filter((name) => name.startsWith("report"))).toHaveLength(4)
        await expectAllVisibleTreeStateAccurate(alice)
        await expectAllVisibleTreeStateAccurate(bob)
        await expectAllVisibleTreeStateAccurate(chen)
    })

    test("多个用户同时用 newName 写入同名节点到同一目录时不应产生同名可见节点", async () => {
        const [alice, bob, chen] = await createMultiUserTables("parallel-set-new-name")
        await alice.setNodes(
            [
                { id: "target", parentId: "/", name: "target", isDir: true },
                { id: "existing", parentId: "target", name: "note.md", isDir: false, size: 1 },
            ],
            { index: { toEnd: true } },
        )

        await Promise.all([
            alice.setNodes([{ id: "alice-note", parentId: "target", name: "note.md", isDir: false, size: 2 }], {
                uniqueBy: "name",
                overwriteMode: "newName",
                index: { toEnd: true },
            }),
            bob.setNodes([{ id: "bob-note", parentId: "target", name: "note.md", isDir: false, size: 3 }], {
                uniqueBy: "name",
                overwriteMode: "newName",
                index: { toEnd: true },
            }),
            chen.setNodes([{ id: "chen-note", parentId: "target", name: "note.md", isDir: false, size: 4 }], {
                uniqueBy: "name",
                overwriteMode: "newName",
                index: { toEnd: true },
            }),
        ])

        const names = await listChildNames(alice, "target")
        expect(new Set(names).size).toBe(names.length)
        expect(names.filter((name) => name.startsWith("note"))).toHaveLength(4)
        await expectAllVisibleTreeStateAccurate(alice)
        await expectAllVisibleTreeStateAccurate(bob)
        await expectAllVisibleTreeStateAccurate(chen)
    })

    test("多个用户同时用 replace 移动同名文件到同一目录时最终只应保留一个可见冲突节点", async () => {
        const [alice, bob, chen] = await createMultiUserTables("parallel-move-replace")
        await alice.setNodes(
            [
                { id: "target", parentId: "/", name: "target", isDir: true },
                { id: "a", parentId: "/", name: "a", isDir: true },
                { id: "b", parentId: "/", name: "b", isDir: true },
                { id: "c", parentId: "/", name: "c", isDir: true },
                { id: "existing", parentId: "target", name: "report.md", isDir: false, size: 1 },
                { id: "from-a", parentId: "a", name: "report.md", isDir: false, size: 2 },
                { id: "from-b", parentId: "b", name: "report.md", isDir: false, size: 3 },
                { id: "from-c", parentId: "c", name: "report.md", isDir: false, size: 4 },
            ],
            { index: { toEnd: true } },
        )

        await Promise.all([
            alice.moveNodes(["from-a"], "target", { uniqueBy: "name", overwriteMode: "replace", index: { toEnd: true } }),
            bob.moveNodes(["from-b"], "target", { uniqueBy: "name", overwriteMode: "replace", index: { toEnd: true } }),
            chen.moveNodes(["from-c"], "target", { uniqueBy: "name", overwriteMode: "replace", index: { toEnd: true } }),
        ])

        const reportNodes = await alice.findMany({ parentId: "target", name: "report.md" })
        expect(reportNodes).toHaveLength(1)
        expect(["from-a", "from-b", "from-c"]).toContain(reportNodes[0].id)
        await expectAllVisibleTreeStateAccurate(alice)
        await expectAllVisibleTreeStateAccurate(bob)
        await expectAllVisibleTreeStateAccurate(chen)
    })

    test("多个用户同时用 replace 写入同名节点到同一目录时最终只应保留一个可见冲突节点", async () => {
        const [alice, bob, chen] = await createMultiUserTables("parallel-set-replace")
        await alice.setNodes(
            [
                { id: "target", parentId: "/", name: "target", isDir: true },
                { id: "existing", parentId: "target", name: "note.md", isDir: false, size: 1 },
            ],
            { index: { toEnd: true } },
        )

        await Promise.all([
            alice.setNodes([{ id: "alice-note", parentId: "target", name: "note.md", isDir: false, size: 2 }], {
                uniqueBy: "name",
                overwriteMode: "replace",
                index: { toEnd: true },
            }),
            bob.setNodes([{ id: "bob-note", parentId: "target", name: "note.md", isDir: false, size: 3 }], {
                uniqueBy: "name",
                overwriteMode: "replace",
                index: { toEnd: true },
            }),
            chen.setNodes([{ id: "chen-note", parentId: "target", name: "note.md", isDir: false, size: 4 }], {
                uniqueBy: "name",
                overwriteMode: "replace",
                index: { toEnd: true },
            }),
        ])

        const noteNodes = await alice.findMany({ parentId: "target", name: "note.md" })
        expect(noteNodes).toHaveLength(1)
        await expectAllVisibleTreeStateAccurate(alice)
        await expectAllVisibleTreeStateAccurate(bob)
        await expectAllVisibleTreeStateAccurate(chen)
    })

    test("多个用户同时用 skip 移动同名文件到空目录时最终只应保留一个可见冲突节点", async () => {
        const [alice, bob, chen] = await createMultiUserTables("parallel-move-skip")
        await alice.setNodes(
            [
                { id: "target", parentId: "/", name: "target", isDir: true },
                { id: "a", parentId: "/", name: "a", isDir: true },
                { id: "b", parentId: "/", name: "b", isDir: true },
                { id: "c", parentId: "/", name: "c", isDir: true },
                { id: "from-a", parentId: "a", name: "report.md", isDir: false, size: 2 },
                { id: "from-b", parentId: "b", name: "report.md", isDir: false, size: 3 },
                { id: "from-c", parentId: "c", name: "report.md", isDir: false, size: 4 },
            ],
            { index: { toEnd: true } },
        )

        await Promise.all([
            alice.moveNodes(["from-a"], "target", { uniqueBy: "name", overwriteMode: "skip", index: { toEnd: true } }),
            bob.moveNodes(["from-b"], "target", { uniqueBy: "name", overwriteMode: "skip", index: { toEnd: true } }),
            chen.moveNodes(["from-c"], "target", { uniqueBy: "name", overwriteMode: "skip", index: { toEnd: true } }),
        ])

        const reportNodes = await alice.findMany({ parentId: "target", name: "report.md" })
        expect(reportNodes).toHaveLength(1)
        expect(["from-a", "from-b", "from-c"]).toContain(reportNodes[0].id)
        await expectAllVisibleTreeStateAccurate(alice)
        await expectAllVisibleTreeStateAccurate(bob)
        await expectAllVisibleTreeStateAccurate(chen)
    })

    test("多个用户同时用 skip 写入同名节点到空目录时最终只应保留一个可见冲突节点", async () => {
        const [alice, bob, chen] = await createMultiUserTables("parallel-set-skip")
        await alice.setNodes([{ id: "target", parentId: "/", name: "target", isDir: true }], { index: { toEnd: true } })

        await Promise.all([
            alice.setNodes([{ id: "alice-note", parentId: "target", name: "note.md", isDir: false, size: 2 }], {
                uniqueBy: "name",
                overwriteMode: "skip",
                index: { toEnd: true },
            }),
            bob.setNodes([{ id: "bob-note", parentId: "target", name: "note.md", isDir: false, size: 3 }], {
                uniqueBy: "name",
                overwriteMode: "skip",
                index: { toEnd: true },
            }),
            chen.setNodes([{ id: "chen-note", parentId: "target", name: "note.md", isDir: false, size: 4 }], {
                uniqueBy: "name",
                overwriteMode: "skip",
                index: { toEnd: true },
            }),
        ])

        const noteNodes = await alice.findMany({ parentId: "target", name: "note.md" })
        expect(noteNodes).toHaveLength(1)
        expect(["alice-note", "bob-note", "chen-note"]).toContain(noteNodes[0].id)
        await expectAllVisibleTreeStateAccurate(alice)
        await expectAllVisibleTreeStateAccurate(bob)
        await expectAllVisibleTreeStateAccurate(chen)
    })

    test("多个用户同时用 merge 移动同名目录到同一目录时最终应收敛为一个目录子树", async () => {
        const [alice, bob, chen] = await createMultiUserTables("parallel-move-merge")
        await alice.setNodes(
            [
                { id: "target", parentId: "/", name: "target", isDir: true },
                { id: "a", parentId: "/", name: "a", isDir: true },
                { id: "b", parentId: "/", name: "b", isDir: true },
                { id: "c", parentId: "/", name: "c", isDir: true },
                { id: "existing-pkg", parentId: "target", name: "pkg", isDir: true },
                { id: "existing-file", parentId: "existing-pkg", name: "main.ts", isDir: false, size: 1 },
                { id: "pkg-a", parentId: "a", name: "pkg", isDir: true },
                { id: "file-a", parentId: "pkg-a", name: "main.ts", isDir: false, size: 2 },
                { id: "pkg-b", parentId: "b", name: "pkg", isDir: true },
                { id: "file-b", parentId: "pkg-b", name: "main.ts", isDir: false, size: 3 },
                { id: "pkg-c", parentId: "c", name: "pkg", isDir: true },
                { id: "file-c", parentId: "pkg-c", name: "main.ts", isDir: false, size: 4 },
            ],
            { index: { toEnd: true } },
        )

        await Promise.all([
            alice.moveNodes(["pkg-a"], "target", { uniqueBy: "name", overwriteMode: "merge", index: { toEnd: true } }),
            bob.moveNodes(["pkg-b"], "target", { uniqueBy: "name", overwriteMode: "merge", index: { toEnd: true } }),
            chen.moveNodes(["pkg-c"], "target", { uniqueBy: "name", overwriteMode: "merge", index: { toEnd: true } }),
        ])

        const pkgNodes = await alice.findMany({ parentId: "target", name: "pkg" })
        expect(pkgNodes).toHaveLength(1)
        expect(await alice.get("pkg-a")).toBeUndefined()
        expect(await alice.get("pkg-b")).toBeUndefined()
        expect(await alice.get("pkg-c")).toBeUndefined()
        const mainFiles = await alice.findMany({ parentId: pkgNodes[0].id, name: "main.ts" })
        expect(mainFiles).toHaveLength(1)
        await expectAllVisibleTreeStateAccurate(alice)
        await expectAllVisibleTreeStateAccurate(bob)
        await expectAllVisibleTreeStateAccurate(chen)
    })

    test("多个用户同时用 merge 写入同名目录到同一目录时最终应收敛为一个目录子树", async () => {
        const [alice, bob, chen] = await createMultiUserTables("parallel-set-merge")
        await alice.setNodes(
            [
                { id: "target", parentId: "/", name: "target", isDir: true },
                { id: "existing-pkg", parentId: "target", name: "pkg", isDir: true },
                { id: "existing-file", parentId: "existing-pkg", name: "main.ts", isDir: false, size: 1 },
            ],
            { index: { toEnd: true } },
        )

        await Promise.all([
            alice.setNodes(
                [
                    { id: "pkg-a", parentId: "target", name: "pkg", isDir: true },
                    { id: "file-a", parentId: "pkg-a", name: "main.ts", isDir: false, size: 2 },
                ],
                { uniqueBy: "name", overwriteMode: "merge", index: { toEnd: true } },
            ),
            bob.setNodes(
                [
                    { id: "pkg-b", parentId: "target", name: "pkg", isDir: true },
                    { id: "file-b", parentId: "pkg-b", name: "main.ts", isDir: false, size: 3 },
                ],
                { uniqueBy: "name", overwriteMode: "merge", index: { toEnd: true } },
            ),
            chen.setNodes(
                [
                    { id: "pkg-c", parentId: "target", name: "pkg", isDir: true },
                    { id: "file-c", parentId: "pkg-c", name: "main.ts", isDir: false, size: 4 },
                ],
                { uniqueBy: "name", overwriteMode: "merge", index: { toEnd: true } },
            ),
        ])

        const pkgNodes = await alice.findMany({ parentId: "target", name: "pkg" })
        expect(pkgNodes).toHaveLength(1)
        expect(await alice.get("pkg-a")).toBeUndefined()
        expect(await alice.get("pkg-b")).toBeUndefined()
        expect(await alice.get("pkg-c")).toBeUndefined()
        const mainFiles = await alice.findMany({ parentId: pkgNodes[0].id, name: "main.ts" })
        expect(mainFiles).toHaveLength(1)
        await expectAllVisibleTreeStateAccurate(alice)
        await expectAllVisibleTreeStateAccurate(bob)
        await expectAllVisibleTreeStateAccurate(chen)
    })

    test("多个用户同时 merge 同名目录时不应丢失各来源目录的不同子文件", async () => {
        const [alice, bob, chen] = await createMultiUserTables("parallel-merge-keep-unique-children")
        await alice.setNodes(
            [
                { id: "target", parentId: "/", name: "target", isDir: true },
                { id: "a", parentId: "/", name: "a", isDir: true },
                { id: "b", parentId: "/", name: "b", isDir: true },
                { id: "c", parentId: "/", name: "c", isDir: true },
                { id: "existing-pkg", parentId: "target", name: "pkg", isDir: true },
                { id: "existing-file", parentId: "existing-pkg", name: "base.ts", isDir: false, size: 1 },
                { id: "pkg-a", parentId: "a", name: "pkg", isDir: true },
                { id: "file-a", parentId: "pkg-a", name: "a.ts", isDir: false, size: 2 },
                { id: "pkg-b", parentId: "b", name: "pkg", isDir: true },
                { id: "file-b", parentId: "pkg-b", name: "b.ts", isDir: false, size: 3 },
                { id: "pkg-c", parentId: "c", name: "pkg", isDir: true },
                { id: "file-c", parentId: "pkg-c", name: "c.ts", isDir: false, size: 4 },
            ],
            { index: { toEnd: true } },
        )

        await Promise.all([
            alice.moveNodes(["pkg-a"], "target", { uniqueBy: "name", overwriteMode: "merge", index: { toEnd: true } }),
            bob.moveNodes(["pkg-b"], "target", { uniqueBy: "name", overwriteMode: "merge", index: { toEnd: true } }),
            chen.moveNodes(["pkg-c"], "target", { uniqueBy: "name", overwriteMode: "merge", index: { toEnd: true } }),
        ])

        const pkgNodes = await alice.findMany({ parentId: "target", name: "pkg" })
        expect(pkgNodes).toHaveLength(1)
        expect(await listChildNames(alice, pkgNodes[0].id)).toEqual(["base.ts", "a.ts", "b.ts", "c.ts"])
        await expectAllVisibleTreeStateAccurate(alice)
        await expectAllVisibleTreeStateAccurate(bob)
        await expectAllVisibleTreeStateAccurate(chen)
    })

    test("多个用户同时 merge 到空目标目录时同名目录应合并且保留各自子文件", async () => {
        const [alice, bob, chen] = await createMultiUserTables("parallel-merge-empty-target")
        await alice.setNodes(
            [
                { id: "target", parentId: "/", name: "target", isDir: true },
                { id: "a", parentId: "/", name: "a", isDir: true },
                { id: "b", parentId: "/", name: "b", isDir: true },
                { id: "c", parentId: "/", name: "c", isDir: true },
                { id: "pkg-a", parentId: "a", name: "pkg", isDir: true },
                { id: "file-a", parentId: "pkg-a", name: "a.ts", isDir: false, size: 2 },
                { id: "pkg-b", parentId: "b", name: "pkg", isDir: true },
                { id: "file-b", parentId: "pkg-b", name: "b.ts", isDir: false, size: 3 },
                { id: "pkg-c", parentId: "c", name: "pkg", isDir: true },
                { id: "file-c", parentId: "pkg-c", name: "c.ts", isDir: false, size: 4 },
            ],
            { index: { toEnd: true } },
        )

        await Promise.all([
            alice.moveNodes(["pkg-a"], "target", { uniqueBy: "name", overwriteMode: "merge", index: { toEnd: true } }),
            bob.moveNodes(["pkg-b"], "target", { uniqueBy: "name", overwriteMode: "merge", index: { toEnd: true } }),
            chen.moveNodes(["pkg-c"], "target", { uniqueBy: "name", overwriteMode: "merge", index: { toEnd: true } }),
        ])

        const pkgNodes = await alice.findMany({ parentId: "target", name: "pkg" })
        expect(pkgNodes).toHaveLength(1)
        expect((await listChildNames(alice, pkgNodes[0].id)).sort()).toEqual(["a.ts", "b.ts", "c.ts"])
        await expectAllVisibleTreeStateAccurate(alice)
        await expectAllVisibleTreeStateAccurate(bob)
        await expectAllVisibleTreeStateAccurate(chen)
    })

    test("多个用户同时 setNodes merge 到空目标目录时同名目录应合并且保留各自子文件", async () => {
        const [alice, bob, chen] = await createMultiUserTables("parallel-set-merge-empty-target")
        await alice.setNodes([{ id: "target", parentId: "/", name: "target", isDir: true }], { index: { toEnd: true } })

        await Promise.all([
            alice.setNodes(
                [
                    { id: "pkg-a", parentId: "target", name: "pkg", isDir: true },
                    { id: "file-a", parentId: "pkg-a", name: "a.ts", isDir: false, size: 2 },
                ],
                { uniqueBy: "name", overwriteMode: "merge", index: { toEnd: true } },
            ),
            bob.setNodes(
                [
                    { id: "pkg-b", parentId: "target", name: "pkg", isDir: true },
                    { id: "file-b", parentId: "pkg-b", name: "b.ts", isDir: false, size: 3 },
                ],
                { uniqueBy: "name", overwriteMode: "merge", index: { toEnd: true } },
            ),
            chen.setNodes(
                [
                    { id: "pkg-c", parentId: "target", name: "pkg", isDir: true },
                    { id: "file-c", parentId: "pkg-c", name: "c.ts", isDir: false, size: 4 },
                ],
                { uniqueBy: "name", overwriteMode: "merge", index: { toEnd: true } },
            ),
        ])

        const pkgNodes = await alice.findMany({ parentId: "target", name: "pkg" })
        expect(pkgNodes).toHaveLength(1)
        expect((await listChildNames(alice, pkgNodes[0].id)).sort()).toEqual(["a.ts", "b.ts", "c.ts"])
        await expectAllVisibleTreeStateAccurate(alice)
        await expectAllVisibleTreeStateAccurate(bob)
        await expectAllVisibleTreeStateAccurate(chen)
    })

    test("多个用户同时 mergeByModif 到空目标目录时同名子文件应保留较新版本", async () => {
        const [alice, bob, chen] = await createMultiUserTables("parallel-merge-by-modif-empty-target")
        await alice.setNodes(
            [
                { id: "target", parentId: "/", name: "target", isDir: true },
                { id: "a", parentId: "/", name: "a", isDir: true },
                { id: "b", parentId: "/", name: "b", isDir: true },
                { id: "c", parentId: "/", name: "c", isDir: true },
                { id: "pkg-a", parentId: "a", name: "pkg", isDir: true },
                { id: "file-a", parentId: "pkg-a", name: "common.ts", isDir: false, size: 2 },
                { id: "only-a", parentId: "pkg-a", name: "a.ts", isDir: false, size: 20 },
                { id: "pkg-b", parentId: "b", name: "pkg", isDir: true },
                { id: "file-b", parentId: "pkg-b", name: "common.ts", isDir: false, size: 3 },
                { id: "only-b", parentId: "pkg-b", name: "b.ts", isDir: false, size: 30 },
                { id: "pkg-c", parentId: "c", name: "pkg", isDir: true },
                { id: "file-c", parentId: "pkg-c", name: "common.ts", isDir: false, size: 4 },
                { id: "only-c", parentId: "pkg-c", name: "c.ts", isDir: false, size: 40 },
            ],
            { index: { toEnd: true } },
        )
        await alice.updateNodes({ id: "file-a" }, { $set: { modif: 100 } })
        await bob.updateNodes({ id: "file-b" }, { $set: { modif: 300 } })
        await chen.updateNodes({ id: "file-c" }, { $set: { modif: 200 } })

        await Promise.all([
            alice.moveNodes(["pkg-a"], "target", { uniqueBy: "name", overwriteMode: "mergeByModif", index: { toEnd: true } }),
            bob.moveNodes(["pkg-b"], "target", { uniqueBy: "name", overwriteMode: "mergeByModif", index: { toEnd: true } }),
            chen.moveNodes(["pkg-c"], "target", { uniqueBy: "name", overwriteMode: "mergeByModif", index: { toEnd: true } }),
        ])

        const pkgNodes = await alice.findMany({ parentId: "target", name: "pkg" })
        expect(pkgNodes).toHaveLength(1)
        const commonFiles = await alice.findMany({ parentId: pkgNodes[0].id, name: "common.ts" })
        expect(commonFiles).toHaveLength(1)
        expect(commonFiles[0].size).toBe(3)
        expect((await listChildNames(alice, pkgNodes[0].id)).sort()).toEqual(["a.ts", "b.ts", "c.ts", "common.ts"])
        await expectAllVisibleTreeStateAccurate(alice)
        await expectAllVisibleTreeStateAccurate(bob)
        await expectAllVisibleTreeStateAccurate(chen)
    })

    test("多个用户同时用 updateNodes 移动节点到同一目录时目标目录 metadata 和 index 应正确", async () => {
        const [alice, bob, chen] = await createMultiUserTables("parallel-update-parent")
        await alice.setNodes(
            [
                { id: "target", parentId: "/", name: "target", isDir: true },
                { id: "a", parentId: "/", name: "a", isDir: true },
                { id: "b", parentId: "/", name: "b", isDir: true },
                { id: "c", parentId: "/", name: "c", isDir: true },
                { id: "from-a", parentId: "a", name: "a.txt", isDir: false, size: 2 },
                { id: "from-b", parentId: "b", name: "b.txt", isDir: false, size: 3 },
                { id: "from-c", parentId: "c", name: "c.txt", isDir: false, size: 4 },
            ],
            { index: { toEnd: true } },
        )

        await Promise.all([
            alice.updateNodes({ id: "from-a" }, { $set: { parentId: "target" } }),
            bob.updateNodes({ id: "from-b" }, { $set: { parentId: "target" } }),
            chen.updateNodes({ id: "from-c" }, { $set: { parentId: "target" } }),
        ])

        expect(await listChildIds(alice, "target")).toHaveLength(3)
        await expectAllVisibleTreeStateAccurate(alice)
        await expectAllVisibleTreeStateAccurate(bob)
        await expectAllVisibleTreeStateAccurate(chen)
    })

    test("多个用户同时把目录互相移动到对方下面时不应形成父级环", async () => {
        const [alice, bob] = await createMultiUserTables("parallel-cross-move-cycle", 2)
        await alice.setNodes(
            [
                { id: "left", parentId: "/", name: "left", isDir: true },
                { id: "right", parentId: "/", name: "right", isDir: true },
                { id: "left-file", parentId: "left", name: "left.ts", isDir: false, size: 1 },
                { id: "right-file", parentId: "right", name: "right.ts", isDir: false, size: 1 },
            ],
            { index: { toEnd: true } },
        )

        await Promise.allSettled([
            alice.moveNodes(["left"], "right", { index: { toEnd: true } }),
            bob.moveNodes(["right"], "left", { index: { toEnd: true } }),
        ])

        await expectNoParentCycles(alice)
        await expectAllVisibleTreeStateAccurate(alice)
        await expectNoParentCycles(bob)
        await expectAllVisibleTreeStateAccurate(bob)
    })
})
