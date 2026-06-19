import type { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"
import { collectAncestorIds } from "./collectAncestorIds"

export interface IRefreshTreeMetadataOptions {
    /** 可能受影响的父级 ID。 */
    parentIds?: string[]
    /** 可能受影响的节点 ID，会读取其 parentId 后刷新祖先链。 */
    nodeIds?: string[]
    /** 本次操作的子树修改计数。 */
    cmodif?: number
}

interface ITreeStats {
    ctotal: number
    cftotal: number
    csize: number
    childLastIndex?: string
}

/** 统一刷新目录树统计字段，第一版优先保证正确性。 */
export async function refreshTreeMetadata<TNode extends ITreeNode>(
    table: TableTree<TNode>,
    options: IRefreshTreeMetadataOptions,
): Promise<void> {
    const refreshIds = new Set<string>()
    const cmodifNodeIds = new Set<string>()

    for (const parentId of options.parentIds ?? []) {
        if (parentId && parentId !== "/") {
            refreshIds.add(parentId)
            cmodifNodeIds.add(parentId)
            for (const ancestorId of await collectAncestorIds(table, parentId)) {
                refreshIds.add(ancestorId)
                cmodifNodeIds.add(ancestorId)
            }
        }
    }

    for (const nodeId of options.nodeIds ?? []) {
        const node = await table.get(nodeId, { ignoreMarkDelete: true })
        if (!node) continue
        refreshIds.add(node.id)
        if (node.parentId && node.parentId !== "/") {
            refreshIds.add(node.parentId)
            cmodifNodeIds.add(node.parentId)
            for (const ancestorId of await collectAncestorIds(table, node.parentId)) {
                refreshIds.add(ancestorId)
                cmodifNodeIds.add(ancestorId)
            }
        }
    }

    const orderedIds = Array.from(refreshIds)
    for (const nodeId of orderedIds) {
        await refreshOneNode(table, nodeId, cmodifNodeIds.has(nodeId) ? options.cmodif : undefined)
    }
}

async function refreshOneNode<TNode extends ITreeNode>(
    table: TableTree<TNode>,
    nodeId: string,
    cmodif?: number,
): Promise<void> {
    const node = await table.get(nodeId, { ignoreMarkDelete: true })
    if (!node || node._isDeleted === true) return

    const stats = await calcChildrenStats(table, nodeId)
    const $set: Record<string, any> = {}
    const $unset: Record<string, true> = {}

    setNumberStat($set, $unset, "ctotal", stats.ctotal)
    setNumberStat($set, $unset, "cftotal", stats.cftotal)
    setNumberStat($set, $unset, "csize", stats.csize)

    if (stats.childLastIndex) {
        $set.childLastIndex = stats.childLastIndex
    } else {
        $unset.childLastIndex = true
    }

    if (cmodif !== undefined) {
        $set.cmodif = cmodif
    }

    if (
        isExistingStatChanged(node.ctotal, stats.ctotal) ||
        isExistingStatChanged(node.csize, stats.csize)
    ) {
        $set.modif = cmodif ?? Date.now()
    }

    await table.updateOne({ id: nodeId }, { $set: $set as any, $unset })
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

function isExistingStatChanged(oldValue: number | undefined, newValue: number): boolean {
    return oldValue !== undefined && oldValue !== newValue
}

async function calcChildrenStats<TNode extends ITreeNode>(
    table: TableTree<TNode>,
    parentId: string,
): Promise<ITreeStats> {
    const children = await table.findMany({ parentId }, { sort: { index: 1 } }) as TNode[]
    const stats: ITreeStats = {
        ctotal: 0,
        cftotal: 0,
        csize: 0,
    }

    for (const child of children) {
        stats.ctotal += 1 + (child.ctotal ?? 0)
        stats.cftotal += (child.isDir ? 0 : 1) + (child.cftotal ?? 0)
        stats.csize += (child.size ?? 0) + (child.csize ?? 0)
        if (child.index && (!stats.childLastIndex || child.index > stats.childLastIndex)) {
            stats.childLastIndex = child.index
        }
    }

    return stats
}
