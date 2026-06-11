import type { ICursorPagingOptions, IReCursorPaging, IReSkipPaging, ISkipPagingOptions } from "../../../core/list"
import type { ITableFilter, ITableUpdateOp } from "../../../core/types"
import type { TableTree } from "../TableTree"
import type { ITreeIndexOptions, ITreeNode, ITreeOverwriteOptions } from "../tree.types"

/** Tree 扩展的运行上下文
 *
 * 目前直接复用 TableTree 实例，后续如果要做更细的解耦，
 * 可以先从这里收敛 core 层真正依赖的能力。
 */
export type ITableTreeContext<TNode extends ITreeNode = ITreeNode> = TableTree<TNode>

/** 树统计字段
 *
 * 这些字段会在后续的独立维护模块中统一计算和增量更新。
 */
export interface ITreeStatsFields {
    /** 子级总大小，不包含当前节点自身 size */
    csize: number
    /** 子级总数量，包含文件夹和文件 */
    ctotal: number
    /** 子级文件总数量，仅统计文件节点 */
    cftotal: number
}

/** 树统计增量 */
export interface ITreeStatsDelta extends ITreeStatsFields {}

/** 由树扩展内部维护的统计字段名 */
export type ITreeManagedStatsField = keyof ITreeStatsFields

/** 由树扩展内部维护的字段名 */
export type ITreeManagedField = ITreeManagedStatsField | "clidLastIndex"

/**
 * 允许外部写入的树节点数据。
 *
 * csize/ctotal/cftotal/clidLastIndex 只允许内部维护，
 * 因此公开写入类型里不暴露这些字段。
 */
export type ITreeWritableNode<TNode extends ITreeNode = ITreeNode> = Omit<TNode, ITreeManagedField>

/** 允许外部写入的树节点补丁数据 */
export type ITreeWritableNodePatch<TNode extends ITreeNode = ITreeNode> = Partial<ITreeWritableNode<TNode>>

/** 创建节点选项 */
export interface ITreeCreateNodesOptions {
    /** 是否自动计算并写入排序索引 */
    index?: ITreeIndexOptions
}

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

/** 检测节点冲突的选项
 *
 * 这里直接复用树覆盖策略选项，保证 checkNodes 的预检语义与 moveNodes / setNodes 一致。
 */
export type ITreeCheckNodesOptions = ITreeOverwriteOptions

/** 检测节点冲突的结果 */
export interface ICheckNodesResult<TNode extends ITreeNode = ITreeNode> {
    /** 是否存在冲突 */
    isConflict: boolean
    /** 已存在的节点列表 */
    existNodes: Partial<TNode>[]
}

/** 设置节点选项 */
export interface ITreeSetNodesOptions extends ITreeOverwriteOptions {
    /** 自动更新排序索引配置 */
    index?: ITreeIndexOptions
}

/** 复制节点选项 */
export interface ITreeCopyNodesOptions {
    /** 新节点插入到该节点之后 */
    prevNodeId?: string
    /** 是否递归复制子节点 */
    deep?: boolean
    /** 复制后的节点是否自动重命名 */
    renameOnCopy?: boolean
}

/** 移动节点选项 */
export interface ITreeMoveNodesOptions extends ITreeOverwriteOptions {
    /** 自动更新排序索引配置 */
    index?: ITreeIndexOptions
}

/** 删除节点选项 */
export interface ITreeDeleteNodesOptions {
    /** 是否强制物理删除 */
    realDelete?: boolean
}

/** 删除节点结果 */
export interface ITreeDeleteResult {
    /** 是否有节点被删除 */
    hasDeleted: boolean
    /** 是否有子节点被删除 */
    hasChildDeleted: boolean
    /** 被删除的节点数量 */
    deletedCount: number
    /** 被删除的节点 id 列表 */
    deletedNodeIds: string[]
}

/** 恢复节点选项 */
export interface ITreeUnDeleteNodesOptions {}

/** 更新节点选项 */
export interface ITreeUpdateNodesOptions {
    /** 是否递归更新子节点 */
    deep?: boolean
}

/** Tree 更新操作类型别名 */
export type ITreeUpdateOp<TNode extends ITreeNode = ITreeNode> = ITableUpdateOp<ITreeWritableNode<TNode> & Pick<ITreeNode, "id">>

/** Tree 过滤器类型别名 */
export type ITreeFilter = ITableFilter