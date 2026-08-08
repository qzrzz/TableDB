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
 *    - 实例级操作串行化队列：同一实例上的所有操作（含 schema 初始化异步触发的
 *      defineIndexes）排队执行，避免并发升级互相 close/置空共享连接。
 * 
 * 3. 混合查询策略:
 *    - 无 sort 或按 _id 排序时，利用内部 _id 索引游标按 _id 序遍历，
 *      支持收集 offset+limit 后提前终止（listPaging/游标分页的高频场景）。
 *    - 对于复杂查询/非 _id 排序，使用游标 (Cursor) 遍历并在内存中进行 matches 匹配。
 * 
 * 4. 兼容性:
 *    - _id: 为每个文档维护一个虚拟的 _id（秒级时间戳 + 单调计数器），
 *      写入时复用已存在文档的 _id 保证其稳定（游标分页依赖）。
 *    - undefined 规范化: 将 undefined 转换为 null，保持与其他适配器行为一致。
 */

/**
 * 内部保留的 _id 索引名称（用于无 sort 时按 _id 自然序遍历）
 * 采用 __ 前缀避免与用户 defineIndexes 的索引名冲突
 */
const ID_INDEX_NAME = "__tableDb_id_index__"

export function IndexedDBAdapter(config: { dbName: string }): ITableDBAdapter {
    return {
        name: "IndexedDBAdapter",
        async useAdapterInstance(tableName: string): Promise<ITableDBAdapterInstance> {
            const instance = new IndexedDBAdapterInstance(config.dbName, tableName)
            await instance.init()
            // 用 Proxy 包装：所有公共方法调用通过实例级操作队列串行执行。
            // 背景：schema 初始化会异步(fire-and-forget)调用 defineIndexes，
            // 若不串行化，它与 clearAll 等操作会在同一实例上并发执行升级，
            // 两个 upgradeDatabase 互相 close/置空共享的 this.db，导致连接状态错乱。
            return new Proxy(instance, {
                get(target, prop, receiver) {
                    const value = Reflect.get(target, prop, receiver)
                    if (typeof value !== "function") return value
                    if (prop === "init" || prop === "enqueue") return value
                    return (...args: any[]) => target.enqueue(() => value.apply(target, args))
                },
            }) as ITableDBAdapterInstance
        },
    }
}

class IndexedDBAdapterInstance implements ITableDBAdapterInstance {
    name = "IndexedDBAdapter"
    private db: IDBDatabase | null = null
    private version: number = 0
    private initPromise: Promise<void> | null = null
    /** 当前连接是否已确认内部 _id 索引存在（每个新连接重新检查一次） */
    private idIndexEnsured = false
    /** 操作串行化队列：同一实例上的操作排队执行，避免并发升级交错 */
    private opQueue: Promise<unknown> = Promise.resolve()

    constructor(private dbName: string, public tableName: string) { }

    /** 将操作加入串行队列执行（队列吞掉错误，避免单条失败阻塞后续操作）
     *  注：必须为 public，useAdapterInstance 的 Proxy 包装需要访问它 */
    enqueue<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.opQueue.then(fn)
        this.opQueue = run.then(() => undefined, () => undefined)
        return run
    }

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

    private openDB(version?: number, upgrader?: (db: IDBDatabase, tx: IDBTransaction) => void): Promise<IDBDatabase> {
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
                // 新连接需要重新确认 _id 索引
                this.idIndexEnsured = false
                resolve(db)
            }
            request.onupgradeneeded = () => {
                const db = request.result
                const tx = request.transaction!
                // 确保当前表存在（如果表已被 drop，这里会重建）
                if (!db.objectStoreNames.contains(this.tableName)) {
                    const store = db.createObjectStore(this.tableName, { keyPath: "id" })
                    // 新表直接创建内部 _id 索引（每个文档都有 _id，用于无 sort 时的自然序遍历）
                    store.createIndex(ID_INDEX_NAME, "_id")
                } else {
                    // 老表升级：补建缺失的内部 _id 索引
                    const store = tx.objectStore(this.tableName)
                    if (!store.indexNames.contains(ID_INDEX_NAME)) {
                        store.createIndex(ID_INDEX_NAME, "_id")
                    }
                }
                upgrader?.(db, tx)
            }
        })
    }

    /**
     * 执行一次数据库版本升级（创建表/索引/删表等），带并发竞争重试。
     *
     * 关键点：升级失败（VersionError，说明其他实例已抢先升级）后，
     * 重新打开连接读取数据库的真实版本号再重试，
     * 避免拿着过期的本地版本号导致无限失败循环。
     */
    private async upgradeDatabase(upgrader: (db: IDBDatabase, tx: IDBTransaction) => void): Promise<void> {
        for (let attempt = 0; attempt < 20; attempt++) {
            if (!this.db) await this.init()
            const newVersion = this.db!.version + 1
            this.db!.close()
            this.db = null
            try {
                this.db = await this.openDB(newVersion, upgrader)
                this.version = this.db!.version
                return
            } catch (e: any) {
                // 升级失败（版本竞争或升级事务 abort）：等待后重试，
                // 重试时 init() 会重新打开连接，拿到最新版本号
                if (e?.name === "VersionError" || e?.name === "AbortError") {
                    await new Promise(resolve => setTimeout(resolve, 20))
                    continue
                }
                throw e
            }
        }
        throw new Error(`[IndexedDBAdapter] 数据库升级失败，已重试 20 次`)
    }

    private async getStore(mode: IDBTransactionMode = "readonly"): Promise<IDBObjectStore> {
        while (true) {
            if (!this.db) await this.init()
            // 防御：并发 versionchange（来自其他实例的升级）可能在 init 刚完成后
            // 把连接置空，此时重试一轮而不是直接访问 null 连接
            if (!this.db) continue
            try {
                if (this.db!.objectStoreNames.contains(this.tableName)) {
                    // 每个连接只检查一次：确保内部 _id 索引存在（老库首次使用需要升级补建）
                    if (!this.idIndexEnsured) {
                        const hasIndex = this.db!
                            .transaction(this.tableName, "readonly")
                            .objectStore(this.tableName)
                            .indexNames.contains(ID_INDEX_NAME)
                        if (!hasIndex) {
                            // 升级补建 _id 索引（upgradeDatabase 会 close 旧连接并重开）
                            this.db!.close()
                            this.db = null
                            await this.upgradeDatabase((db, tx) => {
                                const store = tx.objectStore(this.tableName)
                                if (!store.indexNames.contains(ID_INDEX_NAME)) {
                                    store.createIndex(ID_INDEX_NAME, "_id")
                                }
                            })
                            continue
                        }
                        this.idIndexEnsured = true
                    }
                    const transaction = this.db!.transaction(this.tableName, mode)
                    return transaction.objectStore(this.tableName)
                }
            } catch (e: any) {
                // 连接已被 onversionchange 关闭（此时 objectStoreNames 访问会抛 InvalidStateError）
                // 或并发升级导致事务失效：置空连接后重试
                if (e.name === "InvalidStateError" || e.name === "TransactionInactiveError") {
                    this.db = null
                    continue
                }
                throw e
            }

            // 表不存在，尝试升级创建
            await this.reopenForTable()
        }
    }

    private async reopenForTable() {
        if (this.db && this.db.objectStoreNames.contains(this.tableName)) return
        // 表不存在：升级数据库创建表（upgradeDatabase 内部自动处理版本竞争重试）
        await this.upgradeDatabase(() => {})
    }

    private static _idCounter = 0
    private generateId(): number {
        // 高位为秒级时间戳，低位为单调计数器（每秒最多 100 万个，实际不可能达到）。
        // 修复原实现 Date.now()*1000 + counter%1000 的问题：
        // 同一毫秒内插入超过 1000 条文档时 _id 会重复，导致游标分页（$gt）错乱。
        // Number.MAX_SAFE_INTEGER ≈ 9e15，当前时间戳（秒级 ≈1.75e9）×1e6 ≈ 1.75e15，
        // 距离溢出还有约 285 年的安全边际。
        return Math.floor(Date.now() / 1000) * 1e6 + (IndexedDBAdapterInstance._idCounter++ % 1e6)
    }

    /**
     * 快速检测对象树中是否包含 undefined 值或 Error 对象。
     * 用于 normalizeUndefined 的快速路径：如果没有需要处理的内容，直接返回原对象引用，
     * 避免每次 set 都对文档做一次无谓的全量深拷贝。
     */
    private containsUndefinedOrError(obj: any): boolean {
        if (obj === undefined) return true
        if (obj === null || typeof obj !== "object") return false
        if (obj instanceof Error) return true
        // 特殊类型内部不会包含需要转换的内容，跳过不扫描
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
            return false
        }
        if (Array.isArray(obj)) {
            for (const item of obj) if (this.containsUndefinedOrError(item)) return true
            return false
        }
        const isPlain = obj.constructor === Object || obj.constructor === undefined
        if (!isPlain) return false
        for (const key in obj) {
            if (this.containsUndefinedOrError(obj[key])) return true
        }
        return false
    }

    private normalizeUndefined(obj: any): any {
        if (!this.containsUndefinedOrError(obj)) return obj
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
     * 快速检测对象树中是否存在序列化的 Error（__errorType 标记）。
     * 用于 restoreSpecialTypes 的快速路径：绝大多数文档不含 Error，
     * 检测命中后直接返回原对象，避免每次读取都对文档做全量深拷贝重建。
     */
    private hasErrorType(obj: any): boolean {
        if (obj === null || typeof obj !== "object") return false
        if (obj.__errorType === true) return true
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
            return false
        }
        if (Array.isArray(obj)) {
            for (const item of obj) if (this.hasErrorType(item)) return true
            return false
        }
        for (const key in obj) {
            if (this.hasErrorType(obj[key])) return true
        }
        return false
    }

    /**
     * 恢复从 IndexedDB 取出的数据中的特殊类型（如 Error）
     */
    private restoreSpecialTypes(obj: any): any {
        if (obj === null || obj === undefined) return obj
        if (typeof obj !== "object") return obj

        // 快速路径：对象树中没有序列化 Error 时直接返回原对象，避免无谓深拷贝
        if (!this.hasErrorType(obj)) return obj

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
            const explicitId = (value as any)._id
            if (explicitId !== undefined) {
                // 调用方显式指定了 _id，直接使用
                const doc = { _id: explicitId, ...normalizedValue, id: id }
                const request = store.put(doc)
                request.onerror = () => reject(request.error)
                request.onsuccess = () => resolve()
                return
            }
            // 未指定 _id：先读取已存在文档的 _id 并复用，保证 _id 稳定（
            // 否则 setMany 更新已存在文档时 _id 会每次重新生成，
            // 导致 listPagingByCursor 的游标分页错乱）。文档不存在时生成新 _id。
            const getRequest = store.get(id)
            getRequest.onerror = () => reject(getRequest.error)
            getRequest.onsuccess = () => {
                const existing = getRequest.result
                const doc = { _id: existing?._id ?? this.generateId(), ...normalizedValue, id: id }
                const request = store.put(doc)
                request.onerror = () => reject(request.error)
                request.onsuccess = () => resolve()
            }
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

        // 带条件的计数：专用游标直接计数，不恢复特殊类型（count 只关心数量，
        // 原实现复用 iterateCursor 会对每个匹配文档做全量深拷贝，纯属浪费）
        let count = 0
        const store = await this.getStore()
        await new Promise<void>((resolve, reject) => {
            const request = store.openCursor()
            request.onerror = () => reject(request.error)
            request.onsuccess = (event: any) => {
                const cursor = event.target.result
                if (cursor) {
                    if (matches(cursor.value, filter)) count++
                    cursor.continue()
                } else resolve()
            }
        })
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
        // 清空数据 + 删除所有索引（与 SQLite 适配器 clearAll 行为一致）
        await this.clear()
        await this.dropIndexes()
    }

    async drop(): Promise<void> {
        // 只删除当前表，不能使用 indexedDB.deleteDatabase：
        // 多个表共享同一个 dbName 时，deleteDatabase 会把其他表的数据一并删除。
        // 正确做法是通过版本升级删除当前 ObjectStore。
        if (!this.db) await this.init()
        if (!this.db!.objectStoreNames.contains(this.tableName)) return
        await this.upgradeDatabase((db) => {
            if (db.objectStoreNames.contains(this.tableName)) {
                db.deleteObjectStore(this.tableName)
            }
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
        // limit: 0 按 MongoDB 语义视为不限制（原实现 || Infinity 的行为）
        const limit = options?.limit || Infinity
        const need = limit === Infinity ? Infinity : offset + limit

        if (options?.sort && !this.isSortById(options.sort)) {
            // 非 _id 排序：IndexedDB 索引暂未接入查询，必须全表扫描后在内存中排序
            await this.iterateCursor(filter, (doc) => {
                results.push(doc)
                return true
            })
            this.applySort(results, options.sort)
        } else {
            // 无 sort 或按 _id 排序：走内部 _id 索引游标（天然 _id 升/降序），
            // 收集 offset+limit 条后提前终止，避免全表扫描 + 全量内存排序
            const desc = options?.sort ? this.isSortByIdDesc(options.sort) : false
            await this.iterateCursorByIndex(filter, (doc) => {
                results.push(doc)
                return results.length < need
            }, desc ? "prev" : undefined)
        }

        let finalDocs = results
        if (offset > 0 || limit !== Infinity) {
            finalDocs = results.slice(offset, offset + limit)
        }

        const proj = normalizeProjection(options?.projection as any)

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
            const originalId = doc.id
            const modified = applyUpdate(doc, updateOp)
            if (modified) {
                if (doc.id !== originalId) {
                    // 主键被 $set 改写：同一事务内删除旧 key 再写入新 key，
                    // 避免旧 key 的文档成为孤儿（原实现直接 put 新 key，旧文档残留）
                    await this.replaceId(originalId, doc)
                } else {
                    await this.set(doc.id, doc)
                }
            }
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
        // 单个读写事务完成「收集 → 应用更新 → 写回」：
        // 原实现每个文档一个独立读写事务（N 个事务），且中途失败会留下部分更新；
        // 现在保证原子性并大幅减少事务开销。
        const store = await this.getStore("readwrite")
        const docs = await this.collectMatches(filter, store)

        for (const doc of docs) {
            matchedCount++
            const originalId = doc.id
            const modified = applyUpdate(doc, updateOp)
            if (modified) {
                modifiedCount++
                if (doc.id !== originalId) {
                    // 主键被改写：同事务内删除旧 key + 写入新 key
                    await this.deleteAndPut(store, originalId, doc)
                } else {
                    await this.putDoc(store, doc)
                }
            }
        }

        if (matchedCount === 0 && options?.upsert) {
            const newId = await this.performUpsert(filter, updateOp)
            return { matchedCount: 0, modifiedCount: 0, upsertedIds: [newId] }
        }

        return { matchedCount, modifiedCount, upsertedIds: [] }
    }

    /**
     * 在指定事务（store）内游标收集匹配文档并恢复特殊类型。
     * 供 updateMany 等需要在同一读写事务内读写的场景复用。
     */
    private collectMatches(filter: ITableFilter, store: IDBObjectStore): Promise<ITableDoc[]> {
        const results: ITableDoc[] = []
        return new Promise((resolve, reject) => {
            const request = store.openCursor()
            request.onerror = () => reject(request.error)
            request.onsuccess = (event: any) => {
                const cursor = event.target.result
                if (cursor) {
                    if (matches(cursor.value, filter)) {
                        results.push(this.restoreSpecialTypes(cursor.value))
                    }
                    cursor.continue()
                } else resolve(results)
            }
        })
    }

    /** 在指定事务内写入文档（先 normalizeUndefined） */
    private putDoc(store: IDBObjectStore, doc: any): Promise<void> {
        const normalized = this.normalizeUndefined(doc)
        return new Promise((resolve, reject) => {
            const request = store.put(normalized)
            request.onerror = () => reject(request.error)
            request.onsuccess = () => resolve()
        })
    }

    /** 主键变更场景：在指定事务内先删除旧 key 再写入新文档，保证原子性 */
    private deleteAndPut(store: IDBObjectStore, oldId: any, doc: any): Promise<void> {
        const normalized = this.normalizeUndefined(doc)
        return new Promise((resolve, reject) => {
            const delRequest = store.delete(oldId)
            delRequest.onerror = () => reject(delRequest.error)
            delRequest.onsuccess = () => {
                const putRequest = store.put(normalized)
                putRequest.onerror = () => reject(putRequest.error)
                putRequest.onsuccess = () => resolve()
            }
        })
    }

    /** 主键变更：独立读写事务内删除旧 key + 写入新文档（updateOne/setMany 使用） */
    private async replaceId(oldId: any, doc: any): Promise<void> {
        const store = await this.getStore("readwrite")
        await this.deleteAndPut(store, oldId, doc)
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
            const docId = doc.id !== undefined && doc.id !== null ? doc.id : this.generateId()
            if (typeof docId === "object") {
                // 对象不能作为 IndexedDB 的 keyPath 值，提前给出明确错误
                throw new TypeError(`[IndexedDBAdapter] insertMany: 文档 id 必须是标量值，收到 ${typeof docId}`)
            }
            const normalizedDoc = this.normalizeUndefined(doc)
            try {
                await new Promise<void>((resolve, reject) => {
                    const finalDoc = { _id: (doc as any)._id !== undefined ? (doc as any)._id : this.generateId(), ...normalizedDoc, id: docId }
                    const request = store.add(finalDoc)
                    request.onerror = (e: any) => {
                        if (request.error?.name === "ConstraintError") {
                            // 主键冲突：跳过该文档继续插入其余文档（与 MongoDB insertMany 语义一致）
                            e.preventDefault()
                            e.stopPropagation()
                        }
                        // 其他错误（DataError 等）：不 preventDefault，事务 abort 回滚，保证一致性
                        reject(request.error)
                    }
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
                // 合并/更新可能改写 finalDoc.id（如 doc 中携带了不同的 id 字段）：
                // 此时删除旧 key 再写入新 key，避免旧文档成为孤儿
                if (finalDoc.id !== existing.id) {
                    await this.replaceId(existing.id, finalDoc)
                } else {
                    await this.set(finalDoc.id, finalDoc)
                }
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
        // 单个读写事务内完成「匹配 → 游标删除」：
        // 原实现先 findMany 全量收集（含无谓的类型恢复深拷贝）再逐个 delete，
        // 现在在游标回调中直接 cursor.delete()，一次遍历、一个事务、零拷贝
        let deletedCount = 0
        const store = await this.getStore("readwrite")
        await new Promise<void>((resolve, reject) => {
            const request = store.openCursor()
            request.onerror = () => reject(request.error)
            request.onsuccess = (event: any) => {
                const cursor = event.target.result
                if (cursor) {
                    if (matches(cursor.value, filter)) {
                        cursor.delete()
                        deletedCount++
                    }
                    cursor.continue()
                } else resolve()
            }
        })
        return { deletedCount }
    }

    async deleteOne(filter: ITableFilter, options?: ITableDeleteOptions): Promise<ITableDeletedResult> {
        const doc = await this.findOne(filter, { sort: options?.sort })
        if (doc) { await this.delete(doc.id); return { deletedCount: 1 } }
        return { deletedCount: 0 }
    }

    /** 计算索引名称：显式 name 优先，否则用字段名/复合字段名连接 */
    private indexName(idx: ITableIndexConfig): string {
        return idx.name || (typeof idx.key === "string" ? idx.key : Object.keys(idx.key).join("_"))
    }

    async defineIndexes(indexes: ITableIndexConfig[], options?: ITableDefineIndexesOptions): Promise<void> {
        // 确保表已存在，并拿到 store 检查现有索引（getStore 内部处理连接失效重试）
        const store = await this.getStore("readonly")
        let needsUpgrade = false
        for (const idx of indexes) {
            const name = this.indexName(idx)
            if (idx.disabled) { if (store.indexNames.contains(name)) { needsUpgrade = true; break } }
            else { if (!store.indexNames.contains(name)) { needsUpgrade = true; break } }
        }

        if (needsUpgrade || options?.rebuild) {
            // 版本升级创建/删除索引；upgradeDatabase 内部处理并发升级的版本竞争重试
            await this.upgradeDatabase((db, tx) => {
                const store = tx.objectStore(this.tableName)
                if (options?.rebuild) {
                    // 重建时保留内部 _id 索引（否则 listPaging 的默认 _id 序会失效）
                    Array.from(store.indexNames)
                        .filter(name => name !== ID_INDEX_NAME)
                        .forEach(name => store.deleteIndex(name))
                }
                for (const idx of indexes) {
                    const name = this.indexName(idx)
                    if (idx.disabled) { if (store.indexNames.contains(name)) store.deleteIndex(name) }
                    else if (!store.indexNames.contains(name)) {
                        const keyPath = typeof idx.key === "string" ? idx.key : Object.keys(idx.key)
                        store.createIndex(name, keyPath, { unique: idx.unique })
                    }
                }
            })
        }
    }

    async dropIndexes(): Promise<void> {
        const store = await this.getStore("readonly")
        // 内部 _id 索引不属于用户索引，不删除（listPaging 的默认 _id 序依赖它）
        const userIndexNames = Array.from(store.indexNames).filter(name => name !== ID_INDEX_NAME)
        if (userIndexNames.length === 0) return
        await this.upgradeDatabase((db, tx) => {
            const store = tx.objectStore(this.tableName)
            Array.from(store.indexNames)
                .filter(name => name !== ID_INDEX_NAME)
                .forEach(name => store.deleteIndex(name))
        })
    }

    async compact(): Promise<void> { }

    private async performUpsert(filter: ITableFilter, updateOp: ITableUpdateOp<ITableDoc>): Promise<string> {
        const newDoc: any = {}
        for (const key in filter) {
            if (key === "id" || key.startsWith("$")) continue
            const val = (filter as any)[key]
            // 跳过操作符条件（如 {status: {$ne: "x"}}），
            // 避免把操作符对象原样写入新文档污染数据（原实现直接复制）
            if (val !== null && typeof val === "object") {
                if (Object.keys(val).some(k => k.startsWith("$"))) continue
            }
            newDoc[key] = val
        }

        // id 只能取标量相等条件；filter.id 是操作符对象（如 {id: {$gt: 5}}）
        // 或缺失时生成新 id——否则对象 key 会导致 store.put 抛 DataError
        const idFromFilter = (filter as any).id
        const docId =
            idFromFilter !== undefined && idFromFilter !== null && typeof idFromFilter !== "object"
                ? idFromFilter
                : this.generateId()
        newDoc.id = docId

        applyUpdate(newDoc, updateOp)
        if (updateOp.$setOnInsert) applyUpdate(newDoc, { $set: updateOp.$setOnInsert })
        await this.set(newDoc.id, newDoc)
        return newDoc.id
    }

    /** 判断 sort 是否为单字段 _id 排序（可走内部 _id 索引游标） */
    private isSortById(sort: string[] | Record<string, 1 | -1>): boolean {
        if (Array.isArray(sort)) {
            if (sort.length !== 1) return false
            const s = sort[0]
            return s === "_id" || s === "-_id"
        }
        const keys = Object.keys(sort)
        return keys.length === 1 && keys[0] === "_id" && (sort._id === 1 || sort._id === -1)
    }

    /** 判断 _id 排序是否为降序 */
    private isSortByIdDesc(sort: string[] | Record<string, 1 | -1>): boolean {
        if (Array.isArray(sort)) return sort[0] === "-_id"
        return sort._id === -1
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

    /**
     * 按内部 _id 索引游标遍历（天然 _id 升/降序）。
     * 无 sort 时默认的 _id 插入序语义（listPaging 依赖）由索引保证，
     * 同时支持收集足够数量后提前终止，避免全表扫描。
     */
    private async iterateCursorByIndex(
        filter: ITableFilter,
        callback: (doc: ITableDoc) => boolean | void,
        direction?: IDBCursorDirection
    ): Promise<void> {
        const store = await this.getStore()
        return new Promise((resolve, reject) => {
            const request = store.index(ID_INDEX_NAME).openCursor(null, direction)
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
                const cmp = this.compareValues((a as any)[key], (b as any)[key])
                if (cmp === 0) continue
                return cmp * dir
            }
            return 0
        })
    }

    /**
     * 与 matcher.compare 保持一致的比较规则：
     * 游标分页的 `$gt` 过滤走 matcher，排序走这里，两者规则必须同源，
     * 否则分页结果与游标条件会不自洽（原实现直接用 JS 的 >/<，混合类型时行为不同）。
     */
    private compareValues(a: any, b: any): number {
        if (a === b) return 0
        // null/undefined 排在最后（MongoDB 语义：null 不参与大小比较）
        if (a == null && b == null) return 0
        if (a == null) return 1
        if (b == null) return -1
        // Date 按时间戳比较
        if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime()
        if (a instanceof Date) return 1
        if (b instanceof Date) return -1
        // 类型不同：按类型名排序（与 matcher.compare 的 typeof 比较一致）
        const ta = typeof a
        const tb = typeof b
        if (ta !== tb) return ta < tb ? -1 : 1
        return a > b ? 1 : a < b ? -1 : 0
    }
}
