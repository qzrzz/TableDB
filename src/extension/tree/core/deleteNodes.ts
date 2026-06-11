import type { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"
import type { ITreeDeleteNodesOptions, ITreeDeleteResult } from "./treeCore.types"
import { applyTreeStatsDeltaToAncestors, collectTreeAncestorIds, getTreeNodeStatsContribution } from "./treeStats"

/**
 * 删除节点
 *
 * 子节点也会被递归删除
 *
 */
export async function deleteNodes(
    this: TableTree<ITreeNode>,
    /** 要删除的节点 id 列表 */
    nodeIds: string[],
    options?: ITreeDeleteNodesOptions,
): Promise<ITreeDeleteResult> {
    const uniqueNodeIds = Array.from(new Set(nodeIds))
    if (uniqueNodeIds.length === 0) {
        return {
            hasDeleted: false,
            hasChildDeleted: false,
            deletedCount: 0,
            deletedNodeIds: [],
        }
    }

    const existingNodes: ITreeNode[] = []
    for (const nodeId of uniqueNodeIds) {
        const node = await this.get(nodeId)
        if (node) {
            existingNodes.push(node)
        }
    }

    if (existingNodes.length === 0) {
        return {
            hasDeleted: false,
            hasChildDeleted: false,
            deletedCount: 0,
            deletedNodeIds: [],
        }
    }

    const selectedNodeIdSet = new Set(existingNodes.map((node) => node.id))
    const rootNodes: ITreeNode[] = []

    for (const node of existingNodes) {
        const ancestorIds = await collectTreeAncestorIds.call(this, node.parentId)
        const hasSelectedAncestor = ancestorIds.some((ancestorId) => selectedNodeIdSet.has(ancestorId))
        if (!hasSelectedAncestor) {
            rootNodes.push(node)
        }
    }

    const deletedNodeIdSet = new Set<string>()
    for (const rootNode of rootNodes) {
        const subtreeNodeIds = await collectSubtreeNodeIds.call(this, rootNode.id)
        for (const subtreeNodeId of subtreeNodeIds) {
            deletedNodeIdSet.add(subtreeNodeId)
        }
    }

    const deletedNodeIds = Array.from(deletedNodeIdSet)
    if (deletedNodeIds.length === 0) {
        return {
            hasDeleted: false,
            hasChildDeleted: false,
            deletedCount: 0,
            deletedNodeIds: [],
        }
    }

    for (const rootNode of rootNodes) {
        const contribution = getTreeNodeStatsContribution(rootNode)
        await applyTreeStatsDeltaToAncestors.call(this, rootNode.parentId, {
            csize: -contribution.csize,
            ctotal: -contribution.ctotal,
            cftotal: -contribution.cftotal,
        })
    }

    const deleteResult = await this.deleteMany(
        { id: { $in: deletedNodeIds } },
        options?.realDelete ? { readDelete: true } : undefined,
    )

    return {
        hasDeleted: deleteResult.deletedCount > 0,
        hasChildDeleted: deletedNodeIds.length > rootNodes.length,
        deletedCount: deleteResult.deletedCount,
        deletedNodeIds,
    }
}

/**
 * 递归收集一棵子树里的全部节点 id，包含根节点自身。
 *
 * deleteNodes 只需要 id 列表，因此这里保持最小查询字段，
 * 避免在递归过程中读取不必要的数据。
 */
async function collectSubtreeNodeIds(
    this: TableTree<ITreeNode>,
    rootNodeId: string,
): Promise<string[]> {
    const visitedIds = new Set<string>()
    const queue = [rootNodeId]

    while (queue.length > 0) {
        const currentNodeId = queue.shift()!
        if (visitedIds.has(currentNodeId)) {
            continue
        }

        visitedIds.add(currentNodeId)

        const children = await this.findMany(
            { parentId: currentNodeId },
            {
                projection: ["id"],
            },
        )

        for (const child of children) {
            if (!visitedIds.has(child.id)) {
                queue.push(child.id)
            }
        }
    }

    return Array.from(visitedIds)
}
