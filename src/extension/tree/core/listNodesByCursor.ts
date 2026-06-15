import { ICursorPagingOptions, IReCursorPaging } from "../../../core/list"
import { ITableFilter } from "../../../core/types"
import { TableTree } from "../TableTree"
import { ITreeNode } from "../tree.types"

/** 子节点分页查询选项（cursor） */
export interface ITreeListNodesByCursorOptions extends ICursorPagingOptions {
    /** 仅返回指定类型的节点（优先级高于 onlyNotTypes） */
    onlyTypes?: string[]
    /** 排除指定类型的节点 */
    onlyNotTypes?: string[]
    /** 是否忽略标记删除（结果包括被标记删除的节点） */
    ignoreMarkDelete?: boolean
    /** 额外的 filter，可以手动指定更多的限定范围以提高性能 */
    filter?: ITableFilter
}

/** 子节点分页查询结果（cursor） */
export type ITreeListNodesByCursorResult<TNode extends ITreeNode = ITreeNode> = IReCursorPaging<TNode>

/** 列出节点列表（游标分页）
 * 获取一个节点的子节点（基于游标分页）
 * 基于 Table.listPagingBySkip 实现（基于 cursor 的分页）有更高的性能，但是无法跳转到指定页面，只能不断加载下一页
 */
export async function listNodesByCursor(
    this: TableTree<ITreeNode>,
    /** 要获取的节点，可以用 '/' 表示根节点 */
    parentId: string,
    options?: ITreeListNodesByCursorOptions,
): Promise<ITreeListNodesByCursorResult<ITreeNode>> {}
