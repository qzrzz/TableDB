import type { TableTree } from "../TableTree"
import type { ITreeNode, ITreeOverwriteOptions, ITreeIndexOptions, ITreeChangeResult } from "../tree.types"
import { resolveTreeIndexes } from "../util/resolveTreeIndex"
import { resolveOverwriteNodes } from "../util/resolveOverwriteNodes"
import { rebalanceTreeIndexes } from "../util/rebalanceTreeIndexes"
import { assertNotMoveIntoSelfOrDescendant, assertTreeParentExists } from "../util/assertTreeParent"
import { refreshTreeMetadata } from "../util/refreshTreeMetadata"

/** 移动节点选项 */
export interface ITreeMoveNodesOptions extends ITreeOverwriteOptions {
    /** 自动更新排序索引配置 */
    index?: ITreeIndexOptions
}

/** 移动节点
 *
 *  把目标节点移动到新的父节点下，遵循覆盖设置
 */
export async function moveNodes(
    this: TableTree<ITreeNode>,
    /** 要移动的节点 id 列表 */
    nodeIds: string[],
    /** 目标父节点 id ，如果为 "/" 表示根节点 */
    parentId: string,
    options?: ITreeMoveNodesOptions,
): Promise<ITreeChangeResult> {
    const uniqueNodeIds = Array.from(new Set(nodeIds)).filter(Boolean)
    if (uniqueNodeIds.length === 0) return {}
    await assertTreeParentExists(this, parentId)

    const nodes = (await Promise.all(uniqueNodeIds.map((nodeId) => this.get(nodeId)))).filter(
        (node): node is ITreeNode => !!node,
    )
    if (nodes.length === 0) return {}

    await assertNotMoveIntoSelfOrDescendant(this, nodes.map((node) => node.id), parentId)

    const movableNodes = await applyMoveOverwrite.call(this, nodes, parentId, options)
    if (movableNodes.length === 0) return {}

    const indexes = await resolveTreeIndexes(this, parentId, movableNodes.length, options?.index)
    const modif = Date.now()
    const oldParentIds = Array.from(new Set(movableNodes.map((node) => node.parentId)))
    for (let i = 0; i < movableNodes.length; i++) {
        await this.updateNodes(
            { id: movableNodes[i].id },
            {
                $set: {
                    parentId,
                    index: indexes[i],
                    name: movableNodes[i].name,
                    modif,
                },
            },
        )
    }
    await rebalanceTreeIndexes(this, parentId, movableNodes.map((node, index) => ({ id: node.id, index: indexes[index] })))
    await refreshTreeMetadata(this, {
        parentIds: [parentId, ...oldParentIds],
        nodeIds: movableNodes.map((node) => node.id),
        cmodif: modif,
    })

    return {
        modif,
        cmodif: modif,
    }
}

async function applyMoveOverwrite(
    this: TableTree<ITreeNode>,
    nodes: ITreeNode[],
    parentId: string,
    options?: ITreeMoveNodesOptions,
): Promise<ITreeNode[]> {
    const resolved = await resolveOverwriteNodes(this, parentId, nodes, {
        ...options,
        ignoreNodeIds: nodes.map((node) => node.id),
    })
    if (resolved.deleteNodeIds.length > 0) {
        await this.deleteNodes(resolved.deleteNodeIds)
    }
    for (const pair of resolved.mergePairs) {
        await mergeMoveDir.call(this, pair.sourceNode, pair.targetNode, options)
    }

    return resolved.nodes
}

async function mergeMoveDir(
    this: TableTree<ITreeNode>,
    sourceNode: ITreeNode,
    targetNode: ITreeNode,
    options?: ITreeMoveNodesOptions,
): Promise<void> {
    const children = await this.findMany({ parentId: sourceNode.id }, { sort: { index: 1 } })
    if (children.length > 0) {
        await this.moveNodes(children.map((child) => child.id), targetNode.id, options)
    }
    await this.deleteNodes([sourceNode.id])
}
