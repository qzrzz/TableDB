---
sort: 1
icon: ri-triangular-flag-fill
---

# 使用数据库

## 快速开始

TableDB 把所有配置的工作都集中在定义的阶段， 这样使用 Table 来存取数据时就非常简单。

1. 定义表 (`defineTable()`)
2. 获取表实例 (`useTable()`)
3. 操作数据 (`insertMany`, `findMany`...)

```ts @full
import { defineTable, SQLiteAdapter } from "tbdb"

// 1. 定义 Table，并得到 useTable 函数
let useMemberTable = defineTable({
    name: "Member",
    adapter: SQLiteAdapter({ filename: "./member.sqlite" }),
})

// 2.使用 useTable 创建 Table 实例
let memberTable = await useMemberTable()

// 3.使用 Table 实例进行数据操作
await memberTable.insertMany([
    {
        id: "member1",
        name: "Alice",
        age: 30,
    },
])

let members = await memberTable.findMany({ age: { $gt: 20 } })
```

## 适配器

TableDB 支持多种数据库适配器，用来让不同的存储后端与 TableDB 无缝集成。

### `SQLiteAdapter`

针对 SQLite 的数据库适配器，支持 Node.js 和 Bun 环境。

```ts @full
// 内存数据库，适合测试和临时数据存储
const sqliteMemory = SQLiteAdapter({ filename: ":memory:" })
// 文件数据库，适合持久化存储
const sqliteFile = SQLiteAdapter({ filename: "./data.sqlite" })

let useDraftTable = defineTable({
    name: "Draft",
    adapter: sqliteFile,
})
```

| 参数       | 说明                                                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `filename` | SQLite 数据库文件路径，使用 `:memory:` 可创建一个内存数据库。                                                                     |
| `safe`     | 是否启用安全模式，会牺牲性能降低数据安全性，相当于 `synchronous=NORMAL`，可以设置为 `full` 获得更高的数据安全性。默认为 `false`。 |
| `multi`    | 是否启用多进程访问支持，会启用 WAL 模式并设置合理的锁等待时间，适合多个进程同时访问同一个数据库文件的场景。默认为 `false`。       |
| `zstd`     | 会用 zstd 压缩数据库文件，减少体积。 （打开文件前解压，关闭文件时压缩）                                                           |
| `driver`   | 指定 SQLite 的底层接口：`better-sqlite3`、`node:sqlite`、`bun:sqlite`、`auto`，默认为 `auto`                                      |

### `MongoDBAdapter`

针对 MongoDB 的数据库适配器。

```ts @full
import { defineTable, MongoDBAdapter } from "tbdb"

let useMemberTable = defineTable({
    name: "Member",
    adapter: MongoDBAdapter({
        auth: "mongodb://localhost:27017",
        dbName: "app",
    }),
})
```

### `IndexedDBAdapter`

用于浏览器或 Nodejs、Bun 环境下的 `IndexedDB` 的数据库适配器。

```ts @full
import { defineTable, IndexedDBAdapter } from "tbdb"

let useDraftTable = defineTable({
    name: "Draft",
    adapter: IndexedDBAdapter({
        dbName: "TableDBDemo",
    }),
})
```

## 全局适配器

你可以通过 `defineGlobalDBAdapter()` 定义一个全局适配器，这样在定义表时就不需要每次都指定适配器了。

```ts
import { defineGlobalDBAdapter, defineTable, SQLiteAdapter } from "tbdb"

// 定义全局适配器，所有表默认使用这个适配器
defineGlobalDBAdapter(SQLiteAdapter({ filename: "./data/app.sqlite" }))

// 不用每次定义表时都指定 adapter 了
const useUserTable = defineTable({
    name: "user",
})
```
