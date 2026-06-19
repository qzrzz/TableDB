import { getIndexesBetween, getIndexesNext, getIndexesPrev } from "indexless"
import type { TableTree } from "../TableTree"
import type { ITreeIndexOptions, ITreeNode } from "../tree.types"

/** 为同一父级下的一批节点计算写入 index。 */
export async function resolveTreeIndexes<TNode extends ITreeNode>(
    table: TableTree<TNode>,
    parentId: string,
    count: number,
    options?: ITreeIndexOptions,
): Promise<string[]> {
    if (count <= 0) return []

    if (options?.prevNodeId && options?.nextNodeId) {
        const prevNode = await table.get(options.prevNodeId)
        const nextNode = await table.get(options.nextNodeId)
        assertSiblingIndexNode(prevNode, parentId, options.prevNodeId)
        assertSiblingIndexNode(nextNode, parentId, options.nextNodeId)
        return getIndexesBetween(prevNode.index || null, nextNode.index || null, count)
    }

    if (options?.prevNodeId) {
        const prevNode = await table.get(options.prevNodeId)
        assertSiblingIndexNode(prevNode, parentId, options.prevNodeId)
        return getIndexesNext(prevNode.index || null, count)
    }

    if (options?.nextNodeId) {
        const nextNode = await table.get(options.nextNodeId)
        assertSiblingIndexNode(nextNode, parentId, options.nextNodeId)
        return getIndexesPrev(nextNode.index || null, count)
    }

    if (options?.toStart) {
        const firstNode = await table.findOne({ parentId }, { sort: { index: 1 } })
        return getIndexesPrev(firstNode?.index || null, count)
    }

    if (options?.toEnd) {
        const lastNode = await table.findOne({ parentId }, { sort: { index: -1 } })
        return getIndexesNext(lastNode?.index || null, count)
    }

    if (parentId !== "/") {
        const parentNode = await table.get(parentId)
        if (parentNode?.childLastIndex) {
            return getIndexesNext(parentNode.childLastIndex, count)
        }
    }

    return new Array(count).fill("")
}

function assertSiblingIndexNode<TNode extends ITreeNode>(
    node: TNode | void,
    parentId: string,
    nodeId: string,
): asserts node is TNode {
    if (!node) {
        throw new Error(`[TableTree] 排序参考节点不存在：${nodeId}`)
    }
    if (node.parentId !== parentId) {
        throw new Error(`[TableTree] 排序参考节点不属于目标父级：${nodeId}`)
    }
}
