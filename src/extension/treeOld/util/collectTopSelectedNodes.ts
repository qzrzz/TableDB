import type { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"

/**
 * 根据 ID 读取可见节点，并过滤掉已被选中祖先覆盖的后代节点。
 *
 * 这个工具服务于 copy/move/preOverwrite：
 * 当调用方同时选择“目录”和“目录里的子节点”时，真实操作只需要处理目录本身，
 * 子节点会随目录复制或移动；如果不在这里过滤，后代会被额外平铺到目标父级。
 */
export async function collectTopSelectedNodes(
    table: TableTree<ITreeNode>,
    nodeIds: string[],
): Promise<ITreeNode[]> {
    const uniqueNodeIds = Array.from(new Set(nodeIds)).filter(Boolean)
    if (uniqueNodeIds.length === 0) return []

    const nodes = (await Promise.all(uniqueNodeIds.map((nodeId) => table.get(nodeId)))).filter(
        (node): node is ITreeNode => !!node,
    )
    return filterTopSelectedNodes(table, nodes)
}

/** 父子节点同时被选中时，只保留最外层节点，避免后代被单独平铺处理。 */
async function filterTopSelectedNodes(
    table: TableTree<ITreeNode>,
    nodes: ITreeNode[],
): Promise<ITreeNode[]> {
    const selectedIds = new Set(nodes.map((node) => node.id))
    const roots: ITreeNode[] = []

    for (const node of nodes) {
        if (!await hasSelectedAncestor(table, node.parentId, selectedIds)) {
            roots.push(node)
        }
    }

    return roots
}

async function hasSelectedAncestor(
    table: TableTree<ITreeNode>,
    parentId: string | undefined,
    selectedIds: Set<string>,
): Promise<boolean> {
    let currentParentId = parentId
    while (currentParentId && currentParentId !== "/") {
        if (selectedIds.has(currentParentId)) {
            return true
        }
        // 向上查找时需要忽略标记删除，否则已删除祖先会让父子关系判断断层。
        const parentNode = await table.get(currentParentId, { ignoreMarkDelete: true })
        currentParentId = parentNode?.parentId ?? "/"
    }
    return false
}
