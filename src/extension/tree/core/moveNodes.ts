import type { TableTree } from "../TableTree"
import type { ITreeNode, ITreeOverwriteOptions, ITreeIndexOptions, ITreeChangeResult } from "../tree.types"

/** 移动节点选项 */
export interface ITreeMoveNodesOptions extends ITreeOverwriteOptions {
    /** 自动更新排序索引配置 */
    index?: ITreeIndexOptions
}

/** 移动节点
 *
 *  把目标节点移动到新的父节点下，遵循覆盖设置
 */
export async function moveNodes(
    this: TableTree<ITreeNode>,
    /** 要移动的节点 id 列表 */
    nodeIds: string[],
    /** 目标父节点 id ，如果为 "/" 表示根节点 */
    parentId: string,
    options?: ITreeMoveNodesOptions,
): Promise<ITreeChangeResult> {}
