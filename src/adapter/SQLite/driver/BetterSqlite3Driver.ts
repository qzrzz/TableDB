/**
 * BetterSqlite3Driver - better-sqlite3 的 Driver 实现
 *
 * 包装 better-sqlite3 以符合 ISqliteDatabase 接口
 */

import type Database from "better-sqlite3"
import type {
    ISqliteDatabase,
    ISqliteStatement,
    ISqliteRunResult,
    ISqliteTransactionFn,
    ISqliteDriverConfig,
} from "./types"

import { createRequire } from "node:module"

/**
 * 包装 better-sqlite3 Statement
 */
class BetterSqlite3Statement implements ISqliteStatement {
    constructor(private stmt: Database.Statement) {}

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
 * 包装 better-sqlite3 Database
 */
export class BetterSqlite3Driver implements ISqliteDatabase {
    private db: Database.Database
    private stmtCache = new Map<string, BetterSqlite3Statement>()

    constructor(config: ISqliteDriverConfig) {
        // 动态导入 better-sqlite3（避免在不需要时加载）
        // better-sqlite3 导出的是一个类构造函数
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const require = createRequire(import.meta.url)
        const BetterSqlite3 = require("better-sqlite3") as typeof import("better-sqlite3")
        this.db = new BetterSqlite3(config.filename)

        // 配置 WAL 模式
        if (config.walMode !== false) {
            this.db.pragma("journal_mode = WAL")
        }

        // 配置锁等待时间，避免多进程抢锁时立刻失败
        if (config.busyTimeout !== undefined) {
            this.db.pragma(`busy_timeout = ${config.busyTimeout}`)
        }

        // 配置同步模式
        if (config.synchronous) {
            this.db.pragma(`synchronous = ${config.synchronous}`)
        }
    }

    get isOpen(): boolean {
        return this.db.open
    }

    prepare(sql: string): ISqliteStatement {
        // 使用缓存提高性能
        let cached = this.stmtCache.get(sql)
        if (!cached) {
            if (this.stmtCache.size >= 512) {
                const oldest = this.stmtCache.keys().next().value
                if (oldest) this.stmtCache.delete(oldest)
            }
            cached = new BetterSqlite3Statement(this.db.prepare(sql))
            this.stmtCache.set(sql, cached)
        }
        return cached
    }

    exec(sql: string): void {
        this.db.exec(sql)
    }

    function(name: string, fn: (...args: any[]) => any): void {
        this.db.function(name, fn)
    }

    transaction<T extends (...args: any[]) => any>(fn: T): ISqliteTransactionFn<T> {
        return this.db.transaction(fn) as unknown as ISqliteTransactionFn<T>
    }

    checkpoint(mode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE" = "TRUNCATE"): void {
        if (this.db.open) {
            this.db.pragma(`wal_checkpoint(${mode})`)
        }
    }

    close(): void {
        this.stmtCache.clear()
        if (this.db.open) {
            this.db.close()
        }
    }

    /**
     * 获取原始的 better-sqlite3 Database 实例
     * 用于需要直接访问底层 API 的场景（如 zstd 压缩）
     */
    getRawDatabase(): Database.Database {
        return this.db
    }
}
