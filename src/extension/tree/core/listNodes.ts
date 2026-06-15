import type { TableTree } from "../TableTree"
import type { ITableFilter } from "../../../core/types"
import type { ITableFindOptions } from "../../../adapter/adapter"
import type { ITreeNode } from "../tree.types"
import type { ICursorPagingOptions, IReCursorPaging, IReSkipPaging, ISkipPagingOptions } from "../../../core/list"

/** 子节点分页查询选项（skip/limit） */
export interface ITreeListNodesOptions extends ISkipPagingOptions {
    /** 仅返回指定类型的节点 */
    onlyTypes?: string[]
    /** 排除指定类型的节点 */
    onlyNotTypes?: string[]
    /** 是否忽略标记删除 */
    ignoreMarkDelete?: boolean
}

/** 子节点分页查询结果（skip/limit） */
export type ITreeListNodesResult<TNode extends ITreeNode = ITreeNode> = IReSkipPaging<TNode>

/** 子节点分页查询选项（cursor） */
export interface ITreeListNodesByCursorOptions extends ICursorPagingOptions {
    /** 仅返回指定类型的节点 */
    onlyTypes?: string[]
    /** 排除指定类型的节点 */
    onlyNotTypes?: string[]
}

/** 子节点分页查询结果（cursor） */
export type ITreeListNodesByCursorResult<TNode extends ITreeNode = ITreeNode> = IReCursorPaging<TNode>

/** 深度遍历分页游标
 *
 * 这里只约束遍历恢复所需的最小信息，
 * 后续真正实现时可以继续补充字段，但不应破坏既有含义。
 */
export interface ITreeListAllNodesCursor {
    /** 上一批结果的最后一个节点 ID */
    lastNodeId?: string
    /** 上一批结果最后一个节点的深度 */
    depth?: number
    /** 当前游标所属的父节点 ID */
    parentId?: string
}

/** 获取全部子孙节点的分页选项 */
export interface ITreeListAllNodesOptions {
    /** 每页数量 */
    pageSize?: number
    /** 深度遍历游标 */
    cursor?: ITreeListAllNodesCursor
    /** 仅返回指定类型的节点 */
    onlyTypes?: string[]
    /** 排除指定类型的节点 */
    onlyNotTypes?: string[]
    /** 投影字段 */
    projection?: string[] | Record<string, 1 | -1>
    /** 是否忽略标记删除 */
    ignoreMarkDelete?: boolean
}

/** 获取全部子孙节点的分页结果 */
export interface ITreeListAllNodesResult<TNode extends ITreeNode = ITreeNode> {
    /** 扁平化节点列表 */
    list: TNode[]
    /** 下一页游标 */
    nextCursor: ITreeListAllNodesCursor | null
    /** 是否还有下一页 */
    hasNext: boolean
}

/** 获取一个节点的子节点（基于 skip limit）
 *
 * 基于 Table.listPagingBySkip
 */
export function listNodes(
    this: TableTree<ITreeNode>,
    /** 要获取的节点
     *  可以用 '/' 表示根节点 */
    parentId: string,
    options?: ITreeListNodesOptions,
): Promise<ITreeListNodesResult<ITreeNode>> {
    return listNodesInternal.call(this, parentId, options)
}

async function listNodesInternal(
    this: TableTree<ITreeNode>,
    parentId: string,
    options?: ITreeListNodesOptions,
): Promise<ITreeListNodesResult<ITreeNode>> {
    const filter = buildListNodesFilter(parentId, options)
    const useIndexedOrder = await hasIndexedChildren.call(this, parentId, options?.ignoreMarkDelete)
    return this.listPaging<ITreeNode>(filter, {
        ...options,
        sort: options?.sort ?? (useIndexedOrder ? { index: 1, id: 1 } : undefined),
        ignoreMarkDelete: options?.ignoreMarkDelete,
    })
}

/**
 * 获取一个节点的子节点（基于游标分页）
 */
export async function listNodesByCursor(
    this: TableTree<ITreeNode>,
    /** 要获取的节点
     *  可以用 '/' 表示根节点 */
    parentId: string,
    options?: ITreeListNodesByCursorOptions,
): Promise<ITreeListNodesByCursorResult<ITreeNode>> {
    const filter = buildListNodesFilter(parentId, options)
    const useIndexedOrder = await hasIndexedChildren.call(this, parentId)
    return this.listPagingByCursor<ITreeNode>(filter, {
        ...options,
        ...(useIndexedOrder ? { sortKey: "index" } : undefined),
    })
}


/**
 * 获取一个节点的所有子节点（分页）
 * 
 * 基于 listNodesByCursor，但 Cursor 记录了深度遍历信息，可以从 Cursor 接着遍历
 * 返回的是扁平化的节点列表
 */
export async function listAllNodes(
    this: TableTree<ITreeNode>,
    /** 要获取其全部子孙节点的父节点 ID */
    parentId: string,
    options?: ITreeListAllNodesOptions,
): Promise<ITreeListAllNodesResult<ITreeNode>> {
    const pageSize = Math.max(1, options?.pageSize ?? 20)
    const traversedNodes = await traverseAllDescendants.call(this, parentId, options)

    let startIndex = 0
    if (options?.cursor?.lastNodeId) {
        const cursorIndex = traversedNodes.findIndex(
            (item) =>
                item.node.id === options.cursor?.lastNodeId &&
                item.depth === options.cursor?.depth &&
                item.parentId === options.cursor?.parentId,
        )
        startIndex = cursorIndex >= 0 ? cursorIndex + 1 : 0
    }

    const pageItems = traversedNodes.slice(startIndex, startIndex + pageSize)
    const hasNext = startIndex + pageSize < traversedNodes.length
    const lastItem = pageItems[pageItems.length - 1]

    return {
        list: pageItems.map((item) => item.node),
        hasNext,
        nextCursor: hasNext && lastItem
            ? {
                  lastNodeId: String(lastItem.node.id),
                  depth: lastItem.depth,
                  parentId: lastItem.parentId,
              }
            : null,
    }
}

/**
 * 构造直属子节点列表查询条件。
 *
 * 这里把类型筛选逻辑集中在一处，后续 listAllNodes 也可以直接复用，
 * 避免不同分页入口在 onlyTypes/onlyNotTypes 上出现行为分叉。
 */
function buildListNodesFilter(
    parentId: string,
    options?: Pick<ITreeListNodesOptions, "onlyTypes" | "onlyNotTypes">,
): ITableFilter {
    const filter: Record<string, any> = { parentId }

    if (options?.onlyTypes && options.onlyTypes.length > 0) {
        filter.type = { $in: options.onlyTypes }
        return filter
    }

    if (options?.onlyNotTypes && options.onlyNotTypes.length > 0) {
        filter.type = { $nin: options.onlyNotTypes }
    }

    return filter
}

interface ITreeTraversalItem {
    node: ITreeNode
    depth: number
    parentId: string
}

/**
 * 深度优先遍历指定父节点下的全部后代节点。
 *
 * 这里始终遍历完整树结构，只在结果输出时应用类型过滤，
 * 否则 onlyTypes/onlyNotTypes 会错误地阻断中间节点以下的后代遍历。
 */
async function traverseAllDescendants(
    this: TableTree<ITreeNode>,
    parentId: string,
    options?: ITreeListAllNodesOptions,
): Promise<ITreeTraversalItem[]> {
    const traversedItems: ITreeTraversalItem[] = []

    await visitDescendants.call(this, parentId, 0, options, traversedItems)

    return traversedItems
}

async function visitDescendants(
    this: TableTree<ITreeNode>,
    parentId: string,
    depth: number,
    options: ITreeListAllNodesOptions | undefined,
    traversedItems: ITreeTraversalItem[],
): Promise<void> {
    const children = await findTreeChildrenForTraversal.call(this, parentId, options)

    for (const child of children) {
        const item: ITreeTraversalItem = {
            node: child,
            depth: depth + 1,
            parentId,
        }

        if (shouldIncludeNodeInListAll(child, options)) {
            traversedItems.push(item)
        }

        await visitDescendants.call(this, String(child.id), depth + 1, options, traversedItems)
    }
}

/**
 * 获取遍历时使用的直属子节点列表。
 *
 * 为了让 listAllNodes 的游标稳定，这里使用固定排序：
 * 先按 index，再按 id。
 */
async function findTreeChildrenForTraversal(
    this: TableTree<ITreeNode>,
    parentId: string,
    options?: ITreeListAllNodesOptions,
): Promise<ITreeNode[]> {
    const useIndexedOrder = await hasIndexedChildren.call(this, parentId, options?.ignoreMarkDelete)
    const findOptions = buildListAllProjectionOptions(options, useIndexedOrder)
    return this.findMany({ parentId }, findOptions)
}

function buildListAllProjectionOptions(options?: ITreeListAllNodesOptions, useIndexedOrder?: boolean): ITableFindOptions {
    return {
        projection: mergeProjectionWithCursorFields(options?.projection),
        sort: useIndexedOrder ? { index: 1, id: 1 } : undefined,
        ignoreMarkDelete: options?.ignoreMarkDelete,
    }
}

async function hasIndexedChildren(
    this: TableTree<ITreeNode>,
    parentId: string,
    ignoreMarkDelete?: boolean,
): Promise<boolean> {
    const indexedChild = await this.findOne(
        {
            parentId,
            index: { $ne: null },
        },
        {
            projection: ["id"],
            ignoreMarkDelete,
        },
    )

    return Boolean(indexedChild)
}

function mergeProjectionWithCursorFields(projection?: string[] | Record<string, 1 | -1>): string[] | Record<string, 1 | -1> | undefined {
    if (!projection) {
        return undefined
    }

    if (Array.isArray(projection)) {
        return Array.from(new Set([...projection, "id", "parentId", "type"]))
    }

    return {
        ...projection,
        id: 1,
        parentId: 1,
        type: 1,
    }
}

function shouldIncludeNodeInListAll(node: ITreeNode, options?: ITreeListAllNodesOptions): boolean {
    if (options?.onlyTypes && options.onlyTypes.length > 0) {
        return node.type ? options.onlyTypes.includes(node.type) : false
    }

    if (options?.onlyNotTypes && options.onlyNotTypes.length > 0) {
        return !node.type || !options.onlyNotTypes.includes(node.type)
    }

    return true
}
