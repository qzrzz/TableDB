/**
 * SQLite Driver 统一导出
 * 
/**
 * SQLite Driver 统一导出
 *
 * 提供 better-sqlite3 和 node:sqlite 两种驱动的统一接口
 */

export * from "./types"
export { BetterSqlite3Driver } from "./BetterSqlite3Driver"
export { NodeSqliteDriver } from "./NodeSqliteDriver"
export { BunSqliteDriver } from "./BunSqliteDriver"

import type { ISqliteDatabase, ISqliteDriverConfig, SqliteDriverType } from "./types"
import { BetterSqlite3Driver } from "./BetterSqlite3Driver"
import { NodeSqliteDriver } from "./NodeSqliteDriver"
import { BunSqliteDriver } from "./BunSqliteDriver"
import { createRequire } from "node:module"

/**
 * 创建 SQLite Driver 实例
 *
 * @param type 驱动类型: "better-sqlite3" 或 "node:sqlite"
 * @param config 驱动配置
 * @returns SQLite 数据库实例
 *
 * @example
 * ```ts
 * // 使用 better-sqlite3（默认，兼容性更好）
 * const db = createSqliteDriver("better-sqlite3", { filename: "test.db" })
 *
 * // 使用 node:sqlite（Node.js 22.5+ 内置，无需安装依赖）
 * const db = createSqliteDriver("node:sqlite", { filename: "test.db" })
 * ```
 */
export function createSqliteDriver(type: SqliteDriverType, config: ISqliteDriverConfig): ISqliteDatabase {
    switch (type) {
        case "better-sqlite3":
            return new BetterSqlite3Driver(config)
        case "node:sqlite":
            return new NodeSqliteDriver(config)
        case "bun:sqlite":
            return new BunSqliteDriver(config)
        default:
            throw new Error(`不支持的 SQLite 驱动类型: ${type}`)
    }
}

/**
 * 检测当前是否在 Bun 运行时环境中
 */
function isBunRuntime(): boolean {
    // @ts-ignore - Bun 全局变量
    return typeof Bun !== "undefined"
}

/**
 * 自动检测并创建可用的 SQLite Driver
 *
 * 选择逻辑：
 * 1. Bun 环境：直接使用 bun:sqlite
 * 2. Node 环境：
 *    - 优先使用环境变量 TABLEDB_SQLITE_DRIVER 指定的驱动
 *    - 其次使用 better-sqlite3
 *    - 如果 better-sqlite3 不可用，退回 node:sqlite
 *
 * @param config 驱动配置
 * @returns SQLite 数据库实例和使用的驱动类型
 */
export function createAutoSqliteDriver(config: ISqliteDriverConfig): { db: ISqliteDatabase; type: SqliteDriverType } {
    // Bun 环境：直接使用 bun:sqlite
    if (isBunRuntime()) {
        return { db: new BunSqliteDriver(config), type: "bun:sqlite" }
    }

    // Node 环境
    const require = createRequire(import.meta.url)
    const envDriver = process.env.TABLEDB_SQLITE_DRIVER as SqliteDriverType | undefined

    // 验证环境变量值
    if (envDriver && !["better-sqlite3", "node:sqlite", "bun:sqlite"].includes(envDriver)) {
        throw new Error(`无效的 TABLEDB_SQLITE_DRIVER 值: ${envDriver}. 仅支持 "better-sqlite3", "node:sqlite" 或 "bun:sqlite"`)
    }

    // 如果指定了环境变量，优先使用
    if (envDriver) {
        try {
            return { db: createSqliteDriver(envDriver, config), type: envDriver }
        } catch (e) {
            console.warn(`[SQLiteAdapter] 环境变量指定的驱动 ${envDriver} 不可用，将尝试其他驱动`)
        }
    }

    // 尝试 better-sqlite3
    try {
        require.resolve("better-sqlite3")
        return { db: new BetterSqlite3Driver(config), type: "better-sqlite3" }
    } catch {
        // better-sqlite3 不可用
    }

    // 退回 node:sqlite
    try {
        require("node:sqlite")
        return { db: new NodeSqliteDriver(config), type: "node:sqlite" }
    } catch {
        // node:sqlite 不可用
    }

    throw new Error(
        "没有可用的 SQLite 驱动。请安装 better-sqlite3 (npm install better-sqlite3)，" +
        "或使用 Node.js 22.5.0+ 以使用内置的 node:sqlite 模块。"
    )
}

/**
 * 检查指定的 SQLite 驱动是否可用
 */
export function isSqliteDriverAvailable(type: SqliteDriverType): boolean {
    const require = createRequire(import.meta.url)
    try {
        if (type === "better-sqlite3") {
            require.resolve("better-sqlite3")
            return true
        }
        if (type === "node:sqlite") {
            require("node:sqlite")
            return true
        }
        if (type === "bun:sqlite") {
            // @ts-ignore - bun:sqlite 是 Bun 特有模块
            require("bun:sqlite")
            return true
        }
    } catch {
        return false
    }
    return false
}
