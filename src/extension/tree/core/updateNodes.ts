import { ITableFilter, ITableUpdateOp } from "../../../core/types"
import type { TableTree } from "../TableTree"
import type { ITreeChangeResult, ITreeNode } from "../tree.types"

/** 更新节点选项 */
export interface ITreeUpdateNodesOptions {
    /** 是否递归更新子节点 */
    deep?: boolean
}

/** 更新节点
 *  可以通过 `options.deep` 参数递归更新子节点
 */
export async function updateNodes(
    this: TableTree<ITreeNode>,
    filter: ITableFilter,
    updateOp: ITableUpdateOp<ITreeNode>,
    options?: ITreeUpdateNodesOptions,
): Promise<ITreeChangeResult> {
    let newModif = Date.now()
}
