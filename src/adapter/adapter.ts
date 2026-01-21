import { ITableFilter, ITableValue, ITableUpdateOp } from "../core/types"

export type ITableDoc = Record<string, ITableValue> & {
    id: any
    _createDate?: Date
    _updateDate?: Date
    _deleteDate?: Date
    _isDeleted?: boolean
}

export type ITableDBAdapter = {
    name: string
    useAdapterInstance(tableName: string): Promise<ITableDBAdapterInstance>
}

export interface ITableDBAdapterInstance {
    name: string
    // KV 基础操作
    get(id: any): Promise<ITableDoc | void>
    set(id: any, value: Partial<ITableDoc>): Promise<void>
    delete(id: any): Promise<void>
    has(id: any): Promise<boolean>

    count(filter?: ITableFilter, options?: { debug?: ITableDebugResult }): Promise<number>
    /** 清空所有数据，不包括索引 */
    clear(): Promise<void>
    /** 清除所有数据和索引 */
    clearAll(): Promise<void>
    /** 删除表 */
    drop(): Promise<void>
    /** 安全的关闭连接 */
    close(): Promise<void>

    // MongoDB 风格的操作 ---------------------------

    /** 查找多个文档 */
    findMany(filter: ITableFilter, options?: ITableFindOptions): Promise<ITableDoc[]>
    /** 查找单个文档 */
    findOne(filter: ITableFilter, options?: ITableFindOptions): Promise<ITableDoc | void>

    /** 修改单个现有文档
     *  如果没有匹配的文档，则不进行任何操作
     *  只会修改第一个匹配的文档
     */
    updateOne(
        filter: ITableFilter,
        updateOp: ITableUpdateOp<ITableDoc>,
        options?: ITableUpdateOptions
    ): Promise<ITableUpdateResult>

    /** 修改多个现有文档
     *  如果没有匹配的文档，则不进行任何操作
     *  根据 filter 的匹配结果，可能会修改多个文档
     */
    updateMany(
        filter: ITableFilter,
        updateOp: ITableUpdateOp<ITableDoc>,
        options?: ITableUpdateOptions
    ): Promise<ITableUpdateResult>

    /** 批量修改多个文档
     *  根据每个 update 的 filter 进行匹配 ，可能会修改多个文档
     */
    bulkUpdate(
        updates: { filter: ITableFilter; updateOp: ITableUpdateOp<ITableDoc>; options?: ITableUpdateOptions }[]
    ): Promise<ITableUpdateResult>

    /** 插入新文档
     *
     *  如果目标文档的 ID 已存在，会忽略，不会进行覆盖，并且继续插入其他文档
     */
    insertMany(docs: Partial<ITableDoc>[]): Promise<ITableInsertResult>

    /** 设置多个文档
     *
     * 根据 doc 的 id 匹配，如果已存在则进行 update 否则进行 insert\
     * 可以通过 options 控制只插入新文档或只覆盖已存在文档
     */
    setMany(docs: Partial<ITableDoc>[], options?: ITableSetOptions): Promise<ITableSetResult>

    /** 删除多个文档
     *
     * 根据 filter 的匹配结果，可能会删除多个文档
     */
    deleteMany(filter: ITableFilter, options?: ITableDeleteOptions): Promise<ITableDeletedResult>

    /** 删除单个文档
     *
     * 只会删除第一个匹配的文档
     */
    deleteOne(filter: ITableFilter, options?: ITableDeleteOptions): Promise<ITableDeletedResult>
    // ------------------------------------------

    // ------------------------------------------
    // 定义索引

    /**
     * 定义索引
     * 指定 data 中哪些字段需要创建索引，可以加快查询速度
     *
     */
    defineIndexes(indexes: ITableIndexConfig[], options?: ITableDefineIndexesOptions): Promise<void>

    /** 删除所有索引 */
    dropIndexes(): Promise<void>

    // ------------------------------------------
    // 数据检查
    /**
     * 在插入或更新文档前，进行检查和修正\
     *  直接修改传入的 doc 对象\
     */
    onCheckInputDoc?(doc: ITableDoc | void): any
    /**
     * 在输出文档前，进行检查和修正\
     * 直接修改传入的 doc 对象\
     */
    onCheckOutputDoc?(doc: ITableDoc | void): any
    /**
     * 在 fitler 实际使用前，进行检查和修正\
     * 直接修改传入的 filter 对象\
     */
    onCheckFilter?(filter: ITableFilter): any

    /** 压缩数据库文件，回收空间
     *
     * mongodb 会使用 compact 命令进行压缩\
     * sqlite 会使用 VACUUM 命令进行压缩\
     */
    compact(): Promise<void>
}

export interface ITableFindOptions {
    /** 限制返回的记录数（每一页） */
    limit?: number
    /** 跳过的记录数（页码 * 每页记录数） */
    offset?: number
    /** 投影字段列表
     *
     *  可以是字符串数组，表示包含的字段列表\
     *  也可以是字段映射对象，1 表示包含该字段，-1 表示排除该字段\
     *  不能同时包含和排除字段
     *
     *  可以是 plv 预设投影名称
     */
    projection?: string[] | Record<string, 1 | -1>

    /** 排序字段列表
     *
     * 可以是字符串数组， 前面加 `-` 表示降序，\
     * 也可以是字段映射对象，1 表示升序，-1 表示降序
     */
    sort?: string[] | Record<string, 1 | -1>
    /** 排序时按自然排序， numericOrdering:true locale: "zh" */
    naturalSort?: boolean
    /** 排序时是否区分大小写，默认区分 */
    caseSensitive?: boolean
    /** 排序时是否进行数字排序，默认不进行 */
    numericOrdering?: boolean
    /** 是否忽略标记删除逻辑，默认 false */
    ignoreMarkDelete?: boolean

    /** 调试信息存储对象
     *  提供一个对象用来接受调试信息，调试信息会写入该对象 */
    debug?: ITableDebugResult
}


export interface ITableUpdateOptions {
    /** 是否在没有匹配的文档时插入一个新文档，然后再进行更新操作 */
    upsert?: boolean

    /** 排序字段列表
     *  只在 updateOne 中有效，用于当 filter 有多个匹配文档时，优先更新哪个文档
     *
     * 可以是字符串数组， 前面加 `-` 表示降序，\
     * 也可以是字段映射对象，1 表示升序，-1 表示降序
     */
    sort?: string[] | Record<string, 1 | -1>

    /** 调试信息存储对象
     *  提供一个对象用来接受调试信息，调试信息会写入该对象 */
    debug?: ITableDebugResult
}

export interface ITableDeleteOptions {
    /** 排序字段列表
     *  用于当 filter 有多个匹配文档时，优先删除哪个文档
     *
     * 可以是字符串数组， 前面加 `-` 表示降序，\
     * 也可以是字段映射对象，1 表示升序，-1 表示降序
     */
    sort?: string[] | Record<string, 1 | -1>

    /** 是否忽略标记删除逻辑，直接物理删除文档，默认 false */
    readDelete?: boolean

    /** 调试信息存储对象
     *  提供一个对象用来接受调试信息，调试信息会写入该对象 */
    debug?: ITableDebugResult
}

export interface ITableSetOptions {
    /** 是否合并对象字段而不是覆盖，默认 false
     *
     * - 对于数组的合并，采用的是集合合并，
     *   即新的数组元素检查原数组中是否已存在，不存在就添加，类似于 `$addToSet` 操作，遵循的是 BSON 值的比较规则
     */
    merge?: boolean
    /** 是否对 doc 进行覆盖而不是浅合并，把新文档完全替换掉已存在的文档 */
    overwrite?: boolean
    /** 是否只插入新文档，已存在的文档不进行更新 */
    insertOnly?: boolean
    /** 是否只更新已存在的文档，不存在的文档不进行插入 */
    updateOnly?: boolean

    /** 仅在插入新文档时设置的字段
     *  类似于 updateOp 的 $setOnInsert，用于设置 _createDate 等元数据
     */
    setOnInsert?: Record<string, any>

    /** 调试信息存储对象
     *  提供一个对象用来接受调试信息，调试信息会写入该对象 */
    debug?: ITableDebugResult
}


export interface ITableDebugResult {
    // --- Execution Info (执行细节) ---
    /** SQL 语句及其参数，结构化存储，支持多条（如批量操作或回退查询） */
    sql?: Array<{
        query: string
        params: any[]
        /** 该条 SQL 的实际执行耗时 (ms) */
        executionTimeMs?: number
    }>
    /** EXPLAIN QUERY PLAN 的原始输出 (通常对应最后一条 SQL) */
    sqlPlan?: Array<{ id: number; parent: number; detail: string }>

    // --- Performance Metrics (性能耗时指标) ---
    /** 适配器总耗时 (ms, 从调用开始到返回) */
    totalTimeMs?: number
    /** SQL 准备耗时 (ms, mongoToSql 解析 + 序列化开销) */
    prepareTimeMs?: number
    /** 实际数据库交互总耗时 (ms) */
    dbExecTimeMs?: number

    // --- Strategy & Compatibility (策略与兼容性) ---
    /** 查询策略: 'SQL' (纯SQL) | 'HYBRID' (混合) | 'JS' (纯JS兜底) */
    strategy?: "SQL" | "HYBRID" | "JS"

    /** 是否触发了侧表优化 */
    isSideTableUsed?: boolean
    /** 具体的索引使用情况 (如果有) */
    usedIndexes?: string[]

    // --- Diagnostic Info (诊断信息) ---
    /** 导致无法使用纯 SQL 的原因列表 (替换 dirtyQueries) */
    dirtyReasons?: Array<{
        /** 字段路径 */
        path: string
        /** 原因 (e.g., "Array containment", "$where operator") */
        reason: string
        /** 导致问题的值 */
        value?: any
    }>

    /** 是否全表扫描 (从 sqlPlan 分析得出) */
    isFullScan?: boolean

    // --- Context (上下文) ---
    /** 事务状态 */
    isTransaction?: boolean

    [key: string]: any
}


export interface ITableDefineIndexesOptions {
    /** 是否强制重新创建索引，默认 false */
    rebuild?: boolean
}

export interface ITableUpdateResult {
    /** 匹配到的文档数量 */
    matchedCount: number
    /** 成功修改的文档数量 */
    modifiedCount: number
    /** 如果进行了 upsert 操作，返回新插入的文档 ID 列表 */
    upsertedIds?: any[]
}

export interface ITableInsertResult {
    /** 成功插入的文档数量 */
    insertedCount: number
    /** 因为已存在而跳过的文档数量 */
    skippedCount: number
    /** 成功插入的文档 ID 列表 */
    insertedIds: string[]
    /** 已存在未插入的文档 ID 列表 */
    skippedIds: string[]
}

export interface ITableSetResult {
    /** 成功插入的新文档数量 */
    insertedCount: number
    /** 因为已存在而被覆盖的文档数量 */
    overwriteCount: number
    /** 成功插入的新文档 ID 列表 */
    insertedIds: string[]
}

export interface ITableDeletedResult {
    /** 成功删除的文档数量 */
    deletedCount: number
}

export type ITableIndexConfig = {
    /**
     * 要索引的字段
     *
     * 可以用 `.` 表示嵌套字段\
     * 可以用对象表示复合索引，如 { city: 1, age: -1 } 表示对 city 升序，age 降序,\
     * 复合索引的字段顺序很重要，先按 city 排序，再按 age 排序
     */
    key: string | Record<string, 1 | -1>

    /** 索引名称
     *  默认为字段名或复合字段名的连接字符串 + "_1" ，MongoDB 默认规则
     */
    name?: string

    /** 索引类型 */
    type?: string

    /** 是否禁用该索引（删除此索引）
     *  需要指定 name 选项才能删除对应的索引
     */
    disabled?: boolean

    /** 是否唯一，默认 false */
    unique?: boolean

    /** 语言/区域设置  */
    locale?: string | "en" | "zh" | "jp"

    /** 是否按数字排序\
     *  如果为真，则 '2' 会排在 '10' 前面
     */
    numericOrdering?: boolean

    /**
     * 是否使用自然排序
     * 相当于 numericOrdering = true, locale = "zh"
     */
    naturalSort?: boolean

    /** 区分大小写
     *
     *  默认 true，区分大小写，如果为 false，则 'a' 和 'A' 视为相同字符
     */
    caseSensitive?: boolean
}
