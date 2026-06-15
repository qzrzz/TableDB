import { ITableFilter, ITableUpdateOp } from "../../../core/types"
import type { TableTree } from "../TableTree"
import type { ITreeChangeResult, ITreeNode } from "../tree.types"

/** 更新节点选项 */
export interface ITreeUpdateNodesOptions {
    /** 是否递归更新子节点 */
    deep?: boolean
}

/** 更新节点
 *
 * 更底层的更新接口，可以一次更新多个经 filter 筛选的文档。
 * 可以通过 `options.deep` 参数递归更新子节点。
 *
 * 一次操作更新的所有节点都有相同的 modif, cmodif 值
 *
 * 要注意如果修改了节点的  需要触发相应的 metadata 变更，通过此接口修改 parentId 不能进行覆盖检查所以要注意
 */
export async function updateNodes(
    this: TableTree<ITreeNode>,
    filter: ITableFilter,
    updateOp: ITableUpdateOp<ITreeNode>,
    options?: ITreeUpdateNodesOptions,
): Promise<ITreeChangeResult> {
    let newModif = Date.now()
}
