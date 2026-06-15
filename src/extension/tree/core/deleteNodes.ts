import type { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"

/** 删除节点选项 */
export interface ITreeDeleteNodesOptions {
    /** 是否强制物理删除 */
    realDelete?: boolean
}

/** 删除节点结果 */
export interface ITreeDeleteResult {
    /** 是否有节点被删除 */
    hasDeleted: boolean
    /** 是否有子节点被删除 */
    hasChildDeleted: boolean
    /** 被删除的节点数量 */
    deletedCount: number
}

/**
 * 删除节点
 *
 * 子节点也会被递归删除
 * 要注意递归删除可能会导致性能问题，尤其是当删除的节点有大量子孙节点时。
 * 
 */
export async function deleteNodes(
    this: TableTree<ITreeNode>,
    /** 要删除的节点 id 列表 */
    nodeIds: string[],
    options?: ITreeDeleteNodesOptions,
): Promise<ITreeDeleteResult> {}
