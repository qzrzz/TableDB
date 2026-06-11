import { ITableFilter, ITableUpdateOp } from "../../../core/types"
import type { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"
import type { ITreeUpdateNodesOptions } from "./treeCore.types"
import { applyTreeStatsDeltaToAncestors, getTreeNodeStatsContribution, normalizeTreeStatsValue } from "./treeStats"
import { assertTreeManagedStatsNotModified, hasFieldUpdate, hasTreeStatAffectingFieldUpdate } from "./treeWriteGuards"

/** 更新节点
 *  可以通过 `options.deep` 参数递归更新子节点
 */
export async function updateNodes(
    this: TableTree<ITreeNode>,
    filter: ITableFilter,
    updateOp: ITableUpdateOp<ITreeNode>,
    options?: ITreeUpdateNodesOptions,
): Promise<void> {
    assertTreeManagedStatsNotModified(updateOp)

    if (hasFieldUpdate(updateOp, ["parentId"])) {
        throw new Error("[TableTree] 不允许通过 updateNodes 修改 parentId，请改用 moveNodes")
    }

    const directlyMatchedNodes = await this.findMany(filter, {
        projection: ["id", "parentId", "isDir", "size", "csize", "ctotal", "cftotal"],
    })

    const matchedNodes = options?.deep
        ? await collectDeepMatchedNodes.call(this, directlyMatchedNodes as ITreeNode[])
        : directlyMatchedNodes

    if (matchedNodes.length === 0) {
        return
    }

    const shouldRefreshAncestorStats = hasTreeStatAffectingFieldUpdate(updateOp)
    const previousContributionMap = new Map<string, ReturnType<typeof getTreeNodeStatsContribution>>()

    if (shouldRefreshAncestorStats) {
        for (const node of matchedNodes) {
            previousContributionMap.set(node.id, getTreeNodeStatsContribution(node))
        }
    }

    const targetFilter = options?.deep
        ? { id: { $in: matchedNodes.map((node) => node.id) } }
        : filter

    await this.updateMany(targetFilter, updateOp)

    if (!shouldRefreshAncestorStats) {
        return
    }

    const refreshedNodes = await this.findMany(
        { id: { $in: matchedNodes.map((node) => node.id) } },
        {
            projection: ["id", "parentId", "isDir", "size", "csize", "ctotal", "cftotal"],
        },
    )

    for (const node of refreshedNodes) {
        const previousContribution = previousContributionMap.get(node.id)
        if (!previousContribution) {
            continue
        }

        const nextContribution = getTreeNodeStatsContribution(node)
        const delta = {
            csize: nextContribution.csize - previousContribution.csize,
            ctotal: nextContribution.ctotal - previousContribution.ctotal,
            cftotal: nextContribution.cftotal - previousContribution.cftotal,
        }

        if (normalizeTreeStatsValue(delta).csize === 0 && normalizeTreeStatsValue(delta).ctotal === 0 && normalizeTreeStatsValue(delta).cftotal === 0) {
            continue
        }

        await applyTreeStatsDeltaToAncestors.call(this, node.parentId, delta)
    }
}

async function collectDeepMatchedNodes(
    this: TableTree<ITreeNode>,
    rootNodes: ITreeNode[],
): Promise<ITreeNode[]> {
    const collectedNodeMap = new Map<string, ITreeNode>()
    const queue = rootNodes.map((node) => String(node.id))

    for (const rootNode of rootNodes) {
        collectedNodeMap.set(String(rootNode.id), rootNode)
    }

    while (queue.length > 0) {
        const currentNodeId = queue.shift()!
        const children = await this.findMany(
            { parentId: currentNodeId },
            {
                projection: ["id", "parentId", "isDir", "size", "csize", "ctotal", "cftotal"],
            },
        )

        for (const child of children as ITreeNode[]) {
            const childId = String(child.id)
            if (collectedNodeMap.has(childId)) {
                continue
            }
            collectedNodeMap.set(childId, child)
            queue.push(childId)
        }
    }

    return Array.from(collectedNodeMap.values())
}
