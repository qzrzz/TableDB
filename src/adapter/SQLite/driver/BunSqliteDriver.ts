/**
 * BunSqliteDriver - bun:sqlite 的 Driver 实现
 *
 * 包装 Bun 内置的 bun:sqlite 模块以符合 ISqliteDatabase 接口
 *
 * 注意事项：
 * 1. bun:sqlite 仅在 Bun 运行时可用
 * 2. bun:sqlite 不支持自定义函数 (db.function)，会抛出错误
 * 3. 因此使用此驱动时，无法使用依赖 JsMatch/JsPatch 的混合查询模式
 */

import type {
    ISqliteDatabase,
    ISqliteStatement,
    ISqliteRunResult,
    ISqliteTransactionFn,
    ISqliteDriverConfig,
} from "./types"

// bun:sqlite 类型定义
interface BunSqliteStatement {
    all(...params: any[]): any[]
    get(...params: any[]): any
    run(...params: any[]): { changes: number | bigint; lastInsertRowid: number | bigint }
}

interface BunSqliteDatabase {
    // bun:sqlite 没有 isOpen 属性，需要自己维护状态
    query(sql: string): BunSqliteStatement
    exec(sql: string): void
    close(): void
    // bun:sqlite 使用 transaction 方法
    transaction<T>(fn: () => T): () => T
}

/**
 * 包装 bun:sqlite Statement
 */
class BunSqliteStatementWrapper implements ISqliteStatement {
    constructor(private stmt: BunSqliteStatement) {}

    all(...params: any[]): any[] {
        return this.stmt.all(...params)
    }

    get(...params: any[]): any {
        return this.stmt.get(...params)
    }

    run(...params: any[]): ISqliteRunResult {
        const result = this.stmt.run(...params)
        return {
            changes: result.changes,
            lastInsertRowid: result.lastInsertRowid,
        }
    }
}

/**
 * 包装 bun:sqlite Database
 *
 * 主要差异处理：
 * 1. bun:sqlite 使用 query() 而不是 prepare()
 * 2. bun:sqlite 不支持自定义函数 function()
 * 3. bun:sqlite 没有 isOpen 属性
 * 4. bun:sqlite 的 transaction() API 不同于 better-sqlite3
 */
export class BunSqliteDriver implements ISqliteDatabase {
    private db: BunSqliteDatabase
    private stmtCache = new Map<string, BunSqliteStatementWrapper>()
    private _isOpen = true

    constructor(config: ISqliteDriverConfig) {
        // 动态导入 bun:sqlite
        let sqlite: { Database: new (filename: string) => BunSqliteDatabase }
        try {
            // @ts-ignore - bun:sqlite 是 Bun 特有模块
            sqlite = require("bun:sqlite")
        } catch (e) {
            throw new Error(
                "bun:sqlite 模块不可用。请确保在 Bun 运行时中运行，" + "或者切换到 better-sqlite3 或 node:sqlite 驱动。",
                { cause: e }
            )
        }

        this.db = new sqlite.Database(config.filename)

        // 配置 WAL 模式
        if (config.walMode !== false) {
            this.db.exec("PRAGMA journal_mode = WAL")
        }

        // 配置锁等待时间，避免多进程抢锁时立刻失败
        if (config.busyTimeout !== undefined) {
            this.db.exec(`PRAGMA busy_timeout = ${config.busyTimeout}`)
        }

        // 配置同步模式
        if (config.synchronous) {
            this.db.exec(`PRAGMA synchronous = ${config.synchronous}`)
        }
    }

    get isOpen(): boolean {
        return this._isOpen
    }

    prepare(sql: string): ISqliteStatement {
        // 使用缓存提高性能
        // bun:sqlite 使用 query() 而不是 prepare()
        let cached = this.stmtCache.get(sql)
        if (!cached) {
            cached = new BunSqliteStatementWrapper(this.db.query(sql))
            this.stmtCache.set(sql, cached)
        }
        return cached
    }

    exec(sql: string): void {
        this.db.exec(sql)
    }

    /**
     * bun:sqlite 不支持自定义函数
     * 
     * 这意味着使用 BunSqliteDriver 时：
     * - 无法使用 JsMatch 进行混合模式查询
     * - 无法使用 JsPatch 进行内存更新
     * - 所有查询必须使用纯 SQL 模式
     * 
     * @throws Error 始终抛出错误
     */
    function(_name: string, _fn: (...args: any[]) => any): void {
        throw new Error(
            "bun:sqlite 不支持自定义函数 (custom functions)。" +
            "使用 BunSqliteDriver 时，SQLiteAdapter 将无法使用混合查询模式 (JsMatch/JsPatch)。" +
            "如果需要完整功能，请切换到 better-sqlite3 或 node:sqlite 驱动。"
        )
    }

    /**
     * 包装 bun:sqlite 的 transaction() 方法
     * 
     * bun:sqlite 的 transaction() 签名: transaction<T>(fn: () => T): () => T
     * better-sqlite3 的 transaction() 签名: transaction<T>(fn: T): T & { immediate, exclusive, deferred }
     */
    transaction<T extends (...args: any[]) => any>(fn: T): ISqliteTransactionFn<T> {
        const self = this

        // 创建事务包装函数
        const txFn = function (this: any, ...args: any[]) {
            self.db.exec("BEGIN")
            try {
                const result = fn.apply(this, args)
                self.db.exec("COMMIT")
                return result
            } catch (e) {
                self.db.exec("ROLLBACK")
                throw e
            }
        } as T

        // 添加 immediate/exclusive/deferred 变体
        const immediateFn = function (this: any, ...args: any[]) {
            self.db.exec("BEGIN IMMEDIATE")
            try {
                const result = fn.apply(this, args)
                self.db.exec("COMMIT")
                return result
            } catch (e) {
                self.db.exec("ROLLBACK")
                throw e
            }
        } as T

        const exclusiveFn = function (this: any, ...args: any[]) {
            self.db.exec("BEGIN EXCLUSIVE")
            try {
                const result = fn.apply(this, args)
                self.db.exec("COMMIT")
                return result
            } catch (e) {
                self.db.exec("ROLLBACK")
                throw e
            }
        } as T

        const deferredFn = function (this: any, ...args: any[]) {
            self.db.exec("BEGIN DEFERRED")
            try {
                const result = fn.apply(this, args)
                self.db.exec("COMMIT")
                return result
            } catch (e) {
                self.db.exec("ROLLBACK")
                throw e
            }
        } as T

        // 组装返回对象
        const result = txFn as ISqliteTransactionFn<T>
        result.immediate = immediateFn
        result.exclusive = exclusiveFn
        result.deferred = deferredFn

        return result
    }

    checkpoint(mode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE" = "TRUNCATE"): void {
        if (this._isOpen) {
            this.db.exec(`PRAGMA wal_checkpoint(${mode})`)
        }
    }

    close(): void {
        this.stmtCache.clear()
        if (this._isOpen) {
            this.db.close()
            this._isOpen = false
        }
    }

    /**
     * 获取原始的 bun:sqlite Database 实例
     */
    getRawDatabase(): BunSqliteDatabase {
        return this.db
    }
}
