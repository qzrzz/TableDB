import type { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"
import chalk from "chalk"

/**
 * 清理无效的死节点（孤立节点）
 *
 * 无效节点是指那些不再满足树形可达性条件的节点，例如：
 * 1. 父级节点被删除了，但子节点还存在（例如递归删除时，程序被意外中断，导致子节点残留）。
 * 2. 某个节点虽然父级存在，但父级的父级被删除了（祖先断链）。
 *
 * 算法策略：
 * 1. 生成一个唯一的时间戳/标识，从根节点（parentId 为 "/" 且未被标记删除的节点）开始遍历。
 * 2. 通过 BFS 广度优先遍历树，将每个可达节点的临时属性 `__checkIsNotDead` 标记为该标识。
 * 3. 遍历结束后，未被打上该标记的节点即为死节点。
 * 4. 根据表是否启用 `enableMarkDelete`，在物理删除时保留已标记删除的节点（即排除 `_isDeleted: true` 节点），而只清理其他孤立的正常节点。
 * 5. 清理完死节点后，移除所有存活节点上的临时标记。
 *
 * 由于此操作需要遍历所有节点，可能会比较耗时，工具会使用 chalk 在控制台输出多彩的日志提示进度和结果。
 *
 * @param table 目录树表实例
 * @returns 返回清理掉的无效死节点数量
 */
export async function clearDeadNodes<TNode extends ITreeNode = ITreeNode>(
    table: TableTree<TNode>
): Promise<number> {
    const startTime = performance.now()
    const flagKey = "__checkIsNotDead"
    const flagValue = `dead_check_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

    console.log(chalk.blue.bold(`[ClearDeadNodes] 开始扫描无效死节点...`))

    // 1. 获取所有有效的根节点 (parentId 为 "/")
    // 注意：默认 findMany 会排除已标记删除 (_isDeleted === true) 的节点
    const rootNodes = await table.findMany({ parentId: "/" })
    const rootIds = rootNodes.map((n) => n.id)

    if (rootIds.length === 0) {
        console.log(chalk.yellow(`[ClearDeadNodes] 未在根路径 "/" 下找到任何有效节点。`))
    } else {
        // 给根节点打上标记
        await table.adapter.updateMany(
            { id: { $in: rootIds } },
            { $set: { [flagKey]: flagValue } }
        )
    }

    // 2. BFS 队列遍历所有可达节点
    let queue = [...rootIds]
    const visited = new Set<string>(rootIds)
    let scannedCount = rootIds.length

    while (queue.length > 0) {
        // 每次取 500 个父节点 ID 进行批量子节点查询，防止 SQL IN 操作过大
        const batchParentIds = queue.splice(0, 500)
        
        // 查找这批父节点名下的子节点 (同样默认不包含已标记删除的子节点)
        const children = await table.findMany({ parentId: { $in: batchParentIds } })
        
        // 筛选出未访问过的子节点 ID
        const unvisitedIds = children
            .map((c) => c.id)
            .filter((id) => !visited.has(id))

        if (unvisitedIds.length > 0) {
            // 给子节点打标记
            await table.adapter.updateMany(
                { id: { $in: unvisitedIds } },
                { $set: { [flagKey]: flagValue } }
            )

            // 放入队列和访问集合
            for (const id of unvisitedIds) {
                visited.add(id)
                queue.push(id)
            }
            scannedCount += unvisitedIds.length
            console.log(chalk.dim(`[ClearDeadNodes] 扫描中：已标记 ${scannedCount} 个有效可达节点...`))
        }
    }

    console.log(chalk.green(`[ClearDeadNodes] 可达节点标记完成，共扫描并标记了 ${chalk.bold(scannedCount)} 个有效节点。`))

    // 3. 构建删除死节点的 filter
    // 如果启用了标记删除，则排除 _isDeleted: true 节点，避免把正常逻辑删除的节点当作脏数据物理清除
    const deleteFilter: any = {
        [flagKey]: { $ne: flagValue }
    }
    if (table.options.enableMarkDelete) {
        deleteFilter._isDeleted = { $ne: true }
    }

    // 获取并物理删除无效死节点
    const deadCount = await table.adapter.count(deleteFilter)
    if (deadCount > 0) {
        console.log(chalk.red.bold(`[ClearDeadNodes] 发现 ${deadCount} 个无效孤立节点，正在物理删除...`))
        await table.adapter.deleteMany(deleteFilter)
        console.log(chalk.red(`[ClearDeadNodes] 成功删除了 ${chalk.bold(deadCount)} 个无效节点。`))
    } else {
        console.log(chalk.green(`[ClearDeadNodes] 未发现任何无效死节点，结构完整。`))
    }

    // 4. 清理所有存活节点上的临时打标属性
    await table.adapter.updateMany(
        { [flagKey]: flagValue },
        { $unset: { [flagKey]: "" } as any }
    )

    const duration = (performance.now() - startTime).toFixed(2)
    console.log(chalk.blue.bold(`[ClearDeadNodes] 扫描清理流程结束，共耗时 ${duration}ms。\n`))

    return deadCount
}
