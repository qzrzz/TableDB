import type { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"
import { collectDescendantNodes } from "../util/collectDescendantNodes"
import { applyTreeMetadataDelta } from "../util/applyTreeMetadataDelta"
import { setTreeNumberStat } from "../util/setTreeNumberStat"

/** 删除节点结果 */
export interface ITreeDeleteResult {
    /** 是否有节点被删除 */
    hasDeleted: boolean
    /** 是否有子节点被删除 */
    hasChildDeleted: boolean
    /** 被删除的节点数量 */
    deletedCount: number
}

/**
 * 恢复已删除的节点
 *
 * 如果 TableTree 设置了 `enableMarkDelete: true`，
 * 则删除节点时会把节点标记为已删除而不是直接从数据库中删除
 * 这时就可以通过 `unDeleteNodes()` 方法来恢复这些被标记为已删除的节点。
 *
 * 核心流程：
 * 1. 读取待恢复节点的整棵后代子树，同时读取祖先链，避免恢复深层节点后出现可见孤儿节点。
 * 2. 只对当前确实处于 _isDeleted 状态的节点执行恢复，未删除节点不改动。
 * 3. 先基于“本次真实恢复的节点集合”重建被恢复目录内部统计，避免把仍然删除的后代计入 metadata。
 * 4. 用最外层恢复节点的贡献量增量刷新外部父级和祖先。
 * 5. 单独修正被恢复目录自身的 ctotal/cftotal/csize/childLastIndex，让恢复后的子树内部也保持一致。
 */
export async function unDeleteNodes(
    this: TableTree<ITreeNode>,
    /** 要恢复的节点 id 列表 */
    nodeIds: string[],
): Promise<void> {
    const uniqueNodeIds = Array.from(new Set(nodeIds))
    if (uniqueNodeIds.length === 0) return

    // includeSelf 恢复入口节点本身；ignoreMarkDelete 允许读取已删除节点及其后代。
    const descendantNodes = await collectDescendantNodes(this, uniqueNodeIds, {
        includeSelf: true,
        ignoreMarkDelete: true,
    })
    // 恢复深层节点时，父级如果仍处于删除状态，也要一起恢复，否则列表可见性会断层。
    const ancestorNodes = await collectAncestorNodes.call(this, uniqueNodeIds)
    const nodesById = new Map<string, ITreeNode>()
    for (const node of [...ancestorNodes, ...descendantNodes]) {
        nodesById.set(node.id, node)
    }
    const nodes = Array.from(nodesById.values())
    if (nodes.length === 0) return

    const restoredNodes = nodes.filter((node) => node._isDeleted === true)
    const restoredStatsByDirId = calcRestoredDirStats(restoredNodes)
    const topRestoredNodes = collectTopRestoredNodes(restoredNodes)
    const modif = Date.now()
    await this.updateMany(
        { id: { $in: nodes.map((node) => node.id) }, _isDeleted: true } as any,
        {
            $set: { modif } as any,
            $unset: { _isDeleted: true, _deleteDate: true } as any,
        },
        { upsert: false },
    )

    await applyTreeMetadataDelta(this, topRestoredNodes.map((node) => {
        const childStats = restoredStatsByDirId.get(node.id)
        return {
            parentId: node.parentId,
            ctotal: 1 + (childStats?.ctotal ?? 0),
            cftotal: (node.isDir ? 0 : 1) + (childStats?.cftotal ?? 0),
            csize: (node.size ?? 0) + (childStats?.csize ?? 0),
            refreshChildLastIndex: true,
        }
    }), modif)
    // applyTreeMetadataDelta 维护的是外部父级链；被恢复目录自身的内部统计需要按恢复集合重建。
    await updateRestoredDirMetadata(this, restoredNodes, restoredStatsByDirId, modif)
}

interface IRestoredDirStats {
    ctotal: number
    cftotal: number
    csize: number
    childLastIndex?: string
}

/** 根据本次真正恢复的节点集合，重建被恢复目录内部的可见统计，避免仍删除的后代被旧 metadata 带回来。 */
function calcRestoredDirStats(nodes: ITreeNode[]): Map<string, IRestoredDirStats> {
    const nodeById = new Map(nodes.map((node) => [node.id, node]))
    const statsByDirId = new Map<string, IRestoredDirStats>()
    for (const node of nodes) {
        if (node.isDir) {
            statsByDirId.set(node.id, { ctotal: 0, cftotal: 0, csize: 0 })
        }
    }

    for (const node of nodes) {
        let parentId: string | undefined = node.parentId
        while (parentId && nodeById.has(parentId)) {
            const stats = statsByDirId.get(parentId)
            if (stats) {
                stats.ctotal += 1
                stats.cftotal += node.isDir ? 0 : 1
                stats.csize += node.size ?? 0
                if (parentId === node.parentId && node.index && (!stats.childLastIndex || node.index > stats.childLastIndex)) {
                    // 目录恢复可能只恢复部分子级，childLastIndex 必须按本次真实可见的直接子级重建。
                    stats.childLastIndex = node.index
                }
            }
            parentId = nodeById.get(parentId)?.parentId
        }
    }

    return statsByDirId
}

function collectTopRestoredNodes(nodes: ITreeNode[]): ITreeNode[] {
    const restoredNodeIds = new Set(nodes.map((node) => node.id))
    return nodes.filter((node) => !restoredNodeIds.has(node.parentId))
}

async function updateRestoredDirMetadata(
    table: TableTree<ITreeNode>,
    restoredNodes: ITreeNode[],
    statsByDirId: Map<string, IRestoredDirStats>,
    cmodif: number,
): Promise<void> {
    const updates: Parameters<TableTree<ITreeNode>["bulkUpdate"]>[0] = []
    for (const node of restoredNodes) {
        if (!node.isDir) continue
        const stats = statsByDirId.get(node.id) ?? { ctotal: 0, cftotal: 0, csize: 0 }
        const $set: Record<string, any> = { cmodif }
        const $unset: Record<string, true> = {}

        setTreeNumberStat($set, $unset, "ctotal", stats.ctotal)
        setTreeNumberStat($set, $unset, "cftotal", stats.cftotal)
        setTreeNumberStat($set, $unset, "csize", stats.csize)
        if (stats.childLastIndex) {
            $set.childLastIndex = stats.childLastIndex
        } else {
            $unset.childLastIndex = true
        }
        if (
            node.ctotal !== stats.ctotal ||
            node.cftotal !== stats.cftotal ||
            node.csize !== stats.csize ||
            node.childLastIndex !== stats.childLastIndex
        ) {
            $set.modif = cmodif
        }

        updates.push({
            filter: { id: node.id },
            updateOp: { $set: $set as any, $unset },
        })
    }

    if (updates.length > 0) {
        await table.bulkUpdate(updates)
    }
}

/** 恢复深层节点时需要一并恢复祖先链，避免出现父级已删除但子节点可见的断层。 */
async function collectAncestorNodes(this: TableTree<ITreeNode>, nodeIds: string[]): Promise<ITreeNode[]> {
    const result: ITreeNode[] = []
    const visitedIds = new Set<string>()

    for (const nodeId of nodeIds) {
        let node = await this.get(nodeId, { ignoreMarkDelete: true })
        while (node && node.parentId !== "/" && !visitedIds.has(node.parentId)) {
            const parentNode = await this.get(node.parentId, { ignoreMarkDelete: true })
            if (!parentNode) break
            visitedIds.add(parentNode.id)
            result.push(parentNode)
            node = parentNode
        }
    }

    return result
}
