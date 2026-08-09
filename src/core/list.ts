import { ITableGetBaseOptions, Table } from "./Table"
import { ITableJoinOp, joinListWithTable } from "./join"
import { ITableFilter } from "./types"

export interface ISkipPagingOptions {
    /** 当前页码 */
    pageIndex?: number
    /** 每页数量 */
    pageSize?: number
    /** 投影字段列表
     *
     *  可以是字符串数组，表示包含的字段列表\
     *  也可以是字段映射对象，1 表示包含该字段，-1 表示排除该字段\
     *  不能同时包含和排除字段
     */
    projection?: string[] | Record<string, 1 | -1>
    /** 排序字段列表 */
    sort?: any
    /** 获取总数 */
    getTotal?: boolean
    /** 排序时是否区分大小写，默认区分 */
    caseSensitive?: boolean
    /** 强制自然排序 */
    naturalSort?: boolean
    /** 连接其他表格，根据 result.list 中的字段，把其他表的字典添加到 result */
    join?: ITableJoinOp[]
}

export interface IReSkipPaging<T> {
    /** 当前页码 */
    pageIndex: number
    /** 每页记录数 */
    pageSize: number
    /** 总记录数，仅当 options.getTotal 为 true 时返回 */
    total?: number
    /** 是否有下一页 */
    hasNext?: boolean
    /** 记录列表 */
    list: T[]
}

/** 分页列表查询 (skip/limit)
 *
 *  采用分页查询，会排序全部数据然后跳过前面的数据，效率较低，不推荐在大数据量时使用
 */
export async function listPagingBySkip<T>(
    table: Table,
    filter: ITableFilter,
    options: ISkipPagingOptions & { ignoreMarkDelete?: boolean }
): Promise<IReSkipPaging<T>> {
    const pageIndex = options.pageIndex || 1
    const pageSize = options.pageSize || 20
    const skip = (Math.max(1, pageIndex) - 1) * pageSize

    // 标记删除的逻辑在 __check_filter 中处理,不需要在这里处理

    // 查询多一条以判断是否有下一页
    const findOptions: any = {
        offset: skip,
        limit: pageSize + 1,
        sort: options.sort,
        projection: options.projection,
        caseSensitive: options.caseSensitive,
        naturalSort: options.naturalSort,
        ignoreMarkDelete: options.ignoreMarkDelete,
    }

    const docs = await table.findMany(filter, findOptions)

    let hasNext = false
    let list = docs

    // 如果返回数量大于 pageSize，说明还有下一页
    if (docs.length > pageSize) {
        hasNext = true
        // 截取前 pageSize 条
        list = docs.slice(0, pageSize)
    }

    if (options.join) {
        list = await joinListWithTable(list, options.join)
    }

    const result: IReSkipPaging<T> = {
        pageIndex,
        pageSize,
        hasNext,
        list: list as any,
    }

    if (options?.getTotal) {
        result.total = await table.count(filter, { ignoreMarkDelete: options.ignoreMarkDelete })
    }
    return result
}

// -----------------------------------------
export interface ICursorPagingOptions {
    /** 每页数量 */
    pageSize?: number

    /**
     * 下一页的游标
     * (第一页传 undefined/null)
     */
    cursor?: any

    /**
     * 排序字段
     * ⚠️ 注意：游标分页要求排序字段的值必须是唯一的，或者结合 ID 使用。
     * 为了性能和实现简单，这里建议使用具有唯一性的字段（如 id, createdTime(高精度), 或 uuid）
     * 默认为 '_id'
     */
    sortKey?: string

    /** 排序方向: 1 升序, -1 降序 (默认 1) */
    sortOrder?: 1 | -1

    /** 投影字段 */
    projection?: string[] | Record<string, 1 | -1>

    /** 是否忽略标记删除 */
    ignoreMarkDelete?: boolean

    /** 连接其他表格，根据 result.list 中的字段，把其他表的字典添加到 result */
    join?: ITableJoinOp[]
}

export interface IReCursorPaging<T> {
    /** 记录列表 */
    list: T[]
    /** 下一页的游标 (如果没有下一页则为 null) */
    nextCursor: any | null
    /** 是否有下一页 */
    hasNext: boolean
}

/**
 * 游标分页查询 (Cursor Based)
 *
 * 🚀 高性能分页方案
 *
 * ⚠️ 限制：
 * 1. 只能支持单字段排序（或依赖该字段的唯一性）
 * 2. 无法直接跳转到特定页码（只能“下一页”）
 */
export async function listPagingByCursor<T>(
    table: Table,
    filter: ITableFilter,
    options: ICursorPagingOptions
): Promise<IReCursorPaging<T>> {
    const pageSize = options.pageSize || 20
    const sortKey = options.sortKey || "_id"
    const sortOrder = options.sortOrder || 1 // 1: asc, -1: desc

    // 1. 处理 Filter (合并游标条件)
    let finalFilter: any = { ...filter }

    // 🚨 游标分页限制：Filter 中不能包含排序字段
    if (finalFilter[sortKey] !== undefined) {
        throw new Error(
            `[listPagingByCursor] Filter cannot contain the sort field '${sortKey}'. Cursor paging relies on controlling this field range.`
        )
    }

    // 标记删除的逻辑在 __check_filter 中处理,不需要在这里处理

    // 2. 应用游标条件
    if (options.cursor != undefined) {
        // 构建范围查询条件
        // 升序(1):  field > cursor
        // 降序(-1): field < cursor
        const operator = sortOrder === 1 ? "$gt" : "$lt"
        const cursorVal = options.cursor

        finalFilter[sortKey] = { [operator]: cursorVal }
    }

    // 3. 查询数据
    const findOptions: any = {
        limit: pageSize + 1, // 多查一条用于判断 hasNext
        sort: { [sortKey]: sortOrder }, // 必须按照游标字段排序
        // 透传 ignoreMarkDelete 给 findMany -> __check_filter
        ignoreMarkDelete: options.ignoreMarkDelete,
    }

    // 只有在有 projection 或需要 _id 时才设置 projection
    // 避免创建空 projection 导致 adapter 错误地过滤字段
    if (options.projection || sortKey === "_id") {
        findOptions.projection = { ...options.projection }
        if (sortKey === "_id") {
            findOptions.projection._id = 1
            // 默认游标依赖内部 _id，但调用方没有投影时仍需要返回完整文档。
            // SQLiteAdapter 使用该内部标记区分游标取值和用户显式的“仅 _id”投影。
            if (!options.projection) findOptions.__cursorNeedsFullDocument = true
        }
    }

    const docs = await table.findMany(finalFilter, findOptions)

    // 4. 处理结果和生成新游标
    let hasNext = false
    let list = docs
    let nextCursor: any = null

    if (docs.length > pageSize) {
        hasNext = true
        list = docs.slice(0, pageSize) // 去掉多查的那一条
    }

    // 生成下一页的游标 (取最后一条数据的排序字段值)
    if (list.length > 0) {
        const lastItem = list[list.length - 1]
        const lastVal = (lastItem as any)[sortKey]

        if (lastVal !== undefined && lastVal !== null) {
            nextCursor = lastVal
        }
    }

    // 如果使用了 _id 作为排序键，返回值去掉 _id 字段
    if (sortKey === "_id") {
        for (const element of list) {
            delete (element as any)._id
        }
    }

    if (options.join) {
        list = await joinListWithTable(list, options.join)
    }

    return {
        list,
        nextCursor,
        hasNext,
    } as any
}
