import type { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"

/** 恢复节点选项 */
export interface ITreeUnDeleteNodesOptions {}

/** 删除节点结果 */
export interface ITreeDeleteResult {
    /** 是否有节点被删除 */
    hasDeleted: boolean
    /** 是否有子节点被删除 */
    hasChildDeleted: boolean
    /** 被删除的节点数量 */
    deletedCount: number
}

/** 恢复已删除的节点
 *
 * 如果 TableTree 设置了 `enableMarkDelete: true`，
 * 则删除节点时会把节点标记为已删除而不是直接从数据库中删除
 * 这时就可以通过 `unDeleteNodes()` 方法来恢复这些被标记为已删除的节点。
 * 恢复时应当按后续实现的统一规则一并恢复子节点，
 * 注意要重新维护祖先节点上的树 metadata 字段
 */
export async function unDeleteNodes(
    this: TableTree<ITreeNode>,
    /** 要恢复的节点 id 列表 */
    nodeIds: string[],
    options?: ITreeUnDeleteNodesOptions,
): Promise<void> {
    const uniqueNodeIds = Array.from(new Set(nodeIds))
}
