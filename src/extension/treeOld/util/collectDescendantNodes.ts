import type { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"

export interface ICollectDescendantNodesOptions {
    /** 是否包含传入的根节点自身。 */
    includeSelf?: boolean
    /** 是否包含已标记删除的节点。 */
    ignoreMarkDelete?: boolean
}

/** 单次查询最多携带的父级 ID 数量，避免大型树触发 SQL 参数上限。 */
const DESCENDANT_PARENT_BATCH_SIZE = 500

/** 递归收集一批节点的全部后代节点。 */
export async function collectDescendantNodes<TNode extends ITreeNode>(
    table: TableTree<TNode>,
    nodeIds: string[],
    options?: ICollectDescendantNodesOptions,
): Promise<TNode[]> {
    const uniqueIds = Array.from(new Set(nodeIds)).filter(Boolean)
    const result: TNode[] = []
    const resultNodeIds = new Set<string>()

    // 只从实际存在的根节点开始遍历，避免损坏数据中“孤儿节点恰好引用不存在 ID”时被误删。
    const rootNodes: TNode[] = []
    for (let index = 0; index < uniqueIds.length; index += DESCENDANT_PARENT_BATCH_SIZE) {
        const idBatch = uniqueIds.slice(index, index + DESCENDANT_PARENT_BATCH_SIZE)
        const batchNodes = (await table.findMany(
            { id: { $in: idBatch } },
            { ignoreMarkDelete: options?.ignoreMarkDelete },
        )) as TNode[]
        rootNodes.push(...batchNodes)
    }
    const rootNodeById = new Map(rootNodes.map((node) => [node.id, node]))
    if (options?.includeSelf) {
        for (const nodeId of uniqueIds) {
            pushUniqueNode(result, resultNodeIds, rootNodeById.get(nodeId))
        }
    }

    let currentParentIds = uniqueIds.filter((nodeId) => rootNodeById.has(nodeId))
    const visitedParentIds = new Set<string>()
    while (currentParentIds.length > 0) {
        const nextParentIds = currentParentIds.filter((id) => !visitedParentIds.has(id))
        if (nextParentIds.length === 0) break
        for (const id of nextParentIds) visitedParentIds.add(id)

        const children: TNode[] = []
        for (let index = 0; index < nextParentIds.length; index += DESCENDANT_PARENT_BATCH_SIZE) {
            const parentIdBatch = nextParentIds.slice(index, index + DESCENDANT_PARENT_BATCH_SIZE)
            const batchChildren = (await table.findMany(
                { parentId: { $in: parentIdBatch } },
                { ignoreMarkDelete: options?.ignoreMarkDelete },
            )) as TNode[]
            children.push(...batchChildren)
        }
        for (const child of children) {
            pushUniqueNode(result, resultNodeIds, child)
        }
        currentParentIds = children.map((node) => node.id)
    }

    return result
}

/** 输入同时包含父节点和后代节点时，同一个后代只能在结果中出现一次。 */
function pushUniqueNode<TNode extends ITreeNode>(
    result: TNode[],
    resultNodeIds: Set<string>,
    node: TNode | void | undefined,
): void {
    if (!node || resultNodeIds.has(node.id)) return

    resultNodeIds.add(node.id)
    result.push(node)
}
