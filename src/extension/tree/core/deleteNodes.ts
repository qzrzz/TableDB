import type { TableTree } from "../TableTree"
import { ITreeNode } from "../tree.types"

/**
 * 删除节点
 *
 * 子节点也会被递归删除
 *
 */
export async function deleteNodes(
    this: InstanceType<typeof TableTree>,
    /** 要删除的节点 id 列表 */
    nodeIds: string[],
    options?: {
        /** 是否真正删除节点 (在 Table enableMarkDeleted 为 true 时，也物理删除文档) */
        realDelete?: boolean
 
    },
): Promise<ITreeDeleteResult> {}

export interface ITreeDeleteResult {
    /** 是否有节点被删除 */
    hasDeleted: boolean
    /** 是否有子节点被删除 */
    hasChildDeleted: boolean
    /** 被删除的节点数量 */
    deletedCount: number
    /**
     * 被删除的节点 id 列表
     * 如果 options.notReturnDeletedNodeIds 为 true 则该字段为空数组
     */
    deletedNodeIds: string[]
}
