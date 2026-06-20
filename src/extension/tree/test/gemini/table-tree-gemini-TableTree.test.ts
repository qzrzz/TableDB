import { SQLiteAdapter } from "../../../../adapter/SQLite"
import { TableTree } from "../../TableTree"
import type { ITreeNode } from "../../tree.types"
import { rebalanceTreeIndexes } from "../../util/rebalanceTreeIndexes"

function createTreeTable(name: string) {
    return new TableTree<ITreeNode>({
        name,
        adapter: SQLiteAdapter({ filename: ":memory:", driver: "better-sqlite3" }),
        enableMarkDelete: true,
    })
}

describe("TableTree 目录树 BUG 测试 (Gemini)", () => {
    test("使用 setNodes 批量创建嵌套多层级节点时，父节点的统计信息（ctotal, csize 等）应该正确维护", async () => {
        const table = createTreeTable("tree_bug_nested_set_nodes")
        await table.inited

        // 一次性批量写入三层嵌套 of 目录树结构
        await table.setNodes([
            { id: "dir1", name: "dir1", isDir: true, parentId: "/" },
            { id: "dir2", name: "dir2", isDir: true, parentId: "dir1" },
            { id: "file1", name: "file1.txt", isDir: false, size: 100, parentId: "dir2" },
        ])

        const nodeDir2 = await table.get("dir2")
        const nodeDir1 = await table.get("dir1")

        // 验证第二层节点 dir2 的统计信息
        expect(nodeDir2?.ctotal).toBe(1)
        expect(nodeDir2?.cftotal).toBe(1)
        expect(nodeDir2?.csize).toBe(100)

        // 验证第一层节点 dir1 的统计信息
        // 应该包含 dir2 (1个目录) 加上 file1 (1个文件)，共计 2 个后代节点
        expect(nodeDir1?.ctotal).toBe(2)
        expect(nodeDir1?.cftotal).toBe(1)
        expect(nodeDir1?.csize).toBe(100)
    })

    test("当父节点的 ctotal 或 csize 从 undefined 变为有值时，其 modif 应该被更新", async () => {
        const table = createTreeTable("tree_bug_modif_update")
        await table.inited

        // 1. 创建一个初始为空 neighborhood 的目录
        await table.createNodes([{ id: "dir", name: "dir", isDir: true }], "/")
        const dirInit = await table.get("dir")
        expect(dirInit?.ctotal).toBeUndefined()
        expect(dirInit?.csize).toBeUndefined()
        const initModif = dirInit?.modif
        expect(initModif).toBeGreaterThan(0)

        // 稍作延迟确保时间戳不同
        await new Promise((resolve) => setTimeout(resolve, 5))

        // 2. 在该目录下创建一个子文件，使得 ctotal 从 undefined 变为 1，csize 从 undefined 变为 10
        await table.createNodes([{ id: "file", name: "file.txt", size: 10, isDir: false }], "dir")

        const dirAfter = await table.get("dir")
        expect(dirAfter?.ctotal).toBe(1)
        expect(dirAfter?.csize).toBe(10)

        // 验证 modif 确实被更新（变大）
        expect(dirAfter?.modif).toBeGreaterThan(initModif!)
    })

    test("使用 copyNodes 递归复制多层级嵌套节点时，复制得到的新目录的统计信息应该正确维护", async () => {
        const table = createTreeTable("tree_bug_copy_nested")
        await table.inited

        // 1. 创建嵌套结构（分批创建以避开 setNodes 的 bug）
        await table.createNodes([{ id: "dir1", name: "dir1", isDir: true }], "/")
        await table.createNodes([{ id: "dir2", name: "dir2", isDir: true }], "dir1")
        await table.createNodes([{ id: "file1", name: "file1.txt", isDir: false, size: 100 }], "dir2")

        // 2. 递归复制整个目录
        const result = await table.copyNodes(["dir1"], "/", { deep: true, renameOnCopy: true })
        expect(result.createdNodeIds.length).toBe(1)
        const copiedRootId = result.createdNodeIds[0]

        // 查找复制出来的 dir2 节点
        const copiedDir2List = await table.findMany({ parentId: copiedRootId, name: "dir2" })
        expect(copiedDir2List.length).toBe(1)
        const copiedDir2 = copiedDir2List[0]

        const copiedRoot = await table.get(copiedRootId)

        // 验证复制出来的子目录和根目录的统计信息
        expect(copiedDir2?.ctotal).toBe(1)
        expect(copiedDir2?.cftotal).toBe(1)
        expect(copiedDir2?.csize).toBe(100)

        expect(copiedRoot?.ctotal).toBe(2)
        expect(copiedRoot?.cftotal).toBe(1)
        expect(copiedRoot?.csize).toBe(100)
    })

    test("当触发索引重排 (rebalance) 时，受影响节点的 modif 和父目录的 cmodif 应该被更新", async () => {
        const table = createTreeTable("tree_bug_rebalance_sync")
        await table.inited

        // 1. 创建父目录
        await table.createNodes([{ id: "dir", name: "dir", isDir: true }], "/")

        // 2. 使用 setNodes 以保留自定义 index
        await table.setNodes([
            { id: "file1", name: "file1", isDir: false, index: "a", parentId: "dir" },
            { id: "file2", name: "file2", isDir: false, index: "ab", parentId: "dir" },
        ])

        const file1Init = await table.get("file1")
        const file2Init = await table.get("file2")
        const dirInit = await table.get("dir")

        // 稍作延迟
        await new Promise((resolve) => setTimeout(resolve, 5))

        // 3. 直接调用重排函数，设置较小的 maxIndexLength 以强制触发重排
        await rebalanceTreeIndexes(table, "dir", [
            { id: "file1", index: "a" },
            { id: "file2", index: "ab" },
        ], { maxIndexLength: 1 })

        const file1After = await table.get("file1")
        const file2After = await table.get("file2")
        const dirAfter = await table.get("dir")

        // 验证重排确实发生（index 应该被缩短或重写）
        expect(file2After?.index).not.toBe("ab")

        // 验证受影响子节点的 modif 被更新
        expect(file2After?.modif).toBeGreaterThan(file2Init!.modif)

        // 验证父目录的 cmodif 被更新
        expect(dirAfter?.cmodif).toBeGreaterThan(dirInit!.cmodif ?? 0)
    })

    test("preOverwriteNodes 进行冲突预检时，应该过滤掉待移动的节点自身，不报告自己与自己的冲突", async () => {
        const table = createTreeTable("tree_bug_pre_overwrite_self")
        await table.inited

        // 1. 创建一个父目录和文件
        await table.createNodes([{ id: "dir", name: "dir", isDir: true }], "/")
        await table.createNodes([{ id: "file1", name: "file1.txt", isDir: false }], "dir")

        // 2. 检查将 file1 移动 to 同级时（即仍然在 dir 下），按 name 预检不应报告冲突
        const checkResult = await table.preOverwriteNodes(
            [],
            ["file1"],
            "dir",
            { uniqueBy: "name" },
        )

        // 因为移动的就是自己，且没有其他同名节点，所以不应该有冲突
        expect(checkResult.isConflict).toBe(false)
        expect(checkResult.existNodes).toEqual([])
    })

    test("createNodes 创建节点时应该保留传入节点对象上自带 of index，而不应直接将其覆盖丢弃", async () => {
        const table = createTreeTable("tree_bug_create_nodes_keeps_index")
        await table.inited

        // 创建时显式传入自定义的 index
        await table.createNodes([
            { id: "file1", name: "file1", isDir: false, index: "custom-idx" },
        ], "/")

        const node = await table.get("file1")
        // 应保留用户传入的排序索引
        expect(node?.index).toBe("custom-idx")
    })

    test("setNodes 在进行目录合并 (merge) 时，应该正确移动数据库中已存在的源目录子节点，并清理旧目录", async () => {
        const table = createTreeTable("tree_bug_set_nodes_merge")
        await table.inited

        // 1. 创建源目录 src 及其子文件 file_src
        await table.createNodes([{ id: "src", name: "src", isDir: true }], "/")
        await table.createNodes([{ id: "file_src", name: "file.txt", isDir: false }], "src")

        // 2. 创建目标目录 target
        await table.createNodes([{ id: "target", name: "target", isDir: true }], "/")

        // 3. 调用 setNodes 将 src 重命名为 target，触发合并
        await table.setNodes(
            [{ id: "src", name: "target", parentId: "/" }],
            { uniqueBy: "name", overwriteMode: "merge" }
        )

        // 验证源目录已不复存在（或被标记删除）
        const oldSrc = await table.get("src")
        expect(oldSrc).toBeUndefined()

        // 验证源目录下的子文件已被正确移动到目标目录 target 下
        const file = await table.get("file_src")
        expect(file?.parentId).toBe("target")
    })

    test("moveNodes 批量移动多个节点时，如果这批节点中存在同名冲突，应该遵循冲突覆盖策略处理", async () => {
        const table = createTreeTable("tree_bug_batch_move_self_conflict")
        await table.inited

        // 1. 创建两个源目录，每个目录下面都有一个同名 file.txt
        await table.createNodes([{ id: "dir1", name: "dir1", isDir: true }], "/")
        await table.createNodes([{ id: "dir2", name: "dir2", isDir: true }], "/")
        await table.createNodes([{ id: "f1", name: "file.txt", isDir: false }], "dir1")
        await table.createNodes([{ id: "f2", name: "file.txt", isDir: false }], "dir2")

        // 2. 创建目标目录
        await table.createNodes([{ id: "target", name: "target", isDir: true }], "/")

        // 3. 批量将这两个同名文件移动到目标目录下，设置唯一属性为 name，覆盖策略为 newName
        await table.moveNodes(["f1", "f2"], "target", {
            uniqueBy: "name",
            overwriteMode: "newName",
        })

        const file1 = await table.get("f1")
        const file2 = await table.get("f2")

        // 验证它们都被移动到了 target 下
        expect(file1?.parentId).toBe("target")
        expect(file2?.parentId).toBe("target")

        // 验证两个文件的名字不能完全相同（由于 uniqueBy: name 且 newName，其中一个应该重命名，例如 file (1).txt）
        const names = [file1?.name, file2?.name]
        expect(names).toContain("file.txt")
        expect(names).toContain("file (1).txt")
    })

    test("setNodes 批量写入多个包含内部同名冲突的节点时，在 replace 覆盖模式下应确保同级唯一约束不被破坏", async () => {
        const table = createTreeTable("tree_bug_batch_set_internal_conflict")
        await table.inited

        // 批量向 "/" 写入两个同名为 "conflict.txt" 的文件
        await table.setNodes([
            { id: "node1", name: "conflict.txt", parentId: "/", isDir: false },
            { id: "node2", name: "conflict.txt", parentId: "/", isDir: false },
        ], {
            uniqueBy: "name",
            overwriteMode: "replace",
        })

        // 查找根目录下名称为 "conflict.txt" 的有效节点
        const activeNodes = await table.findMany({ parentId: "/", name: "conflict.txt" })
        // 应该只有 1 个文件，另一个文件由于被覆盖，不应该同时存在
        expect(activeNodes.length).toBe(1)
    })

    test("moveNodes 批量移动节点时，如果同时移动了父目录和其子节点，子节点应该保留在父目录下，而不应被平铺移动到目标目录", async () => {
        const table = createTreeTable("tree_bug_move_nodes_nested_flatten")
        await table.inited

        // 1. 创建源目录结构: dir1/child_file
        await table.createNodes([{ id: "dir1", name: "dir1", isDir: true }], "/")
        await table.createNodes([{ id: "child_file", name: "child.txt", isDir: false }], "dir1")

        // 2. 创建目标目录 target
        await table.createNodes([{ id: "target", name: "target", isDir: true }], "/")

        // 3. 批量将 dir1 及其子文件 child_file 移动到 target
        await table.moveNodes(["dir1", "child_file"], "target")

        const dir1 = await table.get("dir1")
        const child = await table.get("child_file")

        // 验证 dir1 被移动到 target 下
        expect(dir1?.parentId).toBe("target")
        // 验证子文件应仍然在 dir1 下，而不是被平铺直接移动到 target 下
        expect(child?.parentId).toBe("dir1")
    })
})