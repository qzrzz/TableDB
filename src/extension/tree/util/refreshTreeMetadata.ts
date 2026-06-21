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
    /** 是否需要重新统计子级数量、文件数、大小和末尾 index；普通内容更新只需要推进 cmodif。 */
    statsChanged?: boolean
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
    const ancestorIdsCache = new Map<string, string[]>()
    const collectCachedAncestorIds = async (nodeId: string | undefined) => {
        if (!nodeId || nodeId === "/") return []
        const cachedIds = ancestorIdsCache.get(nodeId)
        if (cachedIds) return cachedIds

        const ancestorIds = await collectAncestorIds(table, nodeId)
        ancestorIdsCache.set(nodeId, ancestorIds)
        return ancestorIds
    }

    for (const parentId of options.parentIds ?? []) {
        if (parentId && parentId !== "/") {
            refreshIds.add(parentId)
            cmodifNodeIds.add(parentId)
            for (const ancestorId of await collectCachedAncestorIds(parentId)) {
                refreshIds.add(ancestorId)
                cmodifNodeIds.add(ancestorId)
            }
        }
    }

    for (const nodeId of options.nodeIds ?? []) {
        const node = await table.get(nodeId, { ignoreMarkDelete: true })
        if (!node) continue
        // 节点自身的统计只由它的子级决定；当前节点被写入时，只需要刷新它的父级和祖先。
        if (node.parentId && node.parentId !== "/") {
            refreshIds.add(node.parentId)
            cmodifNodeIds.add(node.parentId)
            for (const ancestorId of await collectCachedAncestorIds(node.parentId)) {
                refreshIds.add(ancestorId)
                cmodifNodeIds.add(ancestorId)
            }
        }
    }

    if (options.statsChanged === false) {
        await refreshCmodifOnly(table, Array.from(cmodifNodeIds), options.cmodif)
        return
    }

    const refreshLevels = await groupRefreshIdsByDepth(table, Array.from(refreshIds), collectCachedAncestorIds)
    for (const levelIds of refreshLevels) {
        const updates: Parameters<TableTree<TNode>["bulkUpdate"]>[0] = []
        for (const nodeId of levelIds) {
            const updateOp = await calcRefreshNodeUpdateOp(table, nodeId, cmodifNodeIds.has(nodeId) ? options.cmodif : undefined)
            if (updateOp) {
                updates.push({
                    filter: { id: nodeId },
                    updateOp,
                })
            }
        }
        if (updates.length > 0) {
            // 同深度目录互不依赖，可以批量提交；不同深度仍逐层向上刷新，保证父级读到最新子级统计。
            await table.bulkUpdate(updates)
        }
    }
}

async function refreshCmodifOnly<TNode extends ITreeNode>(
    table: TableTree<TNode>,
    nodeIds: string[],
    cmodif: number | undefined,
): Promise<void> {
    if (cmodif === undefined || nodeIds.length === 0) return

    // 普通内容更新不会改变目录统计，直接推进可见祖先的 cmodif，避免重复扫描所有兄弟节点。
    await table.bulkUpdate(nodeIds.map((nodeId) => ({
        filter: { id: nodeId, _isDeleted: { $ne: true } } as any,
        updateOp: { $set: { cmodif } as any },
    })))
}

async function groupRefreshIdsByDepth<TNode extends ITreeNode>(
    table: TableTree<TNode>,
    nodeIds: string[],
    collectCachedAncestorIds?: (nodeId: string | undefined) => Promise<string[]>,
): Promise<string[][]> {
    const depthByNodeId = new Map<string, number>()
    for (const nodeId of nodeIds) {
        const ancestorIds = collectCachedAncestorIds
            ? await collectCachedAncestorIds(nodeId)
            : await collectAncestorIds(table, nodeId)
        depthByNodeId.set(nodeId, ancestorIds.length)
    }

    const orderedIds = nodeIds.sort((left, right) => {
        return (depthByNodeId.get(right) ?? 0) - (depthByNodeId.get(left) ?? 0)
    })
    const groups: string[][] = []
    let currentDepth: number | undefined
    for (const nodeId of orderedIds) {
        const depth = depthByNodeId.get(nodeId) ?? 0
        if (currentDepth !== depth) {
            groups.push([])
            currentDepth = depth
        }
        groups[groups.length - 1].push(nodeId)
    }
    return groups
}

async function calcRefreshNodeUpdateOp<TNode extends ITreeNode>(
    table: TableTree<TNode>,
    nodeId: string,
    cmodif?: number,
): Promise<Parameters<TableTree<TNode>["bulkUpdate"]>[0][number]["updateOp"] | undefined> {
    const node = await table.get(nodeId, { ignoreMarkDelete: true })
    if (!node || node._isDeleted === true) return undefined

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
        isExistingStatChanged(node.cftotal, stats.cftotal) ||
        isExistingStatChanged(node.csize, stats.csize) ||
        node.childLastIndex !== stats.childLastIndex
    ) {
        $set.modif = cmodif ?? Date.now()
    }

    return { $set: $set as any, $unset }
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
    return oldValue !== newValue && (oldValue !== undefined || newValue > 0)
}

async function calcChildrenStats<TNode extends ITreeNode>(
    table: TableTree<TNode>,
    parentId: string,
): Promise<ITreeStats> {
    const children = await table.findMany(
        { parentId },
        { projection: ["id", "index", "isDir", "size", "ctotal", "cftotal", "csize"] },
    ) as TNode[]
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
