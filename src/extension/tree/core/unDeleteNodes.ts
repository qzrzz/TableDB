import type { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"
import { collectDescendantNodes } from "../util/collectDescendantNodes"
import { applyTreeMetadataDelta } from "../util/applyTreeMetadataDelta"

/** 恢复节点选项 */
export interface ITreeUnDeleteNodesOptions {}

/** 删除节点结果 */
export interface ITreeDeleteResult {
    /** 是否有节点被删除 */
    hasDeleted: boolean
    /** 是否有子节点被删除 */
    hasChildDeleted: boolean
    /** 被删除的节点数量 */
    deletedCount: number
}

/** 恢复已删除的节点
 *
 * 如果 TableTree 设置了 `enableMarkDelete: true`，
 * 则删除节点时会把节点标记为已删除而不是直接从数据库中删除
 * 这时就可以通过 `unDeleteNodes()` 方法来恢复这些被标记为已删除的节点。
 * 恢复时应当按后续实现的统一规则一并恢复子节点，
 * 注意要重新维护祖先节点上的树 metadata 字段
 */
export async function unDeleteNodes(
    this: TableTree<ITreeNode>,
    /** 要恢复的节点 id 列表 */
    nodeIds: string[],
    options?: ITreeUnDeleteNodesOptions,
): Promise<void> {
    const uniqueNodeIds = Array.from(new Set(nodeIds))
    if (uniqueNodeIds.length === 0) return

    const descendantNodes = await collectDescendantNodes(this, uniqueNodeIds, {
        includeSelf: true,
        ignoreMarkDelete: true,
    })
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
    await updateRestoredDirMetadata(this, restoredNodes, restoredStatsByDirId, modif)
}

interface IRestoredDirStats {
    ctotal: number
    cftotal: number
    csize: number
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

        setNumberStat($set, $unset, "ctotal", stats.ctotal)
        setNumberStat($set, $unset, "cftotal", stats.cftotal)
        setNumberStat($set, $unset, "csize", stats.csize)
        if (
            node.ctotal !== stats.ctotal ||
            node.cftotal !== stats.cftotal ||
            node.csize !== stats.csize
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

function setNumberStat(
    $set: Record<string, any>,
    $unset: Record<string, true>,
    key: "ctotal" | "cftotal" | "csize",
    value: number,
) {
    if (value > 0) {
        $set[key] = value
    } else {
        $unset[key] = true
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
