import type { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"

/** 从一个父级 ID 开始向上收集祖先节点 ID，不包含根节点 "/"。 */
export async function collectAncestorIds<TNode extends ITreeNode>(
    table: TableTree<TNode>,
    parentId: string | undefined,
): Promise<string[]> {
    const ancestorIds: string[] = []
    const visitedIds = new Set<string>()
    let currentId = parentId

    while (currentId && currentId !== "/") {
        if (visitedIds.has(currentId)) {
            throw new Error(`[TableTree] 检测到循环父级引用：${currentId}`)
        }
        visitedIds.add(currentId)
        ancestorIds.push(currentId)

        const parentNode = await table.get(currentId, { ignoreMarkDelete: true })
        currentId = parentNode?.parentId
    }

    return ancestorIds
}
