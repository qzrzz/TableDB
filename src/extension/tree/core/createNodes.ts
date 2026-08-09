import type { ITreeNode, ITreeIndexOptions } from "../tree.types"
import type { ITreeOperationContext } from "./context"
import { normalizeWritableNode } from "../util/normalizeWritableNode"
import { resolveTreeIndexes } from "../util/resolveTreeIndex"
import { rebalanceTreeIndexes } from "../util/rebalanceTreeIndexes"
import { assertTreeParentExists } from "../util/assertTreeParent"
import { applyTreeMetadataDelta, calcTreeNodeContribution } from "../util/applyTreeMetadataDelta"

export interface ITreeCreateNodesOptions {
    /** 是否自动计算排序 index。 */
    index?: ITreeIndexOptions
    /** 是否返回真正插入的节点。 */
    returnNewNodes?: boolean
}

export interface ITreeCreateResult {
    createdNodeIds: string[]
    newNodes?: ITreeNode[]
}

/** 创建 core：只负责一批新节点，不负责判断输入节点是新建还是更新。 */
export async function createNodesCore(
    context: ITreeOperationContext,
    nodes: Partial<ITreeNode>[],
    parentId: string,
    options?: ITreeCreateNodesOptions,
): Promise<ITreeCreateResult> {
    if (nodes.length === 0) {
        return { createdNodeIds: [], newNodes: options?.returnNewNodes ? [] : undefined }
    }

    await assertTreeParentExists(context.view as any, parentId)
    const modif = Date.now()
    const newNodes = nodes.map((node) => normalizeWritableNode(node, { parentId, modif }) as ITreeNode)

    const nodesNeedIndex = options?.index
        ? newNodes
        : newNodes.filter((node) => !node.index)
    if (nodesNeedIndex.length > 0) {
        const indexes = await resolveTreeIndexes(context.view as any, parentId, nodesNeedIndex.length, options?.index)
        for (let index = 0; index < nodesNeedIndex.length; index++) {
            nodesNeedIndex[index].index = indexes[index]
        }
    }

    const result = await context.adapter.insertMany(newNodes)
    const insertedIds = result.insertedIds ?? []
    const insertedIdSet = new Set(insertedIds)
    const insertedNodes = newNodes.filter((node, index) => {
        // 部分成功的适配器可能只返回 insertedCount；此时按顺序截取，避免 metadata 完全不更新。
        return insertedIdSet.has(node.id) || (insertedIds.length === 0 && index < result.insertedCount)
    })

    await applyTreeMetadataDelta(context.view as any, insertedNodes.map((node) => ({
        parentId,
        ...calcTreeNodeContribution(node),
        childLastIndexCandidate: node.index,
    })), modif)
    await rebalanceTreeIndexes(context.view as any, parentId, insertedNodes.map((node) => ({ id: node.id, index: node.index })))

    return {
        createdNodeIds: insertedIds.length > 0 ? insertedIds : insertedNodes.map((node) => node.id),
        newNodes: options?.returnNewNodes ? insertedNodes : undefined,
    }
}
