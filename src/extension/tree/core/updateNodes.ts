import { ITableFilter, ITableUpdateOp } from "../../../core/types"
import type { TableTree } from "../TableTree"
import { ITreeNode } from "../tree.types"

/** 更新节点
 *  可以通过 `options.deep` 参数递归更新子节点
 */
export function updateNodes(
    this: InstanceType<typeof TableTree>,
    filter: ITableFilter,
    updateOp: ITableUpdateOp<any>,
    options?: {
        /** 是否递归更新子节点 */
        deep?: boolean
    },
) {}
