import type { TableTree } from "../TableTree"
import type { ITreeCreateNodesOptions, ITreeWritableNode } from "./treeCoreTypes"
import type { ITreeNode } from "../tree.types"
import { addTreeStatsDelta, applyTreeStatsDeltaToAncestors, getTreeNodeStatsContribution, normalizeTreeStatsValue } from "./treeStats"
import { createTreeIndexRange, hasTreeIndexedOrder, normalizeTreeSiblingIndexes, persistTreeParentLastIndex } from "./treeIndex"
import { stripManagedTreeStatsFromPatch } from "./treeWriteGuards"

/** 创建节点
 *
 * 只能在指定的父节点下创建节点，所有创建的节点都会设置 parentId 字段为 parentId 参数的值
 */
export async function createNodes(
    this: TableTree<ITreeNode>,
    /** 要创建的节点文档 */
    nodes: ITreeWritableNode<ITreeNode>[],
    /** 父级节点 id ，如果为 "/" 表示根节点 */
    parentId: string,
    options?: ITreeCreateNodesOptions,
): Promise<void> {
    if (nodes.length === 0) {
        return
    }

    if (parentId !== "/") {
        const parentNode = await this.get(parentId)
        if (!parentNode) {
            throw new Error(`[TableTree] 父节点不存在: ${parentId}`)
        }
    }

    const indexResult = options?.index
        ? await createTreeNodeIndexes.call(this, parentId, nodes.length, options.index)
        : await hasTreeIndexedOrder.call(this, parentId)
            ? await createTreeNodeIndexes.call(this, parentId, nodes.length, { toEnd: true })
            : { indexes: [] }

    const normalizedNodes = nodes.map((node, index) => {
        const writableNode = stripManagedTreeStatsFromPatch<ITreeNode>(node)
        return {
            ...writableNode,
            parentId,
            size: typeof writableNode.size === "number" ? writableNode.size : 0,
            modif: typeof writableNode.modif === "number" ? writableNode.modif : 0,
            ...(indexResult.indexes[index] !== undefined ? { index: indexResult.indexes[index] } : undefined),
            // 统计字段只能由内部维护，忽略外部传入的值。
            csize: 0,
            ctotal: 0,
            cftotal: 0,
        } as ITreeNode
    })

    const insertResult = await this.insertMany(normalizedNodes)
    if (insertResult.insertedCount <= 0) {
        return
    }

    const insertedIdSet = new Set(insertResult.insertedIds)
    let totalDelta = normalizeTreeStatsValue()

    for (const node of normalizedNodes) {
        if (!insertedIdSet.has(node.id)) {
            continue
        }
        totalDelta = addTreeStatsDelta(totalDelta, getTreeNodeStatsContribution(node))
    }

    await persistTreeParentLastIndex.call(this, parentId, indexResult.nextParentLastIndex)
    await applyTreeStatsDeltaToAncestors.call(this, parentId, totalDelta)
}

async function createTreeNodeIndexes(
    this: TableTree<ITreeNode>,
    parentId: string,
    count: number,
    options: NonNullable<ITreeCreateNodesOptions["index"]>,
): Promise<{ indexes: number[]; nextParentLastIndex?: number }> {
    const enabledModes = [options.prevNodeId, options.nextNodeId, options.toStart, options.toEnd].filter(Boolean).length
    if (enabledModes > 1) {
        throw new Error("[TableTree] createNodes 的 index 选项一次只能指定一种插入位置")
    }

    const siblings = await this.findMany(
        { parentId },
        {
            projection: ["id", "index"],
            sort: { index: 1, id: 1 },
        },
    ) as Array<Pick<ITreeNode, "id" | "index">>

    const orderedSiblingIds = siblings.map((sibling) => String(sibling.id))
    const normalizedIndexMap = normalizeTreeSiblingIndexes(siblings)

    let insertAt = orderedSiblingIds.length
    if (options.toStart) {
        insertAt = 0
    } else if (options.nextNodeId) {
        const nextIndex = orderedSiblingIds.indexOf(options.nextNodeId)
        if (nextIndex < 0) {
            throw new Error(`[TableTree] nextNodeId 不存在于目标父节点下: ${options.nextNodeId}`)
        }
        insertAt = nextIndex
    } else if (options.prevNodeId) {
        const prevIndex = orderedSiblingIds.indexOf(options.prevNodeId)
        if (prevIndex < 0) {
            throw new Error(`[TableTree] prevNodeId 不存在于目标父节点下: ${options.prevNodeId}`)
        }
        insertAt = prevIndex + 1
    }

    const lowerSiblingId = insertAt > 0 ? orderedSiblingIds[insertAt - 1] : undefined
    const upperSiblingId = insertAt < orderedSiblingIds.length ? orderedSiblingIds[insertAt] : undefined
    const lowerIndex = lowerSiblingId ? normalizedIndexMap.get(lowerSiblingId) : undefined
    const upperIndex = upperSiblingId ? normalizedIndexMap.get(upperSiblingId) : undefined

    return createTreeIndexRange.call(this, parentId, count, lowerIndex, upperIndex)
}
