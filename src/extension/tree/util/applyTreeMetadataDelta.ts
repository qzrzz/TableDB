import type { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"
import { collectAncestorIds } from "./collectAncestorIds"

export interface ITreeMetadataStatsDelta {
    /** 直接受影响的父级，增量会沿着该父级的祖先链向上应用。 */
    parentId: string | undefined
    /** 子树节点数量增量。 */
    ctotal?: number
    /** 子树文件数量增量。 */
    cftotal?: number
    /** 子树大小增量。 */
    csize?: number
    /** 新写入的直接子级 index 候选值，用于无需扫描兄弟节点地推进 childLastIndex。 */
    childLastIndexCandidate?: string
    /** 删除、移动或 index 变化可能移除最后一个子级时，需要用一次 limit=1 查询修正直接父级 childLastIndex。 */
    refreshChildLastIndex?: boolean
}

interface IAggregatedMetadataDelta {
    ctotal: number
    cftotal: number
    csize: number
    childLastIndexCandidates: string[]
    refreshChildLastIndex: boolean
}

/** 将节点自身连同其后代，换算成它对父级统计字段的贡献。 */
export function calcTreeNodeContribution(node: Pick<ITreeNode, "isDir" | "size" | "ctotal" | "cftotal" | "csize">) {
    return {
        ctotal: 1 + (node.ctotal ?? 0),
        cftotal: (node.isDir ? 0 : 1) + (node.cftotal ?? 0),
        csize: (node.size ?? 0) + (node.csize ?? 0),
    }
}

/**
 * 按增量维护目录 metadata。
 *
 * 目标是把结构性变更从“扫描每个受影响目录的全部子级”降为“沿父级祖先链做加减法”。
 * 这里仍会读取祖先节点当前值，用于保持 0 值字段 unset 的历史语义。
 */
export async function applyTreeMetadataDelta<TNode extends ITreeNode>(
    table: TableTree<TNode>,
    deltas: ITreeMetadataStatsDelta[],
    cmodif?: number,
): Promise<void> {
    const aggregated = await aggregateDeltasByNodeId(table, deltas)
    const updates: Parameters<TableTree<TNode>["bulkUpdate"]>[0] = []

    for (const [nodeId, delta] of aggregated) {
        const node = await table.get(nodeId, { ignoreMarkDelete: true })
        if (!node || node._isDeleted === true) continue

        const updateOp = await calcDeltaUpdateOp(table, node, delta, cmodif)
        updates.push({
            filter: { id: nodeId },
            updateOp,
        })
    }

    if (updates.length > 0) {
        await table.bulkUpdate(updates)
    }
}

async function aggregateDeltasByNodeId<TNode extends ITreeNode>(
    table: TableTree<TNode>,
    deltas: ITreeMetadataStatsDelta[],
): Promise<Map<string, IAggregatedMetadataDelta>> {
    const aggregated = new Map<string, IAggregatedMetadataDelta>()
    const ancestorIdsCache = new Map<string, string[]>()

    for (const delta of deltas) {
        if (!delta.parentId || delta.parentId === "/") continue

        const ancestorIds = ancestorIdsCache.get(delta.parentId) ?? await collectAncestorIds(table, delta.parentId)
        ancestorIdsCache.set(delta.parentId, ancestorIds)
        for (const nodeId of ancestorIds) {
            const item = getAggregatedDelta(aggregated, nodeId)
            item.ctotal += delta.ctotal ?? 0
            item.cftotal += delta.cftotal ?? 0
            item.csize += delta.csize ?? 0
        }

        const directParentDelta = getAggregatedDelta(aggregated, delta.parentId)
        if (delta.childLastIndexCandidate) {
            directParentDelta.childLastIndexCandidates.push(delta.childLastIndexCandidate)
        }
        if (delta.refreshChildLastIndex) {
            directParentDelta.refreshChildLastIndex = true
        }
    }

    return aggregated
}

function getAggregatedDelta(
    aggregated: Map<string, IAggregatedMetadataDelta>,
    nodeId: string,
): IAggregatedMetadataDelta {
    const existing = aggregated.get(nodeId)
    if (existing) return existing

    const next = {
        ctotal: 0,
        cftotal: 0,
        csize: 0,
        childLastIndexCandidates: [],
        refreshChildLastIndex: false,
    }
    aggregated.set(nodeId, next)
    return next
}

async function calcDeltaUpdateOp<TNode extends ITreeNode>(
    table: TableTree<TNode>,
    node: TNode,
    delta: IAggregatedMetadataDelta,
    cmodif: number | undefined,
): Promise<Parameters<TableTree<TNode>["bulkUpdate"]>[0][number]["updateOp"]> {
    const nextStats = {
        ctotal: Math.max(0, (node.ctotal ?? 0) + delta.ctotal),
        cftotal: Math.max(0, (node.cftotal ?? 0) + delta.cftotal),
        csize: Math.max(0, (node.csize ?? 0) + delta.csize),
    }
    const $set: Record<string, any> = {}
    const $unset: Record<string, true> = {}

    setNumberStat($set, $unset, "ctotal", nextStats.ctotal)
    setNumberStat($set, $unset, "cftotal", nextStats.cftotal)
    setNumberStat($set, $unset, "csize", nextStats.csize)

    const nextChildLastIndex = await resolveNextChildLastIndex(table, node, delta)
    if (nextChildLastIndex) {
        $set.childLastIndex = nextChildLastIndex
    } else if (delta.refreshChildLastIndex || node.childLastIndex) {
        $unset.childLastIndex = true
    }

    if (cmodif !== undefined) {
        $set.cmodif = cmodif
    }
    if (delta.ctotal !== 0 || delta.cftotal !== 0 || delta.csize !== 0 || nextChildLastIndex !== node.childLastIndex) {
        $set.modif = cmodif ?? Date.now()
    }

    return { $set: $set as any, $unset }
}

async function resolveNextChildLastIndex<TNode extends ITreeNode>(
    table: TableTree<TNode>,
    node: TNode,
    delta: IAggregatedMetadataDelta,
): Promise<string | undefined> {
    if (delta.refreshChildLastIndex) {
        const [lastChild] = await table.findMany(
            { parentId: node.id },
            { sort: { index: -1 }, limit: 1, projection: ["id", "index"] },
        ) as Pick<TNode, "index">[]
        return lastChild?.index || undefined
    }

    let childLastIndex = node.childLastIndex
    for (const candidate of delta.childLastIndexCandidates) {
        if (!childLastIndex || candidate > childLastIndex) {
            childLastIndex = candidate
        }
    }
    return childLastIndex
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
