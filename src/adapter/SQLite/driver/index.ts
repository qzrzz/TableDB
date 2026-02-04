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

import type { ISqliteDatabase, ISqliteDriverConfig, SqliteDriverType } from "./types"
import { BetterSqlite3Driver } from "./BetterSqlite3Driver"
import { NodeSqliteDriver } from "./NodeSqliteDriver"
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
        default:
            throw new Error(`不支持的 SQLite 驱动类型: ${type}`)
    }
}

/**
 * 自动检测并创建可用的 SQLite Driver
 *
 * 支持环境变量 TABLEDB_SQLITE_DRIVER 指定优先使用的驱动类型
 *
 * 优先使用 better-sqlite3（兼容性更好），如果不可用则尝试 node:sqlite
 *
 * @param config 驱动配置
 * @returns SQLite 数据库实例和使用的驱动类型
 */
export function createAutoSqliteDriver(config: ISqliteDriverConfig): { db: ISqliteDatabase; type: SqliteDriverType } {
    // 传入当前文件的 URL，以确保 require 的相对路径解析正确
    const require = createRequire(import.meta.url)

    const envDriver = process.env.TABLEDB_SQLITE_DRIVER as SqliteDriverType | undefined

    const candidates: SqliteDriverType[] = envDriver
        ? [envDriver, envDriver === "better-sqlite3" ? "node:sqlite" : "better-sqlite3"]
        : ["better-sqlite3", "node:sqlite"]

    if (envDriver && envDriver !== "better-sqlite3" && envDriver !== "node:sqlite") {
        throw new Error(`无效的 TABLEDB_SQLITE_DRIVER 值: ${envDriver}. 仅支持 "better-sqlite3" 或 "node:sqlite"`)
    }

    const factories: Record<SqliteDriverType, () => ISqliteDatabase> = {
        "better-sqlite3": () => {
            require.resolve("better-sqlite3")
            return new BetterSqlite3Driver(config)
        },
        "node:sqlite": () => {
            require("node:sqlite")
            return new NodeSqliteDriver(config)
        },
    }

    for (const d of candidates) {
        try {
            return { db: factories[d](), type: d }
        } catch (e: any) {
            console.error(e)
            // 候选不可用 -> 继续
        }
    }

    throw new Error(
        "没有可用的 SQLite 驱动。请安装 better-sqlite3 (npm install better-sqlite3) " +
            "或使用 Node.js 22.5.0+ 以使用内置的 node:sqlite 模块。"
    )
}

/**
 * 检查指定的 SQLite 驱动是否可用
 */
export function isSqliteDriverAvailable(type: SqliteDriverType): boolean {
    try {
        if (type === "better-sqlite3") {
            require.resolve("better-sqlite3")
            return true
        }
        if (type === "node:sqlite") {
            require("node:sqlite")
            return true
        }
    } catch {
        return false
    }
    return false
}
