import type { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"
import type { ITreeUnDeleteNodesOptions } from "./treeCore.types"
import { applyTreeStatsDeltaToAncestors, getTreeNodeStatsContribution } from "./treeStats"

/** 恢复节点
 *
 * 恢复时应当按后续实现的统一规则一并恢复子节点，
 * 并重新维护祖先节点上的树统计字段。
 */
export async function unDeleteNodes(
    this: TableTree<ITreeNode>,
    /** 要恢复的节点 id 列表 */
    nodeIds: string[],
    options?: ITreeUnDeleteNodesOptions,
): Promise<void> {
    const uniqueNodeIds = Array.from(new Set(nodeIds))
    if (uniqueNodeIds.length === 0) {
        return
    }

    const existingDeletedNodes: ITreeNode[] = []
    for (const nodeId of uniqueNodeIds) {
        const node = await this.get(nodeId, { ignoreMarkDelete: true })
        if (node && (node as any)._isDeleted === true) {
            existingDeletedNodes.push(node)
        }
    }

    if (existingDeletedNodes.length === 0) {
        return
    }

    const selectedNodeIdSet = new Set(existingDeletedNodes.map((node) => node.id))
    const rootNodes: ITreeNode[] = []

    for (const node of existingDeletedNodes) {
        const ancestorIds = await collectAncestorIdsIncludingDeleted.call(this, node.parentId)
        const hasSelectedAncestor = ancestorIds.some((ancestorId) => selectedNodeIdSet.has(ancestorId))
        if (!hasSelectedAncestor) {
            rootNodes.push(node)
        }
    }

    const restoredNodeIdSet = new Set<string>()
    for (const rootNode of rootNodes) {
        const subtreeNodeIds = await collectDeletedSubtreeNodeIds.call(this, rootNode.id)
        for (const subtreeNodeId of subtreeNodeIds) {
            restoredNodeIdSet.add(subtreeNodeId)
        }
    }

    const restoredNodeIds = Array.from(restoredNodeIdSet)
    if (restoredNodeIds.length === 0) {
        return
    }

    const updateOp: any = {
        $unset: {
            _isDeleted: true,
            _deleteDate: true,
        },
    }
    if (this.options?.enableAutoMetadata) {
        updateOp.$set = { _updateDate: new Date() }
    }

    await this.adapter.updateMany(
        { id: { $in: restoredNodeIds }, _isDeleted: true },
        updateOp,
    )

    for (const rootNode of rootNodes) {
        const contribution = getTreeNodeStatsContribution(rootNode)
        await applyTreeStatsDeltaToAncestors.call(this, rootNode.parentId, contribution)
    }
}

async function collectAncestorIdsIncludingDeleted(
    this: TableTree<ITreeNode>,
    parentId: string,
): Promise<string[]> {
    const ancestorIds: string[] = []
    let currentParentId = parentId

    while (currentParentId && currentParentId !== "/") {
        ancestorIds.push(currentParentId)
        const parentNode = await this.get(currentParentId, { ignoreMarkDelete: true })
        if (!parentNode) {
            break
        }
        currentParentId = parentNode.parentId
    }

    return ancestorIds
}

async function collectDeletedSubtreeNodeIds(
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

        const currentNode = await this.get(currentNodeId, { ignoreMarkDelete: true })
        if (!currentNode || (currentNode as any)._isDeleted !== true) {
            continue
        }

        visitedIds.add(currentNodeId)

        const children = await this.findMany(
            { parentId: currentNodeId },
            {
                projection: ["id"],
                ignoreMarkDelete: true,
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
