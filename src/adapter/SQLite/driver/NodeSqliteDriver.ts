/**
 * NodeSqliteDriver - node:sqlite 的 Driver 实现
 *
 * 包装 Node.js 22+ 内置的 node:sqlite 模块以符合 ISqliteDatabase 接口
 *
 * 注意事项：
 * 1. node:sqlite 从 Node.js 22.5.0 开始可用
 * 2. node:sqlite 不支持 db.transaction()，需要手动实现
 * 3. pragma 需要通过 db.exec() 执行
 */

import type {
    ISqliteDatabase,
    ISqliteStatement,
    ISqliteRunResult,
    ISqliteTransactionFn,
    ISqliteDriverConfig,
} from "./types"

import { createRequire } from "node:module"

// node:sqlite 类型定义（因为是内置模块，可能没有完整的类型定义）
interface NodeSqliteStatement {
    all(...params: any[]): any[]
    get(...params: any[]): any
    run(...params: any[]): { changes: number | bigint; lastInsertRowid: number | bigint }
}

interface NodeSqliteDatabase {
    isOpen: boolean
    prepare(sql: string): NodeSqliteStatement
    exec(sql: string): void
    function(name: string, options: { varargs?: boolean }, fn: (...args: any[]) => any): void
    function(name: string, fn: (...args: any[]) => any): void
    close(): void
}

/**
 * 包装 node:sqlite Statement
 */
class NodeSqliteStatementWrapper implements ISqliteStatement {
    constructor(private stmt: NodeSqliteStatement) {}

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
 * 包装 node:sqlite Database
 *
 * 主要差异处理：
 * 1. transaction() 需要手动实现（使用 BEGIN/COMMIT/ROLLBACK）
 * 2. function() 的签名略有不同
 * 3. isOpen 属性名称相同
 */
export class NodeSqliteDriver implements ISqliteDatabase {
    private db: NodeSqliteDatabase
    private stmtCache = new Map<string, NodeSqliteStatementWrapper>()

    constructor(config: ISqliteDriverConfig) {
        // 动态导入 node:sqlite
        // 使用 require 以支持 CommonJS 和条件加载
        let sqlite: { DatabaseSync: new (filename: string) => NodeSqliteDatabase }
        try {
            const require = createRequire(import.meta.url)
            sqlite = require("node:sqlite")
        } catch (e) {
            console.error(e)
            throw new Error(
                "node:sqlite 模块不可用。请确保使用 Node.js 22.5.0 或更高版本，" + "或者切换到 better-sqlite3 驱动。",
                {
                    cause: e,
                }
            )
        }

        this.db = new sqlite.DatabaseSync(config.filename)

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
        return this.db.isOpen
    }

    prepare(sql: string): ISqliteStatement {
        // 使用缓存提高性能
        let cached = this.stmtCache.get(sql)
        if (!cached) {
            cached = new NodeSqliteStatementWrapper(this.db.prepare(sql))
            this.stmtCache.set(sql, cached)
        }
        return cached
    }

    exec(sql: string): void {
        this.db.exec(sql)
    }

    function(name: string, fn: (...args: any[]) => any): void {
        // node:sqlite 的 function 签名: function(name, [options,] fn)
        // 使用 varargs: true 支持可变参数
        this.db.function(name, { varargs: true }, fn)
    }

    /**
     * 模拟 better-sqlite3 的 transaction() 行为
     *
     * better-sqlite3 的 transaction() 返回一个函数，调用时会自动包装在事务中
     * node:sqlite 没有这个 API，需要手动实现
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
        if (this.db.isOpen) {
            this.db.exec(`PRAGMA wal_checkpoint(${mode})`)
        }
    }

    close(): void {
        this.stmtCache.clear()
        if (this.db.isOpen) {
            this.db.close()
        }
    }

    /**
     * 获取原始的 node:sqlite Database 实例
     */
    getRawDatabase(): NodeSqliteDatabase {
        return this.db
    }
}
