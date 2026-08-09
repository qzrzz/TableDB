import { ICursorPagingOptions, IReCursorPaging } from "../../../core/list"
import { ITableFilter } from "../../../core/types"
import { TableTree } from "../TableTree"
import { ITreeNode } from "../tree.types"
import { buildTreeListFilter } from "./listNodes"

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

/**
 * 列出节点列表（游标分页）
 *
 * 获取指定父级的直属子节点，适合“继续加载下一页”的场景。
 *
 * 核心流程：
 * 1. 复用 buildTreeListFilter，保证父级限定和类型过滤与 listNodes 完全一致。
 * 2. 使用底层 listPagingByCursor 实现游标分页，避免大页码 skip 的性能问题。
 * 3. 默认 sortKey 为 id，sortOrder 为升序；调用方可以显式指定其他游标排序字段。
 * 4. 透传 ignoreMarkDelete，保持软删除读取语义与 skip/limit 分页一致。
 */
export async function listNodesByCursor(
    this: TableTree<ITreeNode>,
    /** 要获取的节点，可以用 '/' 表示根节点 */
    parentId: string,
    options?: ITreeListNodesByCursorOptions,
): Promise<ITreeListNodesByCursorResult<ITreeNode>> {
    const filter = buildTreeListFilter(parentId, options)

    return this.listPagingByCursor(filter, {
        ...options,
        sortKey: options?.sortKey ?? "id",
        sortOrder: options?.sortOrder ?? 1,
        ignoreMarkDelete: options?.ignoreMarkDelete,
    }) as Promise<ITreeListNodesByCursorResult<ITreeNode>>
}
