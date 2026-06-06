import { ITableFilter, ITableUpdateOp } from "../../../core/types"
import type { TableTree } from "../TableTree"
import { ITreeNode } from "../tree.types"

/** 设置节点
 *  可以通过 `options.deep` 参数递归更新子节点
 */
export function setNodes(
    this: InstanceType<typeof TableTree>,
    filter: ITableFilter,
    updateOp: ITableUpdateOp<any>,
    options?: {
        /** 是否递归更新子节点 */
        deep?: boolean
    },
) {}
