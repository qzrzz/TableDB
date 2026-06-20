import type { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"

export interface ICollectDescendantNodesOptions {
    /** 是否包含传入的根节点自身。 */
    includeSelf?: boolean
    /** 是否包含已标记删除的节点。 */
    ignoreMarkDelete?: boolean
}

/** 递归收集一批节点的全部后代节点。 */
export async function collectDescendantNodes<TNode extends ITreeNode>(
    table: TableTree<TNode>,
    nodeIds: string[],
    options?: ICollectDescendantNodesOptions,
): Promise<TNode[]> {
    const uniqueIds = Array.from(new Set(nodeIds)).filter(Boolean)
    const result: TNode[] = []
    const resultNodeIds = new Set<string>()

    if (options?.includeSelf) {
        for (const nodeId of uniqueIds) {
            const node = await table.get(nodeId, { ignoreMarkDelete: options.ignoreMarkDelete })
            pushUniqueNode(result, resultNodeIds, node)
        }
    }

    let currentParentIds = uniqueIds
    const visitedParentIds = new Set<string>()
    while (currentParentIds.length > 0) {
        const nextParentIds = currentParentIds.filter((id) => !visitedParentIds.has(id))
        if (nextParentIds.length === 0) break
        for (const id of nextParentIds) visitedParentIds.add(id)

        const children = (await table.findMany(
            { parentId: { $in: nextParentIds } },
            { ignoreMarkDelete: options?.ignoreMarkDelete },
        )) as TNode[]
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
