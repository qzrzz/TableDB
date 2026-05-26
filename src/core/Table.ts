import { EventHub } from "fzz"
import {
    ITableDBAdapterInstance,
    ITableDBAdapter,
    ITableDefineIndexesOptions,
    ITableDeletedResult,
    ITableDeleteOptions,
    ITableDoc,
    ITableFindOptions,
    ITableIndexConfig,
    ITableInsertResult,
    ITableSetOptions,
    ITableSetResult,
    ITableUpdateOptions,
    ITableUpdateResult,
} from "../adapter/adapter"
import { exportBinary, exportBinaryToFile, importBinary, importBinaryFromFile } from "./backup"
import { __check_filter, __check_find_options, __check_input_doc, __check_output_doc, __check_update_op } from "./check"
import {
    ICursorPagingOptions,
    IReCursorPaging,
    IReSkipPaging,
    ISkipPagingOptions,
    listPagingByCursor,
    listPagingBySkip,
} from "./list"
import { __schema_init, ISchemaHints } from "./schema"
import { ITableFilter, ITableUpdateOp } from "./types"
import { TableEeventDefifne } from "./event"

export interface ITableOptions<TSchema, TPlv extends IPlvMap = IPlvMap> {
    /** Talbe 名称
     *
     * 会作为存储时的表名或集合名使用
     */
    name: string

    /** 文档 schema 定义
     *
     * 使用 `fzz dto` 来定义，可以用来校验文档结构，定义索引等
     */
    schema?: TSchema

    /** 索引定义
     *
     *  优先级大于 schema 的索引定义
     */
    indexes?: ITableIndexConfig[]

    /** 指定 Adapter */
    adapter?: ITableDBAdapter

    // 功能扩展 --------------------------------

    /** 是否启用标记删除功能 */
    enableMarkDelete?: boolean
    /** 是否启用自动元数据功能（_updateDate, _createDate, _deleteDate） */
    enableAutoMetadata?: boolean
    /** 是否启用目录树功能 */
    enableTree?: boolean

    /** 预设投影列表 */
    projections?: TPlv
}

export interface ITableGetBaseOptions {
    /** 是否忽略标记删除的文档 */
    ignoreMarkDelete?: boolean
}

export interface IPlvMap {
    [plvName: string]: string[] | { [field: string]: 1 | -1 }
}

/**
 * 数据表对象
 * 实现类似 MongoDB 的 NoSQL 数据存储 API
 *
 * 底层可以使用 SQLite, indexedDB, MongoDB
 */
export class Table<TSchema extends ITableDoc = ITableDoc, TPlv extends IPlvMap = IPlvMap> {
    static globalAdapter?: ITableDBAdapter
    name!: string
    options!: ITableOptions<TSchema, TPlv>
    adapter!: ITableDBAdapterInstance
    schema!: TSchema
    inited!: Promise<boolean>
    eventHub!: EventHub<typeof TableEeventDefifne>
    constructor(tableOptions: ITableOptions<TSchema, TPlv>) {
        this.name = tableOptions.name
        this.options = tableOptions
        this.schema = tableOptions.schema as TSchema
        this.eventHub = new EventHub()
        this.inited = this.init()
    }

    async init() {
        let adapter = this.options.adapter ?? Table.globalAdapter
        if (!adapter) {
            throw new Error("[TableDB] Not Defined adapter.")
        }
        // 获取适配器实例
        this.adapter = await adapter.useAdapterInstance(this.name)

        // 初始化 schema
        await this.__schema_init()

        return true
    }

    // -------------------------------------------------------
    // schema 相关
    __schema_hints!: ISchemaHints
    private __schema_init = __schema_init
    // 检查接口
    private __check_filter = __check_filter
    private __check_output_doc = __check_output_doc
    private __check_find_options = __check_find_options
    private __check_input_doc = __check_input_doc
    private __check_update_op = __check_update_op
    // -------------------------------------------------------
    // KV 操作

    /** 获取单个文档 */
    async get(id: any, options?: ITableGetBaseOptions): Promise<TSchema | void> {
        let doc = await this.adapter.get(id)
        if (options?.ignoreMarkDelete !== true && this.options?.enableMarkDelete) {
            if (doc && (doc as any)._isDeleted === true) {
                return undefined
            }
        }
        this.__check_output_doc(doc)
        return doc as any
    }

    /** 设置单个文档 */
    async set(id: any, doc: Partial<TSchema>): Promise<void> {
        ;(doc as any).id = id
        this.__check_input_doc(doc)
        // 启用自动元数据时，使用 setMany 来处理 _createDate 和 _updateDate
        if (this.options?.enableAutoMetadata) {
            const now = new Date()
            ;(doc as any)._updateDate = now
            await this.adapter.setMany([doc], { setOnInsert: { _createDate: now } })
            return
        }
        return this.adapter.set(id, doc)
    }

    /** 删除单个文档 */
    async delete(id: any, options?: ITableDeleteOptions) {
        if (this.options?.enableMarkDelete && options?.readDelete !== true) {
            // 标记删除时的元数据处理
            const updateSet: any = { _isDeleted: true }
            if (this.options?.enableAutoMetadata) {
                const now = new Date()
                updateSet._deleteDate = now
                updateSet._updateDate = now
            }
            await this.adapter.updateOne({ id }, { $set: updateSet })
            return
        }

        return this.adapter.delete(id)
    }
    /** 检查单个文档是否存在 */
    async has(id: any, options?: ITableGetBaseOptions) {
        if (options?.ignoreMarkDelete !== true && this.options?.enableMarkDelete) {
            const doc = await this.adapter.get(id)
            if (doc && (doc as any)._isDeleted === true) {
                return false
            }
        }
        return this.adapter.has(id)
    }
    /** 统计文档数量 */
    async count(filter?: ITableFilter, options?: ITableGetBaseOptions & { debug?: any }) {
        if (!filter) filter = {}
        this.__check_filter(filter, options)
        return this.adapter.count(filter, options)
    }
    /** 清空所有文档 */
    async clear() {
        return this.adapter.clear()
    }
    /** 清除所有文档和索引 */
    async clearAll() {
        return this.adapter.clearAll()
    }
    /** 关闭连接 */
    async close() {
        return this.adapter.close()
    }
    // -------------------------------------------------------
    // MongoDB 风格的操作

    /** 根据 filter 查找多个文档
     *
     * 可以使用选项中的 `limit`,`offset`, `pageIndex`, `sort` 来分页查询结果，但更
     * 推荐使用 `listPaging` 和 `listIdPaging` 来进行分页查询
     *
     * fitler 用法：
     * 1. 精确匹配: `{ field: value }`, `$eq`
     * 2. 比较操作符:`$gt`, `$gte`, `$lt`, `$lte`, `$ne`
     * 3. 包含操作符: `$in`, `$nin`
     * 4. 逻辑操作符: `$and`, `$or`, `$not`，`$nor`
     * 5. 字符串匹配: `$like`, `$regex`
     * 6. 数组操作: `$elemMatch`, `$all`, `$size`
     * 7. 存在操作: `$exists`
     */
    async findMany(filter: ITableFilter, options?: ITableFindOptions): Promise<TSchema[]> {
        this.__check_filter(filter, options)
        this.__check_find_options(options)

        let docs = await this.adapter.findMany(filter, options)
        for (let doc of docs) {
            this.__check_output_doc(doc)
        }
        return docs as any
    }

    /** 根据 filter 查找单个文档
     *  如果有多个匹配的文档，则只返回第一个匹配的文档
     *
     * fitler 用法：
     * 1. 精确匹配: `{ field: value }`, `$eq`
     * 2. 比较操作符:`$gt`, `$gte`, `$lt`, `$lte`, `$ne`
     * 3. 包含操作符: `$in`, `$nin`
     * 4. 逻辑操作符: `$and`, `$or`, `$not`，`$nor`
     * 5. 字符串匹配: `$like`, `$regex`
     * 6. 数组操作: `$elemMatch`, `$all`, `$size`
     * 7. 存在操作: `$exists`
     */
    async findOne(filter: ITableFilter, options?: ITableFindOptions): Promise<TSchema | void> {
        this.__check_filter(filter, options)
        this.__check_find_options(options)
        let doc = await this.adapter.findOne(filter, options)
        this.__check_output_doc(doc)
        return doc as any
    }

    /** 修改单个现有文档
     *
     * 根据 filter 的匹配第一个文档，再根据 updateOp 进行更新
     *
     * updateOp 用法：
     * 1. 设置字段： `$set`,`$unset`,`$setOnInsert`,`$rename`
     * 2. 数值运算： `$inc`, `$mul`, `$min`, `$max`
     * 3. 数组运算： `$push`, `$pop`, `$addToSet`, `$pull`
     *
     * @param options.upsert 如果没有匹配的文档，是否插入新文档，默认 false
     * @param options.sort 如果 fitler 匹配多个文档，使用 sort 来决定更新哪一个文档
     *
     */
    async updateOne(
        filter: ITableFilter,
        updateOp: ITableUpdateOp<TSchema>,
        options?: ITableUpdateOptions
    ): Promise<ITableUpdateResult> {
        this.__check_filter(filter)
        this.__check_update_op(updateOp)
        // 启用自动元数据时，自动添加 _updateDate 和 _createDate（用于 upsert）
        if (this.options?.enableAutoMetadata) {
            const now = new Date()
            updateOp = {
                ...updateOp,
                $set: { ...(updateOp.$set || {}), _updateDate: now } as any,
                $setOnInsert: { ...(updateOp.$setOnInsert || {}), _createDate: now } as any,
            }
        }
        return this.adapter.updateOne(filter, updateOp, options)
    }

    /** 修改多个现有文档
     *
     *  根据 filter 的匹配多个文档，再根据 updateOp 进行更新
     *
     *  updateOp 用法：
     * 1. 设置字段： `$set`,`$unset`,`$setOnInsert`,`$rename`
     * 2. 数值运算： `$inc`, `$mul`, `$min`, `$max`
     * 3. 数组运算： `$push`, `$pop`, `$addToSet`, `$pull`
     *
     *
     * @param options.upsert 如果没有匹配的文档，是否插入新文档，默认 false
     */
    async updateMany(
        filter: ITableFilter,
        updateOp: ITableUpdateOp<TSchema>,
        options?: ITableUpdateOptions
    ): Promise<ITableUpdateResult> {
        this.__check_filter(filter)
        this.__check_update_op(updateOp)
        // 启用自动元数据时，自动添加 _updateDate 和 _createDate（用于 upsert）
        if (this.options?.enableAutoMetadata) {
            const now = new Date()
            updateOp = {
                ...updateOp,
                $set: { ...(updateOp.$set || {}), _updateDate: now } as any,
                $setOnInsert: { ...(updateOp.$setOnInsert || {}), _createDate: now } as any,
            }
        }
        return this.adapter.updateMany(filter, updateOp, options)
    }

    /**
     * 批量进行多次更新操作
     */
    async bulkUpdate(
        updates: { filter: ITableFilter; updateOp: ITableUpdateOp<TSchema>; options?: ITableUpdateOptions }[]
    ) {
        for (const update of updates) {
            this.__check_filter(update.filter)
            this.__check_update_op(update.updateOp)
        }
        // 启用自动元数据时，为每个更新操作添加 _updateDate 和 _createDate
        if (this.options?.enableAutoMetadata) {
            const now = new Date()
            updates = updates.map((u) => ({
                ...u,
                updateOp: {
                    ...u.updateOp,
                    $set: { ...(u.updateOp.$set || {}), _updateDate: now } as any,
                    $setOnInsert: { ...(u.updateOp.$setOnInsert || {}), _createDate: now } as any,
                },
            }))
        }
        return this.adapter.bulkUpdate(updates)
    }

    /** 插入新文档
     *
     *  如果目标文档的 ID 已存在，会忽略，不会进行覆盖，并且继续插入其他文档\n
     *  文档必须有 ID 字段，如果没有 ID 字段会自动生成一个唯一 ID
     */
    async insertMany(docs: Partial<TSchema>[]): Promise<ITableInsertResult> {
        // 启用自动元数据时，为每个文档添加 _createDate 和 _updateDate
        if (this.options?.enableAutoMetadata) {
            const now = new Date()
            for (let doc of docs) {
                ;(doc as any)._createDate = now
                ;(doc as any)._updateDate = now
            }
        }
        for (let doc of docs) {
            this.__check_input_doc(doc)
        }
        return this.adapter.insertMany(docs)
    }

    /** 插入单个新文档
     *
     * 如果目标文档的 ID 已存在，会忽略，不会进行覆盖\
     * 相当于调用 `insertMany([doc])`
     */
    async insertOne(doc: Partial<TSchema>): Promise<ITableInsertResult> {
        return await this.insertMany([doc])
    }

    /** 设置多个文档
     *
     * 根据 doc 的 id 匹配，如果已存在则进行 update 否则进行 insert\
     *
     * @param options.merge  是对存在 doc 进行深度合并而不是浅合并（Object.assign），深度合并时可以使用 `__overwrite__` 标记来强制覆盖子对象
     * @param options.overwrite  是否对 doc 进行覆盖而不是浅合并，把新文档完全替换掉已存在的文档
     * @param options.insertOnly  是否只插入新文档，已存在的文档不进行更新
     * @param options.updateOnly  是否只更新已存在的文档，未存在的文档不进行插入
     *
     */
    async setMany(docs: Partial<TSchema>[], options?: ITableSetOptions): Promise<ITableSetResult> {
        // 启用自动元数据时，为每个文档添加 _updateDate，并使用 setOnInsert 添加 _createDate
        if (this.options?.enableAutoMetadata) {
            const now = new Date()
            for (let doc of docs) {
                ;(doc as any)._updateDate = now
            }

            // overwrite 模式使用 replaceOne，不支持 $setOnInsert
            // 需要先查询已存在文档的 _createDate，并保留它
            if (options?.overwrite) {
                for (let doc of docs) {
                    const existingDoc = await this.adapter.get((doc as any).id)
                    if (existingDoc && existingDoc._createDate) {
                        // 保留已存在文档的 _createDate
                        ;(doc as any)._createDate = existingDoc._createDate
                    } else {
                        // 新文档，设置 _createDate
                        ;(doc as any)._createDate = now
                    }
                }
            } else {
                // 非 overwrite 模式，使用 setOnInsert 处理 _createDate
                options = { ...options, setOnInsert: { ...(options?.setOnInsert || {}), _createDate: now } }
            }
        }
        for (let doc of docs) {
            this.__check_input_doc(doc)
        }
        return this.adapter.setMany(docs, options)
    }

    /** 删除多个文档
     *
     * 根据 filter 的匹配结果，可能会删除多个文档
     *
     * fitler 用法：
     * 1. 精确匹配: `{ field: value }`, `$eq`
     * 2. 比较操作符:`$gt`, `$gte`, `$lt`, `$lte`, `$ne`
     * 3. 包含操作符: `$in`, `$nin`
     * 4. 逻辑操作符: `$and`, `$or`, `$not`，`$nor`
     * 5. 字符串匹配: `$like`, `$regex`
     * 6. 数组操作: `$elemMatch`, `$all`, `$size`
     * 7. 存在操作: `$exists`
     */
    async deleteMany(filter: ITableFilter, options?: ITableDeleteOptions): Promise<ITableDeletedResult> {
        this.__check_filter(filter, options)
        if (this.options?.enableMarkDelete && options?.readDelete !== true) {
            // 标记删除时的元数据处理
            const updateSet: any = { _isDeleted: true }
            if (this.options?.enableAutoMetadata) {
                const now = new Date()
                updateSet._deleteDate = now
                updateSet._updateDate = now
            }
            let re = await this.adapter.updateMany(filter, { $set: updateSet })
            return { deletedCount: re.modifiedCount }
        }
        return this.adapter.deleteMany(filter)
    }

    /** 删除单个文档
     *
     * 只会删除第一个匹配的文档
     *
     * fitler 用法：
     * 1. 精确匹配: `{ field: value }`, `$eq`
     * 2. 比较操作符:`$gt`, `$gte`, `$lt`, `$lte`, `$ne`
     * 3. 包含操作符: `$in`, `$nin`
     * 4. 逻辑操作符: `$and`, `$or`, `$not`，`$nor`
     * 5. 字符串匹配: `$like`, `$regex`
     * 6. 数组操作: `$elemMatch`, `$all`, `$size`
     * 7. 存在操作: `$exists`
     *
     * @param options.sort 如果 fitler 匹配多个文档，使用 sort 来决定删除哪一个文档
     */
    async deleteOne(filter: ITableFilter, options?: ITableDeleteOptions): Promise<ITableDeletedResult> {
        this.__check_filter(filter, options)
        if (this.options?.enableMarkDelete && options?.readDelete !== true) {
            // 标记删除时的元数据处理
            const updateSet: any = { _isDeleted: true }
            if (this.options?.enableAutoMetadata) {
                const now = new Date()
                updateSet._deleteDate = now
                updateSet._updateDate = now
            }
            let re = await this.adapter.updateOne(filter, { $set: updateSet }, options)
            return { deletedCount: re.modifiedCount }
        }
        return this.adapter.deleteOne(filter, options)
    }

    /** 定义索引
     *
     *  普通索引：\
     *   [{ key: "fieldName"}]\
     * 唯一索引：\
     *   [{ key: "md5", unique: true }]\
     * 复合索引：\
     *  [{ key: { fieldA: 1, 'b.a': -1 }, unique: false }]\
     * 禁用索引：\
     *   [{ key: "fieldName", disabled: true }]\
     * 自然排序：\
     *  [{ key: "num", naturalSort: true }]\
     */
    async defineIndexes(indexes: ITableIndexConfig[], options?: ITableDefineIndexesOptions): Promise<void> {
        return this.adapter.defineIndexes(indexes, options)
    }

    /** 清除所有索引 */
    async dropIndexes(): Promise<void> {
        return this.adapter.dropIndexes()
    }

    /** 压缩数据文件，清理碎片 */
    async compact(): Promise<void> {
        return this.adapter.compact()
    }

    // -------------------------------------------------------

    /** 列出分页加载（使用 skip limit） */
    async listPaging<T = TSchema>(
        filter: any,
        options: ISkipPagingOptions & ITableGetBaseOptions
    ): Promise<IReSkipPaging<T>> {
        this.__check_filter(filter, options)
        let re = listPagingBySkip<T>(this, filter, options)
        return <any>re
    }

    /** 列出分页加载（使用 cursor） */
    async listPagingByCursor<T = TSchema>(filter: any, options: ICursorPagingOptions): Promise<IReCursorPaging<T>> {
        this.__check_filter(filter, options)
        let re = listPagingByCursor<T>(this, filter, options)
        return <any>re
    }

    /** 遍历所有文档，批量处理 */
    async eachBatch(
        filter: any,
        options: {
            pageSize?: number
            projection?: any
            sortKey?: string
            sortOrder?: 1 | -1
        } & ITableGetBaseOptions,
        eachFunc: (list: TSchema[], stop: () => void, batch: number) => Promise<void>
    ) {
        this.__check_filter(filter, options)

        const pageSize = options.pageSize || 100
        let batch = 0
        let isStop = false
        let cursor: any = undefined
        const stop = () => {
            isStop = true
        }

        while (!isStop) {
            const re = await this.listPagingByCursor(filter, {
                pageSize,
                cursor,
                projection: options.projection,
                sortKey: options.sortKey,
                sortOrder: options.sortOrder,
                ignoreMarkDelete: options.ignoreMarkDelete,
            })

            if (re.list.length === 0) {
                break
            }

            await eachFunc(re.list, stop, batch)

            if (!re.hasNext) {
                break
            }

            cursor = re.nextCursor
            batch++
        }
    }

    /** 遍历所有文档 */
    async forEach<T = TSchema>(filter: any, callbackfn: (value: T, index: number) => Promise<void>): Promise<void> {
        let index = 0
        await this.eachBatch(filter, {}, async (list) => {
            for (const item of list) {
                await callbackfn(item as unknown as T, index)
                index++
            }
        })
    }

    // -------------------------------------------------------

    /**
     * 获取预设投影列表
     */
    plv(plvName: keyof TPlv): string[] | { [field: string]: 1 | -1 } | undefined {
        return this.options?.projections?.[plvName as string]
    }
    // -------------------------------------------------------
    // 导入导出与备份

    /** 导出表数据为二进制格式 */
    exportBinary = exportBinary
    /** 从二进制格式导入表数据 */
    importBinary = importBinary
    /** 导出表数据为二进制文件 (Node.js) */
    exportBinaryToFile = exportBinaryToFile
    /** 从二进制文件导入表数据 (Node.js) */
    importBinaryFromFile = importBinaryFromFile
}
