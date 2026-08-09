import type { ITreeNode } from "../tree.types"
import { newNodeId } from "./newNodeId"
import { stripTreeManagedFields } from "./stripTreeManagedFields"
import { assertTreeNodeValues } from "./assertTreeParent"

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
    // 只有真正缺失字段才使用默认值；显式传入 null 或错误类型必须被校验拦截，不能静默变成合法节点。
    const name = cleanNode.name === undefined ? "" : cleanNode.name

    const nextNode: Partial<TNode> = {
        ...cleanNode,
        id: (cleanNode.id === undefined ? newNodeId() : cleanNode.id) as any,
        parentId: (options?.parentId ?? (cleanNode.parentId === undefined ? "/" : cleanNode.parentId)) as any,
        name: name as any,
        index: (cleanNode.index === undefined ? "" : cleanNode.index) as any,
        modif: (cleanNode.modif === undefined ? (options?.modif ?? Date.now()) : cleanNode.modif) as any,
        isDir: (cleanNode.isDir === undefined ? false : cleanNode.isDir) as any,
        size: (cleanNode.size === undefined ? 0 : cleanNode.size) as any,
    }

    assertTreeNodeValues(nextNode as Pick<ITreeNode, "id" | "parentId" | "name" | "isDir" | "size" | "index" | "modif">)

    return nextNode
}
