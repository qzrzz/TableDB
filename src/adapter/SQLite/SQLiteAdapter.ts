import { mkdirSync } from "fs"
import { resolve, dirname } from "path"
import { checkAndDecompressDb, compressFile, prepareForCompression } from "./utils/zstdHelper"

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
    ITableDebugResult,
} from "../adapter"
import { ITableFilter, ITableUpdateOp } from "../../core/types"
import { deserialize, serialize, serializeSync, fastDeserialize } from "./utils/serializer"
import { mongoToSql } from "./utils/mongoToSql"
import { matches } from "./utils/matcher"
import { applyUpdate, deepMergeWithArrayUnion } from "./utils/patch"
import { project, normalizeProjection } from "./utils/projection"
import { analyzeQueryCompatibility, SQLITE_VALUE_TYPE } from "./utils/queryAnalysis"
import { getSideTableName, quoteIdentifier, quoteSqlString, sqliteJsonPath } from "./utils/sqlIdentifiers"

// 导入 Driver 抽象层
import {
    ISqliteDatabase,
    ISqliteStatement,
    SqliteDriverType,
    createSqliteDriver,
    createAutoSqliteDriver,
} from "./driver"

/**
 * SQLiteAdapter 机制说明文档
 * ===============================================
 *
 * 核心设计目标：
 * 在 SQLite 上提供高性能、全功能的 MongoDB 风格文档数据库体验。
 *
 * 关键机制 (Key Mechanisms):
 *
 * 1. 侧表倒排索引 (Side Table Inverted Index):
 *    - 问题: 对于数组字段查询 (e.g. { tags: "A" })，SQLite 原生 JSON 函数需要全表扫描。
 *    - 解决: 为数组字段创建辅助表 `_idx_{tableName}_{field}`，存储 `(val, id)` 对。
 *    - 实现: 使用 SQLite Triggers 自动维护侧表数据（Insert/Update/Delete 时自动触发）。
 *    - 效果: 将 Array Containment 查询转化为高效的 SQL `EXISTS` 子查询。
 *
 * 2. 脏字段检测与查询优化 ( Dirty Tracking & Query Optimization):
 *    - 问题: 混合模式 (Hybrid Mode) 虽然万能但较慢，纯 SQL 模式快但可能语义不准确（特别是数组隐式包含）。
 *    - 解决: 维护 `_schema_dirty_{tableName}` 表，记录哪些字段曾经存储过数组或特殊值 (NaN/Null)。
 *    - 策略:
 *      - 如果某字段以前从未存过数组，那么 `{ field: "A" }` 可以安全视为 SQL 相等比较。
 *      - 如果存过数组，则必须回退到 JsMatch 或使用侧表。
 *
 * 3. 混合查询执行 (Hybrid Query Execution):
 *    - 纯 SQL 模式 (SQL Mode): 当 Filter 可以完全无损映射为 SQL 时使用，性能最高。
 *    - 混合模式 (Hybrid Mode): `SELECT ... WHERE (SQL_PreFilter) AND JsMatch(data, filter)`
 *      - 利用 SQL 索引进行粗筛。
 *      - 利用自定义 SQLite 函数 `JsMatch` 在内存中运行 JS 逻辑进行精确匹配。
 *      - 保证了 MongoDB 语义的 100% 兼容性 (Regular Expressions, $where, complex logic)。
 *
 * 4. 批量操作优化:
 *    - 批量插入优化: 临时禁用侧表 Trigger -> 批量插入数据 -> 批量 Rebuild 侧表 -> 恢复 Trigger。
 *    - 批量更新优化 (bulkUpdateSync): 在单个事务中执行所有操作，减少 I/O 和上下文切换。
 *
 * 5. 多驱动支持 (Multi-Driver Support):
 *    - 支持 better-sqlite3 和 node:sqlite (Node.js 22.5+) 两种驱动
 *    - 通过 Driver 抽象层统一 API 差异
 *    - 可通过 config.driver 指定驱动类型，或使用 "auto" 自动选择
 */

/** SQLiteAdapter 配置选项 */
export interface SQLiteAdapterConfig {
    /** 数据库文件路径，":memory:" 表示内存数据库 */
    filename: string
    /**
     * 安全模式配置
     * - false/undefined: synchronous=OFF，性能最高但系统崩溃可能丢数据
     * - true: synchronous=NORMAL，平衡性能和安全
     * - "full": synchronous=FULL，最安全，每次写入都落盘
     */
    safe?: boolean | "full"
    /** 是否启用 ZSTD 压缩（打开文件前解压，关闭文件时压缩） */
    zstd?: boolean
    /**
     * 多进程访问模式
     * 使用 WAL 模式和适当的同步设置，SQLite 可以支持多个进程同时访问同一个数据库文件。
     * 启用 multi 模式后，SQLiteAdapter 将自动配置数据库连接以支持多进程访问：
     * - PRAGMA journal_mode=WAL
     * - PRAGMA busy_timeout=15000
     * 可以与 `safe:true` 一起使用
     */
    multi?: boolean
    /**
     * SQLite 驱动类型
     * - "better-sqlite3": 使用 better-sqlite3（需要安装依赖，兼容性好，支持自定义函数）
     * - "node:sqlite": 使用 Node.js 内置模块（Node.js 22.5+ 无需安装依赖，支持自定义函数）
     * - "bun:sqlite": 使用 Bun 内置模块（仅 Bun 运行时，不支持自定义函数，无法使用混合查询模式）
     * - "auto": 自动选择（Bun 环境用 bun:sqlite，Node 环境优先 better-sqlite3 > node:sqlite）
     *
     * 注意：bun:sqlite 不支持自定义函数，因此无法使用 JsMatch/JsPatch 混合查询模式
     *
     * @default "auto"
     */
    driver?: SqliteDriverType | "auto"
}

export function SQLiteAdapter(config: SQLiteAdapterConfig): ITableDBAdapter {
    let db: ISqliteDatabase
    let driverType: SqliteDriverType
    let activeInstances = 0
    let closePromise: Promise<void> | undefined
    const writeQueue = new WriteQueue()

    function getDb() {
        if (!db) {
            let filename = config.filename
            const isMemory = filename?.startsWith(":memory:")

            // 如果是文件路径，确保目录存在
            if (isMemory === false) {
                try {
                    const resolvedPath = resolve(filename)
                    const dir = dirname(resolvedPath)
                    mkdirSync(dir, { recursive: true })

                    // ZSTD 解压：在打开数据库前检查并解压 .zst 文件
                    if (config.zstd) {
                        checkAndDecompressDb(filename)
                    }
                } catch (error) {
                    console.warn(`Warning: Could not ensure directory exists for ${filename}:`, error)
                }
            }

            // 根据配置选择驱动
            const synchronous: "FULL" | "NORMAL" | "OFF" = config.safe === "full" ? "FULL" : config.safe ? "NORMAL" : "OFF"
            const driverConfig = {
                filename,
                walMode: config.multi === true,
                // 同进程的同步 SQLite 连接不能长时间阻塞事件循环；锁竞争交给下方异步退避处理。
                busyTimeout: config.multi ? 10 : undefined,
                synchronous,
            }

            if (config.driver === "auto" || !config.driver) {
                // 自动选择驱动
                const result = createAutoSqliteDriver(driverConfig)
                db = result.db
                driverType = result.type
            } else {
                // 使用指定的驱动
                db = createSqliteDriver(config.driver, driverConfig)
                driverType = config.driver
            }

            console.log(`[SQLiteAdapter] using driver: ${driverType}`)

            // bun:sqlite 不支持自定义函数，查询和更新会拒绝无法完整映射的操作。
            if (driverType === "bun:sqlite") {
                console.warn(
                    "[SQLiteAdapter] bun:sqlite 不支持自定义函数，" +
                        "将无法使用混合查询模式 (JsMatch/JsPatch)，不兼容操作会直接报错。",
                )
            } else {
                registerCustomFunctions(db)
            }
        }
        return db
    }

    async function closeSharedDatabase() {
        activeInstances = Math.max(0, activeInstances - 1)
        if (activeInstances !== 0 || closePromise || !db?.isOpen) return closePromise
        closePromise = (async () => {
            const shouldCompress = config.zstd && config.filename && !config.filename.startsWith(":memory:")
            if (shouldCompress) prepareForCompression(db)
            db.close()
            if (shouldCompress) await compressFile(config.filename)
        })()
        return closePromise
    }

    const Adapter: ITableDBAdapter = {
        name: "SQLiteAdapter",
        async useAdapterInstance(tableName: string): Promise<ITableDBAdapterInstance> {
            const database = getDb()
            activeInstances++
            return new SQLiteAdapterInstance(database, tableName, config, driverType, writeQueue, closeSharedDatabase)
        },
    }
    return Adapter
}

/**
 * 注册自定义 SQLite 函数
 *
 * @param db SQLite 数据库实例（支持 better-sqlite3 和 node:sqlite）
 */
function registerCustomFunctions(db: ISqliteDatabase) {
    let cachedFilterJson: string | undefined
    let cachedFilter: any
    /**
     * JsMatch: 内存匹配函数
     * 用于 Hybrid 模式，在 SQL 筛选后进行最终的 MongoDB 语义验证。
     */
    db.function("JsMatch", (docJson: any, idVal: any, filterJson: any) => {
        if (!docJson) return 0
        try {
            const doc = deserialize(JSON.parse(docJson))
            doc._id = idVal
            if (filterJson !== cachedFilterJson) {
                cachedFilterJson = filterJson
                cachedFilter = deserialize(JSON.parse(filterJson))
            }
            return matches(doc, cachedFilter) ? 1 : 0
        } catch (e) {
            // 自定义函数异常不能伪装成“不匹配”，否则查询会静默丢数据。
            throw e
        }
    })

    /**
     * JsPatch: 内存更新函数
     * 用于在 SQL UPDATE 语句中直接执行 MongoDB 风格的 Update Operator ($set, $push 等)。
     * 避免了 "Read to JS -> Modify -> Write back" 的往返开销（在部分场景下）。
     */
    db.function("JsPatch", (docJson: any, opJson: any) => {
        if (!docJson) return null
        try {
            const doc = deserialize(JSON.parse(docJson))
            const op = deserialize(JSON.parse(opJson))
            applyUpdate(doc, op)
            // 必须使用同步序列化器，因为 SQLite 自定义函数必须同步返回
            return JSON.stringify(serializeSync(doc))
        } catch (e) {
            // 更新函数异常必须中断当前 SQL/事务，避免返回未修改文档却报告成功。
            throw e
        }
    })
}

/**
 * 写入队列类
 * 用于串行化异步的数据库写入操作，防止并发冲突
 */
class WriteQueue {
    private promise: Promise<void> = Promise.resolve();

    /**
     * 向队列中添加一个异步写入任务
     * @param fn 要执行的异步任务函数
     * @returns 返回任务执行结果的 Promise
     */
    async add<T>(fn: () => Promise<T>): Promise<T> {
        const next = this.promise.then(fn);
        this.promise = next.then(() => {}, () => {});
        return next;
    }
}


export class SQLiteAdapterInstance implements ITableDBAdapterInstance {
    name = "SQLiteAdapter"
    private statementCache = new Map<string, ISqliteStatement>()
    private indexedFields = new Set<string>()
    // 脏字段缓存: path -> { hasArray: boolean; hasSpecial: boolean }
    // 用于指导查询分析器选择最佳策略
    private dirtyFieldCache = new Map<string, { hasArray: boolean; hasSpecial: boolean; typeMask: number }>()
    // 是否支持自定义函数（JsMatch/JsPatch）
    // bun:sqlite 不支持混合模式，因此不兼容操作会在执行前明确报错
    private supportsCustomFunctions: boolean

    private inTransaction = false
    private closed = false

    private get tableSql() {
        return quoteIdentifier(this.tableName)
    }

    private get dirtyTableSql() {
        return quoteIdentifier(`_schema_dirty_${this.tableName}`)
    }

    private async runInImmediateTransaction<T>(fn: () => Promise<T>): Promise<T> {
        // 同一实例的嵌套事务直接复用外层事务，避免 BEGIN 嵌套和队列死锁。
        if (this.inTransaction) return fn()

        let retries = 0
        const retryDeadline = Date.now() + 5000
        while (true) {
            try {
                this.db.prepare("BEGIN IMMEDIATE").run()
                break
            } catch (err: any) {
                const isBusy = err.code === "SQLITE_BUSY" || err.message?.includes("database is locked")
                if (isBusy && Date.now() < retryDeadline) {
                    retries++
                    // 短暂让出事件循环，使同进程中持锁的异步事务有机会提交。
                    const delay = Math.min(50, 2 ** Math.min(retries, 5) + Math.random() * 5)
                    await new Promise((resolve) => setTimeout(resolve, delay))
                    continue
                }
                throw err
            }
        }

        this.inTransaction = true
        try {
            const res = await fn()
            this.db.prepare("COMMIT").run()
            return res
        } catch (err) {
            try {
                this.db.prepare("ROLLBACK").run()
            } catch {}
            throw err
        } finally {
            this.inTransaction = false
        }
    }

    async runTransaction<T>(fn: () => Promise<T>): Promise<T> {
        if (this.inTransaction) return fn()
        return this.writeQueue.add(async () => {
            return this.runInImmediateTransaction(fn)
        })
    }

    constructor(
        private db: ISqliteDatabase,
        private tableName: string,
        private config: SQLiteAdapterConfig,
        private driverType: SqliteDriverType = "better-sqlite3",
        private writeQueue: WriteQueue,
        private closeSharedDatabase?: () => Promise<void>,
    ) {
        // bun:sqlite 不支持自定义函数
        this.supportsCustomFunctions = driverType !== "bun:sqlite"

        // 1. 确保存储表存在
        this.getStatement(
            `
            CREATE TABLE IF NOT EXISTS ${quoteIdentifier(tableName)} (
                _id INTEGER PRIMARY KEY AUTOINCREMENT,
                id TEXT UNIQUE,
                data TEXT
            )
        `,
        ).run()

        // 2. 创建 Schema Dirty 记录表
        // 用于记录字段类型特征，优化查询计划
        this.getStatement(
            `
            CREATE TABLE IF NOT EXISTS ${quoteIdentifier(`_schema_dirty_${tableName}`)} (
                path TEXT PRIMARY KEY,
                hasArray INTEGER DEFAULT 0,
                hasSpecial INTEGER DEFAULT 0,
                typeMask INTEGER DEFAULT 0
            )
        `,
        ).run()

        // 兼容旧版本创建的脏字段表，旧记录的 typeMask 为 0，查询会保守回退。
        try {
            this.db.exec(`ALTER TABLE ${this.dirtyTableSql} ADD COLUMN typeMask INTEGER DEFAULT 0`)
        } catch {
            // 字段已存在时 SQLite 会报错，此时无需处理。
        }

        this.loadExistingIndexes()
        this.loadDirtyFields()
    }

    // --- Schema Dirty Tracking ---

    private loadDirtyFields() {
        try {
            const rows = this.getStatement(
                `SELECT path, hasArray, hasSpecial, typeMask FROM ${this.dirtyTableSql}`,
            ).all() as any[]
            for (const row of rows) {
                this.dirtyFieldCache.set(row.path, {
                    hasArray: !!row.hasArray,
                    hasSpecial: !!row.hasSpecial,
                    typeMask: Number(row.typeMask || 0),
                })
            }
        } catch (e) {
            // 忽略表不存在错误（理论上不会发生）
        }
    }

    /** 从共享的脏字段表刷新内存快照，避免多个实例之间使用过期的字段类型信息。 */
    private refreshDirtyFields() {
        this.dirtyFieldCache.clear()
        try {
            const rows = this.getStatement(
                `SELECT path, hasArray, hasSpecial, typeMask FROM ${this.dirtyTableSql}`,
            ).all() as any[]
            for (const row of rows) {
                this.dirtyFieldCache.set(row.path, {
                    hasArray: !!row.hasArray,
                    hasSpecial: !!row.hasSpecial,
                    typeMask: Number(row.typeMask || 0),
                })
            }
        } catch (e) {
            // 元数据表暂时不可用时保留空快照，主查询仍由后续兼容性检查决定策略。
        }
    }

    /**
     * 检查查询是否可以使用纯 SQL 模式
     *
     * 对无法完整映射到 SQL 的查询必须拒绝执行，不能静默退化为全表查询。
     */
    private isQueryCompatible(filter: ITableFilter): boolean {
        const analysis = analyzeQueryCompatibility(filter, this.dirtyFieldCache)
        if (!analysis.compatible && !this.supportsCustomFunctions) {
            throw new Error(
                "[SQLiteAdapter] 当前 SQLite 驱动不支持该查询的完整 MongoDB 语义，请切换到 better-sqlite3 或 node:sqlite 驱动。",
            )
        }
        return analysis.compatible
    }

    private markFieldType(path: string, typeMask: number, type?: "array" | "special") {
        let entry = this.dirtyFieldCache.get(path)
        if (!entry) {
            entry = { hasArray: false, hasSpecial: false, typeMask: 0 }
            this.dirtyFieldCache.set(path, entry)
        }

        let changed = false
        if (type === "array" && !entry.hasArray) {
            entry.hasArray = true
            changed = true
        }
        if (type === "special" && !entry.hasSpecial) {
            entry.hasSpecial = true
            changed = true
        }
        if ((entry.typeMask & typeMask) !== typeMask) {
            entry.typeMask |= typeMask
            changed = true
        }

        if (changed) {
            this.getStatement(
                `
                INSERT INTO ${this.dirtyTableSql} (path, hasArray, hasSpecial, typeMask)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(path) DO UPDATE SET
                    hasArray = MAX(hasArray, excluded.hasArray),
                    hasSpecial = MAX(hasSpecial, excluded.hasSpecial),
                    typeMask = typeMask | excluded.typeMask
            `,
            ).run(path, entry.hasArray ? 1 : 0, entry.hasSpecial ? 1 : 0, entry.typeMask)
        }
    }

    private markFieldDirty(path: string, type: "array" | "special") {
        this.markFieldType(
            path,
            type === "array" ? SQLITE_VALUE_TYPE.ARRAY : SQLITE_VALUE_TYPE.SPECIAL,
            type,
        )
    }

    /**
     * 扫描文档并标记脏字段
     * 在写入文档前调用，用于更新 Schema 统计信息
     */
    private scanAndMarkDirty(doc: any, prefix = "") {
        if (!doc || typeof doc !== "object") return

        for (const key in doc) {
            const val = doc[key]
            const path = prefix ? `${prefix}.${key}` : key

            // 检查特殊值 (null, undefined, NaN, Infinite)
            // 这些值在 SQL 中处理较为棘手，需要 Hybrid 模式兜底
            if (val === null || val === undefined) {
                this.markFieldType(path, SQLITE_VALUE_TYPE.SPECIAL, "special")
                continue
            }
            if (typeof val === "number" && (!Number.isFinite(val) || Number.isNaN(val))) {
                this.markFieldType(path, SQLITE_VALUE_TYPE.SPECIAL, "special")
                continue
            }

            if (Array.isArray(val)) {
                this.markFieldDirty(path, "array")
                // 递归检查数组元素，通常用于 Object Array
                val.forEach((item) => this.scanAndMarkDirty(item, path))
            } else if (typeof val === "string") {
                this.markFieldType(path, SQLITE_VALUE_TYPE.STRING)
            } else if (typeof val === "number") {
                this.markFieldType(path, SQLITE_VALUE_TYPE.NUMBER)
            } else if (typeof val === "boolean") {
                this.markFieldType(path, SQLITE_VALUE_TYPE.BOOLEAN)
            } else if (val instanceof Date) {
                this.markFieldType(path, SQLITE_VALUE_TYPE.DATE)
            } else if (typeof val === "object" && !Buffer.isBuffer(val)) {
                this.markFieldType(path, SQLITE_VALUE_TYPE.OTHER)
                this.scanAndMarkDirty(val, path)
            } else {
                this.markFieldType(path, SQLITE_VALUE_TYPE.OTHER)
            }
        }
    }

    // --- Helper Methods ---

    private loadExistingIndexes() {
        const idxs = this.db
            .prepare(
                `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND name NOT LIKE 'sqlite_autoindex%'`,
            )
            .all(this.tableName) as { name: string; sql: string }[]

        for (const idx of idxs) {
            // 通过解析 SQL 语句判断是否为 JSON 索引
            const match = idx.sql?.match(/json_extract\(data, '\$\.([^']+)'\)/)
            if (match && match[1]) {
                const field = match[1]
                const sideTableName = this.getSideTableName(field)
                // 检查对应的侧表是否存在
                const exists = this.db
                    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
                    .get(sideTableName)

                if (exists) {
                    this.indexedFields.add(field)
                }
            }
        }
    }

    private getStatement(sql: string): ISqliteStatement {
        const cached = this.statementCache.get(sql)
        if (cached) return cached
        // 分页、排序和动态 SQL 会不断产生新语句，限制缓存避免长期运行时无界增长。
        if (this.statementCache.size >= 512) {
            const oldest = this.statementCache.keys().next().value
            if (oldest) this.statementCache.delete(oldest)
        }
        const stmt = this.db.prepare(sql)
        this.statementCache.set(sql, stmt)
        return stmt
    }

    /**
     * 数据规范化：处理 undefined 和特殊对象类型
     * - undefined -> null (JSON 标准)
     * - 保留 Map, Set, Date, BigInt, Blob 等特殊类型 (Serializer 会处理)
     */
    private normalizeUndefined(obj: any): any {
        if (obj === undefined) return null
        if (obj === null) return null
        if (typeof obj !== "object") return obj

        // 保留特殊类型，不进行递归转换
        if (
            obj instanceof Map ||
            obj instanceof Set ||
            obj instanceof Date ||
            obj instanceof RegExp ||
            Buffer.isBuffer(obj) ||
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

        // 仅处理普通对象
        const isPlain = obj.constructor === Object || obj.constructor === undefined
        if (!isPlain) {
            return obj
        }

        const normalized: any = {}
        for (const key in obj) {
            normalized[key] = this.normalizeUndefined(obj[key])
        }
        return normalized
    }

    // --- CRUD Operations ---

    async get(id: any): Promise<ITableDoc | void> {
        const row = this.getStatement(`SELECT data FROM ${this.tableSql} WHERE id = ?`).get(String(id)) as
            | { data: string }
            | undefined
        if (!row) return undefined
        return fastDeserialize(row.data)
    }

    async _set(id: any, value: ITableDoc): Promise<void> {
        const normalizedValue = this.normalizeUndefined(value)
        this.scanAndMarkDirty(normalizedValue)
        const sVal = await serialize(normalizedValue)
        this.getStatement(
            `
            INSERT INTO ${this.tableSql} (id, data) VALUES (?, ?)
            ON CONFLICT(id) DO UPDATE SET data=excluded.data
        `,
        ).run(String(id), JSON.stringify(sVal))
    }

    async set(id: any, value: ITableDoc): Promise<void> {
        if (this.inTransaction) {
            await this._set(id, value)
            return
        }
        return this.writeQueue.add(async () => {
            return this.runInImmediateTransaction(async () => {
                await this._set(id, value)
            })
        })
    }

    async _delete(id: any): Promise<void> {
        this.getStatement(`DELETE FROM ${this.tableSql} WHERE id = ?`).run(String(id))
    }

    async delete(id: any): Promise<void> {
        if (this.inTransaction) {
            await this._delete(id)
            return
        }
        return this.writeQueue.add(async () => {
            return this.runInImmediateTransaction(async () => {
                await this._delete(id)
            })
        })
    }

    async has(id: any): Promise<boolean> {
        const row = this.getStatement(`SELECT 1 FROM ${this.tableSql} WHERE id = ?`).get(String(id))
        return !!row
    }

    async count(filter?: ITableFilter, options?: { debug?: ITableDebugResult }): Promise<number> {
        this.refreshDirtyFields()
        let debug: DebugCollector | undefined
        if (options?.debug) debug = new DebugCollector(options.debug)

        if (debug && filter) {
            const analysis = analyzeQueryCompatibility(filter, this.dirtyFieldCache)
            options!.debug!.strategy = analysis.compatible ? "SQL" : "HYBRID"
            options!.debug!.dirtyReasons = analysis.reasons
            debug.setPrepareTime()
        }

        if (!filter || Object.keys(filter).length === 0) {
            if (debug) debug.finish()
            const res = this.getStatement(`SELECT count(*) as count FROM ${this.tableSql}`).get() as {
                count: number
            }
            return res.count
        }

        // 生成 SQL WHERE 子句
        const q = await mongoToSql(
            filter,
            { indexedFields: this.indexedFields, tableName: this.tableName } as any,
            this.dirtyFieldCache,
        )
        const isCompatible = this.isQueryCompatible(filter)

        let sql = ""
        let params = q.params

        if (isCompatible) {
            sql = `SELECT count(*) as count FROM ${this.tableSql} WHERE (${q.where})`
        } else {
            // 混合策略: 先用 SQL 筛选，再用 JsMatch 验证
            sql = `SELECT count(*) as count FROM ${this.tableSql} WHERE (${q.where}) AND JsMatch(data, _id, ?)`
            const sFilter = JSON.stringify(await serialize(filter))
            params = [...params, sFilter]
        }

        if (debug) {
            try {
                const plan = this.getStatement(`EXPLAIN QUERY PLAN ${sql}`).all(...params)
                options!.debug!.sqlPlan = plan as any
                options!.debug!.isFullScan = plan.some(
                    (row: any) => row.detail.includes("SCAN TABLE") && !row.detail.includes("USING INDEX"),
                )
            } catch (e) {}
        }

        const tStart = performance.now()
        const res = this.getStatement(sql).get(...params) as { count: number }
        const tEnd = performance.now()

        if (debug) {
            debug.addSql(sql, params, tEnd - tStart)
            debug.setDbExecTime(tEnd - tStart)
            debug.finish()
        }

        return res.count
    }

    async _clear(): Promise<void> {
        this.getStatement(`DELETE FROM ${this.tableSql}`).run()
    }

    async clear(): Promise<void> {
        return this.writeQueue.add(async () => {
            return this.runInImmediateTransaction(async () => {
                await this._clear()
            })
        })
    }

    async clearAll(): Promise<void> {
        return this.writeQueue.add(async () => {
            return this.runInImmediateTransaction(async () => {
                await this._clear()
                await this._dropIndexes()
            })
        })
    }

    async _drop(): Promise<void> {
        const triggers = this.db
            .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=?")
            .all(this.tableName) as { name: string }[]
        for (const trigger of triggers) {
            this.getStatement(`DROP TRIGGER IF EXISTS ${quoteIdentifier(trigger.name)}`).run()
        }

        // drop 后必须同时清理侧表和字段元数据，否则同名表重建时会继承旧数据。
        const likePrefix = `_idx_${this.tableName}`.replace(/[\\%_]/g, "\\$&") + "_%"
        const sideTables = this.db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE ? ESCAPE '\\'")
            .all(likePrefix) as { name: string }[]
        for (const sideTable of sideTables) {
            this.getStatement(`DROP TABLE IF EXISTS ${quoteIdentifier(sideTable.name)}`).run()
        }
        this.getStatement(`DROP TABLE IF EXISTS ${this.dirtyTableSql}`).run()
        this.getStatement(`DROP TABLE IF EXISTS ${this.tableSql}`).run()
        this.indexedFields.clear()
        this.dirtyFieldCache.clear()
    }

    async drop(): Promise<void> {
        return this.writeQueue.add(async () => {
            return this.runInImmediateTransaction(async () => {
                await this._drop()
            })
        })
    }

    async close(): Promise<void> {
        if (this.closed) return
        this.closed = true
        this.statementCache.clear()
        if (this.closeSharedDatabase) {
            await this.closeSharedDatabase()
        } else if (this.db && this.db.isOpen) {
            const shouldCompress =
                this.config.zstd && this.config.filename && !this.config.filename.startsWith(":memory:")

            // ZSTD 压缩：在关闭前执行 WAL checkpoint，确保所有数据写入主文件
            if (shouldCompress) {
                prepareForCompression(this.db)
            }

            this.db.close()

            // ZSTD 压缩：关闭后压缩数据库文件
            if (shouldCompress) {
                await compressFile(this.config.filename)
            }
        }
    }

    // --- Advanced MongoDB-Style Operations ---

    async findMany(filter: ITableFilter, options?: ITableFindOptions): Promise<ITableDoc[]> {
        this.refreshDirtyFields()
        let isCompatible = true
        let debug: DebugCollector | undefined

        if (options?.debug) {
            debug = new DebugCollector(options.debug)
        }

        if ((options as any)?.skip) {
            throw new Error("skip is not supported, please use limit and offset instead.")
        }

        const q = await mongoToSql(
            filter,
            { ...options, indexedFields: this.indexedFields, tableName: this.tableName } as any,
            this.dirtyFieldCache,
        )

        // 策略分析 (Strategy Analysis)
        if (debug) {
            const analysis = analyzeQueryCompatibility(filter, this.dirtyFieldCache)
            // Bun 驱动不能执行 JsMatch，因此不兼容查询必须在执行前失败。
            if (!this.supportsCustomFunctions && !analysis.compatible) {
                this.isQueryCompatible(filter)
            }
            isCompatible = analysis.compatible
            options!.debug!.strategy = isCompatible ? "SQL" : "HYBRID"
            options!.debug!.dirtyReasons = analysis.reasons
            debug.setPrepareTime()
        } else {
            isCompatible = this.isQueryCompatible(filter)
        }

        let sql = ""
        let params = q.params

        if (isCompatible) {
            // 策略 1: 纯 SQL 模式
            sql = `SELECT _id, data FROM ${this.tableSql} WHERE (${q.where})`
        } else {
            // 策略 2: 混合模式
            sql = `SELECT _id, data FROM ${this.tableSql} WHERE (${q.where}) AND JsMatch(data, _id, ?)`
            const sFilter = JSON.stringify(await serialize(filter))
            params = [...params, sFilter]
        }

        if (q.sort) sql += ` ORDER BY ${q.sort}`
        if (q.limit !== undefined && q.limit !== 0) {
            sql += ` LIMIT ?`
            params = [...params, q.limit]
        } else if (q.offset !== undefined) {
            // SQLite REQUIRE limit implicitly if offset used
            sql += ` LIMIT -1`
        }
        if (q.offset !== undefined) {
            sql += ` OFFSET ?`
            params = [...params, q.offset]
        }

        if (debug) {
            options!.debug!.isSideTableUsed = sql.includes(`_idx_${this.tableName}`)
            try {
                const plan = this.getStatement(`EXPLAIN QUERY PLAN ${sql}`).all(...params)
                options!.debug!.sqlPlan = plan as any
                options!.debug!.isFullScan = plan.some(
                    (row: any) => row.detail.includes("SCAN TABLE") && !row.detail.includes("USING INDEX"),
                )
            } catch (e) {
                /* ignore */
            }
        }

        const stmt = this.getStatement(sql)
        const tStart = performance.now()
        const rows = stmt.all(...params)
        const tEnd = performance.now()

        if (debug) {
            debug.addSql(sql, params, tEnd - tStart)
            debug.setDbExecTime(tEnd - tStart)
        }

        const proj = normalizeProjection(options?.projection as any)

        // 投影优化：如果仅请求 _id，直接返回无需反序列化
        if (proj) {
            const projKeys = Object.keys(proj)
            const isOnlyIdInclusion = projKeys.length === 1 && projKeys[0] === "_id" && proj["_id"] === 1

            if (isOnlyIdInclusion && !(options as any)?.__cursorNeedsFullDocument) {
                const docs = rows.map((r: any) => {
                    return { _id: r._id } as unknown as ITableDoc
                })
                if (debug) debug.finish()
                return docs
            }

            if (isOnlyIdInclusion && (options as any)?.__cursorNeedsFullDocument) {
                const docs = rows.map((r: any) => {
                    const doc = fastDeserialize(r.data)
                    doc._id = r._id
                    return doc
                })
                if (debug) debug.finish()
                return docs
            }
        }

        const docs = rows.map((r: any) => {
            const d = fastDeserialize(r.data)
            d._id = r._id

            // 应用投影：移除不需要的字段
            const p = project(d, proj)
            // 默认行为：移除 _id，除非显式请求
            if (!proj || (proj && !proj._id)) {
                delete p._id
            }
            return p
        })

        if (debug) debug.finish()
        return docs
    }

    async findOne(filter: ITableFilter, options?: ITableFindOptions): Promise<ITableDoc | void> {
        const opts = { ...options, limit: 1 }
        const docs = await this.findMany(filter, opts)
        return docs[0]
    }

    async _updateMany(
        filter: ITableFilter,
        updateOp: ITableUpdateOp<ITableDoc>,
        options?: ITableUpdateOptions,
    ): Promise<ITableUpdateResult> {
        this.refreshDirtyFields()
        let debug: DebugCollector | undefined
        if (options?.debug) debug = new DebugCollector(options.debug)

        if (debug) {
            const analysis = analyzeQueryCompatibility(filter, this.dirtyFieldCache)
            options!.debug!.dirtyReasons = analysis.reasons
            if (!this.supportsCustomFunctions && !analysis.compatible) {
                this.isQueryCompatible(filter)
            }
            const strategyCompatible = analysis.compatible
            options!.debug!.strategy = strategyCompatible ? "SQL" : "HYBRID"
        }

        const q = await mongoToSql(
            filter,
            { ...options, indexedFields: this.indexedFields, tableName: this.tableName } as any,
            this.dirtyFieldCache,
        )
        const isCompatible = this.isQueryCompatible(filter)

        let selectSql = ""
        let params = q.params

        if (isCompatible) {
            selectSql = `SELECT _id, data FROM ${this.tableSql} WHERE (${q.where})`
        } else {
            selectSql = `SELECT _id, data FROM ${this.tableSql} WHERE (${q.where}) AND JsMatch(data, _id, ?)`
            const sFilter = JSON.stringify(await serialize(filter))
            params = [...params, sFilter]
        }

        if (debug) {
            debug.setPrepareTime()
            try {
                const plan = this.getStatement(`EXPLAIN QUERY PLAN ${selectSql}`).all(...params)
                options!.debug!.sqlPlan = plan as any
            } catch (e) {}
            debug.addSql(selectSql, params, 0)
        }

        const rows = this.getStatement(selectSql).all(...params) as { _id: number; data: string }[]

        let modifiedCount = 0
        let matchedCount = 0

        const normalizedOp = this.normalizeUndefined(updateOp)
        const updateStmt = this.getStatement(`UPDATE ${this.tableSql} SET data = ? WHERE _id = ?`)

        // 预处理更新 (外部事务允许异步序列化)
        const updatesToApply: Array<{ _id: number; sDoc: string }> = []

        for (const row of rows) {
            matchedCount++
            try {
                const doc = fastDeserialize(row.data)
                doc._id = row._id
                // 内存应用更新
                const modified = applyUpdate(doc, normalizedOp)
                if (modified) {
                    delete doc._id
                    this.scanAndMarkDirty(doc)
                    // 使用异步序列化，确保支持 Blob 等特殊类型
                    const sData = await serialize(doc)
                    updatesToApply.push({ _id: row._id, sDoc: JSON.stringify(sData) })
                }
            } catch (e) {
                // 批量更新任一行序列化失败都必须让外层事务回滚。
                throw e
            }
        }

        // 事务：批量执行更新
        if (updatesToApply.length > 0) {
            const txBody = () => {
                for (const update of updatesToApply) {
                    updateStmt.run(update.sDoc, update._id)
                    modifiedCount++
                }
            }
            const tStart = performance.now()
            if (this.inTransaction) {
                txBody()
            } else {
                this.db.transaction(txBody)()
            }
            const tEnd = performance.now()
            if (debug) {
                debug.setDbExecTime(tEnd - tStart)
                debug.finish()
            }
        } else if (debug) {
            debug.finish()
        }

        // Upsert 逻辑
        if (matchedCount === 0 && options?.upsert) {
            const newDoc: any = {}
            for (const key in filter) {
                if (key === "id" || key.startsWith("$")) continue
                const val = (filter as any)[key]
                if (val !== null && typeof val === "object") {
                    if (Object.keys(val).some((k) => k.startsWith("$"))) continue
                }
                newDoc[key] = val
            }

            const idFromFilter = (filter as any).id
            if (idFromFilter) newDoc.id = idFromFilter
            else newDoc.id = String(Date.now() + Math.random())

            const normalizedOp = this.normalizeUndefined(updateOp)
            applyUpdate(newDoc, normalizedOp)
            if (normalizedOp.$setOnInsert) {
                const setOnInsertOp = { $set: normalizedOp.$setOnInsert }
                applyUpdate(newDoc, setOnInsertOp)
            }

            await this._set(newDoc.id, newDoc)
            return { matchedCount: 0, modifiedCount: 0, upsertedIds: [newDoc.id] }
        }

        return { matchedCount, modifiedCount, upsertedIds: [] }
    }

    async updateMany(
        filter: ITableFilter,
        updateOp: ITableUpdateOp<ITableDoc>,
        options?: ITableUpdateOptions,
    ): Promise<ITableUpdateResult> {
        if (this.inTransaction) {
            return this._updateMany(filter, updateOp, options)
        }
        return this.writeQueue.add(async () => {
            return this.runInImmediateTransaction(async () => {
                return this._updateMany(filter, updateOp, options)
            })
        })
    }

    async bulkUpdate(
        updates: { filter: ITableFilter; updateOp: ITableUpdateOp<ITableDoc>; options?: ITableUpdateOptions }[],
        options?: { debug?: ITableDebugResult },
    ): Promise<ITableUpdateResult> {
        if (this.inTransaction) {
            let matchedCount = 0
            let modifiedCount = 0
            const upsertedIds: any[] = []
            for (const item of updates) {
                try {
                    const res = await this._updateOne(item.filter, item.updateOp, item.options)
                    matchedCount += res.matchedCount
                    modifiedCount += res.modifiedCount
                    if (res.upsertedIds) {
                        upsertedIds.push(...res.upsertedIds)
                    }
                } catch (e) {
                    throw e
                }
            }
            return { matchedCount, modifiedCount, upsertedIds: upsertedIds.length > 0 ? upsertedIds : undefined }
        }
        return this.writeQueue.add(async () => {
            return this.runInImmediateTransaction(async () => {
                let matchedCount = 0
                let modifiedCount = 0
                const upsertedIds: any[] = []

                let debug: DebugCollector | undefined
                if (options?.debug) debug = new DebugCollector(options.debug)
                if (debug) debug.setPrepareTime()

                const tStart = performance.now()
                // 在 immediate 事务中执行，updateOne 内部改为调用非锁的 _updateOne
                for (const item of updates) {
                    try {
                        const res = await this._updateOne(item.filter, item.updateOp, item.options)
                        matchedCount += res.matchedCount
                        modifiedCount += res.modifiedCount
                        if (res.upsertedIds) {
                            upsertedIds.push(...res.upsertedIds)
                        }
                    } catch (e) {
                        throw e
                    }
                }
                const tEnd = performance.now()

                if (debug) {
                    debug.setDbExecTime(tEnd - tStart)
                    debug.finish()
                }

                return { matchedCount, modifiedCount, upsertedIds: upsertedIds.length > 0 ? upsertedIds : undefined }
            })
        })
    }

    async bulkUpdateSync(
        updates: { filter: ITableFilter; updateOp: ITableUpdateOp<ITableDoc>; options?: ITableUpdateOptions }[],
        options?: { debug?: ITableDebugResult },
    ): Promise<ITableUpdateResult> {
        const execute = async (): Promise<ITableUpdateResult> => {
            this.refreshDirtyFields()
            let matchedCount = 0
        let modifiedCount = 0
        const upsertedIds: any[] = []

        let debug: DebugCollector | undefined
        if (options?.debug) debug = new DebugCollector(options.debug)

        const preparedUpdates: Array<{
            selectSql: string
            params: any[]
            sOp: string
            normalizedOp: any
            options?: ITableUpdateOptions
            filter: ITableFilter
            sUpsertDoc?: string
            upsertId?: string
        }> = []

        const tPrepStart = performance.now()

        // 1. 预处理阶段
        for (const item of updates) {
            const q = await mongoToSql(
                item.filter,
                {
                    sort: item.options?.sort,
                    indexedFields: this.indexedFields,
                    tableName: this.tableName,
                } as any,
                this.dirtyFieldCache,
            )

            q.limit = 1
            const isCompatible = this.isQueryCompatible(item.filter)
            let selectSql = ""
            let params = q.params

            if (isCompatible) {
                selectSql = `SELECT _id, id, data FROM ${this.tableSql} WHERE (${q.where})`
            } else {
                const sFilter = JSON.stringify(await serialize(item.filter))
                selectSql = `SELECT _id, id, data FROM ${this.tableSql} WHERE (${q.where}) AND JsMatch(data, _id, ?)`
                params = [...params, sFilter]
            }

            if (q.sort) selectSql += ` ORDER BY ${q.sort}`
            selectSql += ` LIMIT 1`

            const normalizedOp = this.normalizeUndefined(item.updateOp)
            const sOp = JSON.stringify(await serialize(normalizedOp))

            // 预先准备 Upsert 文档 (如果需要)
            let sUpsertDoc: string | undefined
            let upsertId: string | undefined

            if (item.options?.upsert) {
                const newDoc: any = {}
                // 从 filter 中提取初始字段
                for (const key in item.filter) {
                    if (key === "id" || key.startsWith("$")) continue
                    const val = (item.filter as any)[key]
                    if (val !== null && typeof val === "object") {
                        if (Object.keys(val).some((k) => k.startsWith("$"))) continue
                    }
                    newDoc[key] = val
                }

                const idFromFilter = (item.filter as any).id
                if (idFromFilter) newDoc.id = idFromFilter
                else newDoc.id = String(Date.now() + Math.random()) // 简化的 ID 生成，实际应更健壮

                upsertId = newDoc.id

                // 应用更新
                applyUpdate(newDoc, normalizedOp)
                if (normalizedOp.$setOnInsert) {
                    const setOnInsertOp = { $set: normalizedOp.$setOnInsert }
                    applyUpdate(newDoc, setOnInsertOp)
                }

                // 标记脏字段 & 序列化
                this.scanAndMarkDirty(newDoc)
                sUpsertDoc = JSON.stringify(await serialize(newDoc))
            }

            preparedUpdates.push({
                selectSql,
                params,
                sOp,
                normalizedOp,
                options: item.options,
                filter: item.filter,
                sUpsertDoc, // 预序列化的 upsert 文档
                upsertId,
            })
        }

        if (debug) {
            options!.debug!.prepareTimeMs = performance.now() - tPrepStart
        }

        const tExecStart = performance.now()
        // 2. 执行阶段 (事务中)
        const txBody = () => {
            const insertStmt = this.getStatement(`INSERT INTO ${this.tableSql} (id, data) VALUES (?, ?)`)

            // 根据是否支持自定义函数选择不同的更新策略
            if (this.supportsCustomFunctions) {
                // 使用 JsPatch 进行高效的 SQL 内更新
                const updateStmt = this.getStatement(
                    `UPDATE ${this.tableSql} SET data = JsPatch(data, ?) WHERE _id = ?`,
                )

                for (const prepared of preparedUpdates) {
                    try {
                        const row = this.getStatement(prepared.selectSql).get(...prepared.params)
                        if (row) {
                            // 包含匹配行 -> Update
                            updateStmt.run(prepared.sOp, (row as any)._id)
                            const changedRow = this.getStatement(`SELECT data FROM ${this.tableSql} WHERE _id = ?`).get((row as any)._id) as { data: string }
                            matchedCount++
                            if (!changedRow || changedRow.data !== (row as any).data) modifiedCount++
                            if (changedRow) this.scanAndMarkDirty(fastDeserialize(changedRow.data))
                        } else if (prepared.options?.upsert && prepared.sUpsertDoc && prepared.upsertId) {
                            // 无匹配行且启用了 Upsert -> Insert
                            try {
                                insertStmt.run(prepared.upsertId, prepared.sUpsertDoc)
                                upsertedIds.push(prepared.upsertId)
                            } catch (insertErr) {
                                throw insertErr
                              }
                          }
                      } catch (e) {
                          throw e
                      }
                  }
              } else {
                  // bun:sqlite 不支持 JsPatch，使用读取-修改-写回模式
                  const selectDataStmt = this.getStatement(`SELECT _id, data FROM ${this.tableSql} WHERE _id = ?`)
                  const updateStmt = this.getStatement(`UPDATE ${this.tableSql} SET data = ? WHERE _id = ?`)

                  for (const prepared of preparedUpdates) {
                      try {
                          const row = this.getStatement(prepared.selectSql).get(...prepared.params)
                          if (row) {
                              // 读取完整数据
                              const fullRow = selectDataStmt.get((row as any)._id) as { _id: number; data: string }
                              if (fullRow) {
                                  // 在内存中应用更新
                                  const doc = fastDeserialize(fullRow.data)
                                  const modified = applyUpdate(doc, prepared.normalizedOp)
                                  if (modified) {
                                      const sDoc = JSON.stringify(serializeSync(doc))
                                      updateStmt.run(sDoc, fullRow._id)
                                      modifiedCount++
                                  }
                                  matchedCount++
                              }
                          } else if (prepared.options?.upsert && prepared.sUpsertDoc && prepared.upsertId) {
                              try {
                                  insertStmt.run(prepared.upsertId, prepared.sUpsertDoc)
                                  upsertedIds.push(prepared.upsertId)
                              } catch (insertErr) {
                                  throw insertErr
                              }
                          }
                      } catch (e) {
                          throw e
                      }
                  }
              }
          }

          if (this.inTransaction) {
              txBody()
          } else {
              this.db.transaction(txBody)()
          }
          const tExecEnd = performance.now()

          if (debug) {
              debug.setDbExecTime(tExecEnd - tExecStart)
              debug.finish()
          }

            return { matchedCount, modifiedCount, upsertedIds: upsertedIds.length > 0 ? upsertedIds : undefined }
        }
        if (this.inTransaction) return execute()
        return this.writeQueue.add(() => this.runInImmediateTransaction(execute))
  }

    async _updateOne(
        filter: ITableFilter,
        updateOp: ITableUpdateOp<ITableDoc>,
        options?: ITableUpdateOptions,
    ): Promise<ITableUpdateResult> {
        this.refreshDirtyFields()
        let debug: DebugCollector | undefined
        if (options?.debug) debug = new DebugCollector(options.debug)

        if (debug) {
            const analysis = analyzeQueryCompatibility(filter, this.dirtyFieldCache)
            options!.debug!.dirtyReasons = analysis.reasons
            if (!this.supportsCustomFunctions && !analysis.compatible) {
                this.isQueryCompatible(filter)
            }
            const strategyCompatible = analysis.compatible
            options!.debug!.strategy = strategyCompatible ? "SQL" : "HYBRID"
        }

        const q = await mongoToSql(
            filter,
            { sort: options?.sort, indexedFields: this.indexedFields, tableName: this.tableName } as any,
            this.dirtyFieldCache,
        )
        q.limit = 1

        const isCompatible = this.isQueryCompatible(filter)

        let selectSql = ""
        let params = q.params

        if (isCompatible) {
            selectSql = `SELECT _id, data FROM ${this.tableSql} WHERE (${q.where})`
        } else {
            selectSql = `SELECT _id, data FROM ${this.tableSql} WHERE (${q.where}) AND JsMatch(data, _id, ?)`
            const sFilter = JSON.stringify(await serialize(filter))
            params = [...params, sFilter]
        }

        if (q.sort) selectSql += ` ORDER BY ${q.sort}`
        selectSql += " LIMIT 1"

        if (debug) {
            debug.setPrepareTime()
            try {
                const plan = this.getStatement(`EXPLAIN QUERY PLAN ${selectSql}`).all(...params)
                options!.debug!.sqlPlan = plan as any
            } catch (e) {}
            debug.addSql(selectSql, params)
        }

        const tStart = performance.now()
        const row = this.getStatement(selectSql).get(...params) as { _id: number; data: string }
        const tEnd = performance.now()

        if (debug) debug.setDbExecTime(tEnd - tStart)

        if (!row) {
            // Upsert Logic
            if (options?.upsert) {
                const newDoc: any = {}
                for (const key in filter) {
                    if (key === "id" || key.startsWith("$")) continue
                    const val = (filter as any)[key]
                    if (val !== null && typeof val === "object") {
                        if (Object.keys(val).some((k) => k.startsWith("$"))) continue
                    }
                    newDoc[key] = val
                }

                const idFromFilter = (filter as any).id
                if (idFromFilter) newDoc.id = idFromFilter
                else newDoc.id = String(Date.now() + Math.random())

                const normalizedOp = this.normalizeUndefined(updateOp)
                applyUpdate(newDoc, normalizedOp)
                if (normalizedOp.$setOnInsert) {
                    const setOnInsertOp = { $set: normalizedOp.$setOnInsert }
                    applyUpdate(newDoc, setOnInsertOp)
                }

                if (debug) debug.finish()
                await this._set(newDoc.id, newDoc)
                return { matchedCount: 0, modifiedCount: 0, upsertedIds: [newDoc.id] }
            }
            if (debug) debug.finish()
            return { matchedCount: 0, modifiedCount: 0, upsertedIds: [] }
        }

        let modifiedCount = 0
        try {
            const doc = fastDeserialize(row.data)
            doc._id = row._id

            const normalizedOp = this.normalizeUndefined(updateOp)
            const modified = applyUpdate(doc, normalizedOp)

            if (modified) {
                delete doc._id
                this.scanAndMarkDirty(doc)
                // 使用异步序列化，确保支持 Blob 等特殊类型（新创建的 Blob 没有 _buffer 属性，需要异步调用 arrayBuffer()）
                const sData = await serialize(doc)
                const sDoc = JSON.stringify(sData)
                const upSql = `UPDATE ${this.tableSql} SET data = ? WHERE _id = ?`
                this.getStatement(upSql).run(sDoc, row._id)
                modifiedCount = 1
                if (debug) {
                    debug.addSql(upSql, [sDoc, row._id])
                }
            }
        } catch (e) {
            // 更新异常必须向调用方暴露，否则会伪装成 matched 但未修改。
            throw e
        }

        if (debug) debug.finish()
        return { matchedCount: 1, modifiedCount, upsertedIds: [] }
    }

    async updateOne(
        filter: ITableFilter,
        updateOp: ITableUpdateOp<ITableDoc>,
        options?: ITableUpdateOptions,
    ): Promise<ITableUpdateResult> {
        if (this.inTransaction) {
            return this._updateOne(filter, updateOp, options)
        }
        return this.writeQueue.add(async () => {
            return this.runInImmediateTransaction(async () => {
                return this._updateOne(filter, updateOp, options)
            })
        })
    }

    private static BULK_IMPORT_THRESHOLD = 1000

    async insertMany(docs: ITableDoc[], options?: { debug?: ITableDebugResult }): Promise<ITableInsertResult> {
        if (this.inTransaction) {
            const shouldOptimize = docs.length >= SQLiteAdapterInstance.BULK_IMPORT_THRESHOLD && this.indexedFields.size > 0
            if (shouldOptimize) {
                return this.insertManyOptimized(docs)
            } else {
                return this.insertManyDefault(docs)
            }
        }
        return this.writeQueue.add(async () => {
            let debug: DebugCollector | undefined
            if (options?.debug) debug = new DebugCollector(options.debug)
            if (debug) debug.setPrepareTime()

            const shouldOptimize = docs.length >= SQLiteAdapterInstance.BULK_IMPORT_THRESHOLD && this.indexedFields.size > 0

            const tStart = performance.now()
            let res: ITableInsertResult
            res = await this.runInImmediateTransaction(async () => {
                if (shouldOptimize) return this.insertManyOptimized(docs)
                return this.insertManyDefault(docs)
            })
            const tEnd = performance.now()

            if (debug) {
                options!.debug!.strategy = shouldOptimize ? ("BULK_OPT" as any) : "SQL"
                debug.setDbExecTime(tEnd - tStart)
                debug.finish()
            }
            return res
        })
    }

    /**
     * 默认批量插入实现
     * 使用标准事务通过 INSERT 语句逐条插入
     */
    private async insertManyDefault(docs: ITableDoc[]): Promise<ITableInsertResult> {
        const stmt = this.getStatement(`INSERT INTO ${this.tableSql} (id, data) VALUES (?, ?)`)
        const result: ITableInsertResult = {
            insertedCount: 0,
            skippedCount: 0,
            insertedIds: [],
            skippedIds: [],
        }

        const serializedInfo: { id: string; data: string }[] = []
        for (const doc of docs) {
            const normalizedDoc = this.normalizeUndefined(doc)
            this.scanAndMarkDirty(normalizedDoc)
            const sDoc = await serialize(normalizedDoc)
            const generatedId = doc.id ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`
            serializedInfo.push({ id: String(generatedId), data: JSON.stringify(sDoc) })
        }

        const txBody = (items: { id: string; data: string }[]) => {
            for (const item of items) {
                try {
                    stmt.run(item.id, item.data)
                    result.insertedCount++
                    result.insertedIds.push(item.id)
                } catch (err: any) {
                    // 处理不同驱动的正约束错误
                    const isBetterSqliteConstraint =
                        err.code === "SQLITE_CONSTRAINT_PRIMARYKEY" || err.code === "SQLITE_CONSTRAINT_UNIQUE"
                    const isNodeSqliteConstraint =
                        err.code === "ERR_SQLITE_ERROR" &&
                        (err.errcode === 2067 || err.errcode === 1555 || err.message?.includes("UNIQUE constraint"))

                    if (isBetterSqliteConstraint || isNodeSqliteConstraint) {
                        result.skippedCount++
                        result.skippedIds.push(item.id)
                    } else {
                        throw err
                    }
                }
            }
        }

        if (this.inTransaction) {
            txBody(serializedInfo)
        } else {
            this.db.transaction(txBody)(serializedInfo)
        }
        return result
    }

    /**
     * 高性能批量插入实现
     *
     * 优化机制：
     * 1. 禁用 Trigger: 临时禁用侧表维护触发器。
     * 2. 批量写入: 执行纯数据插入。
     * 3. 批量重建 (Rebuild): 插入完成后，rebuildSideTableIndexes 一次性回填。
     */
    private async insertManyOptimized(docs: ITableDoc[]): Promise<ITableInsertResult> {
        const result: ITableInsertResult = {
            insertedCount: 0,
            skippedCount: 0,
            insertedIds: [],
            skippedIds: [],
        }

        await this.disableSideTableTriggers()

        try {
            const chunkSize = 1000
            for (let i = 0; i < docs.length; i += chunkSize) {
                const chunk = docs.slice(i, i + chunkSize)
                const chunkResult = await this.insertManyDefault(chunk)
                result.insertedCount += chunkResult.insertedCount
                result.skippedCount += chunkResult.skippedCount
                result.insertedIds.push(...chunkResult.insertedIds)
                result.skippedIds.push(...chunkResult.skippedIds)
            }
            await this.rebuildSideTableIndexes()
        } finally {
            await this.enableSideTableTriggers()
        }

        return result
    }

    async _setMany(docs: Partial<ITableDoc>[], options?: ITableSetOptions): Promise<ITableSetResult> {
        let debug: DebugCollector | undefined
        if (options?.debug) debug = new DebugCollector(options.debug)
        if (debug) debug.setPrepareTime()

        const result: ITableSetResult = {
            insertedCount: 0,
            overwriteCount: 0,
            insertedIds: [],
        }

        const preparedDocs: Array<{
            id: string
            serializedData: string
            normalizedDoc: any
            finalSerializedData?: string
        }> = []

        for (const doc of docs) {
            const normalizedDoc = this.normalizeUndefined(doc)
            this.scanAndMarkDirty(normalizedDoc)
            const sDoc = await serialize(normalizedDoc)
            preparedDocs.push({
                id: String(doc.id),
                serializedData: JSON.stringify(sDoc),
                normalizedDoc,
            })
        }

        // 在事务内预先完成合并和异步序列化，避免 txBody 中调用 serializeSync 把新 Blob 当成普通对象。
        const stmtPrepareCheck = this.getStatement(`SELECT data FROM ${this.tableSql} WHERE id = ?`)
        for (const prepared of preparedDocs) {
            const exist = stmtPrepareCheck.get(prepared.id) as { data: string } | undefined
            if (exist) {
                if (options?.insertOnly) continue
                if (options?.overwrite) {
                    prepared.finalSerializedData = prepared.serializedData
                    continue
                }
                const finalDoc = deserialize(JSON.parse(exist.data))
                if (options?.merge) deepMergeWithArrayUnion(finalDoc, prepared.normalizedDoc)
                else applyUpdate(finalDoc, { $set: prepared.normalizedDoc })
                prepared.finalSerializedData = JSON.stringify(await serialize(finalDoc))
            } else if (!options?.updateOnly) {
                const finalDoc = options?.setOnInsert
                    ? { ...options.setOnInsert, ...prepared.normalizedDoc }
                    : prepared.normalizedDoc
                prepared.finalSerializedData = JSON.stringify(await serialize(finalDoc))
            }
        }

        const tStart = performance.now()
        const txBody = () => {
            const stmtCheck = this.getStatement(`SELECT data FROM ${this.tableSql} WHERE id = ?`)
            const stmtUpdate = this.getStatement(`UPDATE ${this.tableSql} SET data = ? WHERE id = ?`)
            const stmtInsert = this.getStatement(`INSERT INTO ${this.tableSql} (id, data) VALUES (?, ?)`)

            for (const prepared of preparedDocs) {
                const { id, serializedData } = prepared
                const exist = stmtCheck.get(id) as { data: string } | undefined

                if (exist) {
                    if (options?.insertOnly) continue

                    // Overwrite 选项优化：直接替换，不进行合并
                    if (options?.overwrite) {
                        stmtUpdate.run(serializedData, id)
                        result.overwriteCount++
                        continue
                    }

                    stmtUpdate.run(prepared.finalSerializedData ?? serializedData, id)
                    result.overwriteCount++
                } else {
                    if (options?.updateOnly) continue

                    stmtInsert.run(id, prepared.finalSerializedData ?? serializedData)
                    result.insertedCount++
                    result.insertedIds.push(id)
                }
            }
        }

        if (this.inTransaction) {
            txBody()
        } else {
            this.db.transaction(txBody)()
        }
        const tEnd = performance.now()

        if (debug) {
            debug.setDbExecTime(tEnd - tStart)
            debug.finish()
        }
        return result
    }

    async setMany(docs: Partial<ITableDoc>[], options?: ITableSetOptions): Promise<ITableSetResult> {
        if (this.inTransaction) {
            return this._setMany(docs, options)
        }
        return this.writeQueue.add(async () => {
            return this.runInImmediateTransaction(async () => {
                return this._setMany(docs, options)
            })
        })
    }

    async _deleteMany(filter: ITableFilter, options?: ITableDeleteOptions): Promise<ITableDeletedResult> {
        this.refreshDirtyFields()
        let debug: DebugCollector | undefined
        if (options?.debug) debug = new DebugCollector(options.debug)

        if (debug) {
            const analysis = analyzeQueryCompatibility(filter, this.dirtyFieldCache)
            options!.debug!.dirtyReasons = analysis.reasons
            if (!this.supportsCustomFunctions && !analysis.compatible) {
                this.isQueryCompatible(filter)
            }
            const strategyCompatible = analysis.compatible
            options!.debug!.strategy = strategyCompatible ? "SQL" : "HYBRID"
        }

        const q = await mongoToSql(
            filter,
            { ...options, indexedFields: this.indexedFields, tableName: this.tableName } as any,
            this.dirtyFieldCache,
        )
        const isCompatible = this.isQueryCompatible(filter)

        let sql = ""
        let params = q.params

        if (isCompatible) {
            sql = `DELETE FROM ${this.tableSql} WHERE (${q.where})`
        } else {
            const sFilter = JSON.stringify(await serialize(filter))
            sql = `DELETE FROM ${this.tableSql} WHERE _id IN (
                SELECT _id FROM ${this.tableSql} WHERE (${q.where}) AND JsMatch(data, _id, ?)
             )`
            params = [...params, sFilter]
        }

        if (debug) {
            debug.setPrepareTime()
            try {
                const plan = this.getStatement(`EXPLAIN QUERY PLAN ${sql}`).all(...params)
                options!.debug!.sqlPlan = plan as any
            } catch (e) {}
        }

        const tStart = performance.now()
        const info = this.getStatement(sql).run(...params)
        const tEnd = performance.now()

        if (debug) {
            debug.addSql(sql, params, tEnd - tStart)
            debug.setDbExecTime(tEnd - tStart)
            debug.finish()
        }
        return { deletedCount: Number(info.changes) }
    }

    async deleteMany(filter: ITableFilter, options?: ITableDeleteOptions): Promise<ITableDeletedResult> {
        if (this.inTransaction) {
            return this._deleteMany(filter, options)
        }
        return this.writeQueue.add(async () => {
            return this.runInImmediateTransaction(async () => {
                return this._deleteMany(filter, options)
            })
        })
    }

    async _deleteOne(filter: ITableFilter, options?: ITableDeleteOptions): Promise<ITableDeletedResult> {
        this.refreshDirtyFields()
        let debug: DebugCollector | undefined
        if (options?.debug) debug = new DebugCollector(options.debug)

        const q = await mongoToSql(
            filter,
            { ...options, limit: 1, indexedFields: this.indexedFields, tableName: this.tableName } as any,
            this.dirtyFieldCache,
        )
        const isCompatible = this.isQueryCompatible(filter)

        let selectSql = ""
        let params = q.params

        // 查找要删除的 ID (从 deleteMany 的子查询逻辑借鉴，但改为 Fetch + Delete 模式以支持 Limit)
        if (isCompatible) {
            selectSql = `SELECT _id FROM ${this.tableSql} WHERE (${q.where})`
        } else {
            const sFilter = JSON.stringify(await serialize(filter))
            selectSql = `SELECT _id FROM ${this.tableSql} WHERE (${q.where}) AND JsMatch(data, _id, ?)`
            params = [...params, sFilter]
        }

        if (q.sort) selectSql += ` ORDER BY ${q.sort}`
        selectSql += " LIMIT 1"

        if (debug) {
            debug.setPrepareTime()
            debug.addSql(selectSql, params)
        }

        const tStart = performance.now()
        const row = this.getStatement(selectSql).get(...params) as { _id: number }

        if (row) {
            const delSql = `DELETE FROM ${this.tableSql} WHERE _id = ?`
            this.getStatement(delSql).run(row._id)
            if (debug) {
                debug.addSql(delSql, [row._id])
                debug.setDbExecTime(performance.now() - tStart)
                debug.finish()
            }
            return { deletedCount: 1 }
        }

        if (debug) {
            debug.setDbExecTime(performance.now() - tStart)
            debug.finish()
        }
        return { deletedCount: 0 }
    }

    async deleteOne(filter: ITableFilter, options?: ITableDeleteOptions): Promise<ITableDeletedResult> {
        if (this.inTransaction) {
            return this._deleteOne(filter, options)
        }
        return this.writeQueue.add(async () => {
            return this.runInImmediateTransaction(async () => {
                return this._deleteOne(filter, options)
            })
        })
    }

    // --- Index Management ---

    async _defineIndexes(indexes: ITableIndexConfig[], options?: ITableDefineIndexesOptions): Promise<void> {
        if (options?.rebuild) {
            await this._dropIndexes()
        }

        for (const idx of indexes) {
            let name = idx.name
            if (!name) {
                if (typeof idx.key === "string") name = `idx_${idx.key}`
                else name = `idx_${Object.keys(idx.key).join("_")}`
            }

            if (idx.disabled) {
                this.getStatement(`DROP INDEX IF EXISTS ${quoteIdentifier(name)}`).run()
                const keys = typeof idx.key === "string" ? { [idx.key]: 1 } : idx.key
                if (Object.keys(keys).length === 1) {
                    this.dropSideTableIndex(Object.keys(keys)[0])
                }
                for (const k in keys) {
                    this.indexedFields.delete(k)
                }
                continue
            }

            const exprs: string[] = []
            const keys = typeof idx.key === "string" ? { [idx.key]: 1 } : idx.key

            for (const [k, dir] of Object.entries(keys)) {
                exprs.push(`json_extract(data, ${quoteSqlString(sqliteJsonPath(k))}) ${dir === 1 ? "ASC" : "DESC"}`)
            }

            const unique = idx.unique ? "UNIQUE" : ""
            const sql = `CREATE ${unique} INDEX IF NOT EXISTS ${quoteIdentifier(name)} ON ${this.tableSql} (${exprs.join(", ")})`

            this.getStatement(sql).run()

            // 如果是单字段索引，自动创建侧表以支持数组查询加速
            if (Object.keys(keys).length === 1) {
                const field = Object.keys(keys)[0]
                this.createSideTableIndex(field)
            }
        }
    }

    async defineIndexes(indexes: ITableIndexConfig[], options?: ITableDefineIndexesOptions): Promise<void> {
        return this.writeQueue.add(async () => {
            return this.runInImmediateTransaction(async () => {
                await this._defineIndexes(indexes, options)
            })
        })
    }

    private getSideTableName(field: string): string {
        return getSideTableName(this.tableName, field)
    }

    private async createSideTableIndex(field: string) {
        const sideTableName = this.getSideTableName(field)
        const sideTableSql = quoteIdentifier(sideTableName)
        const triggerPrefix = `t_${sideTableName}`
        const triggerInsertSql = quoteIdentifier(`${triggerPrefix}_insert`)
        const triggerDeleteSql = quoteIdentifier(`${triggerPrefix}_delete`)
        const triggerUpdateSql = quoteIdentifier(`${triggerPrefix}_update`)
        const jsonPathSql = quoteSqlString(sqliteJsonPath(field))

        this.getStatement(
            `CREATE TABLE IF NOT EXISTS ${sideTableSql} (
                val,
                id,
                PRIMARY KEY (val, id)
            )`,
        ).run()

        const extractArr = `
            SELECT DISTINCT value, NEW.id 
            FROM json_each(NEW.data, ${jsonPathSql})
            WHERE json_type(NEW.data, ${jsonPathSql}) = 'array'
        `
        const extractScalarAndObject = `
            SELECT json_extract(NEW.data, ${jsonPathSql}), NEW.id
            WHERE json_type(NEW.data, ${jsonPathSql}) IS NOT 'array'
              AND json_type(NEW.data, ${jsonPathSql}) IS NOT NULL
        `

        this.getStatement(
            `CREATE TRIGGER IF NOT EXISTS ${triggerInsertSql} AFTER INSERT ON ${this.tableSql}
            BEGIN
                INSERT INTO ${sideTableSql} (val, id)
                ${extractArr}
                UNION
                ${extractScalarAndObject};
            END;`,
        ).run()

        this.getStatement(
            `CREATE TRIGGER IF NOT EXISTS ${triggerDeleteSql} AFTER DELETE ON ${this.tableSql}
            BEGIN
                DELETE FROM ${sideTableSql} WHERE id = OLD.id;
            END;`,
        ).run()

        this.getStatement(
            `CREATE TRIGGER IF NOT EXISTS ${triggerUpdateSql} AFTER UPDATE ON ${this.tableSql}
            BEGIN
                DELETE FROM ${sideTableSql} WHERE id = OLD.id;
                INSERT INTO ${sideTableSql} (val, id)
                ${extractArr}
                UNION
                ${extractScalarAndObject};
            END;`,
        ).run()

        // 初始化回填
        const backfillArr = `
            SELECT DISTINCT json_each.value, ${this.tableSql}.id
            FROM ${this.tableSql}, json_each(${this.tableSql}.data, ${jsonPathSql})
            WHERE json_type(${this.tableSql}.data, ${jsonPathSql}) = 'array'
        `
        const backfillScalarAndObject = `
            SELECT json_extract(data, ${jsonPathSql}), id
            FROM ${this.tableSql}
            WHERE json_type(data, ${jsonPathSql}) IS NOT 'array'
              AND json_type(data, ${jsonPathSql}) IS NOT NULL
        `

        this.getStatement(
            `INSERT OR IGNORE INTO ${sideTableSql} (val, id)
            ${backfillArr}
            UNION
            ${backfillScalarAndObject}`,
        ).run()

        this.indexedFields.add(field)
    }

    private dropSideTableIndex(field: string) {
        const sideTableName = this.getSideTableName(field)
        this.getStatement(`DROP TRIGGER IF EXISTS ${quoteIdentifier(`t_${sideTableName}_insert`)}`).run()
        this.getStatement(`DROP TRIGGER IF EXISTS ${quoteIdentifier(`t_${sideTableName}_delete`)}`).run()
        this.getStatement(`DROP TRIGGER IF EXISTS ${quoteIdentifier(`t_${sideTableName}_update`)}`).run()
        this.getStatement(`DROP TABLE IF EXISTS ${quoteIdentifier(sideTableName)}`).run()
    }

    async disableSideTableTriggers(): Promise<void> {
        for (const field of this.indexedFields) {
            const sideTableName = this.getSideTableName(field)
            this.getStatement(`DROP TRIGGER IF EXISTS ${quoteIdentifier(`t_${sideTableName}_insert`)}`).run()
            this.getStatement(`DROP TRIGGER IF EXISTS ${quoteIdentifier(`t_${sideTableName}_delete`)}`).run()
            this.getStatement(`DROP TRIGGER IF EXISTS ${quoteIdentifier(`t_${sideTableName}_update`)}`).run()
        }
    }

    async enableSideTableTriggers(): Promise<void> {
        for (const field of this.indexedFields) {
            this.createSideTableTriggersOnly(field)
        }
    }

    private createSideTableTriggersOnly(field: string) {
        const sideTableName = this.getSideTableName(field)
        const sideTableSql = quoteIdentifier(sideTableName)
        const jsonPathSql = quoteSqlString(sqliteJsonPath(field))

        const extractArr = `SELECT DISTINCT value, NEW.id FROM json_each(NEW.data, ${jsonPathSql}) WHERE json_type(NEW.data, ${jsonPathSql}) = 'array'`
        const extractScalarAndNull = `
            SELECT json_extract(NEW.data, ${jsonPathSql}), NEW.id
            WHERE json_type(NEW.data, ${jsonPathSql}) IS NOT 'array'
              AND json_type(NEW.data, ${jsonPathSql}) IS NOT NULL
        `

        this.getStatement(
            `CREATE TRIGGER IF NOT EXISTS ${quoteIdentifier(`t_${sideTableName}_insert`)} AFTER INSERT ON ${this.tableSql}
            BEGIN
                INSERT INTO ${sideTableSql} (val, id)
                ${extractArr}
                UNION
                ${extractScalarAndNull};
            END;`,
        ).run()

        this.getStatement(
            `CREATE TRIGGER IF NOT EXISTS ${quoteIdentifier(`t_${sideTableName}_delete`)} AFTER DELETE ON ${this.tableSql}
            BEGIN
                DELETE FROM ${sideTableSql} WHERE id = OLD.id;
            END;`,
        ).run()

        this.getStatement(
            `CREATE TRIGGER IF NOT EXISTS ${quoteIdentifier(`t_${sideTableName}_update`)} AFTER UPDATE ON ${this.tableSql}
            BEGIN
                DELETE FROM ${sideTableSql} WHERE id = OLD.id;
                INSERT INTO ${sideTableSql} (val, id)
                ${extractArr}
                UNION
                ${extractScalarAndNull};
            END;`,
        ).run()
    }

    async rebuildSideTableIndexes(): Promise<void> {
        for (const field of this.indexedFields) {
            const sideTableName = this.getSideTableName(field)
            const sideTableSql = quoteIdentifier(sideTableName)
            const jsonPathSql = quoteSqlString(sqliteJsonPath(field))

            this.getStatement(`DELETE FROM ${sideTableSql}`).run()

            const backfillArr = `SELECT DISTINCT json_each.value, ${this.tableSql}.id FROM ${this.tableSql}, json_each(${this.tableSql}.data, ${jsonPathSql}) WHERE json_type(${this.tableSql}.data, ${jsonPathSql}) = 'array'`
            const backfillScalar = `
                SELECT json_extract(data, ${jsonPathSql}), id FROM ${this.tableSql}
                WHERE json_type(data, ${jsonPathSql}) IS NOT 'array'
                  AND json_type(data, ${jsonPathSql}) IS NOT NULL
            `

            this.getStatement(
                `INSERT OR IGNORE INTO ${sideTableSql} (val, id)
                ${backfillArr}
                UNION
                ${backfillScalar}`,
            ).run()
        }
    }

    async _dropIndexes(): Promise<void> {
        const dropTxFn = () => {
            const idxs = this.db
                .prepare(
                    `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND name NOT LIKE 'sqlite_autoindex%'`,
                )
                .all(this.tableName) as { name: string; sql: string }[]

            for (const idx of idxs) {
                this.getStatement(`DROP INDEX ${quoteIdentifier(idx.name)}`).run()
            }

            for (const field of this.indexedFields) {
                this.dropSideTableIndex(field)
            }
            this.indexedFields.clear()
        }

        if (this.inTransaction) {
            dropTxFn()
        } else {
            this.db.transaction(dropTxFn)()
        }
    }

    async dropIndexes(): Promise<void> {
        return this.writeQueue.add(async () => {
            await this._dropIndexes()
        })
    }

    async _compact(): Promise<void> {
        this.getStatement("VACUUM").run()
    }

    async compact(): Promise<void> {
        return this.writeQueue.add(async () => {
            await this._compact()
        })
    }
}

/**
 * Debug 收集器
 * 负责收集 SQL 执行信息、时间统计和查询计划
 */
class DebugCollector {
    startTime: number
    result: any

    constructor(result: any) {
        this.result = result
        this.startTime = performance.now()
        this.result.sql = this.result.sql || []
        this.result.dirtyReasons = this.result.dirtyReasons || []
    }

    setPrepareTime() {
        if (!this.result.prepareTimeMs) {
            this.result.prepareTimeMs = performance.now() - this.startTime
        }
    }

    addSql(query: string, params: any[], execTime?: number) {
        this.result.sql!.push({ query, params, executionTimeMs: execTime })
    }

    setDbExecTime(time: number) {
        this.result.dbExecTimeMs = (this.result.dbExecTimeMs || 0) + time
    }

    finish() {
        this.result.totalTimeMs = performance.now() - this.startTime
    }
}
