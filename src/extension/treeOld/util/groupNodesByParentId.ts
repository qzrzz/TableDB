import type { ITreeNode } from "../tree.types"

/**
 * 按 parentId 分组节点，方便同级批量处理覆盖、排序和 metadata。
 *
 * 目录树的大部分规则都以“同一个父级的直属子节点”为边界：
 * 覆盖冲突只在同级内判断，index 也只在同级内排序，因此 core 流程会频繁按 parentId 分组。
 */
export function groupNodesByParentId<TNode extends Pick<ITreeNode, "parentId">>(nodes: TNode[]): Map<string, TNode[]> {
    const nodesByParentId = new Map<string, TNode[]>()
    for (const node of nodes) {
        const list = nodesByParentId.get(node.parentId) ?? []
        list.push(node)
        nodesByParentId.set(node.parentId, list)
    }
    return nodesByParentId
}
