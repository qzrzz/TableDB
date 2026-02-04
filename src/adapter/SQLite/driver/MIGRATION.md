# SQLite Driver 抽象层迁移指南

本文档说明如何使用 `SQLiteAdapter` 的多驱动支持功能。

## 概述

`SQLiteAdapter` 现在支持三种 SQLite 驱动：

- **better-sqlite3** - 第三方高性能 SQLite 绑定（需要安装依赖，功能完整）
- **node:sqlite** - Node.js 22.5+ 内置模块（无需安装额外依赖，功能完整）
- **bun:sqlite** - Bun 内置模块（仅 Bun 运行时，不支持自定义函数）

## 快速使用

```typescript
import { SQLiteAdapter } from "tbdb"

// 方式 1: 自动选择驱动（推荐）
// - Bun 环境：自动使用 bun:sqlite
// - Node 环境：优先 better-sqlite3，不可用时退回 node:sqlite
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

// 方式 4: 指定使用 bun:sqlite（仅 Bun 运行时）
// 注意：bun:sqlite 不支持自定义函数，无法使用混合查询模式
const adapter4 = SQLiteAdapter({
    filename: "data.db",
    driver: "bun:sqlite"
})
```

## 自动选择逻辑

当 `driver: "auto"` 时（默认值），驱动选择逻辑如下：

1. **Bun 环境**：直接使用 `bun:sqlite`
2. **Node 环境**：
   - 优先使用环境变量 `TABLEDB_SQLITE_DRIVER` 指定的驱动
   - 其次尝试 `better-sqlite3`
   - 如果 `better-sqlite3` 不可用，退回 `node:sqlite`

```bash
# 通过环境变量指定驱动（Node 环境）
TABLEDB_SQLITE_DRIVER=node:sqlite node app.js
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
     * - "bun:sqlite": 使用 Bun 内置模块（不支持自定义函数）
     * - "auto": 自动选择（默认，优先 better-sqlite3 > node:sqlite）
     */
    driver?: "better-sqlite3" | "node:sqlite" | "bun:sqlite" | "auto"
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

if (isSqliteDriverAvailable("bun:sqlite")) {
    console.log("bun:sqlite 可用（Bun 运行时）")
}
```

## 兼容性矩阵

| 功能 | better-sqlite3 | node:sqlite | bun:sqlite |
|------|----------------|-------------|------------|
| 基本 CRUD | ✅ | ✅ | ✅ |
| MongoDB 风格查询 | ✅ | ✅ | ✅ |
| 事务 | ✅ | ✅ | ✅ |
| 自定义函数 | ✅ | ✅ | ❌ |
| 混合查询模式 (JsMatch/JsPatch) | ✅ | ✅ | ❌ |
| 索引 | ✅ | ✅ | ✅ |
| 侧表优化 | ✅ | ✅ | ✅ |
| ZSTD 压缩 | ✅ | ✅ | ✅ |
| 最低运行时版本 | Node.js 14+ | Node.js 22.5+ | Bun |
| 需要安装依赖 | 是 | 否 | 否 |

## bun:sqlite 限制说明

⚠️ **重要**：`bun:sqlite` 不支持自定义 SQL 函数，这意味着：

1. **无法使用混合查询模式**：JsMatch 和 JsPatch 函数无法注册
2. **所有查询必须使用纯 SQL 模式**：复杂的 MongoDB 语义查询可能无法正确执行
3. **自动选择不包含 bun:sqlite**：为避免功能受限，自动选择模式不会选择 bun:sqlite

如需使用 `bun:sqlite`，请通过以下方式显式指定：

```typescript
// 方式 1: 代码中指定
const adapter = SQLiteAdapter({
    filename: "data.db",
    driver: "bun:sqlite"
})

// 方式 2: 环境变量指定
// TABLEDB_SQLITE_DRIVER=bun:sqlite
```

## 高级用法：直接使用 Driver

如果你需要直接使用底层的 Driver 抽象层：

```typescript
import { 
    createSqliteDriver, 
    createAutoSqliteDriver,
    BetterSqlite3Driver,
    NodeSqliteDriver,
    BunSqliteDriver,
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
