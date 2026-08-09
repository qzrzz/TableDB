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

/**
 * 列出节点列表（skip/limit 分页）
 *
 * 获取指定父级的直属子节点。
 *
 * 核心流程：
 * 1. 先通过 buildTreeListFilter 固定 parentId，确保额外 filter 不能越权查询其他父级。
 * 2. 根据 onlyTypes / onlyNotTypes 追加类型过滤，onlyTypes 优先级更高。
 * 3. 默认按 index 升序返回，符合目录树手动排序语义；调用方仍可通过 options.sort 覆盖。
 * 4. 将 ignoreMarkDelete 透传给底层分页，让调用方可选择是否读取软删除节点。
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
    // parentId 放在展开项之后，保证调用方传入的额外 filter 不能覆盖父级范围。
    const filter: Record<string, any> = {
        ...(options?.filter as Record<string, any> | undefined),
        parentId,
    }

    if (options?.onlyTypes?.length) {
        // onlyTypes 表示白名单，优先于 onlyNotTypes，避免同时传入时语义冲突。
        filter.type = { $in: options.onlyTypes }
    } else if (options?.onlyNotTypes?.length) {
        filter.type = { $nin: options.onlyNotTypes }
    }

    return filter
}
