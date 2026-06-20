import type { TableTree } from "../TableTree"
import type { ITreeNode, ITreeIndexOptions } from "../tree.types"
import { normalizeWritableNode } from "../util/normalizeWritableNode"
import { refreshTreeMetadata } from "../util/refreshTreeMetadata"
import { resolveTreeIndexes } from "../util/resolveTreeIndex"
import { rebalanceTreeIndexes } from "../util/rebalanceTreeIndexes"
import { assertTreeParentExists } from "../util/assertTreeParent"

/** 创建节点选项 */
export interface ITreeCreateNodesOptions {
    /** 是否自动计算并写入排序索引 */
    index?: ITreeIndexOptions

    /** 是否在创建后返回新节点的数据，默认为 false */
    returnNewNodes?: boolean
}

export interface ITreeCreateResult {
    /** 创建的节点 id 列表 */
    createdNodeIds: string[]

    /** 创建的节点数据列表，仅在 options.returnNewNodes 为 true 时返回 */
    newNodes?: ITreeNode[]
}

/** 创建节点
 *
 * 在指定的父节点下批量创建新节点。
 * 所有创建的节点都将自动归属到指定的 parentId 下。
 *
 */
export async function createNodes(
    this: TableTree<ITreeNode>,
    /** 要创建的节点文档 */
    nodes: Partial<ITreeNode>[],
    /** 父级节点 id ，如果为 "/" 表示根节点 */
    parentId: string,
    options?: ITreeCreateNodesOptions,
): Promise<ITreeCreateResult> {
    if (nodes.length === 0) {
        return { createdNodeIds: [], newNodes: options?.returnNewNodes ? [] : undefined }
    }
    await assertTreeParentExists(this, parentId)

    const modif = Date.now()
    const newNodes = nodes.map((node, index) => {
        return normalizeWritableNode(node, {
            parentId,
            modif,
        }) as ITreeNode
    })

    if (options?.index) {
        const indexes = await resolveTreeIndexes(this, parentId, newNodes.length, options.index)
        for (let i = 0; i < newNodes.length; i++) {
            newNodes[i].index = indexes[i]
        }
    } else {
        const nodesNeedIndex = newNodes.filter((node) => !node.index)
        if (nodesNeedIndex.length > 0) {
            const indexes = await resolveTreeIndexes(this, parentId, nodesNeedIndex.length)
            for (let i = 0; i < nodesNeedIndex.length; i++) {
                nodesNeedIndex[i].index = indexes[i]
            }
        }
    }

    const result = await this.insertMany(newNodes)
    await rebalanceTreeIndexes(this, parentId, newNodes.map((node) => ({ id: node.id, index: node.index })))
    await refreshTreeMetadata(this, {
        parentIds: [parentId],
        nodeIds: result.insertedIds,
        cmodif: modif,
    })

    return {
        createdNodeIds: result.insertedIds,
        newNodes: options?.returnNewNodes ? newNodes.filter((node) => result.insertedIds.includes(node.id)) : undefined,
    }
}
