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
import { matches } from "../SQLite/utils/matcher"
import { applyUpdate, deepMergeWithArrayUnion } from "../SQLite/utils/patch"
import { project, normalizeProjection } from "../SQLite/utils/projection"

/**
 * IndexedDBAdapter 机制说明
 * ===============================================
 * 
 * 核心设计目标：
 * 在浏览器环境下提供高性能的 MongoDB 风格文档数据库体验。
 * 
 * 关键机制:
 * 1. 动态 Schema 管理:
 *    IndexedDB 只能在 onupgradeneeded 事件中修改 ObjectStore 和 Index。
 *    当调用 defineIndexes 时，如果发现需要创建新索引，会关闭当前数据库连接，
 *    增加版本号并重新打开。
 * 
 * 2. 多表与并发升级支持:
 *    - 适配器在获取 Store 前会自动检查表是否存在，如果不存在则触发数据库升级。
 *    - 通过监听 onversionchange 事件，当其他实例请求升级时主动关闭连接，防止死锁和超时。
 * 
 * 3. 混合查询策略:
 *    - 尽可能利用 IndexedDB 索引进行范围查询 (IDBKeyRange)。(待进一步优化)
 *    - 对于复杂查询，使用游标 (Cursor) 遍历并在内存中进行 matches 匹配。
 * 
 * 4. 兼容性:
 *    - _id: 为每个文档维护一个虚拟的 _id，以兼容核心层对 _id 的依赖（如游标分页）。
 *    - undefined 规范化: 将 undefined 转换为 null，保持与其他适配器行为一致。
 */

export function IndexedDBAdapter(config: { dbName: string }): ITableDBAdapter {
    return {
        name: "IndexedDBAdapter",
        async useAdapterInstance(tableName: string): Promise<ITableDBAdapterInstance> {
            const instance = new IndexedDBAdapterInstance(config.dbName, tableName)
            await instance.init()
            return instance
        },
    }
}

class IndexedDBAdapterInstance implements ITableDBAdapterInstance {
    name = "IndexedDBAdapter"
    private db: IDBDatabase | null = null
    private version: number = 0
    private initPromise: Promise<void> | null = null

    constructor(private dbName: string, public tableName: string) { }

    async init() {
        if (this.db) return
        if (this.initPromise) return this.initPromise

        this.initPromise = (async () => {
            try {
                this.db = await this.openDB()
                this.version = this.db.version
            } finally {
                this.initPromise = null
            }
        })()
        return this.initPromise
    }

    private openDB(version?: number): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, version)
            request.onerror = () => reject(request.error)
            request.onsuccess = () => {
                const db = request.result
                // 监听版本变更事件，防止阻塞其他连接的升级请求
                db.onversionchange = () => {
                    db.close()
                    this.db = null
                }
                resolve(db)
            }
            request.onupgradeneeded = (event: any) => {
                const db = request.result
                if (!db.objectStoreNames.contains(this.tableName)) {
                    db.createObjectStore(this.tableName, { keyPath: "id" })
                }
            }
        })
    }

    private async getStore(mode: IDBTransactionMode = "readonly"): Promise<IDBObjectStore> {
        while (true) {
            if (!this.db) await this.init()

            if (this.db!.objectStoreNames.contains(this.tableName)) {
                try {
                    const transaction = this.db!.transaction(this.tableName, mode)
                    return transaction.objectStore(this.tableName)
                } catch (e: any) {
                    // 如果因为并发升级导致连接已关闭，重试
                    if (e.name === "InvalidStateError" || e.name === "TransactionInactiveError") {
                        this.db = null
                        continue
                    }
                    throw e
                }
            }

            // 表不存在，尝试升级
            await this.reopenForTable()
        }
    }

    private async reopenForTable() {
        if (this.db && this.db.objectStoreNames.contains(this.tableName)) return

        const newVersion = (this.db?.version || 0) + 1
        if (this.db) {
            this.db.close()
            this.db = null
        }

        try {
            this.db = await this.openDB(newVersion)
            this.version = this.db.version
        } catch (e) {
            // 如果升级失败（可能是因为其他连接正在升级），稍后重试
            this.db = null
            await new Promise(resolve => setTimeout(resolve, 50))
        }
    }

    private static _idCounter = 0
    private generateId(): number {
        // 使用时间戳 + 递增计数器确保严格顺序
        return Date.now() * 1000 + (IndexedDBAdapterInstance._idCounter++ % 1000)
    }

    private normalizeUndefined(obj: any): any {
        if (obj === undefined) return null
        if (obj === null) return null
        if (typeof obj !== "object") return obj

        // Error 类型需要特殊处理，IndexedDB 不支持直接存储 Error
        if (obj instanceof Error) {
            return this.serializeError(obj, 0)
        }

        if (
            obj instanceof Map ||
            obj instanceof Set ||
            obj instanceof Date ||
            obj instanceof RegExp ||
            (typeof Buffer !== "undefined" && Buffer.isBuffer(obj)) ||
            (typeof Blob !== "undefined" && obj instanceof Blob) ||
            (typeof File !== "undefined" && obj instanceof File) ||
            obj instanceof DataView ||
            ArrayBuffer.isView(obj) ||
            obj instanceof ArrayBuffer
        ) {
            return obj
        }

        if (Array.isArray(obj)) {
            return obj.map((item) => this.normalizeUndefined(item))
        }

        const isPlain = obj.constructor === Object || obj.constructor === undefined
        if (!isPlain) return obj

        const normalized: any = {}
        for (const key in obj) {
            normalized[key] = this.normalizeUndefined(obj[key])
        }
        return normalized
    }

    /**
     * 序列化 Error 对象以便存储到 IndexedDB
     * 支持 name, message, stack, cause（最多递归 3 层）
     */
    private serializeError(error: Error, depth: number): any {
        const result: any = {
            __errorType: true,
            name: error.name,
            message: error.message,
        }
        
        if (error.stack) {
            result.stack = error.stack
        }
        
        // 处理 cause，最多递归 3 层
        if (error.cause !== undefined && depth < 3) {
            if (error.cause instanceof Error) {
                result.cause = this.serializeError(error.cause, depth + 1)
            } else {
                result.cause = this.normalizeUndefined(error.cause)
            }
        }
        
        return result
    }

    /**
     * 反序列化 Error 对象
     */
    private deserializeError(data: any): Error {
        const message = data.message || ""
        let error: Error
        
        switch (data.name) {
            case "TypeError":
                error = new TypeError(message)
                break
            case "RangeError":
                error = new RangeError(message)
                break
            case "SyntaxError":
                error = new SyntaxError(message)
                break
            case "ReferenceError":
                error = new ReferenceError(message)
                break
            case "URIError":
                error = new URIError(message)
                break
            case "EvalError":
                error = new EvalError(message)
                break
            default:
                error = new Error(message)
                if (data.name && data.name !== "Error") {
                    error.name = data.name
                }
                break
        }
        
        if (data.stack) {
            error.stack = data.stack
        }
        
        if (data.cause !== undefined) {
            if (data.cause && data.cause.__errorType) {
                (error as any).cause = this.deserializeError(data.cause)
            } else {
                (error as any).cause = this.restoreSpecialTypes(data.cause)
            }
        }
        
        return error
    }

    /**
     * 恢复从 IndexedDB 取出的数据中的特殊类型（如 Error）
     */
    private restoreSpecialTypes(obj: any): any {
        if (obj === null || obj === undefined) return obj
        if (typeof obj !== "object") return obj

        // 检测序列化的 Error
        if (obj.__errorType === true) {
            return this.deserializeError(obj)
        }

        if (Array.isArray(obj)) {
            return obj.map((item) => this.restoreSpecialTypes(item))
        }

        // 不处理特殊类型（它们由 IndexedDB 原生支持）
        if (
            obj instanceof Map ||
            obj instanceof Set ||
            obj instanceof Date ||
            obj instanceof RegExp ||
            (typeof Blob !== "undefined" && obj instanceof Blob) ||
            (typeof File !== "undefined" && obj instanceof File) ||
            obj instanceof DataView ||
            ArrayBuffer.isView(obj) ||
            obj instanceof ArrayBuffer
        ) {
            return obj
        }

        const isPlain = obj.constructor === Object || obj.constructor === undefined
        if (!isPlain) return obj

        const restored: any = {}
        for (const key in obj) {
            restored[key] = this.restoreSpecialTypes(obj[key])
        }
        return restored
    }

    // --- KV Operations ---

    async get(id: any): Promise<ITableDoc | void> {
        const store = await this.getStore()
        return new Promise((resolve, reject) => {
            const request = store.get(id)
            request.onerror = () => reject(request.error)
            request.onsuccess = () => {
                let doc = request.result
                if (doc) {
                    delete (doc as any)._id // 默认隐藏
                    doc = this.restoreSpecialTypes(doc) // 恢复特殊类型（如 Error）
                }
                resolve(doc)
            }
        })
    }

    async set(id: any, value: Partial<ITableDoc>): Promise<void> {
        const store = await this.getStore("readwrite")
        const normalizedValue = this.normalizeUndefined(value)
        return new Promise((resolve, reject) => {
            // 确保有 _id 和 id，且 id 类型被保留
            const doc = {
                _id: (value as any)._id || this.generateId(),
                ...normalizedValue,
                id: id
            }
            const request = store.put(doc)
            request.onerror = () => reject(request.error)
            request.onsuccess = () => resolve()
        })
    }

    async delete(id: any): Promise<void> {
        const store = await this.getStore("readwrite")
        return new Promise((resolve, reject) => {
            const request = store.delete(id)
            request.onerror = () => reject(request.error)
            request.onsuccess = () => resolve()
        })
    }

    async has(id: any): Promise<boolean> {
        const store = await this.getStore()
        return new Promise((resolve, reject) => {
            const request = store.count(id)
            request.onerror = () => reject(request.error)
            request.onsuccess = () => resolve(request.result > 0)
        })
    }

    async count(filter?: ITableFilter): Promise<number> {
        if (!filter || Object.keys(filter).length === 0) {
            const store = await this.getStore()
            return new Promise((resolve, reject) => {
                const request = store.count()
                request.onerror = () => reject(request.error)
                request.onsuccess = () => resolve(request.result)
            })
        }

        let count = 0
        await this.iterateCursor(filter, () => { count++ })
        return count
    }

    async clear(): Promise<void> {
        const store = await this.getStore("readwrite")
        return new Promise((resolve, reject) => {
            const request = store.clear()
            request.onerror = () => reject(request.error)
            request.onsuccess = () => resolve()
        })
    }

    async clearAll(): Promise<void> {
        await this.getStore("readwrite")
        await this.clear()
    }

    async drop(): Promise<void> {
        if (this.db) {
            this.db.close()
            this.db = null
        }
        return new Promise((resolve, reject) => {
            const request = indexedDB.deleteDatabase(this.dbName)
            request.onerror = () => reject(request.error)
            request.onsuccess = () => resolve()
        })
    }

    async close(): Promise<void> {
        if (this.db) {
            this.db.close()
            this.db = null
        }
    }

    // --- MongoDB Style Operations ---

    async findMany(filter: ITableFilter, options?: ITableFindOptions): Promise<ITableDoc[]> {
        return this._findInternal(filter, options, false)
    }

    private async _findInternal(filter: ITableFilter, options?: ITableFindOptions, includeHidden = false): Promise<ITableDoc[]> {
        const results: ITableDoc[] = []
        const offset = options?.offset || 0
        const limit = options?.limit || Infinity

        await this.iterateCursor(filter, (doc) => {
            results.push(doc)
            return true
        })

        if (options?.sort) this.applySort(results, options.sort)
        else this.applySort(results, { _id: 1 })

        let finalDocs = results
        if (offset > 0 || limit !== Infinity) {
            finalDocs = results.slice(offset, offset + limit)
        }

        const proj = normalizeProjection(options?.projection)

        let isOnlyIdInclusion = false
        if (proj) {
            const keys = Object.keys(proj)
            isOnlyIdInclusion = keys.length === 1 && keys[0] === "_id" && proj._id === 1
        }

        return finalDocs.map(d => {
            if (isOnlyIdInclusion) return d

            const p = project(d, proj)
            if (!includeHidden && !(proj && proj._id === 1)) delete (p as any)._id
            return p as ITableDoc
        })
    }

    async findOne(filter: ITableFilter, options?: ITableFindOptions): Promise<ITableDoc | void> {
        const docs = await this.findMany(filter, { ...options, limit: 1 })
        return docs[0]
    }

    async updateOne(
        filter: ITableFilter,
        updateOp: ITableUpdateOp<ITableDoc>,
        options?: ITableUpdateOptions
    ): Promise<ITableUpdateResult> {
        // 使用内部方法以保留 _id
        const docs = await this._findInternal(filter, { sort: options?.sort, limit: 1 }, true)
        const doc = docs[0]
        if (doc) {
            const modified = applyUpdate(doc, updateOp)
            if (modified) await this.set(doc.id, doc)
            return { matchedCount: 1, modifiedCount: modified ? 1 : 0, upsertedIds: [] }
        } else if (options?.upsert) {
            const newId = await this.performUpsert(filter, updateOp)
            return { matchedCount: 0, modifiedCount: 0, upsertedIds: [newId] }
        }
        return { matchedCount: 0, modifiedCount: 0, upsertedIds: [] }
    }

    async updateMany(
        filter: ITableFilter,
        updateOp: ITableUpdateOp<ITableDoc>,
        options?: ITableUpdateOptions
    ): Promise<ITableUpdateResult> {
        let matchedCount = 0
        let modifiedCount = 0
        // 使用内部方法以保留 _id
        const docs = await this._findInternal(filter, {}, true)

        for (const doc of docs) {
            matchedCount++
            const modified = applyUpdate(doc, updateOp)
            if (modified) {
                await this.set(doc.id, doc)
                modifiedCount++
            }
        }

        if (matchedCount === 0 && options?.upsert) {
            const newId = await this.performUpsert(filter, updateOp)
            return { matchedCount: 0, modifiedCount: 0, upsertedIds: [newId] }
        }

        return { matchedCount, modifiedCount, upsertedIds: [] }
    }

    async bulkUpdate(
        updates: { filter: ITableFilter; updateOp: ITableUpdateOp<ITableDoc>; options?: ITableUpdateOptions }[]
    ): Promise<ITableUpdateResult> {
        let matchedCount = 0
        let modifiedCount = 0
        const upsertedIds: any[] = []

        for (const update of updates) {
            const res = await this.updateOne(update.filter, update.updateOp, update.options)
            matchedCount += res.matchedCount
            modifiedCount += res.modifiedCount
            if (res.upsertedIds) upsertedIds.push(...res.upsertedIds)
        }

        return { matchedCount, modifiedCount, upsertedIds }
    }

    async insertMany(docs: Partial<ITableDoc>[]): Promise<ITableInsertResult> {
        const result: ITableInsertResult = { insertedCount: 0, skippedCount: 0, insertedIds: [], skippedIds: [] }
        const store = await this.getStore("readwrite")

        for (const doc of docs) {
            const docId = doc.id || this.generateId()
            const normalizedDoc = this.normalizeUndefined(doc)
            try {
                await new Promise<void>((resolve, reject) => {
                    const finalDoc = { _id: (doc as any)._id || this.generateId(), ...normalizedDoc, id: docId }
                    const request = store.add(finalDoc)
                    request.onerror = (e) => { e.preventDefault(); e.stopPropagation(); reject(request.error) }
                    request.onsuccess = () => resolve()
                })
                result.insertedCount++; result.insertedIds.push(docId)
            } catch (err: any) {
                if (err.name === "ConstraintError") { result.skippedCount++; result.skippedIds.push(docId) }
                else throw err
            }
        }
        return result
    }

    async setMany(docs: Partial<ITableDoc>[], options?: ITableSetOptions): Promise<ITableSetResult> {
        const result: ITableSetResult = { insertedCount: 0, overwriteCount: 0, insertedIds: [] }
        for (const doc of docs) {
            const existing = await this.get(doc.id)
            if (existing) {
                if (options?.insertOnly) continue
                let finalDoc = existing
                if (options?.overwrite) finalDoc = { ...doc, id: existing.id } as ITableDoc
                else if (options?.merge) deepMergeWithArrayUnion(finalDoc, doc)
                else applyUpdate(finalDoc, { $set: doc })
                await this.set(finalDoc.id, finalDoc)
                result.overwriteCount++
            } else {
                if (options?.updateOnly) continue
                // 如果有 setOnInsert 选项，在插入新文档时合并这些字段
                const finalDoc = options?.setOnInsert ? { ...options.setOnInsert, ...doc } : doc
                await this.set(finalDoc.id, finalDoc)
                result.insertedCount++; result.insertedIds.push(doc.id)
            }
        }
        return result
    }

    async deleteMany(filter: ITableFilter, options?: ITableDeleteOptions): Promise<ITableDeletedResult> {
        let deletedCount = 0
        const docs = await this.findMany(filter, { sort: options?.sort })
        const store = await this.getStore("readwrite")
        for (const doc of docs) {
            await new Promise<void>((resolve, reject) => {
                const request = store.delete(doc.id)
                request.onerror = () => reject(request.error); request.onsuccess = () => resolve()
            })
            deletedCount++
        }
        return { deletedCount }
    }

    async deleteOne(filter: ITableFilter, options?: ITableDeleteOptions): Promise<ITableDeletedResult> {
        const doc = await this.findOne(filter, { sort: options?.sort })
        if (doc) { await this.delete(doc.id); return { deletedCount: 1 } }
        return { deletedCount: 0 }
    }

    async defineIndexes(indexes: ITableIndexConfig[], options?: ITableDefineIndexesOptions): Promise<void> {
        if (!this.db) await this.init()

        // 确保表已存在
        await this.getStore("readonly")

        const store = this.db!.transaction(this.tableName, "readonly").objectStore(this.tableName)
        let needsUpgrade = false
        for (const idx of indexes) {
            const name = idx.name || (typeof idx.key === "string" ? idx.key : Object.keys(idx.key).join("_"))
            if (idx.disabled) { if (store.indexNames.contains(name)) { needsUpgrade = true; break } }
            else { if (!store.indexNames.contains(name)) { needsUpgrade = true; break } }
        }

        if (needsUpgrade || options?.rebuild) {
            const newVersion = this.db!.version + 1
            this.db!.close(); this.db = null
            this.db = await new Promise<IDBDatabase>((resolve, reject) => {
                const request = indexedDB.open(this.dbName, newVersion)
                request.onerror = () => reject(request.error)
                request.onsuccess = () => {
                    const db = request.result
                    db.onversionchange = () => { db.close(); this.db = null }
                    resolve(db)
                }
                request.onupgradeneeded = () => {
                    const db = request.result
                    const store = request.transaction!.objectStore(this.tableName)
                    if (options?.rebuild) Array.from(store.indexNames).forEach(name => store.deleteIndex(name))
                    for (const idx of indexes) {
                        const name = idx.name || (typeof idx.key === "string" ? idx.key : Object.keys(idx.key).join("_"))
                        if (idx.disabled) { if (store.indexNames.contains(name)) store.deleteIndex(name) }
                        else if (!store.indexNames.contains(name)) {
                            const keyPath = typeof idx.key === "string" ? idx.key : Object.keys(idx.key)
                            store.createIndex(name, keyPath, { unique: idx.unique })
                        }
                    }
                }
            })
            this.version = this.db!.version
        }
    }

    async dropIndexes(): Promise<void> {
        if (!this.db) await this.init()
        const store = this.db!.transaction(this.tableName, "readonly").objectStore(this.tableName)
        if (store.indexNames.length === 0) return
        const newVersion = this.db!.version + 1
        this.db!.close(); this.db = null
        this.db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(this.dbName, newVersion)
            request.onerror = () => reject(request.error)
            request.onsuccess = () => {
                const db = request.result
                db.onversionchange = () => { db.close(); this.db = null }
                resolve(db)
            }
            request.onupgradeneeded = () => {
                const store = request.transaction!.objectStore(this.tableName)
                Array.from(store.indexNames).forEach(name => store.deleteIndex(name))
            }
        })
        this.version = this.db!.version
    }

    async compact(): Promise<void> { }

    private async performUpsert(filter: ITableFilter, updateOp: ITableUpdateOp<ITableDoc>): Promise<string> {
        const newDoc: any = { id: (filter as any).id || String(this.generateId()) }
        for (const key in filter) { if (key !== "id" && !key.startsWith("$")) newDoc[key] = (filter as any)[key] }
        applyUpdate(newDoc, updateOp)
        if (updateOp.$setOnInsert) applyUpdate(newDoc, { $set: updateOp.$setOnInsert })
        await this.set(newDoc.id, newDoc)
        return newDoc.id
    }

    private async iterateCursor(filter: ITableFilter, callback: (doc: ITableDoc) => boolean | void): Promise<void> {
        const store = await this.getStore()
        return new Promise((resolve, reject) => {
            const request = store.openCursor()
            request.onerror = () => reject(request.error)
            request.onsuccess = (event: any) => {
                const cursor = event.target.result
                if (cursor) {
                    if (matches(cursor.value, filter)) {
                        // 恢复特殊类型（如 Error）
                        const restoredDoc = this.restoreSpecialTypes(cursor.value)
                        if (callback(restoredDoc) === false) { resolve(); return }
                    }
                    cursor.continue()
                } else resolve()
            }
        })
    }

    private applySort(docs: ITableDoc[], sort: string[] | Record<string, 1 | -1>) {
        const criteria: Array<{ key: string, dir: number }> = []
        if (Array.isArray(sort)) {
            for (const s of sort) { if (s.startsWith("-")) criteria.push({ key: s.substring(1), dir: -1 }); else criteria.push({ key: s, dir: 1 }) }
        } else { for (const [k, v] of Object.entries(sort)) criteria.push({ key: k, dir: v as number }) }
        docs.sort((a, b) => {
            for (const { key, dir } of criteria) {
                const va = a[key], vb = b[key]
                if (va === vb) continue
                // 处理 null/undefined 情况：null/undefined 排在最后
                if (va == null && vb == null) continue
                if (va == null) return dir
                if (vb == null) return -dir
                return (va > vb) ? dir : -dir
            }
            return 0
        })
    }
}
