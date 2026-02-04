# SQLite Driver 抽象层迁移指南

本文档说明如何使用 `SQLiteAdapter` 的多驱动支持功能。

## 概述

`SQLiteAdapter` 现在支持两种 SQLite 驱动：

- **better-sqlite3** - 第三方高性能 SQLite 绑定（需要安装依赖）
- **node:sqlite** - Node.js 22.5+ 内置模块（无需安装额外依赖）

## 快速使用

```typescript
import { SQLiteAdapter } from "tbdb"

// 方式 1: 自动选择驱动（推荐）
// 优先使用 better-sqlite3，不可用时自动切换到 node:sqlite
const adapter = SQLiteAdapter({
    filename: "data.db",
    driver: "auto"  // 默认值
})

// 方式 2: 指定使用 better-sqlite3
const adapter2 = SQLiteAdapter({
    filename: "data.db",
    driver: "better-sqlite3"
})

// 方式 3: 指定使用 node:sqlite（需要 Node.js 22.5+）
const adapter3 = SQLiteAdapter({
    filename: "data.db",
    driver: "node:sqlite"
})
```

## 配置选项

```typescript
interface SQLiteAdapterConfig {
    /** 数据库文件路径，":memory:" 表示内存数据库 */
    filename: string
    
    /** 
     * 安全模式配置
     * - false/undefined: synchronous=OFF，性能最高
     * - true: synchronous=NORMAL，平衡性能和安全
     * - "full": synchronous=FULL，最安全
     */
    safe?: boolean | "full"
    
    /** 是否启用 ZSTD 压缩（打开文件前解压，关闭文件时压缩） */
    zstd?: boolean
    
    /** 
     * SQLite 驱动类型
     * - "better-sqlite3": 使用 better-sqlite3
     * - "node:sqlite": 使用 Node.js 内置模块
     * - "auto": 自动选择（默认）
     */
    driver?: "better-sqlite3" | "node:sqlite" | "auto"
}
```

## 驱动检测 API

```typescript
import { isSqliteDriverAvailable } from "tbdb/adapter/SQLite"

// 检查驱动是否可用
if (isSqliteDriverAvailable("node:sqlite")) {
    console.log("node:sqlite 可用（Node.js 22.5+）")
}

if (isSqliteDriverAvailable("better-sqlite3")) {
    console.log("better-sqlite3 已安装")
}
```

## 兼容性矩阵

| 功能 | better-sqlite3 | node:sqlite |
|------|----------------|-------------|
| 基本 CRUD | ✅ | ✅ |
| MongoDB 风格查询 | ✅ | ✅ |
| 事务 | ✅ | ✅ |
| 自定义函数 | ✅ | ✅ |
| 索引 | ✅ | ✅ |
| 侧表优化 | ✅ | ✅ |
| ZSTD 压缩 | ✅ | ✅ |
| 最低 Node.js 版本 | 14+ | 22.5+ |
| 需要安装依赖 | 是 | 否 |

## 高级用法：直接使用 Driver

如果你需要直接使用底层的 Driver 抽象层：

```typescript
import { 
    createSqliteDriver, 
    createAutoSqliteDriver,
    BetterSqlite3Driver,
    NodeSqliteDriver,
    type ISqliteDatabase
} from "tbdb/adapter/SQLite"

// 直接创建 Driver 实例
const db: ISqliteDatabase = createSqliteDriver("node:sqlite", {
    filename: ":memory:",
    walMode: true,
    synchronous: "OFF"
})

// 使用统一的 API
db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)")
const stmt = db.prepare("INSERT INTO test (id, name) VALUES (?, ?)")
stmt.run(1, "Alice")

const row = db.prepare("SELECT * FROM test WHERE id = ?").get(1)
console.log(row) // { id: 1, name: "Alice" }

// 事务
const tx = db.transaction(() => {
    stmt.run(2, "Bob")
    stmt.run(3, "Charlie")
})
tx()

db.close()
```

## ZSTD 压缩功能

ZSTD 压缩是 SQLiteAdapter 的文件级别功能，与 SQLite 驱动无关，两种驱动都支持：

- **打开文件时**：检测文件是否为 ZSTD 压缩格式，如果是则自动解压
- **关闭文件时**：执行 WAL checkpoint 并压缩数据库文件

```typescript
// ZSTD 压缩示例（两种驱动都支持）
const adapter = SQLiteAdapter({
    filename: "data.db",
    zstd: true  // 启用 ZSTD 压缩
})
```
