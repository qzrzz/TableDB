import type { TableTree } from "../TableTree"
import type { ITableFilter } from "../../../core/types"
import type { ITreeNode } from "../tree.types"
import type { IReSkipPaging, ISkipPagingOptions } from "../../../core/list"

/** 子节点分页查询选项（skip/limit） */
export interface ITreeListNodesOptions extends ISkipPagingOptions {
    /** 仅返回指定类型的节点（优先级高于 onlyNotTypes） */
    onlyTypes?: string[]
    /** 排除指定类型的节点 */
    onlyNotTypes?: string[]
    /** 是否忽略标记删除（结果包括被标记删除的节点） */
    ignoreMarkDelete?: boolean
    /** 额外的 filter，可以手动指定更多的限定范围以提高性能 */
    filter?: ITableFilter
}

/** 子节点分页查询结果（skip/limit） */
export type ITreeListNodesResult<TNode extends ITreeNode = ITreeNode> = IReSkipPaging<TNode>

/** 列出节点列表（分页）
 *
 * 获取一个节点的子节点
 * 基于 Table.listPagingBySkip 实现（基于 skip limit 的分页）
 */
export function listNodes(
    this: TableTree<ITreeNode>,
    /** 要获取的节点，可以用 '/' 表示根节点 */
    parentId: string,
    options?: ITreeListNodesOptions,
): Promise<ITreeListNodesResult<ITreeNode>> {
    const filter = buildTreeListFilter(parentId, options)
    return this.listPaging(filter, {
        ...options,
        sort: options?.sort ?? { index: 1 },
        ignoreMarkDelete: options?.ignoreMarkDelete,
    }) as Promise<ITreeListNodesResult<ITreeNode>>
}

export function buildTreeListFilter(parentId: string, options?: ITreeListNodesOptions): ITableFilter {
    const filter: Record<string, any> = {
        ...(options?.filter as Record<string, any> | undefined),
        parentId,
    }

    if (options?.onlyTypes?.length) {
        filter.type = { $in: options.onlyTypes }
    } else if (options?.onlyNotTypes?.length) {
        filter.type = { $nin: options.onlyNotTypes }
    }

    return filter
}
