import type { ITableFindOptions } from "../../../adapter/adapter"
import type { ITreeNode } from "../tree.types"
import type { ITableTreeContext, ITreeStatsDelta, ITreeStatsFields } from "./treeCoreTypes"

/**
 * 统计维护所需的最小节点视图。
 *
 * 统计模块只依赖这些字段，
 * 这样后续无论是 findMany 的投影结果，还是完整节点对象，都可以复用同一套计算逻辑。
 */
export type ITreeStatsNode = Pick<ITreeNode, "id" | "parentId" | "isDir" | "size" | "csize" | "ctotal" | "cftotal">

/** 树统计模块的查询选项 */
export interface ITreeStatsQueryOptions {
    /** 是否忽略标记删除 */
    ignoreMarkDelete?: boolean
}

/** 重建单个节点统计值的选项 */
export interface ITreeRebuildNodeStatsOptions extends ITreeStatsQueryOptions {
    /** 是否把计算结果回写到节点中，默认 true */
    writeBack?: boolean
}

/** 重建祖先链统计值的选项 */
export interface ITreeRebuildAncestorStatsOptions extends ITreeRebuildNodeStatsOptions {
    /** 是否包含起始节点本身，默认 false */
    includeSelf?: boolean
}

/**
 * 把任意统计对象归一化成合法值。
 *
 * 这里统一兜底 undefined/null/NaN，避免增量更新时把脏值继续传播到祖先链。
 */
export function normalizeTreeStatsValue(stats?: Partial<ITreeStatsFields> | null): ITreeStatsFields {
    return {
        csize: normalizeTreeStatNumber(stats?.csize),
        ctotal: normalizeTreeStatNumber(stats?.ctotal),
        cftotal: normalizeTreeStatNumber(stats?.cftotal),
    }
}

/**
 * 计算一个节点对祖先链的统计贡献。
 *
 * 祖先节点存的是“后代统计”，因此这里需要把当前节点自身也折算进去：
 * - csize: 当前节点自身 size + 当前节点已有后代大小
 * - ctotal: 当前节点自身 1 个节点 + 当前节点已有后代数量
 * - cftotal: 如果当前节点是文件则额外贡献 1，再加上已有后代文件数
 */
export function getTreeNodeStatsContribution(node: Pick<ITreeStatsNode, "isDir" | "size" | "csize" | "ctotal" | "cftotal">): ITreeStatsDelta {
    const baseStats = normalizeTreeStatsValue(node)
    return {
        csize: normalizeTreeStatNumber(node.size) + baseStats.csize,
        ctotal: 1 + baseStats.ctotal,
        cftotal: (node.isDir ? 0 : 1) + baseStats.cftotal,
    }
}

/** 累加 2 组树统计值 */
export function addTreeStatsDelta(base: Partial<ITreeStatsFields> | null | undefined, delta: Partial<ITreeStatsFields> | null | undefined): ITreeStatsFields {
    const baseValue = normalizeTreeStatsValue(base)
    const deltaValue = normalizeTreeStatsValue(delta)
    return {
        csize: baseValue.csize + deltaValue.csize,
        ctotal: baseValue.ctotal + deltaValue.ctotal,
        cftotal: baseValue.cftotal + deltaValue.cftotal,
    }
}

/** 从 1 组树统计值中扣除另一组增量 */
export function subtractTreeStatsDelta(base: Partial<ITreeStatsFields> | null | undefined, delta: Partial<ITreeStatsFields> | null | undefined): ITreeStatsFields {
    const baseValue = normalizeTreeStatsValue(base)
    const deltaValue = normalizeTreeStatsValue(delta)
    return {
        csize: baseValue.csize - deltaValue.csize,
        ctotal: baseValue.ctotal - deltaValue.ctotal,
        cftotal: baseValue.cftotal - deltaValue.cftotal,
    }
}

/**
 * 读取某个父节点的直属子节点，并裁剪到统计模块真正需要的字段。
 *
 * 这里单独封装一层，后续如果需要给统计模块切换更激进的 projection，
 * 只需要改这一处。
 */
export async function listTreeStatsChildren<TNode extends ITreeNode>(
    this: ITableTreeContext<TNode>,
    parentId: string,
    options?: ITreeStatsQueryOptions,
): Promise<ITreeStatsNode[]> {
    const findOptions: ITableFindOptions = {
        projection: ["id", "parentId", "isDir", "size", "csize", "ctotal", "cftotal"],
        ignoreMarkDelete: options?.ignoreMarkDelete,
    }
    const children = await this.findMany({ parentId }, findOptions)
    return children as unknown as ITreeStatsNode[]
}

/**
 * 重新计算某个父节点下直属子节点汇总出来的统计值。
 *
 * 返回值只表示“后代统计”，不包含当前节点自身。
 */
export async function calcTreeChildrenStats<TNode extends ITreeNode>(
    this: ITableTreeContext<TNode>,
    parentId: string,
    options?: ITreeStatsQueryOptions,
): Promise<ITreeStatsFields> {
    const children = await listTreeStatsChildren.call(this, parentId, options)
    let totalStats = normalizeTreeStatsValue()
    for (const child of children) {
        totalStats = addTreeStatsDelta(totalStats, getTreeNodeStatsContribution(child))
    }
    return totalStats
}

/**
 * 按 parentId 一路向上收集祖先节点 id。
 *
 * 根节点使用 '/' 表示，它不是实际文档，因此不会出现在返回值中。
 */
export async function collectTreeAncestorIds<TNode extends ITreeNode>(
    this: ITableTreeContext<TNode>,
    parentId: string,
    options?: ITreeStatsQueryOptions,
): Promise<string[]> {
    const ancestorIds: string[] = []
    let currentParentId = parentId

    while (currentParentId && currentParentId !== "/") {
        ancestorIds.push(currentParentId)

        const parentNode = await this.get(currentParentId, {
            ignoreMarkDelete: options?.ignoreMarkDelete,
        })
        if (!parentNode) {
            break
        }

        currentParentId = parentNode.parentId
    }

    return ancestorIds
}

/**
 * 把统计增量批量应用到一条祖先链上。
 *
 * 这一步只做数值增减，不做重新计算，适合 create/move/delete 这类已知增量的场景。
 * 返回值是实际更新到的祖先节点 id 列表，便于调用侧做调试或补充校验。
 */
export async function applyTreeStatsDeltaToAncestors<TNode extends ITreeNode>(
    this: ITableTreeContext<TNode>,
    parentId: string,
    delta: Partial<ITreeStatsDelta>,
    options?: ITreeStatsQueryOptions,
): Promise<string[]> {
    const normalizedDelta = normalizeTreeStatsValue(delta)
    const ancestorIds = await collectTreeAncestorIds.call(this, parentId, options)

    for (const ancestorId of ancestorIds) {
        await this.updateOne(
            { id: ancestorId },
            {
                $inc: {
                    csize: normalizedDelta.csize,
                    ctotal: normalizedDelta.ctotal,
                    cftotal: normalizedDelta.cftotal,
                },
            },
        )
    }

    return ancestorIds
}

/**
 * 重新计算并可选回写某个节点的统计字段。
 *
 * 这里适合 setNodes、深度 merge 或复杂修复场景：
 * 先根据直属子节点重建当前节点统计，再决定是否继续向祖先层层回写。
 */
export async function rebuildTreeNodeStats<TNode extends ITreeNode>(
    this: ITableTreeContext<TNode>,
    nodeId: string,
    options?: ITreeRebuildNodeStatsOptions,
): Promise<ITreeStatsFields> {
    const nextStats = await calcTreeChildrenStats.call(this, nodeId, options)

    if (nodeId !== "/" && options?.writeBack !== false) {
        await this.updateOne(
            { id: nodeId },
            {
                $set: {
                    csize: nextStats.csize,
                    ctotal: nextStats.ctotal,
                    cftotal: nextStats.cftotal,
                } as Partial<TNode>,
            },
        )
    }

    return nextStats
}

/**
 * 从某个节点开始，逐层向上重建祖先链上的统计字段。
 *
 * 返回值按实际重建顺序排列，方便调用方在需要时记录调试信息。
 */
export async function rebuildTreeAncestorStats<TNode extends ITreeNode>(
    this: ITableTreeContext<TNode>,
    startNodeId: string,
    options?: ITreeRebuildAncestorStatsOptions,
): Promise<Array<{ nodeId: string; stats: ITreeStatsFields }>> {
    const rebuiltList: Array<{ nodeId: string; stats: ITreeStatsFields }> = []

    let currentNodeId = startNodeId
    if (!options?.includeSelf) {
        const startNode = await this.get(startNodeId, {
            ignoreMarkDelete: options?.ignoreMarkDelete,
        })
        currentNodeId = startNode?.parentId ?? "/"
    }

    while (currentNodeId && currentNodeId !== "/") {
        const currentNode = await this.get(currentNodeId, {
            ignoreMarkDelete: options?.ignoreMarkDelete,
        })
        if (!currentNode) {
            break
        }

        const stats = await rebuildTreeNodeStats.call(this, currentNodeId, options)
        rebuiltList.push({ nodeId: currentNodeId, stats })
        currentNodeId = currentNode.parentId
    }

    return rebuiltList
}

function normalizeTreeStatNumber(value: number | null | undefined): number {
    if (typeof value !== "number" || Number.isNaN(value)) {
        return 0
    }
    return value
}