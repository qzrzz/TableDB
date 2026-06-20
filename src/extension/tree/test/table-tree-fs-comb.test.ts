import { SQLiteAdapter } from "../../../adapter/SQLite"
import { TableTree, defineTableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"

// 编写文件目录树连续操作的各种测试
// 目的是模仿文件系统的各种文件操作
// 组合 TableTree 的各种接口连续使用，达到一定复杂度，以发现潜在的 bug
// 看看组合使用时有没有什么问题

interface ITestTreeNode extends ITreeNode {
    tag?: string
    type?: "folder" | "file" | "asset" | "backup" | "archive" | "trash"
    meta?: {
        hash_md5?: string
        stage?: string
        owner?: string
    }
}

let tableIndex = 0

async function createDefinedTreeTable(name: string) {
    const useTreeTable = defineTableTree<ITestTreeNode>({
        name: `test-tree-fs-comb-${tableIndex++}-${name}`,
        adapter: SQLiteAdapter({ filename: ":memory:", driver: "better-sqlite3" }),
        enableMarkDelete: true,
    })

    return await useTreeTable()
}

async function listChildNames(table: TableTree<ITestTreeNode>, parentId: string, ignoreMarkDelete = false) {
    const result = await table.listNodes(parentId, { pageSize: 100, ignoreMarkDelete })
    return result.list.map((node) => node.name)
}

async function listChildIds(table: TableTree<ITestTreeNode>, parentId: string, ignoreMarkDelete = false) {
    const result = await table.listNodes(parentId, { pageSize: 100, ignoreMarkDelete })
    return result.list.map((node) => node.id)
}

async function getChildByName(table: TableTree<ITestTreeNode>, parentId: string, name: string) {
    const [node] = await table.findMany({ parentId, name })
    return node as ITestTreeNode | undefined
}

async function expectStats(
    table: TableTree<ITestTreeNode>,
    nodeId: string,
    expected: { ctotal: number; cftotal: number; csize: number },
) {
    const node = await table.get(nodeId)
    expect(node?.ctotal ?? 0).toBe(expected.ctotal)
    expect(node?.cftotal ?? 0).toBe(expected.cftotal)
    expect(node?.csize ?? 0).toBe(expected.csize)
}

async function expectAllVisibleDirStatsAccurate(table: TableTree<ITestTreeNode>) {
    const nodes = await table.findMany({}) as ITestTreeNode[]
    const nodesByParentId = new Map<string, ITestTreeNode[]>()
    for (const node of nodes) {
        const children = nodesByParentId.get(node.parentId) ?? []
        children.push(node)
        nodesByParentId.set(node.parentId, children)
    }

    function collectVisibleDescendants(nodeId: string): ITestTreeNode[] {
        const children = nodesByParentId.get(nodeId) ?? []
        return children.flatMap((child) => [child, ...collectVisibleDescendants(child.id)])
    }

    for (const node of nodes) {
        if (!node.isDir) continue
        const descendants = collectVisibleDescendants(node.id)
        expect(node.ctotal ?? 0).toBe(descendants.length)
        expect(node.cftotal ?? 0).toBe(descendants.filter((child) => !child.isDir).length)
        expect(node.csize ?? 0).toBe(descendants.reduce((total, child) => total + (child.size ?? 0), 0))
    }
}

describe("TableTree 文件系统连续组合操作", () => {
    test("连续进行创建、深拷贝、移动重命名、更新、删除和恢复后应保持目录统计一致", async () => {
        const table = await createDefinedTreeTable("workspace-life-cycle")

        await table.createNodes(
            [
                { id: "workspace", name: "工作区", isDir: true, type: "folder" },
                { id: "archive", name: "归档", isDir: true, type: "archive" },
                { id: "trash", name: "回收站", isDir: true, type: "trash" },
            ],
            "/",
            { index: { toEnd: true } },
        )
        await table.setNodes(
            [
                { id: "project", parentId: "workspace", name: "项目", isDir: true, type: "folder" },
                { id: "src", parentId: "project", name: "src", isDir: true, type: "folder" },
                { id: "readme", parentId: "project", name: "README.md", isDir: false, size: 3, type: "file" },
                { id: "app", parentId: "src", name: "app.ts", isDir: false, size: 10, type: "file" },
                { id: "logo", parentId: "src", name: "logo.png", isDir: false, size: 7, type: "asset" },
            ],
            { index: { toEnd: true } },
        )

        const copyResult = await table.copyNodes(["project"], "archive", {
            deep: true,
            renameOnCopy: false,
            index: { toEnd: true },
        })
        const archiveProjectId = copyResult.createdNodeIds[0]
        await table.moveNodes(["logo"], "archive", {
            uniqueBy: "name",
            overwriteMode: "newName",
            index: { toEnd: true },
        })
        await table.updateNodes({ id: "src" }, { $set: { tag: "已编译", meta: { stage: "build" } } }, { deep: true })
        await table.deleteNodes(["readme"])
        await table.unDeleteNodes(["readme"])

        expect(await listChildNames(table, "/")).toEqual(["工作区", "归档", "回收站"])
        expect(await listChildNames(table, "project")).toEqual(["src", "README.md"])
        expect(await listChildNames(table, "src")).toEqual(["app.ts"])
        expect(await listChildNames(table, "archive")).toEqual(["项目", "logo.png"])
        expect((await table.get("app"))?.tag).toBe("已编译")
        expect((await table.get("logo"))?.parentId).toBe("archive")
        expect((await table.get("readme") as any)?._isDeleted).toBeUndefined()
        expect(await getChildByName(table, archiveProjectId, "src")).toBeTruthy()
        await expectStats(table, "workspace", { ctotal: 4, cftotal: 2, csize: 13 })
        await expectStats(table, "project", { ctotal: 3, cftotal: 2, csize: 13 })
        await expectStats(table, "src", { ctotal: 1, cftotal: 1, csize: 10 })
        await expectStats(table, "archive", { ctotal: 6, cftotal: 4, csize: 27 })
    })

    test("连续同步同名目录时 replace 应清理旧目录子树并接住本批次新子树", async () => {
        const table = await createDefinedTreeTable("sync-replace-dir")

        await table.createNodes(
            [
                { id: "local", name: "本地", isDir: true },
                { id: "remote", name: "远端", isDir: true },
            ],
            "/",
        )
        await table.createNodes([{ id: "target-src", name: "src", isDir: true, tag: "old" }], "local")
        await table.createNodes(
            [
                { id: "stale-file", name: "stale.ts", isDir: false, size: 11 },
                { id: "keep-id", name: "old-name.ts", isDir: false, size: 5, tag: "old" },
            ],
            "target-src",
        )
        await table.setNodes(
            [
                { id: "incoming-src", parentId: "local", name: "src", isDir: true, tag: "new" },
                { id: "keep-id", parentId: "incoming-src", name: "main.ts", isDir: false, size: 20, tag: "new" },
                { id: "new-dir", parentId: "incoming-src", name: "components", isDir: true },
                { id: "new-file", parentId: "new-dir", name: "button.ts", isDir: false, size: 8 },
            ],
            { uniqueBy: "name", overwriteMode: "replace", index: { toEnd: true } },
        )
        await table.copyNodes(["target-src"], "remote", { deep: true, renameOnCopy: false })

        expect(await table.get("incoming-src")).toBeUndefined()
        expect(await table.get("stale-file")).toBeUndefined()
        expect((await table.get("target-src"))?.tag).toBe("new")
        expect((await table.get("keep-id"))?.parentId).toBe("target-src")
        expect((await table.get("keep-id"))?.name).toBe("main.ts")
        expect((await table.get("new-file"))?.parentId).toBe("new-dir")
        expect(await listChildNames(table, "target-src")).toEqual(["main.ts", "components"])
        expect((await getChildByName(table, "remote", "src"))?.ctotal).toBe(3)
        await expectStats(table, "target-src", { ctotal: 3, cftotal: 2, csize: 28 })
        await expectStats(table, "local", { ctotal: 4, cftotal: 2, csize: 28 })
        await expectStats(table, "remote", { ctotal: 4, cftotal: 2, csize: 28 })
    })

    test("连续移动目录到同名目标并 merge 后应保留目标目录且迁移来源子树", async () => {
        const table = await createDefinedTreeTable("move-merge-release")

        await table.createNodes(
            [
                { id: "downloads", name: "下载", isDir: true },
                { id: "library", name: "资料库", isDir: true },
                { id: "backup", name: "备份", isDir: true },
            ],
            "/",
        )
        await table.createNodes([{ id: "download-album", name: "相册", isDir: true, tag: "source" }], "downloads")
        await table.createNodes(
            [
                { id: "raw", name: "raw", isDir: true },
                { id: "cover", name: "cover.jpg", isDir: false, size: 4 },
            ],
            "download-album",
        )
        await table.createNodes([{ id: "photo-a", name: "a.jpg", isDir: false, size: 6 }], "raw")
        await table.createNodes([{ id: "library-album", name: "相册", isDir: true, tag: "target" }], "library")
        await table.createNodes([{ id: "old-cover", name: "cover.jpg", isDir: false, size: 1, tag: "old" }], "library-album")

        await table.moveNodes(["download-album"], "library", { uniqueBy: "name", overwriteMode: "merge" })
        await table.copyNodes(["library-album"], "backup", { deep: true, renameOnCopy: false })
        await table.updateNodes({ id: "library-album" }, { $set: { type: "folder", meta: { owner: "photo-team" } } })

        expect(await table.get("download-album")).toBeUndefined()
        expect((await table.get("library-album"))?.tag).toBe("target")
        expect((await table.get("raw"))?.parentId).toBe("library-album")
        expect((await table.get("cover"))?.parentId).toBe("library-album")
        expect(await table.get("old-cover")).toBeUndefined()
        expect((await table.get("library-album"))?.meta?.owner).toBe("photo-team")
        expect(await listChildNames(table, "library-album")).toEqual(["raw", "cover.jpg"])
        expect((await getChildByName(table, "backup", "相册"))?.ctotal).toBe(3)
        await expectStats(table, "downloads", { ctotal: 0, cftotal: 0, csize: 0 })
        await expectStats(table, "library", { ctotal: 4, cftotal: 2, csize: 10 })
        await expectStats(table, "backup", { ctotal: 4, cftotal: 2, csize: 10 })
    })

    test("连续删除、恢复、再移动并按内容哈希覆盖时应只影响当前可见文件", async () => {
        const table = await createDefinedTreeTable("trash-restore-replace-by-hash")

        await table.createNodes(
            [
                { id: "desk", name: "桌面", isDir: true },
                { id: "docs", name: "文档", isDir: true },
                { id: "trash", name: "回收站", isDir: true },
            ],
            "/",
        )
        await table.createNodes(
            [
                { id: "report", name: "report.md", isDir: false, size: 9, tag: "draft", meta: { hash_md5: "hash-report" } },
                { id: "notes", name: "notes.md", isDir: false, size: 2, meta: { hash_md5: "hash-notes" } },
            ],
            "desk",
        )
        await table.createNodes([{ id: "old-report", name: "old-report.md", isDir: false, size: 1, tag: "old", meta: { hash_md5: "hash-report" } }], "docs")

        await table.deleteNodes(["notes"])
        await table.moveNodes(["report"], "docs", { uniqueBy: "meta.hash_md5", overwriteMode: "replace" })
        await table.unDeleteNodes(["notes"])
        await table.moveNodes(["notes"], "trash")
        await table.updateNodes({ id: "report" }, { $set: { name: "report-final.md", tag: "final", size: 12 } })

        expect(await table.get("old-report")).toBeUndefined()
        expect((await table.get("report"))?.parentId).toBe("docs")
        expect((await table.get("report"))?.name).toBe("report-final.md")
        expect((await table.get("report"))?.tag).toBe("final")
        expect((await table.get("notes"))?.parentId).toBe("trash")
        expect(await listChildNames(table, "desk")).toEqual([])
        expect(await listChildNames(table, "docs")).toEqual(["report-final.md"])
        expect(await listChildNames(table, "trash")).toEqual(["notes.md"])
        await expectStats(table, "desk", { ctotal: 0, cftotal: 0, csize: 0 })
        await expectStats(table, "docs", { ctotal: 1, cftotal: 1, csize: 12 })
        await expectStats(table, "trash", { ctotal: 1, cftotal: 1, csize: 2 })
    })

    test("连续预检、导入、自动重命名、游标分页和软删除后应保持可见列表稳定", async () => {
        const table = await createDefinedTreeTable("precheck-import-cursor-delete")

        await table.createNodes(
            [
                { id: "inbox", name: "收件箱", isDir: true },
                { id: "photos", name: "照片", isDir: true },
                { id: "trash", name: "回收站", isDir: true },
            ],
            "/",
        )
        await table.createNodes(
            [
                { id: "photo-a", name: "IMG_001.jpg", isDir: false, size: 5, type: "asset", meta: { hash_md5: "hash-a" } },
                { id: "photo-b", name: "IMG_002.jpg", isDir: false, size: 6, type: "asset", meta: { hash_md5: "hash-b" } },
            ],
            "photos",
            { index: { toEnd: true } },
        )
        await table.createNodes(
            [
                { id: "import-a", name: "IMG_001.jpg", isDir: false, size: 7, type: "asset", meta: { hash_md5: "hash-a-new" } },
                { id: "import-c", name: "IMG_003.jpg", isDir: false, size: 8, type: "asset", meta: { hash_md5: "hash-c" } },
            ],
            "inbox",
            { index: { toEnd: true } },
        )

        const precheck = await table.preOverwriteNodes([], ["import-a", "import-c"], "photos", {
            uniqueBy: "name",
            projection: ["id", "name"],
        })
        expect(precheck).toEqual({
            isConflict: true,
            existNodes: [{ id: "photo-a", name: "IMG_001.jpg" }],
        })

        await table.moveNodes(["import-a", "import-c"], "photos", {
            uniqueBy: "name",
            overwriteMode: "newName",
            index: { toEnd: true },
        })
        const firstPage = await table.listNodesByCursor("photos", { pageSize: 2, sortKey: "name", sortOrder: 1 })
        const secondPage = await table.listNodesByCursor("photos", {
            pageSize: 2,
            sortKey: "name",
            sortOrder: 1,
            cursor: firstPage.nextCursor,
        })
        await table.deleteNodes(["photo-b"])
        await table.moveNodes(["photo-b"], "trash")

        expect(firstPage.list.map((node) => node.name)).toEqual(["IMG_001 (1).jpg", "IMG_001.jpg"])
        expect(secondPage.list.map((node) => node.name)).toEqual(["IMG_002.jpg", "IMG_003.jpg"])
        expect(await listChildNames(table, "photos")).toEqual(["IMG_001.jpg", "IMG_001 (1).jpg", "IMG_003.jpg"])
        expect(await listChildNames(table, "photos", true)).toEqual(["IMG_001.jpg", "IMG_002.jpg", "IMG_001 (1).jpg", "IMG_003.jpg"])
        expect((await table.get("photo-b"))).toBeUndefined()
        expect((await table.get("photo-b", { ignoreMarkDelete: true }))?._isDeleted).toBe(true)
        await expectStats(table, "inbox", { ctotal: 0, cftotal: 0, csize: 0 })
        await expectStats(table, "photos", { ctotal: 3, cftotal: 3, csize: 20 })
        await expectStats(table, "trash", { ctotal: 0, cftotal: 0, csize: 0 })
    })

    test("连续本地编辑和 presync 检查应能区分过期目录、缺失节点和已同步节点", async () => {
        const table = await createDefinedTreeTable("presync-after-local-edit")

        await table.setNodes(
            [
                { id: "workspace", parentId: "/", name: "工作区", isDir: true },
                { id: "draft", parentId: "workspace", name: "草稿", isDir: true },
                { id: "doc-a", parentId: "draft", name: "a.md", isDir: false, size: 4, modif: 10 },
                { id: "doc-b", parentId: "draft", name: "b.md", isDir: false, size: 5, modif: 20 },
            ],
            { index: { toEnd: true } },
        )
        const oldDraft = await table.get("draft")
        const oldDocB = await table.get("doc-b")

        await table.updateNodes({ id: "doc-a" }, { $set: { size: 40, tag: "edited" } })
        await table.deleteNodes(["doc-b"])
        const syncResult = await table.presyncNodes([
            { id: "draft", cmodif: oldDraft?.cmodif },
            { id: "doc-a", modif: 10 },
            { id: "doc-b", modif: oldDocB?.modif },
            { id: "missing-online", modif: 1 },
        ])
        await table.unDeleteNodes(["doc-b"])
        await table.setNodes([{ id: "doc-b", parentId: "draft", name: "b-renamed.md", isDir: false, size: 6 }], {
            setMode: "default",
        })

        expect(syncResult.needSync).toBe(true)
        expect(syncResult.syncNodeIds).toEqual(["draft", "doc-a"])
        expect(syncResult.deletedNodeIds).toEqual(["doc-b", "missing-online"])
        expect((await table.get("doc-a"))?.size).toBe(40)
        expect((await table.get("doc-b"))?.name).toBe("b-renamed.md")
        await expectStats(table, "draft", { ctotal: 2, cftotal: 2, csize: 46 })
        await expectStats(table, "workspace", { ctotal: 3, cftotal: 2, csize: 46 })
    })

    test("连续 replace、skip、mergeByModif 和 realDelete 混合覆盖时应只保留预期节点", async () => {
        const table = await createDefinedTreeTable("overwrite-mode-chain")

        await table.createNodes(
            [
                { id: "left", name: "左侧", isDir: true },
                { id: "right", name: "右侧", isDir: true },
                { id: "backup", name: "备份", isDir: true },
            ],
            "/",
        )
        await table.createNodes(
            [
                { id: "left-file", name: "same.txt", isDir: false, size: 3, tag: "left", modif: 30 },
                { id: "left-old", name: "old.txt", isDir: false, size: 2, tag: "old", modif: 5 },
                { id: "left-dir", name: "pkg", isDir: true, tag: "left-dir", modif: 30 },
            ],
            "left",
        )
        await table.createNodes([{ id: "left-dir-file", name: "index.ts", isDir: false, size: 9, modif: 30 }], "left-dir")
        await table.createNodes(
            [
                { id: "right-file", name: "same.txt", isDir: false, size: 4, tag: "right", modif: 10 },
                { id: "right-old", name: "old.txt", isDir: false, size: 1, tag: "newer-target", modif: 50 },
                { id: "right-dir", name: "pkg", isDir: true, tag: "right-dir", modif: 10 },
            ],
            "right",
        )
        await table.createNodes([{ id: "right-dir-file", name: "readme.md", isDir: false, size: 7, modif: 10 }], "right-dir")

        await table.copyNodes(["left"], "backup", { deep: true, renameOnCopy: false })
        await table.moveNodes(["left-file"], "right", { uniqueBy: "name", overwriteMode: "replace" })
        await table.moveNodes(["left-old"], "right", { uniqueBy: "name", overwriteMode: "mergeByModif" })
        await table.moveNodes(["left-dir"], "right", { uniqueBy: "name", overwriteMode: "merge" })
        await table.setNodes([{ id: "incoming-skip", parentId: "right", name: "same.txt", isDir: false, size: 99, tag: "skip" }], {
            uniqueBy: "name",
            overwriteMode: "skip",
        })
        await table.deleteNodes(["backup"], { realDelete: true })

        expect(await table.get("right-file")).toBeUndefined()
        expect((await table.get("left-file"))?.parentId).toBe("right")
        expect((await table.get("left-file"))?.tag).toBe("left")
        expect((await table.get("left-old"))?.parentId).toBe("left")
        expect((await table.get("right-old"))?.tag).toBe("newer-target")
        expect(await table.get("left-dir")).toBeUndefined()
        expect((await table.get("left-dir-file"))?.parentId).toBe("right-dir")
        expect((await table.get("right-dir-file"))?.parentId).toBe("right-dir")
        expect(await table.get("incoming-skip")).toBeUndefined()
        expect(await table.get("backup", { ignoreMarkDelete: true })).toBeUndefined()
        expect(await listChildNames(table, "right")).toEqual(["same.txt", "old.txt", "pkg"])
        await expectStats(table, "left", { ctotal: 1, cftotal: 1, csize: 2 })
        await expectStats(table, "right", { ctotal: 5, cftotal: 4, csize: 20 })
    })

    test("连续复制父子混合选择、移动父子混合选择和 deep 更新时不应把后代平铺", async () => {
        const table = await createDefinedTreeTable("nested-selection-chain")

        await table.createNodes(
            [
                { id: "source", name: "源", isDir: true },
                { id: "stage", name: "暂存", isDir: true },
                { id: "target", name: "目标", isDir: true },
            ],
            "/",
        )
        await table.setNodes(
            [
                { id: "root-dir", parentId: "source", name: "根目录", isDir: true },
                { id: "child-dir", parentId: "root-dir", name: "子目录", isDir: true },
                { id: "deep-file", parentId: "child-dir", name: "deep.txt", isDir: false, size: 12 },
                { id: "sibling-file", parentId: "root-dir", name: "sibling.txt", isDir: false, size: 5 },
            ],
            { index: { toEnd: true } },
        )

        const copyResult = await table.copyNodes(["root-dir", "child-dir", "deep-file"], "stage", {
            deep: true,
            renameOnCopy: false,
        })
        await table.moveNodes(["root-dir", "child-dir", "deep-file"], "target", { index: { toEnd: true } })
        await table.updateNodes({ id: "root-dir" }, { $set: { tag: "moved-tree" } }, { deep: true })

        const copiedRootId = copyResult.createdNodeIds[0]
        const copiedChild = await getChildByName(table, copiedRootId, "子目录")
        const copiedDeep = copiedChild ? await getChildByName(table, copiedChild.id, "deep.txt") : undefined
        expect(copyResult.createdNodeIds).toHaveLength(1)
        expect((await table.get("root-dir"))?.parentId).toBe("target")
        expect((await table.get("child-dir"))?.parentId).toBe("root-dir")
        expect((await table.get("deep-file"))?.parentId).toBe("child-dir")
        expect((await table.get("deep-file"))?.tag).toBe("moved-tree")
        expect((await table.get("sibling-file"))?.tag).toBe("moved-tree")
        expect((await table.get(copiedRootId))?.parentId).toBe("stage")
        expect(copiedDeep?.name).toBe("deep.txt")
        await expectStats(table, "source", { ctotal: 0, cftotal: 0, csize: 0 })
        await expectStats(table, "stage", { ctotal: 4, cftotal: 2, csize: 17 })
        await expectStats(table, "target", { ctotal: 4, cftotal: 2, csize: 17 })
    })

    test("连续 setMode merge、overwrite、updateOnly 和移动后应正确处理普通字段与统计字段", async () => {
        const table = await createDefinedTreeTable("set-mode-update-only-chain")

        await table.setNodes(
            [
                { id: "root", parentId: "/", name: "根", isDir: true, meta: { owner: "team-a" } },
                { id: "config", parentId: "root", name: "config.json", isDir: false, size: 2, meta: { stage: "dev", owner: "team-a" } },
                { id: "dist", parentId: "root", name: "dist", isDir: true },
            ],
            { index: { toEnd: true } },
        )
        await table.setNodes([{ id: "config", parentId: "root", name: "config.json", isDir: false, meta: { stage: "prod" } }], {
            setMode: "merge",
        })
        await table.setNodes([{ id: "config", parentId: "root", name: "config.json", isDir: false, size: 6, tag: "rewritten" }], {
            setMode: "overwrite",
        })
        const result = await table.setNodes(
            [
                { id: "config", parentId: "dist", name: "config.json", isDir: false, size: 8, tag: "published" },
                { id: "missing", parentId: "dist", name: "missing.json", isDir: false, size: 99 },
            ],
            { updateOnly: true, returnChangedNodesIds: true },
        )
        await table.createNodes([{ id: "bundle", name: "bundle.js", isDir: false, size: 20 }], "dist", { index: { toEnd: true } })

        expect(result.changedNodeIds).toEqual(["config"])
        expect(await table.get("missing")).toBeUndefined()
        expect((await table.get("config"))?.parentId).toBe("dist")
        expect((await table.get("config"))?.tag).toBe("published")
        expect((await table.get("config"))?.meta).toBeUndefined()
        expect(await listChildNames(table, "root")).toEqual(["dist"])
        expect(await listChildNames(table, "dist")).toEqual(["config.json", "bundle.js"])
        await expectStats(table, "root", { ctotal: 3, cftotal: 2, csize: 28 })
        await expectStats(table, "dist", { ctotal: 2, cftotal: 2, csize: 28 })
    })

    test("连续目录发布流程应同时覆盖预检、replace 同步、列表过滤和最终物理清理", async () => {
        const table = await createDefinedTreeTable("release-flow")

        await table.createNodes(
            [
                { id: "drafts", name: "草稿箱", isDir: true },
                { id: "public", name: "发布区", isDir: true },
                { id: "history", name: "历史", isDir: true },
            ],
            "/",
        )
        await table.setNodes(
            [
                { id: "draft-release", parentId: "drafts", name: "release", isDir: true, type: "folder" },
                { id: "draft-index", parentId: "draft-release", name: "index.html", isDir: false, type: "file", size: 10, meta: { hash_md5: "h-index-new" } },
                { id: "draft-assets", parentId: "draft-release", name: "assets", isDir: true, type: "folder" },
                { id: "draft-js", parentId: "draft-assets", name: "app.js", isDir: false, type: "file", size: 30, meta: { hash_md5: "h-js" } },
            ],
            { index: { toEnd: true } },
        )
        await table.setNodes(
            [
                { id: "public-release", parentId: "public", name: "release", isDir: true, type: "folder", tag: "old" },
                { id: "old-index", parentId: "public-release", name: "index.html", isDir: false, type: "file", size: 1, meta: { hash_md5: "h-index-old" } },
                { id: "old-css", parentId: "public-release", name: "old.css", isDir: false, type: "file", size: 2 },
            ],
            { index: { toEnd: true } },
        )

        const precheck = await table.preOverwriteNodes([], ["draft-release"], "public", { uniqueBy: "name" })
        await table.copyNodes(["public-release"], "history", { deep: true, renameOnCopy: false })
        await table.moveNodes(["draft-release"], "public", { uniqueBy: "name", overwriteMode: "replace" })
        await table.updateNodes({ id: "draft-release" }, { $set: { tag: "current" } }, { deep: true })
        const fileList = await table.listNodesByCursor("draft-release", {
            pageSize: 20,
            sortKey: "name",
            sortOrder: 1,
            onlyTypes: ["file"],
        })
        await table.deleteNodes(["history"], { realDelete: true })

        expect(precheck.isConflict).toBe(true)
        expect(precheck.existNodes.map((node) => node.id)).toEqual(["public-release"])
        expect(await table.get("public-release")).toBeUndefined()
        expect((await table.get("draft-release"))?.parentId).toBe("public")
        expect((await table.get("draft-release"))?.tag).toBe("current")
        expect((await table.get("draft-index"))?.parentId).toBe("draft-release")
        expect((await table.get("draft-js"))?.tag).toBe("current")
        expect(await table.get("old-index")).toBeUndefined()
        expect(await table.get("old-css")).toBeUndefined()
        expect(fileList.list.map((node) => node.name)).toEqual(["index.html"])
        expect(await table.get("history", { ignoreMarkDelete: true })).toBeUndefined()
        await expectStats(table, "drafts", { ctotal: 0, cftotal: 0, csize: 0 })
        await expectStats(table, "public", { ctotal: 4, cftotal: 2, csize: 40 })
    })

    test("删除目录后只恢复深层文件时应一并恢复祖先链，避免出现可见孤儿节点", async () => {
        const table = await createDefinedTreeTable("undelete-deep-child")

        await table.setNodes(
            [
                { id: "root", parentId: "/", name: "根", isDir: true },
                { id: "dir", parentId: "root", name: "目录", isDir: true },
                { id: "sub", parentId: "dir", name: "子目录", isDir: true },
                { id: "file", parentId: "sub", name: "file.txt", isDir: false, size: 9 },
            ],
            { index: { toEnd: true } },
        )

        await table.deleteNodes(["dir"])
        await table.unDeleteNodes(["file"])

        expect(await table.get("dir")).toBeTruthy()
        expect(await table.get("sub")).toBeTruthy()
        expect((await table.get("dir"))?._isDeleted).toBeUndefined()
        expect((await table.get("sub"))?._isDeleted).toBeUndefined()
        expect((await table.get("file"))?.parentId).toBe("sub")
        expect(await listChildIds(table, "root")).toEqual(["dir"])
        await expectStats(table, "root", { ctotal: 3, cftotal: 1, csize: 9 })
        await expectAllVisibleDirStatsAccurate(table)
    })

    test("连续覆盖删除后恢复旧目标目录时应保持恢复子树和当前子树的统计一致", async () => {
        const table = await createDefinedTreeTable("restore-replaced-target")

        await table.setNodes(
            [
                { id: "src", parentId: "/", name: "来源", isDir: true },
                { id: "target", parentId: "/", name: "目标", isDir: true },
                { id: "incoming", parentId: "src", name: "pkg", isDir: true, tag: "incoming" },
                { id: "incoming-file", parentId: "incoming", name: "new.ts", isDir: false, size: 5 },
                { id: "old-target", parentId: "target", name: "pkg", isDir: true, tag: "old" },
                { id: "old-file", parentId: "old-target", name: "old.ts", isDir: false, size: 7 },
            ],
            { index: { toEnd: true } },
        )

        await table.moveNodes(["incoming"], "target", { uniqueBy: "name", overwriteMode: "replace" })
        await table.unDeleteNodes(["old-target"])

        expect((await table.get("incoming"))?.parentId).toBe("target")
        expect((await table.get("old-target"))?.parentId).toBe("target")
        expect((await table.get("old-file"))?.parentId).toBe("old-target")
        expect(await listChildNames(table, "target")).toEqual(["pkg", "pkg"])
        await expectAllVisibleDirStatsAccurate(table)
    })

    test("连续批量写入同名目录并带子节点时应只保留最终目录树", async () => {
        const table = await createDefinedTreeTable("batch-same-dir-with-children")

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
        expect(await listChildNames(table, "root")).toEqual(["same"])
        await expectStats(table, "dir-b", { ctotal: 3, cftotal: 2, csize: 5 })
        await expectAllVisibleDirStatsAccurate(table)
    })

    test("多轮近似随机文件操作后所有可见目录统计都应与实际子树一致", async () => {
        const table = await createDefinedTreeTable("deterministic-operation-mix")

        await table.setNodes(
            [
                { id: "root", parentId: "/", name: "root", isDir: true },
                { id: "a", parentId: "root", name: "a", isDir: true },
                { id: "b", parentId: "root", name: "b", isDir: true },
                { id: "c", parentId: "root", name: "c", isDir: true },
                { id: "a1", parentId: "a", name: "a1.txt", isDir: false, size: 1 },
                { id: "a2", parentId: "a", name: "a2.txt", isDir: false, size: 2 },
                { id: "b1", parentId: "b", name: "b1.txt", isDir: false, size: 3 },
                { id: "cdir", parentId: "c", name: "nested", isDir: true },
                { id: "c1", parentId: "cdir", name: "c1.txt", isDir: false, size: 4 },
            ],
            { index: { toEnd: true } },
        )

        await table.copyNodes(["a"], "b", { deep: true, renameOnCopy: true, index: { toEnd: true } })
        await table.moveNodes(["cdir"], "a", { index: { toStart: true } })
        await table.updateNodes({ id: "a" }, { $set: { tag: "batch-1" } }, { deep: true })
        await table.deleteNodes(["a2"])
        await table.unDeleteNodes(["a2"])
        await table.moveNodes(["a2"], "c", { index: { toEnd: true } })
        await table.setNodes(
            [
                { id: "incoming-b", parentId: "root", name: "b", isDir: true, tag: "replace-b" },
                { id: "incoming-b-file", parentId: "incoming-b", name: "fresh.txt", isDir: false, size: 8 },
            ],
            { uniqueBy: "name", overwriteMode: "replace" },
        )
        await table.copyNodes(["a", "c"], "root", { deep: true, renameOnCopy: true, index: { toEnd: true } })
        await table.deleteNodes(["b1"], { realDelete: true })

        expect((await table.get("b"))?.tag).toBe("replace-b")
        expect((await table.get("incoming-b-file"))?.parentId).toBe("b")
        expect(await table.get("b1", { ignoreMarkDelete: true })).toBeUndefined()
        await expectAllVisibleDirStatsAccurate(table)
    })
})
