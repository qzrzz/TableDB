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
    constructor(
        private db: Database.Database,
        private tableName: string,
        private config: { filename: string; safe?: boolean | "full"; zstd?: boolean }
    ) {
        this.db
            .prepare(
                `
            CREATE TABLE IF NOT EXISTS "${tableName}" (
                _id INTEGER PRIMARY KEY AUTOINCREMENT,
                id TEXT UNIQUE,
                data TEXT
            )
        `
            )
            .run()
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
        const row = this.db.prepare(`SELECT data FROM "${this.tableName}" WHERE id = ?`).get(String(id)) as
            | { data: string }
            | undefined
        if (!row) return undefined
        return deserialize(JSON.parse(row.data))
    }

    async set(id: any, value: ITableDoc): Promise<void> {
        // Use Async serialize (supports Blobs)
        const normalizedValue = this.normalizeUndefined(value)
        const sVal = await serialize(normalizedValue)
        this.db
            .prepare(
                `
            INSERT INTO "${this.tableName}" (id, data) VALUES (?, ?)
            ON CONFLICT(id) DO UPDATE SET data=excluded.data
        `
            )
            .run(String(id), JSON.stringify(sVal))
    }

    async delete(id: any): Promise<void> {
        this.db.prepare(`DELETE FROM "${this.tableName}" WHERE id = ?`).run(String(id))
    }

    async has(id: any): Promise<boolean> {
        const row = this.db.prepare(`SELECT 1 FROM "${this.tableName}" WHERE id = ?`).get(String(id))
        return !!row
    }

    async count(filter?: ITableFilter): Promise<number> {
        if (!filter || Object.keys(filter).length === 0) {
            const res = this.db.prepare(`SELECT count(*) as count FROM "${this.tableName}"`).get() as { count: number }
            return res.count
        }

        const q = await mongoToSql(filter)
        const sql = `SELECT count(*) as count FROM "${this.tableName}" WHERE (${q.where}) AND JsMatch(data, _id, ?)`

        const sFilter = JSON.stringify(await serialize(filter))

        const res = this.db.prepare(sql).get(...q.params, sFilter) as { count: number }
        return res.count
    }

    async clear(): Promise<void> {
        this.db.prepare(`DELETE FROM "${this.tableName}"`).run()
    }

    async clearAll(): Promise<void> {
        this.clear()
        this.dropIndexes()
    }

    async drop(): Promise<void> {
        this.db.prepare(`DROP TABLE IF EXISTS "${this.tableName}"`).run()
    }

    async close(): Promise<void> {
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
        const q = await mongoToSql(filter, options)

        // Select _id always to optionally return it
        let sql = `SELECT _id, data FROM "${this.tableName}" WHERE (${q.where}) AND JsMatch(data, _id, ?)`

        if (q.sort) sql += ` ORDER BY ${q.sort}`
        if (q.limit !== undefined) sql += ` LIMIT ${q.limit}`
        if (q.offset !== undefined) sql += ` OFFSET ${q.offset}`

        const sFilter = JSON.stringify(await serialize(filter))
        // console.log("SQLiteAdapter findMany SQL:", { sFilter })
        const rows = this.db.prepare(sql).all(...q.params, sFilter)

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
        const q = await mongoToSql(filter)
        const sFilter = JSON.stringify(await serialize(filter))
        const normalizedOp = this.normalizeUndefined(updateOp)
        const sOp = JSON.stringify(await serialize(normalizedOp))

        const sql = `UPDATE "${this.tableName}" SET data = JsPatch(data, ?) WHERE (${q.where}) AND JsMatch(data, _id, ?)`

        const info = this.db.prepare(sql).run(sOp, ...q.params, sFilter)

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
        const q = await mongoToSql(filter, { sort: options?.sort })
        q.limit = 1

        const sFilter = JSON.stringify(await serialize(filter))

        let selectSql = `SELECT _id, id FROM "${this.tableName}" WHERE (${q.where}) AND JsMatch(data, _id, ?)`
        if (q.sort) selectSql += ` ORDER BY ${q.sort}`
        selectSql += ` LIMIT 1`

        // Use _id for faster update if available?
        // _id is PK. Row ID.
        // If we select _id, we can update by _id.
        const row = this.db.prepare(selectSql).get(...q.params, sFilter)

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
        this.db.prepare(updateSql).run(sOp, (row as any)._id)

        return { matchedCount: 1, modifiedCount: 1 }
    }

    async insertMany(docs: ITableDoc[]): Promise<ITableInsertResult> {
        const stmt = this.db.prepare(`INSERT INTO "${this.tableName}" (id, data) VALUES (?, ?)`)

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
            const stmtCheck = this.db.prepare(`SELECT data FROM "${this.tableName}" WHERE id = ?`)
            const stmtUpdate = this.db.prepare(`UPDATE "${this.tableName}" SET data = ? WHERE id = ?`)
            const stmtInsert = this.db.prepare(`INSERT INTO "${this.tableName}" (id, data) VALUES (?, ?)`)

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
        const q = await mongoToSql(filter)
        const sFilter = JSON.stringify(await serialize(filter))
        const sql = `DELETE FROM "${this.tableName}" WHERE (${q.where}) AND JsMatch(data, _id, ?)`
        const info = this.db.prepare(sql).run(...q.params, sFilter)
        return { deletedCount: info.changes }
    }

    async deleteOne(filter: ITableFilter, options?: ITableDeleteOptions): Promise<ITableDeletedResult> {
        const q = await mongoToSql(filter, { sort: options?.sort })
        q.limit = 1
        const sFilter = JSON.stringify(await serialize(filter))

        // Query both _id and id to use correct DELETE target
        let selectSql = `SELECT _id FROM "${this.tableName}" WHERE (${q.where}) AND JsMatch(data, _id, ?)`
        if (q.sort) selectSql += ` ORDER BY ${q.sort}`
        selectSql += ` LIMIT 1`

        const row = this.db.prepare(selectSql).get(...q.params, sFilter)

        if (row) {
            this.db.prepare(`DELETE FROM "${this.tableName}" WHERE _id = ?`).run((row as any)._id)
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
                this.db.prepare(`DROP INDEX IF EXISTS "${name}"`).run()
                continue
            }

            const exprs: string[] = []
            const keys = typeof idx.key === "string" ? { [idx.key]: 1 } : idx.key

            for (const [k, dir] of Object.entries(keys)) {
                exprs.push(`json_extract(data, '$.${k}') ${dir === 1 ? "ASC" : "DESC"}`)
            }

            const unique = idx.unique ? "UNIQUE" : ""
            const sql = `CREATE ${unique} INDEX IF NOT EXISTS "${name}" ON "${this.tableName}" (${exprs.join(", ")})`

            this.db.prepare(sql).run()
        }
    }

    async dropIndexes(): Promise<void> {
        const idxs = this.db
            .prepare(
                `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND name NOT LIKE 'sqlite_autoindex%'`
            )
            .all(this.tableName) as { name: string }[]
        for (const idx of idxs) {
            this.db.prepare(`DROP INDEX "${idx.name}"`).run()
        }
    }

    async compact(): Promise<void> {
        this.db.prepare("VACUUM").run()
    }
}

/**
 * 简单的内存 Projection 实现
 */
function project(doc: any, projection: any): any {
    if (!projection || Object.keys(projection).length === 0) return doc

    // Normalize projection (array to object)
    const proj: any = {}
    if (Array.isArray(projection)) {
        for (const key of projection) proj[key] = 1
    } else {
        Object.assign(proj, projection)
    }

    const result: any = {}
    const keys = Object.keys(proj)
    // Check if it's inclusion or exclusion (mixed not allowed except _id, but we simplify)
    // If any value is 1/true, it's inclusion (rest suppressed).
    // If all 0/false, it's exclusion (rest kept).

    // Simplification: Mongo assumes _id included by default.
    // If user says { a: 1 }, only a and id included.
    // If user says { a: 0 }, a excluded, rest included.

    // Detect mode
    let isInclusion = false
    for (const k in proj) {
        if (proj[k] === 1 || proj[k] === true) {
            isInclusion = true
            break
        }
    }

    if (isInclusion) {
        // Inclusion Mode
        // Always include ID unless explicitly excluded (Mongo behavior)
        // Always include ID unless explicitly excluded (Mongo behavior)
        if (doc.id !== undefined && (proj.id === 1 || proj.id === true)) {
            result.id = doc.id
        }

        if (doc._id !== undefined && (proj._id === 1 || proj._id === true)) {
            result._id = doc._id
        }

        for (const key in proj) {
            if (proj[key] === 1 || proj[key] === true) {
                if (key === "id" || key === "_id") continue
                // Nested projection not fully supported here, just top level
                if (doc[key] !== undefined) result[key] = doc[key]
            }
        }
    } else {
        // Exclusion Mode
        Object.assign(result, doc)
        for (const key in proj) {
            if (proj[key] === 0 || proj[key] === false) {
                delete result[key]
            }
        }
    }
    return result
}
