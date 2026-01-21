import {
    ITableDBAdapterInstance,
    ITableDBAdapter,
    ITableDoc,
    ITableFindOptions,
    ITableUpdateOptions,
    ITableUpdateResult,
    ITableInsertResult,
    ITableSetOptions,
    ITableSetResult,
    ITableDeletedResult,
    ITableDefineIndexesOptions,
    ITableIndexConfig,
    ITableDeleteOptions,
} from "../adapter"
import { ITableFilter, ITableUpdateOp } from "../../core/types"
import { useMongoDB } from "./useMongoDB"
import { Collection } from "mongodb"
import { jsToMongo, mongoToJs } from "./lib/docType"
import { buildProjection } from "./lib/normalizeProjection"
import { normalizeSort } from "./lib/normalizeSort"
import { isPlainObject } from "fzz/src"

export function MongoDBAdapter(config: { auth: string; dbName: string }) {
    const Adapter = {
        name: "MongoDBAdapter",
        async useAdapterInstance(tableName: string): Promise<MongoDBAdapterInstance> {
            let db = await useMongoDB(config)
            return new MongoDBAdapterInstance(db.collection(tableName)) as any
        },
    } as ITableDBAdapter
    return Adapter
}

export class MongoDBAdapterInstance implements ITableDBAdapterInstance {
    name = "MongoDBAdapter"
    constructor(public collection: Collection) { }

    // -------------------------------------------------------
    // KV 基础操作

    /** 获取一个文档 */
    async get(id: any): Promise<ITableDoc | void> {
        const res = await this.collection.findOne({ id }, { projection: { _id: 0 } })
        if (!res) return undefined
        return mongoToJs(res) as ITableDoc
    }

    /** 设置一个文档 */
    async set(id: any, value: ITableDoc): Promise<void> {
        let doc = jsToMongo(value)
        if (doc instanceof Promise) doc = await doc
        await this.collection.replaceOne({ id }, doc, { upsert: true })
        return
    }

    /** 删除一个文档 */
    async delete(id: any): Promise<void> {
        await this.collection.deleteOne({ id })
    }

    /** 检查文档是否存在 */
    async has(id: any): Promise<boolean> {
        const count = await this.collection.countDocuments({ id }, { limit: 1 })
        return count > 0
    }

    /** 获取文档数量 */
    async count(filter?: ITableFilter): Promise<number> {
        if (filter) {
            let query = jsToMongo(filter, true)
            if (query instanceof Promise) query = await query
            return await this.collection.countDocuments(query)
        }
        // 无 filter 时 estimatedDocumentCount 使用元数据统计，速度极快（O(1)）
        return await this.collection.estimatedDocumentCount()
    }

    /** 清空所有文档 */
    async clear(): Promise<void> {
        await this.collection.deleteMany({})
    }

    /** 清除所有数据和索引 */
    async clearAll(): Promise<void> {
        await this.clear()
        await this.dropIndexes()
    }

    /** 删除所有数据和索引 */
    async drop(): Promise<void> {
        await this.collection.drop()
    }

    async close(): Promise<void> {
        this.collection.db.client.close()
    }

    // MongoDB 风格的操作 ---------------------------

    /** 查找多个文档 */
    async findMany(filter: ITableFilter, options?: ITableFindOptions): Promise<ITableDoc[]> {
        let query = jsToMongo(filter, true)
        if (query instanceof Promise) query = await query
        const mongoOptions: any = {
            projection: buildProjection(options?.projection),
            collation: {},
        }

        if (options) {
            if (options.limit) mongoOptions.limit = options.limit
            if (options.offset) mongoOptions.skip = options.offset
            if (options.sort) mongoOptions.sort = normalizeSort(options.sort)
            if (options.numericOrdering) mongoOptions.collation.numericOrdering = true
            if (options.naturalSort) mongoOptions.collation = { locale: "zh", numericOrdering: true }
            if (options.caseSensitive === false) mongoOptions.collation.strength = 2
        }

        // console.log(">>> findMany query:", {query, mongoOptions})
        let cursor = this.collection.find(query, mongoOptions)

        const docs = await cursor.toArray()
        return docs.map((d) => mongoToJs(d)) as ITableDoc[]
    }

    /** 查找单个文档 */
    async findOne(filter: ITableFilter, options?: ITableFindOptions): Promise<ITableDoc | void> {
        let query = jsToMongo(filter, true)
        if (query instanceof Promise) query = await query
        const mongoOptions: any = {
            projection: buildProjection(options?.projection),
        }

        if (options) {
            if (options.limit) mongoOptions.limit = options.limit
            if (options.offset) mongoOptions.skip = options.offset
            if (options.sort) mongoOptions.sort = normalizeSort(options.sort)
            if (options.numericOrdering) mongoOptions.collation.numericOrdering = true
            if (options.naturalSort) mongoOptions.collation = { locale: "zh", numericOrdering: true }
            if (options.caseSensitive === false) mongoOptions.collation.strength = 2
        }

        const res = await this.collection.findOne(query, mongoOptions)
        if (!res) return undefined
        return mongoToJs(res) as ITableDoc
    }

    /** 修改单个现有文档 */
    async updateOne(
        filter: ITableFilter,
        updateOp: ITableUpdateOp,
        options?: ITableUpdateOptions
    ): Promise<ITableUpdateResult> {
        let query = jsToMongo(filter, true)
        if (query instanceof Promise) query = await query
        let update = jsToMongo(updateOp)
        if (update instanceof Promise) update = await update
        const mongoOptions: any = {}

        if (options?.upsert) {
            mongoOptions.upsert = true
        }

        let res: any
        if (options?.sort) {
            // updateOne 不直接支持 sort 选项，需要使用 findOneAndUpdate
            res = await this.collection.findOneAndUpdate(query, update, {
                ...mongoOptions,
                sort: normalizeSort(options.sort),
                returnDocument: "after",
                includeResultMetadata: true,
            })

            let upsertedIds: any[] | undefined
            if (res.lastErrorObject?.upserted) {
                upsertedIds = await this.__mongodbIds_to_docIds([res.lastErrorObject.upserted])
            }

            return {
                matchedCount: res.lastErrorObject?.updatedExisting ? 1 : 0,
                modifiedCount: res.value ? 1 : 0, // findOneAndUpdate 只要匹配到通常就会修改
                upsertedIds,
            }
        } else {
            res = await this.collection.updateOne(query, update, mongoOptions)

            let upsertedIds: any[] | undefined
            if (res.upsertedId) {
                upsertedIds = await this.__mongodbIds_to_docIds([res.upsertedId])
            }

            return {
                matchedCount: res.matchedCount,
                modifiedCount: res.modifiedCount,
                upsertedIds,
            }
        }
    }

    /** 修改多个现有文档 */
    async updateMany(
        filter: ITableFilter,
        updateOp: ITableUpdateOp,
        options?: ITableUpdateOptions
    ): Promise<ITableUpdateResult> {
        let query = jsToMongo(filter, true)
        if (query instanceof Promise) query = await query
        let update = jsToMongo(updateOp)
        if (update instanceof Promise) update = await update
        const mongoOptions: any = {
            ordered: false,
        }
        if (options?.upsert) {
            mongoOptions.upsert = true
        }

        const res = await this.collection.updateMany(query, update, mongoOptions)

        let upsertedIds!: any[]
        if (res.upsertedId) upsertedIds = await this.__mongodbIds_to_docIds([res.upsertedId])

        return {
            matchedCount: res.matchedCount,
            modifiedCount: res.modifiedCount,
            upsertedIds,
        }
    }

    /** 批量更新多个文档 */
    async bulkUpdate(
        updates: { filter: ITableFilter; updateOp: ITableUpdateOp; options?: ITableUpdateOptions }[]
    ): Promise<ITableUpdateResult> {
        const operations = await Promise.all(
            updates.map(async (item) => {
                let query = jsToMongo(item.filter, true)
                if (query instanceof Promise) query = await query
                let update = jsToMongo(item.updateOp)
                if (update instanceof Promise) update = await update

                const op: any = {
                    updateOne: {
                        filter: query,
                        update: update,
                    },
                }

                if (item.options?.upsert) {
                    op.updateOne.upsert = true
                }

                return op
            })
        )

        let res: any
        try {
            res = await this.collection.bulkWrite(operations, { ordered: false })
        } catch (e: any) {
            res = e.result
        }

        if (!res) {
            return {
                matchedCount: 0,
                modifiedCount: 0,
            }
        }

        let upsertedIds: any[] | undefined
        if (res.upsertedIds && Object.keys(res.upsertedIds).length > 0) {
            upsertedIds = await this.__mongodbIds_to_docIds(Object.values(res.upsertedIds))
        }

        return {
            matchedCount: res.matchedCount || 0,
            modifiedCount: res.modifiedCount || 0,
            upsertedIds,
        }
    }

    /** 插入新文档 */
    async insertMany(docs: ITableDoc[]): Promise<ITableInsertResult> {
        const mongoDocsResult = docs.map((d) => jsToMongo(d))
        let mongoDocs: any[]
        if (mongoDocsResult.some((r) => r instanceof Promise)) {
            mongoDocs = await Promise.all(mongoDocsResult)
        } else {
            mongoDocs = mongoDocsResult
        }
        try {
            const res = await this.collection.insertMany(mongoDocs, { ordered: false })
            return {
                insertedCount: res.insertedCount,
                skippedCount: 0,
                insertedIds: await this.__mongodbIds_to_docIds(Object.values(res.insertedIds)),
                skippedIds: [],
            }
        } catch (e: any) {
            const insertedCount = e.insertedCount ?? e.result?.nInserted ?? 0
            const writeErrors = e.writeErrors ?? e.result?.writeErrors ?? []
            const skippedIds = writeErrors.map((err: any) => err.op?.id).filter(Boolean)
            return {
                insertedCount,
                skippedCount: writeErrors.length,
                insertedIds: [], // MongoDB doesn't easily return successful IDs on partial failure here
                skippedIds,
            }
        }
    }

    /** 设置多个文档 */
    async setMany(docs: ITableDoc[], options?: ITableSetOptions): Promise<ITableSetResult> {
        const operations = await Promise.all(
            docs.map(async (doc) => {
                let mongoDoc = jsToMongo(doc)
                if (mongoDoc instanceof Promise) mongoDoc = await mongoDoc

                // 使用转换后的 id 作为 filter，确保类型匹配（例如 bigint）
                const filter = { id: mongoDoc["id"] }

                if (options?.insertOnly) {
                    // 使用 updateOne + $setOnInsert + upsert 来实现 "仅插入不更新"
                    // 如果存在：匹配但不修改
                    // 如果不存在：插入
                    // 合并 options.setOnInsert（用于 _createDate 等元数据）
                    let setOnInsertDoc = mongoDoc
                    if (options?.setOnInsert) {
                        let mongoSetOnInsert = jsToMongo(options.setOnInsert)
                        if (mongoSetOnInsert instanceof Promise) mongoSetOnInsert = await mongoSetOnInsert
                        setOnInsertDoc = { ...mongoSetOnInsert, ...mongoDoc }
                    }
                    return {
                        updateOne: {
                            filter,
                            update: { $setOnInsert: setOnInsertDoc },
                            upsert: true,
                        },
                    }
                }

                if (options?.overwrite) {
                    return {
                        replaceOne: {
                            filter,
                            replacement: mongoDoc,
                            upsert: !options?.updateOnly,
                        },
                    }
                }

                //  进行深度合并扁平化处理
                if (options?.merge) {
                    const updates = collectMergeUpdates(mongoDoc)
                    const updateOp: any = {}
                    if (Object.keys(updates.set).length > 0) updateOp.$set = updates.set
                    if (Object.keys(updates.addToSet).length > 0) updateOp.$addToSet = updates.addToSet

                    return {
                        updateOne: {
                            filter,
                            update: updateOp,
                            upsert: !options?.updateOnly,
                        },
                    }
                }

                // 默认行为：使用 $set 更新，支持 setOnInsert 选项
                const updateOp: any = { $set: mongoDoc }
                // 如果有 setOnInsert 选项，在 upsert 时添加 $setOnInsert
                if (options?.setOnInsert) {
                    let mongoSetOnInsert = jsToMongo(options.setOnInsert)
                    if (mongoSetOnInsert instanceof Promise) mongoSetOnInsert = await mongoSetOnInsert
                    updateOp.$setOnInsert = mongoSetOnInsert
                }

                return {
                    updateOne: {
                        filter,
                        update: updateOp,
                        upsert: !options?.updateOnly,
                    },
                }
            })
        )

        let res: any
        try {
            res = await this.collection.bulkWrite(operations, { ordered: false })
        } catch (e: any) {
            res = e.result
        }

        if (!res) {
            return {
                insertedCount: 0,
                overwriteCount: 0,
                insertedIds: [],
            }
        }

        const insertedIds = [...Object.values(res.upsertedIds || {}), ...Object.values(res.insertedIds || {})]

        return {
            insertedCount: (res.upsertedCount || 0) + (res.insertedCount || 0),
            overwriteCount: options?.insertOnly ? 0 : res.matchedCount || 0,
            insertedIds: await this.__mongodbIds_to_docIds(insertedIds),
        }
    }

    /** 删除多个文档 */
    async deleteMany(filter: ITableFilter): Promise<ITableDeletedResult> {
        let query = jsToMongo(filter, true)
        if (query instanceof Promise) query = await query
        const res = await this.collection.deleteMany(query)
        return { deletedCount: res.deletedCount }
    }

    /** 删除单个文档 */
    async deleteOne(filter: ITableFilter, options?: ITableDeleteOptions): Promise<ITableDeletedResult> {
        let query = jsToMongo(filter, true)
        if (query instanceof Promise) query = await query

        if (options?.sort) {
            // deleteOne 不直接支持 sort 选项，需要使用 findOneAndDelete
            const res = await this.collection.findOneAndDelete(query, {
                sort: normalizeSort(options.sort),
                projection: { id: 1, _id: 1 },
            })

            return { deletedCount: res?.id ? 1 : 0 }
        }

        const res = await this.collection.deleteOne(query)

        return { deletedCount: res.deletedCount || 0 }
    }

    /** 定义索引 */
    async defineIndexes(indexes: ITableIndexConfig[], options?: ITableDefineIndexesOptions): Promise<void> {
        if (options?.rebuild) {
            await this.collection.dropIndexes()
        }

        const indexSpecs: any[] = []
        const dropSpecs: string[] = []

        for (const config of indexes) {
            if (config.disabled) {
                if (config.name) {
                    dropSpecs.push(config.name)
                } else {
                    // 尝试推断默认索引名
                    if (typeof config.key === "string") {
                        dropSpecs.push(`${config.key}_1`)
                    } else {
                        const name = Object.entries(config.key)
                            .map(([k, v]) => `${k}_${v}`)
                            .join("_")
                        dropSpecs.push(name)
                    }
                }
                continue
            }

            const spec: any = {}

            // key
            if (typeof config.key === "string") {
                spec.key = { [config.key]: 1 }
            } else {
                spec.key = config.key
            }

            // name
            if (config.name) spec.name = config.name

            // unique
            if (config.unique) spec.unique = true

            // type
            if (config.type === "text") {
                if (typeof config.key === "string") {
                    spec.key = { [config.key]: "text" }
                }
            }

            // collation
            if (config.locale || config.numericOrdering || config.naturalSort || config.caseSensitive !== undefined) {
                spec.collation = {}

                if (config.locale) {
                    spec.collation.locale = config.locale
                }

                if (config.numericOrdering) {
                    spec.collation.numericOrdering = true
                }

                if (config.naturalSort) {
                    spec.collation.locale = "zh"
                    spec.collation.numericOrdering = true
                }

                if (config.caseSensitive === false) {
                    spec.collation.strength = 2 // 忽略大小写
                }
            }

            indexSpecs.push(spec)
        }

        // 执行删除
        if (dropSpecs.length > 0) {
            for (const name of dropSpecs) {
                try {
                    await this.collection.dropIndex(name)
                } catch (e) {
                    /* ignore if not found */
                }
            }
        }

        // 执行创建
        if (indexSpecs.length > 0) {
            await this.collection.createIndexes(indexSpecs)
        }
    }

    /** 删除所有索引 */
    async dropIndexes(): Promise<void> {
        await this.collection.dropIndexes()
    }

    /** 压缩数据库文件 */
    async compact(): Promise<void> {
        await this.collection.db.command({ compact: this.collection.collectionName })
    }

    /** 内部方法：将 MongoDB 返回的 _id  转换为文档 id */
    async __mongodbIds_to_docIds(_ids: any[]) {
        let re = await this.collection.find({ _id: { $in: _ids } }, { projection: { id: 1 } }).toArray()
        return re.map((r) => r.id)
    }
}

/**
 * 将对象扁平化为 MongoDB 的点符号路径 (Dot Notation)
 * 支持 { __overwrite__: true } 标记来强制覆盖该层级
 * * @param {Object} doc - 需要处理的对象
 * @param {String} prefix - (递归用) 当前路径前缀
 * @param {Object} res - (递归用) 结果累加对象
 */

function collectMergeUpdates(doc: any, prefix = "", res: { set: any; addToSet: any } = { set: {}, addToSet: {} }) {
    for (const key in doc) {
        if (!Object.prototype.hasOwnProperty.call(doc, key)) continue

        const val: any = doc[key]
        const newKey = prefix ? `${prefix}.${key}` : key

        // 0. 特殊 Primitive 类型，直接赋值，不进行递归
        if (val instanceof RegExp || val instanceof DataView) {
            res.set[newKey] = val
            continue
        }

        // 1. 判断是否为普通对象 (排除 null, Array, Date, ObjectId 等)
        if (Array.isArray(val)) {
            // Array -> $addToSet
            res.addToSet[newKey] = { $each: val }
        } else if (isPlainObject(val)) {
            // 2. 检查是否有覆写标记
            if (val.__overwrite__ === true) {
                // 【核心逻辑】如果有标记：
                // 移除标记字段，并将剩余的整个对象直接赋值（阻断递归）
                const { __overwrite__, ...cleanObj } = val
                res.set[newKey] = cleanObj
            } else {
                // 3. 如果没有标记：
                // 继续递归深层扁平化
                // 边界情况：如果是空对象 {}，递归进不去，需要显式赋值
                if (Object.keys(val).length === 0) {
                    res.set[newKey] = val
                } else {
                    collectMergeUpdates(val, newKey, res)
                }
            }
        } else {
            // 4. 非纯对象（基本类型、Date等），直接赋值
            res.set[newKey] = val
        }
    }
    return res
}
