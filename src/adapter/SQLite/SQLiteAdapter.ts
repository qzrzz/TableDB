import Database from "better-sqlite3"
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
} from "../adapter"
import { ITableFilter, ITableUpdateOp } from "../../core/types"
import { deserialize, serialize, serializeSync } from "./utils/serializer"
import { mongoToSql } from "./utils/mongoToSql"
import { matches } from "./utils/matcher"
import { applyUpdate, flattenObject, deepMergeWithArrayUnion } from "./utils/patch"

/**
 * 规范化投影参数（数组转对象）
 */
function normalizeProjection(proj?: string[] | Record<string, 1 | -1 | 0>): Record<string, number> | undefined {
    if (!proj) return undefined
    if (Array.isArray(proj)) {
        const projObj: Record<string, 1> = {}
        proj.forEach((p) => (projObj[p] = 1))
        return projObj
    }
    return proj as Record<string, number>
}

export function SQLiteAdapter(config: { filename: string; safe?: boolean | "full"; zstd?: boolean }): ITableDBAdapter {
    let db: Database.Database


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

                    if (config.zstd) {
                        checkAndDecompressDb(filename)
                    }
                } catch (error) {
                    // 如果目录创建失败，让 Database 构造函数处理错误
                    console.warn(`Warning: Could not ensure directory exists for ${filename}:`, error)
                }
            }

            db = new Database(filename)
            db.pragma("journal_mode = WAL")

            // 如果不需要完全的安全性，可以关闭同步以提升性能
            if (!config.safe) {
                db.pragma("synchronous = OFF")
            }

            if (config.safe === "full") {
                db.pragma("synchronous = FULL")
            }

            registerCustomFunctions(db)
        }
        return db
    }

    const Adapter: ITableDBAdapter = {
        name: "SQLiteAdapter",
        async useAdapterInstance(tableName: string): Promise<ITableDBAdapterInstance> {
            const database = getDb()
            return new SQLiteAdapterInstance(database, tableName, config)
        },
    }
    return Adapter
}

function registerCustomFunctions(db: Database.Database) {
    db.function("JsMatch", (docJson: any, idVal: any, filterJson: any) => {
        if (!docJson) return 0
        try {
            const doc = deserialize(JSON.parse(docJson))
            doc._id = idVal
            const filterObj = deserialize(JSON.parse(filterJson))
            return matches(doc, filterObj) ? 1 : 0
        } catch (e) {
            return 0
        }
    })

    db.function("JsPatch", (docJson: any, opJson: any) => {
        if (!docJson) return null
        try {
            const doc = deserialize(JSON.parse(docJson))
            const op = deserialize(JSON.parse(opJson))

            applyUpdate(doc, op)

            // Must use Sync serializer inside Synchronous SQLite function
            return JSON.stringify(serializeSync(doc))
        } catch (e) {
            return docJson
        }
    })
}

export class SQLiteAdapterInstance implements ITableDBAdapterInstance {
    name = "SQLiteAdapter"
    private statementCache = new Map<string, Database.Statement>()
    private indexedFields = new Set<string>()

    constructor(
        private db: Database.Database,
        private tableName: string,
        private config: { filename: string; safe?: boolean | "full"; zstd?: boolean }
    ) {
        this.getStatement(`
            CREATE TABLE IF NOT EXISTS "${tableName}" (
                _id INTEGER PRIMARY KEY AUTOINCREMENT,
                id TEXT UNIQUE,
                data TEXT
            )
        `).run()

        // 初始化时读取已存在的索引
        this.loadExistingIndexes()
    }

    private loadExistingIndexes() {
        const idxs = this.db
            .prepare(
                `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND name NOT LIKE 'sqlite_autoindex%'`
            )
            .all(this.tableName) as { name: string; sql: string }[]

        for (const idx of idxs) {
            // 解析 SQL 来获取索引字段
            // CREATE INDEX "idx_age" ON "test" (json_extract(data, '$.age'))
            const match = idx.sql?.match(/json_extract\(data, '\$\.([^']+)'\)/)
            if (match && match[1]) {
                const field = match[1]
                // 检查对应的 Side Table 是否存在
                const sideTableName = this.getSideTableName(field)
                const exists = this.db
                    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
                    .get(sideTableName)

                if (exists) {
                    this.indexedFields.add(field)
                }
            }
        }
    }

    private getStatement(sql: string): Database.Statement {
        const cached = this.statementCache.get(sql)
        if (cached) return cached
        const stmt = this.db.prepare(sql)
        this.statementCache.set(sql, stmt)
        return stmt
    }

    /**
     * 将对象中所有 undefined 转换为 null，保持 MongoDB 一致性
     * 注意：不处理 Map、Set、Date、Buffer 等特殊类型，由 serialize/deserialize 处理
     */
    private normalizeUndefined(obj: any): any {
        if (obj === undefined) return null
        if (obj === null) return null
        if (typeof obj !== "object") return obj

        // 跳过特殊对象类型（由 serialize/deserialize 处理）
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

        // 普通对象：递归处理
        const isPlain = obj.constructor === Object || obj.constructor === undefined
        if (!isPlain) {
            // 不是普通对象（可能是自定义类实例），不处理
            return obj
        }

        const normalized: any = {}
        for (const key in obj) {
            normalized[key] = this.normalizeUndefined(obj[key])
        }
        return normalized
    }

    async get(id: any): Promise<ITableDoc | void> {
        const row = this.getStatement(`SELECT data FROM "${this.tableName}" WHERE id = ?`).get(String(id)) as
            | { data: string }
            | undefined
        if (!row) return undefined
        return deserialize(JSON.parse(row.data))
    }

    async set(id: any, value: ITableDoc): Promise<void> {
        // Use Async serialize (supports Blobs)
        const normalizedValue = this.normalizeUndefined(value)
        const sVal = await serialize(normalizedValue)
        this.getStatement(
            `
            INSERT INTO "${this.tableName}" (id, data) VALUES (?, ?)
            ON CONFLICT(id) DO UPDATE SET data=excluded.data
        `
        )
            .run(String(id), JSON.stringify(sVal))
    }

    async delete(id: any): Promise<void> {
        this.getStatement(`DELETE FROM "${this.tableName}" WHERE id = ?`).run(String(id))
    }

    async has(id: any): Promise<boolean> {
        const row = this.getStatement(`SELECT 1 FROM "${this.tableName}" WHERE id = ?`).get(String(id))
        return !!row
    }

    async count(filter?: ITableFilter): Promise<number> {
        if (!filter || Object.keys(filter).length === 0) {
            const res = this.getStatement(`SELECT count(*) as count FROM "${this.tableName}"`).get() as { count: number }
            return res.count
        }

        const q = await mongoToSql(filter, { indexedFields: this.indexedFields, tableName: this.tableName } as any)
        const isCompatible = isQuerySqlCompatible(filter)

        let sql = ""
        let params = q.params

        if (isCompatible) {
            sql = `SELECT count(*) as count FROM "${this.tableName}" WHERE (${q.where})`
        } else {
            sql = `SELECT count(*) as count FROM "${this.tableName}" WHERE (${q.where}) AND JsMatch(data, _id, ?)`
            const sFilter = JSON.stringify(await serialize(filter))
            params = [...params, sFilter]
        }

        const res = this.getStatement(sql).get(...params) as { count: number }
        return res.count
    }

    async clear(): Promise<void> {
        this.getStatement(`DELETE FROM "${this.tableName}"`).run()
    }

    async clearAll(): Promise<void> {
        this.clear()
        this.dropIndexes()
    }

    async drop(): Promise<void> {
        this.getStatement(`DROP TABLE IF EXISTS "${this.tableName}"`).run()
    }

    async close(): Promise<void> {
        // Clear cache statements if needed? managed by db connection usually.
        this.statementCache.clear()

        if (this.db && this.db.open) {
            const shouldCompress = this.config.zstd && this.config.filename && !this.config.filename.startsWith(":memory:")

            if (shouldCompress) {
                prepareForCompression(this.db)
            }
            this.db.close()

            if (shouldCompress) {
                await compressFile(this.config.filename)
            }
        }
    }

    async findMany(filter: ITableFilter, options?: ITableFindOptions): Promise<ITableDoc[]> {
        const q = await mongoToSql(filter, { ...options, indexedFields: this.indexedFields, tableName: this.tableName } as any)
        const isCompatible = isQuerySqlCompatible(filter)

        let sql = ""
        let params = q.params

        // Select _id always to optionally return it
        if (isCompatible) {
            sql = `SELECT _id, data FROM "${this.tableName}" WHERE (${q.where})`
        } else {
            sql = `SELECT _id, data FROM "${this.tableName}" WHERE (${q.where}) AND JsMatch(data, _id, ?)`
            const sFilter = JSON.stringify(await serialize(filter))
            params = [...params, sFilter]
        }

        if (q.sort) sql += ` ORDER BY ${q.sort}`
        if (q.limit !== undefined) sql += ` LIMIT ${q.limit}`
        if (q.offset !== undefined) sql += ` OFFSET ${q.offset}`

        const rows = this.getStatement(sql).all(...params)

        // 处理 projection
        const proj = normalizeProjection(options?.projection)

        if (proj) {
            // 检查是否只有 { _id: 1 }，这种情况表示用户想要全部字段 + _id
            const projKeys = Object.keys(proj)
            const isOnlyIdInclusion = projKeys.length === 1 && projKeys[0] === "_id" && proj["_id"] === 1

            if (isOnlyIdInclusion) {
                // 返回全部字段 + _id
                return rows.map((r: any) => {
                    const d = deserialize(JSON.parse(r.data))
                    d._id = r._id
                    return d
                })
            }

            // 有其他 projection 字段
            return rows.map((r: any) => {
                const d = deserialize(JSON.parse(r.data))
                d._id = r._id
                return project(d, proj)
            })
        }

        // No projection: Do NOT return _id
        return rows.map((r: any) => deserialize(JSON.parse(r.data)))
    }

    async findOne(filter: ITableFilter, options?: ITableFindOptions): Promise<ITableDoc | void> {
        const opts = { ...options, limit: 1 }
        const docs = await this.findMany(filter, opts)
        return docs[0]
    }

    // ... (rest of methods) ...

    async updateMany(
        filter: ITableFilter,
        updateOp: ITableUpdateOp<ITableDoc>,
        options?: ITableUpdateOptions
    ): Promise<ITableUpdateResult> {
        const q = await mongoToSql(filter, { indexedFields: this.indexedFields, tableName: this.tableName } as any)
        const normalizedOp = this.normalizeUndefined(updateOp)
        const sOp = JSON.stringify(await serialize(normalizedOp))
        const isCompatible = isQuerySqlCompatible(filter)

        let sql = ""
        let params: any[] = []

        if (isCompatible) {
            sql = `UPDATE "${this.tableName}" SET data = JsPatch(data, ?) WHERE (${q.where})`
            params = [sOp, ...q.params]
        } else {
            const sFilter = JSON.stringify(await serialize(filter))
            sql = `UPDATE "${this.tableName}" SET data = JsPatch(data, ?) WHERE (${q.where}) AND JsMatch(data, _id, ?)`
            params = [sOp, ...q.params, sFilter]
        }

        const info = this.getStatement(sql).run(...params)

        let modifiedCount = info.changes
        let matchedCount = info.changes

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

            applyUpdate(newDoc, normalizedOp)
            if (normalizedOp.$setOnInsert) {
                const setOnInsertOp = { $set: normalizedOp.$setOnInsert }
                applyUpdate(newDoc, setOnInsertOp)
            }

            await this.set(newDoc.id, newDoc)
            return { matchedCount: 0, modifiedCount: 0, upsertedIds: [newDoc.id] }
        }

        return { matchedCount, modifiedCount }
    }

    async bulkUpdate(
        updates: { filter: ITableFilter; updateOp: ITableUpdateOp<ITableDoc>; options?: ITableUpdateOptions }[]
    ): Promise<ITableUpdateResult> {
        let matchedCount = 0
        let modifiedCount = 0
        const upsertedIds: any[] = []

        for (const item of updates) {
            try {
                const res = await this.updateOne(item.filter, item.updateOp, item.options)
                matchedCount += res.matchedCount
                modifiedCount += res.modifiedCount
                if (res.upsertedIds) {
                    upsertedIds.push(...res.upsertedIds)
                }
            } catch (e) {
                // Simulate ordered: false, ignore error
                console.error("bulkUpdate error:", e)
            }
        }

        return { matchedCount, modifiedCount, upsertedIds: upsertedIds.length > 0 ? upsertedIds : undefined }
    }

    async updateOne(
        filter: ITableFilter,
        updateOp: ITableUpdateOp<ITableDoc>,
        options?: ITableUpdateOptions
    ): Promise<ITableUpdateResult> {
        const q = await mongoToSql(filter, { sort: options?.sort, indexedFields: this.indexedFields, tableName: this.tableName } as any)
        q.limit = 1

        const isCompatible = isQuerySqlCompatible(filter)

        let selectSql = ""
        let params = q.params

        if (isCompatible) {
            selectSql = `SELECT _id, id FROM "${this.tableName}" WHERE (${q.where})`
        } else {
            const sFilter = JSON.stringify(await serialize(filter))
            selectSql = `SELECT _id, id FROM "${this.tableName}" WHERE (${q.where}) AND JsMatch(data, _id, ?)`
            params = [...params, sFilter]
        }

        if (q.sort) selectSql += ` ORDER BY ${q.sort}`
        selectSql += ` LIMIT 1`

        // Use _id for faster update if available?
        // _id is PK. Row ID.
        // If we select _id, we can update by _id.
        const row = this.getStatement(selectSql).get(...params)

        if (!row) {
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
                await this.set(newDoc.id, newDoc)
                return { matchedCount: 0, modifiedCount: 0, upsertedIds: [newDoc.id] }
            }
            return { matchedCount: 0, modifiedCount: 0 }
        }

        const normalizedOp = this.normalizeUndefined(updateOp)
        const sOp = JSON.stringify(await serialize(normalizedOp))
        // Updating by _id is slightly faster/safer if PK changed (unlikely for _id)
        const updateSql = `UPDATE "${this.tableName}" SET data = JsPatch(data, ?) WHERE _id = ?`
        this.getStatement(updateSql).run(sOp, (row as any)._id)

        return { matchedCount: 1, modifiedCount: 1 }
    }

    async insertMany(docs: ITableDoc[]): Promise<ITableInsertResult> {
        const stmt = this.getStatement(`INSERT INTO "${this.tableName}" (id, data) VALUES (?, ?)`)

        const result: ITableInsertResult = {
            insertedCount: 0,
            skippedCount: 0,
            insertedIds: [],
            skippedIds: [],
        }

        const serializedInfo: { id: string; data: string }[] = []
        for (const doc of docs) {
            const normalizedDoc = this.normalizeUndefined(doc)
            const sDoc = await serialize(normalizedDoc)
            serializedInfo.push({ id: String(doc.id), data: JSON.stringify(sDoc) })
        }

        const insertManyTx = this.db.transaction((items: { id: string; data: string }[]) => {
            for (const item of items) {
                try {
                    stmt.run(item.id, item.data)
                    result.insertedCount++
                    result.insertedIds.push(item.id)
                } catch (err: any) {
                    if (err.code === "SQLITE_CONSTRAINT_PRIMARYKEY" || err.code === "SQLITE_CONSTRAINT_UNIQUE") {
                        result.skippedCount++
                        result.skippedIds.push(item.id)
                    } else {
                        throw err
                    }
                }
            }
        })

        insertManyTx(serializedInfo)
        return result
    }

    async setMany(docs: Partial<ITableDoc>[], options?: ITableSetOptions): Promise<ITableSetResult> {
        const result: ITableSetResult = {
            insertedCount: 0,
            overwriteCount: 0,
            insertedIds: [],
        }

        const runSetMany = async () => {
            const stmtCheck = this.getStatement(`SELECT data FROM "${this.tableName}" WHERE id = ?`)
            const stmtUpdate = this.getStatement(`UPDATE "${this.tableName}" SET data = ? WHERE id = ?`)
            const stmtInsert = this.getStatement(`INSERT INTO "${this.tableName}" (id, data) VALUES (?, ?)`)

            for (const doc of docs) {
                const id = String(doc.id)
                const exist = stmtCheck.get(id) as { data: string } | undefined

                if (exist) {
                    if (options?.insertOnly) continue

                    if (options?.overwrite) {
                        const normalizedDoc = this.normalizeUndefined(doc)
                        const sDoc = await serialize(normalizedDoc)
                        stmtUpdate.run(JSON.stringify(sDoc), id)
                        result.overwriteCount++
                        continue
                    }

                    let finalDoc = deserialize(JSON.parse(exist.data))
                    if (options?.merge) {
                        // Deep Merge logic with Array Union
                        const normalizedDoc = this.normalizeUndefined(doc)
                        deepMergeWithArrayUnion(finalDoc, normalizedDoc)
                    } else {
                        // Default behavior: Merge Top-level fields (like updateOne with $set)
                        const normalizedDoc = this.normalizeUndefined(doc)
                        const op = { $set: normalizedDoc }
                        applyUpdate(finalDoc, op)
                    }

                    const sDoc = await serialize(finalDoc)
                    stmtUpdate.run(JSON.stringify(sDoc), id)
                    result.overwriteCount++
                } else {
                    if (options?.updateOnly) continue

                    const normalizedDoc = this.normalizeUndefined(doc)
                    const sDoc = await serialize(normalizedDoc)
                    stmtInsert.run(id, JSON.stringify(sDoc))
                    result.insertedCount++
                    result.insertedIds.push(id)
                }
            }
        }

        await runSetMany()
        return result
    }

    async deleteMany(filter: ITableFilter): Promise<ITableDeletedResult> {
        const q = await mongoToSql(filter, { indexedFields: this.indexedFields, tableName: this.tableName } as any)
        const isCompatible = isQuerySqlCompatible(filter)

        let sql = ""
        let params = q.params

        if (isCompatible) {
            sql = `DELETE FROM "${this.tableName}" WHERE (${q.where})`
        } else {
            const sFilter = JSON.stringify(await serialize(filter))
            sql = `DELETE FROM "${this.tableName}" WHERE (${q.where}) AND JsMatch(data, _id, ?)`
            params = [...params, sFilter]
        }

        const info = this.getStatement(sql).run(...params)
        return { deletedCount: info.changes }
    }

    async deleteOne(filter: ITableFilter, options?: ITableDeleteOptions): Promise<ITableDeletedResult> {
        const q = await mongoToSql(filter, { sort: options?.sort, indexedFields: this.indexedFields, tableName: this.tableName } as any)
        q.limit = 1

        const isCompatible = isQuerySqlCompatible(filter)

        let selectSql = ""
        let params = q.params

        // Query both _id and id to use correct DELETE target
        if (isCompatible) {
            selectSql = `SELECT _id FROM "${this.tableName}" WHERE (${q.where})`
        } else {
            const sFilter = JSON.stringify(await serialize(filter))
            selectSql = `SELECT _id FROM "${this.tableName}" WHERE (${q.where}) AND JsMatch(data, _id, ?)`
            params = [...params, sFilter]
        }

        if (q.sort) selectSql += ` ORDER BY ${q.sort}`
        selectSql += ` LIMIT 1`

        const row = this.getStatement(selectSql).get(...params)

        if (row) {
            this.getStatement(`DELETE FROM "${this.tableName}" WHERE _id = ?`).run((row as any)._id)
            return { deletedCount: 1 }
        }
        return { deletedCount: 0 }
    }

    async defineIndexes(indexes: ITableIndexConfig[], options?: ITableDefineIndexesOptions): Promise<void> {
        if (options?.rebuild) {
            await this.dropIndexes()
        }

        for (const idx of indexes) {
            let name = idx.name
            if (!name) {
                if (typeof idx.key === "string") name = `idx_${idx.key}`
                else name = `idx_${Object.keys(idx.key).join("_")}`
            }

            if (idx.disabled) {
                this.getStatement(`DROP INDEX IF EXISTS "${name}"`).run()
                // 更新 indexedFields
                const keys = typeof idx.key === "string" ? { [idx.key]: 1 } : idx.key
                for (const k in keys) {
                    this.indexedFields.delete(k)
                }
                continue
            }

            const exprs: string[] = []
            const keys = typeof idx.key === "string" ? { [idx.key]: 1 } : idx.key

            for (const [k, dir] of Object.entries(keys)) {
                exprs.push(`json_extract(data, '$.${k}') ${dir === 1 ? "ASC" : "DESC"}`)
                this.indexedFields.add(k)
            }

            const unique = idx.unique ? "UNIQUE" : ""
            const sql = `CREATE ${unique} INDEX IF NOT EXISTS "${name}" ON "${this.tableName}" (${exprs.join(", ")})`

            this.getStatement(sql).run()

            // Side Table Optimization (Inverted Index)
            // Only for single-key indexes to avoid complexity
            if (Object.keys(keys).length === 1) {
                const field = Object.keys(keys)[0]
                this.createSideTableIndex(field)
            }
        }
    }

    private getSideTableName(field: string): string {
        // Sanitize field to be safe in table name
        const safeField = field.replace(/[^a-zA-Z0-9_]/g, "_")
        return `_idx_${this.tableName}_${safeField}`
    }

    private async createSideTableIndex(field: string) {
        // 1. 创建 Side Table
        // _idx_{tableName}_{field}
        // key: value, id
        // 使用标准表允许在 (val, id) 中存储 NULL（WITHOUT ROWID 不允许主键为 NULL）
        const safeField = field.replace(/"/g, '""')
        const sideTableName = this.getSideTableName(field)

        this.getStatement(
            `CREATE TABLE IF NOT EXISTS "${sideTableName}" (
                val,
                id,
                PRIMARY KEY (val, id)
            )`
        ).run()

        // 2. 创建触发器 (自动同步)

        // 辅助 SQL 片段
        const extractArr = `SELECT DISTINCT value, NEW.id FROM json_each(NEW.data, '$.${safeField}') WHERE json_type(NEW.data, '$.${safeField}') = 'array'`
        const extractScalar = `SELECT json_extract(NEW.data, '$.${safeField}'), NEW.id WHERE json_type(NEW.data, '$.${safeField}') IS NOT 'array' AND json_type(NEW.data, '$.${safeField}') IS NOT 'object' AND json_extract(NEW.data, '$.${safeField}') IS NOT NULL`
        // 注意：我们排除了 Object。是否也应该排除 NULL？
        // 等等，失败的测试插入了 NULL。Mongo 会索引 NULL。所以我们应该索引 NULL？
        // 但是如果 key 缺失 json_extract 返回 NULL？
        //  - 如果 key 缺失: json_type 为 null。json_extract 为 null。
        //  - 如果 key 存在且值为 null: json_type 为 'null'。json_extract 为 null。
        // 我们只想索引 "显式 Null"？
        // Mongo: {a:1} -> 索引条目? 否。 {a:null} -> 索引条目 'null'。
        // json_extract(data, '$.field') 对于 "缺失" 和 "null 值" 都返回 NULL。
        // 使用 json_type 来区分？
        // json_type(..., '$.field') 如果显式为 null 则返回 'null'。如果缺失则返回 NULL。

        const extractScalarAndNull = `
            SELECT json_extract(NEW.data, '$.${safeField}'), NEW.id 
            WHERE json_type(NEW.data, '$.${safeField}') IS NOT 'array' 
              AND json_type(NEW.data, '$.${safeField}') IS NOT 'object'
              AND json_type(NEW.data, '$.${safeField}') IS NOT NULL
        `

        // INSERT
        this.getStatement(
            `CREATE TRIGGER IF NOT EXISTS "t_${sideTableName}_insert" AFTER INSERT ON "${this.tableName}"
            BEGIN
                INSERT INTO "${sideTableName}" (val, id)
                ${extractArr}
                UNION
                ${extractScalarAndNull};
            END;`
        ).run()

        // DELETE
        this.getStatement(
            `CREATE TRIGGER IF NOT EXISTS "t_${sideTableName}_delete" AFTER DELETE ON "${this.tableName}"
            BEGIN
                DELETE FROM "${sideTableName}" WHERE id = OLD.id;
            END;`
        ).run()

        // UPDATE
        this.getStatement(
            `CREATE TRIGGER IF NOT EXISTS "t_${sideTableName}_update" AFTER UPDATE ON "${this.tableName}"
            BEGIN
                DELETE FROM "${sideTableName}" WHERE id = OLD.id;
                INSERT INTO "${sideTableName}" (val, id)
                ${extractArr}
                UNION
                ${extractScalarAndNull};
            END;`
        ).run()

        // 3. 回填数据
        // 为了简化，直接循环或使用复杂 SQL。
        // 因为这是一次性操作，我们可以使用类似的 UNION 逻辑。
        const backfillArr = `SELECT DISTINCT json_each.value, "${this.tableName}".id FROM "${this.tableName}", json_each("${this.tableName}".data, '$.${safeField}') WHERE json_type("${this.tableName}".data, '$.${safeField}') = 'array'`
        const backfillScalar = `
            SELECT json_extract(data, '$.${safeField}'), id FROM "${this.tableName}"
            WHERE json_type(data, '$.${safeField}') IS NOT 'array'
              AND json_type(data, '$.${safeField}') IS NOT 'object'
              AND json_type(data, '$.${safeField}') IS NOT NULL
        `

        this.getStatement(
            `INSERT OR IGNORE INTO "${sideTableName}" (val, id)
            ${backfillArr}
            UNION
            ${backfillScalar}`
        ).run()

        this.indexedFields.add(field)
    }

    private dropSideTableIndex(field: string) {
        const sideTableName = this.getSideTableName(field)
        // Dropping table automatically drops triggers associated with it? 
        // No, triggers are on Main Table. Must drop explicitly.

        this.getStatement(`DROP TRIGGER IF EXISTS "t_${sideTableName}_insert"`).run()
        this.getStatement(`DROP TRIGGER IF EXISTS "t_${sideTableName}_delete"`).run()
        this.getStatement(`DROP TRIGGER IF EXISTS "t_${sideTableName}_update"`).run()
        this.getStatement(`DROP TABLE IF EXISTS "${sideTableName}"`).run()
    }

    async dropIndexes(): Promise<void> {
        const dropTx = this.db.transaction(() => {
            const idxs = this.db
                .prepare(
                    `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND name NOT LIKE 'sqlite_autoindex%'`
                )
                .all(this.tableName) as { name: string; sql: string }[]

            for (const idx of idxs) {
                this.getStatement(`DROP INDEX "${idx.name}"`).run()
            }

            // Drop Side Tables
            for (const field of this.indexedFields) {
                this.dropSideTableIndex(field)
            }
            this.indexedFields.clear()
        })
        dropTx()
    }

    async compact(): Promise<void> {
        this.getStatement("VACUUM").run()
    }
}

function isQuerySqlCompatible(filter: ITableFilter): boolean {
    if (!filter) return true

    for (const key in filter) {
        if (key === "$and" || key === "$or") {
            const subs = (filter as any)[key]
            if (Array.isArray(subs)) {
                for (const sub of subs) {
                    if (!isQuerySqlCompatible(sub)) return false
                }
            }
            continue
        }

        // Unsupported logic
        if (key === "$nor" || key === "$not" || key === "$where") return false

        const val = (filter as any)[key]
        if (val && typeof val === "object") {
            // Check if it's an operator object
            if (!Array.isArray(val)) {
                for (const op in val) {
                    // Check supported operators
                    if (["$eq", "$gt", "$gte", "$lt", "$lte", "$in"].includes(op)) {
                        // Check operand compatibility
                        const opVal = val[op]
                        if (!isCompatibleValue(opVal)) return false
                    } else {
                        // Unsupported operator (e.g. $regex, $elemMatch, $size, $exists etc.)
                        // Wait, mongoToSql doesn't handle $exists? Yes it doesn't.
                        return false
                    }
                }
            } else {
                // Array value as direct equality check [1, 2] -> unsafe for SQL if we treated it as equality
                // But mongoToSql treats it as equality? 
                // isSafeForEquality in mongoToSql treats Array as TRUE.
                // But we want to be conservative.
                // If it is an array and not an operator, it probably implies strict array equality, 
                // which mongoToSql handles via parameters.
                // However, array equality in JSON extract logic is tricky. 
                // Let's assume complex types like Array/Object are NOT fully trusted for SQL-only optimization to be safe.
                return false
            }
        } else {
            // Primitive value check
            if (!isCompatibleValue(val)) return false
        }
    }
    return true
}

function isCompatibleValue(val: any): boolean {
    if (val === null || val === undefined) return true
    const t = typeof val
    if (t === 'number' || t === 'string' || t === 'boolean') return true
    if (t === 'bigint') return false // serializes to object, unsafe for SQL range comparison

    // Date, Buffer, etc might rely on specific serialization that matches?
    // Dates are stored as ISO strings. SQL comparison of ISO strings works for > < etc.
    if (val instanceof Date) return true

    return false
}

/**
 * 简单的内存 Projection 实现
 */
function project(doc: any, projection: any): any {
    if (!projection || Object.keys(projection).length === 0) return doc

    // 规范化投影 (数组转对象)
    const proj: any = {}
    if (Array.isArray(projection)) {
        for (const key of projection) proj[key] = 1
    } else {
        Object.assign(proj, projection)
    }

    const result: any = {}
    const keys = Object.keys(proj)
    // 检查是包含模式还是排除模式 (不允许混合，除了 _id，但这里简化处理)
    // 如果任何值为 1/true，则为包含模式 (其余被抑制)。
    // 如果全为 0/false，则为排除模式 (其余保留)。

    // 简化：Mongo 默认包含 _id。
    // 如果用户指定 { a: 1 }，则只包含 a 和 id。
    // 如果用户指定 { a: 0 }，则排除 a，其余包含。

    // 检测模式
    let isInclusion = false
    for (const k in proj) {
        if (proj[k] === 1 || proj[k] === true) {
            isInclusion = true
            break
        }
    }

    if (isInclusion) {
        // 包含模式 (Inclusion Mode)
        // 除非明确排除，否则始终包含 ID (Mongo 行为)
        if (doc.id !== undefined && (proj.id === 1 || proj.id === true)) {
            result.id = doc.id
        }

        if (doc._id !== undefined && (proj._id === 1 || proj._id === true)) {
            result._id = doc._id
        }

        for (const key in proj) {
            if (proj[key] === 1 || proj[key] === true) {
                if (key === "id" || key === "_id") continue
                // 此处未完全支持嵌套投影，仅顶层
                if (doc[key] !== undefined) result[key] = doc[key]
            }
        }
    } else {
        // 排除模式 (Exclusion Mode)
        Object.assign(result, doc)
        for (const key in proj) {
            if (proj[key] === 0 || proj[key] === false) {
                delete result[key]
            }
        }
    }
    return result
}
