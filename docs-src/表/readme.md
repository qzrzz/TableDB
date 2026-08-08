---
sort: 2
icon: ri-table-view
---

# 表 | Table

`Table` 是 TableDB 的核心操作对象。你可以把它理解成“一个带类型信息、带查询能力、带扩展功能的文档集合”，它负责把统一的增删改查 API 映射到不同数据库适配器上。

在使用上，Table 通常分成两步：

1. 用 `defineTable()` 定义表配置
2. 调用 `useTable()` 获取 `Table` 实例后执行操作

## 一个最小示例

```ts @full
import { defineTable, SQLiteAdapter } from "tbdb"
import { dto } from "fzz"

const { String, Number } = dto

class UserSchema {
    id: string = String()
    name: string = String()
    age: number = Number()
}

const useUserTable = defineTable({
    name: "user",
    schema: new UserSchema(),
    adapter: SQLiteAdapter({ filename: "./data/user.sqlite" }),
})

const userTable = await useUserTable()
await userTable.insertOne({ id: "u_1", name: "Alice", age: 20 })
```

## 定义表 `defineTable`

通过 `defineTable` 定义 Table，并返回一个 `useTable` 函数，调用 `useTable` 后得到 `Table` 实例。

```ts
const useUserTable = defineTable({
    name: "user",
    schema: new UserSchema(),
    indexes: [{ key: "name" }],
    enableAutoMetadata: true,
    enableMarkDelete: true,
    projections: {
        min: ["id", "name"],
        full: {},
    },
})
```

- `name` 决定底层的表名或集合名
- `schema` 用来提供类型提示、索引信息和部分检查能力
- `adapter` 决定底层使用 SQLite、MongoDB 还是其他适配器
- `indexes` 定义索引，优先级高于 schema 中的索引配置
- `enableAutoMetadata` 启用后会自动维护 `_createDate`、`_updateDate`、`_deleteDate`
- `enableMarkDelete` 启用后删除操作会写入 `_isDeleted`，而不是物理删除
- `projections` 预设一些可复用的投影配置，方便查询时直接使用
x
### 适配器配置

调用 `useTable()` 时提供 `adapter` 参数，也可以覆盖 `defineTable` 定义的 adapter：

```ts
const userTable = await useUserTable({
    adapter: SQLiteAdapter({ filename: ":memory:" }),
})
```

优先级：

1. `userTable()` 参数
2. `defineTable()` 参数
3. [全局适配器](/units/docs-src-u4f7fu7528u6570u636eu5e93#%E5%85%A8%E5%B1%80%E9%80%82%E9%85%8D%E5%99%A8) `defineGlobalDBAdapter()`

## 创建 Table 实例 `useTable()`

`defineTable` 定义 Table 后会返回一个 `useTable` 函数，调用 `useTable` 后得到 `Table` 实例。
在调用 `useTable` 时可以传入参数覆盖 `defineTable` 定义的配置。

最佳实践是在一个 `.table.ts` 文件里定义好 `useTable`，然后导出它，在应用代码中导入 `useTable` 函数，通过调用 `useTable` 来获取 `Table` 实例。

```ts
import { defineTable, SQLiteAdapter } from "tbdb"

export const useUserTable = defineTable({...})

// 使用 useTable 创建 Table 实例
// 可以传入参数以覆盖 defineTable 定义的配置
let userTable = await useUserTable({
	adapter: SQLiteAdapter({ filename: ":memory:" }),
})

// 可以使用 table 来操作数据了
userTable.insertOne({
    id: "user1",
    name: "Alice",
    age: 30,
})
```

## 定义 Schema

TableDB 的 Schema 不是传统的关系型数据库的表结构定义，而是对存储在 Table 中的文档类型进行定义，更多的是给 TypeScript 提供类型支持，并不在数据库层面进行强制约束，所以即使定义了 Schema，也不会影响数据库的实际存储结构。

不过 Schema 还可以定义一些 metadata 信息，比如可以用来定义索引。

Schema 使用 `fzz` 的 `dto` 类型库来定义：

```ts
import { dto } from "fzz"
class UserSchema {
    id = dto.String({ index: { unique: true } })
    name = dto.String({ index: true })
    age = dto.Number()
}
```

## 预设投影 `projections`

Table 定义中 `projections` 参数可以预设一系列 `projection`，各种查询方法中的 `options.projection` 就可以直接使用这些预设的投影：

```ts
const useUserTable = defineTable({
    name: "user",
    projections: {
        min: ["id", "name"], // 数组表示仅包含哪些字段
        full: {}, // 空对象表示不做任何投影，返回完整文档
    },
})

const list = await userTable.findMany(
    {},
    {
        // 直接使用预设的 projection
        // 为了安全起见，如果给定名称没有找到 projection 会抛错
        projection: "min",
    },
)
```

## 定义索引 `indexes`

在 Table 中定义的 `indexes` 可以用来创建数据库索引，

```ts
indexes?: ITableIndexConfig[]
```

@import "../../src/adapter/adapter.ts" @only=ITableIndexConfig @title=索引数据类型

## 额外功能

### 自动维护元数据 `enableAutoMetadata`

启用后会在文档更新时自动维护 `_createDate`、`_updateDate`、`_deleteDate` 字段

### 标记删除 `enableMarkDelete`

启用后删除操作会写入 `_isDeleted` 字段，而不是物理删除

可以在操作的 `options` 中指定 `readDelete: true` 可以物理删除文档

```ts
table.deleteOne({ id: "1" }, { readDelete: true })
```
