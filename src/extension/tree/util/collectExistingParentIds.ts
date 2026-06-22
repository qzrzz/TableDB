import type { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"

/**
 * 收集节点写入前所在的父级，用于移动后刷新旧父级及其祖先统计。
 *
 * setNodes 可以同时创建、更新和移动节点；如果节点 parentId 发生变化，
 * 只刷新新父级是不够的，旧父级也需要扣减统计并推进 cmodif。
 */
export async function collectExistingParentIds<TNode extends ITreeNode>(
    table: TableTree<TNode>,
    nodes: Pick<TNode, "id">[],
): Promise<string[]> {
    const parentIds = new Set<string>()
    for (const node of nodes) {
        const oldNode = await table.get(node.id, { ignoreMarkDelete: true })
        if (oldNode?.parentId) {
            parentIds.add(oldNode.parentId)
        }
    }
    return Array.from(parentIds)
}
