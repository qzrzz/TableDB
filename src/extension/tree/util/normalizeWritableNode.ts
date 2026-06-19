import type { ITreeNode } from "../tree.types"
import { newNodeId } from "./newNodeId"
import { stripTreeManagedFields } from "./stripTreeManagedFields"
import { assertTreeNodeName } from "./assertTreeParent"

export interface INormalizeWritableNodeOptions {
    /** 指定写入父级，提供后会覆盖外部传入的 parentId。 */
    parentId?: string
    /** 本次操作默认 modif，外部没有提供 modif 时使用。 */
    modif?: number
}

/** 将外部传入的节点数据整理为 TableTree 可写入的数据。 */
export function normalizeWritableNode<TNode extends ITreeNode>(
    node: Partial<TNode>,
    options?: INormalizeWritableNodeOptions,
): Partial<TNode> {
    const cleanNode = stripTreeManagedFields(node as Record<string, any>) as Partial<TNode>
    const name = cleanNode.name ?? ""
    assertTreeNodeName(name)

    const nextNode: Partial<TNode> = {
        ...cleanNode,
        id: (cleanNode.id ?? newNodeId()) as any,
        parentId: (options?.parentId ?? cleanNode.parentId ?? "/") as any,
        name: name as any,
        index: (cleanNode.index ?? "") as any,
        modif: (cleanNode.modif ?? options?.modif ?? Date.now()) as any,
        isDir: (cleanNode.isDir ?? false) as any,
        size: (cleanNode.size ?? 0) as any,
    }

    return nextNode
}
