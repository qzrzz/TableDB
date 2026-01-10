# TableDB

一个非常简单的 NoSQL 数据库抽象层，提供类似 MongoDB 的增删改查 API，支持多种存储后端（SQLite, MongoDB）。

-   对 JavaScript 内置数据类型完全支持，可以把 `Date`, `Map`, `RegExp`,`ArrayBuffer`, `Blob` 等类型直接存入 TableDB，再出取出后数据类型不变。
-   类似 MongoDB 的查询和更新语法，并且提供“分页”、“游标分页”、“批量遍历”等实用功能。
-   可以方便的切换不同的数据库存储后端（SQLite, MongoDB），非常适合跨平台、多端应用程序。
-   支持常见数据模式如：
    -   `autoMetadata` 自动元数据（创建时间，修改时间）
    -   `markDelete` 标记删除
    -   `tree` 目录树存储

## 文件说明

-   接口类型：`./core/types.ts`, `./adapter/adapter.ts`
-   核心类：`./core/Table.ts`
-   适配器实现：`./adapter/`

## 使用

Table 使用分为 2 个步骤，所有配置的工作都集中在定义的阶段，
这样使用 Table 来存取数据时就非常简单。

1. 定义 Table（可选 Schema）
2. 创建并使用 Table 实例

### 定义 Table

Table 的定义主要是配置：

-   在数据库中的表名（`name`）
-   文档类型定义（`schema`）
-   使用什么数据库实现（`adapter`）
-   其他功能扩展的配置（如 `enableMarkDelete`）

### 定义 Schema

TableDB 的 Schema 不是传统的关系型数据库的表结构定义，而是对存储在 Table 中的文档类型进行定义，
更多的是给 TypeScript 提供类型支持，并不在数据库层面进行强制约束。

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

### 定义 useTable 函数

我们可以使用 `defineTable` 来定义一个 `useTable` 函数

```ts
import { defineTable, SQLiteAdapter } from "fzz/src/only/tableDB"

let useUserTable = defineTable({
    name: "User",
    schema: new UserSchema(),
    adapter: SQLiteAdapter({ filename: ":memory:" }),
})

// 使用 useTable 创建 Table 实例
let userTable = await useUserTable()

// 可以使用 table 来操作数据了
userTable.insertOne({
    id: "user1",
    name: "Alice",
    age: 30,
})
```

### 定义全局 Adapter

我们可以在 `defineTable()` 通过定义`adapter` 来决定 Table 使用什么数据库存储，
但是每次定义 Table 都要指定一遍 adapter 会比较麻烦，并且也不方便切换数据库实现。

使用推荐使用 `defineGlobalDBAdapter()` 来定义全局的数据库适配器，
这样 `defineTable()` 就不需要每次都指定 adapter 了。

```ts
import { defineTable, defineGlobalDBAdapter, SQLiteAdapter } from "fzz/src/only/tableDB"

// 定义全局的数据库适配器
defineGlobalDBAdapter(SQLiteAdapter({ filename: ":memory:" }))

let useUserTable = defineTable({
    name: "User",
    schema: new UserSchema(),
    // 不指定 adapter 时会使用全局的 adapter
    // 如果指定了 adapter 则会覆盖全局的 adapter
})
```

某些情况下，我们可能需要更灵活的为 Table 指定不同的 adapter，
可以在 `useTable` 函数调用时传入 `adapter` 参数来覆盖 adapter 选项

```ts
import { defineTable, SQLiteAdapter } from "fzz/src/only/tableDB"

let useUserTable = defineTable({
    name: "User",
    schema: new UserSchema(),
})

let userTable = await useUserTable({
    adapter: SQLiteAdapter({ filename: ":memory:" }),
})
```

## 增删改查

### 增加文档

-   `insertOne(doc)` 插入单个新文档
-   `insertMany(docs)` 插入多个新文档
-   `setMany(docs)` 批量设置文档（有则更新，无则插入）

```ts
let userTable = await useUserTable()

await userTable.insertMany([
    {
        id: "user1",
        name: "Alice",
        age: 30,
    },
])
```

### 查询文档

-   `findOne(filter)` 查找一个符合 `filter` 的文档
-   `findMany(filter, options)` 查找全部符合 `filter` 的文档

```ts
let userTable = await useUserTable()

let users: UserSchema[] = await userTable.findMany({ age: { $gt: 20 } })
```

### 删除文档

-   `deleteOne(filter)` 删除一个符合 `filter` 的文档
-   `deleteMany(filter)` 删除多个符合 `filter` 的文档

```ts
let userTable = await useUserTable()
await userTable.deleteMany({ id: { $in: ["id1", "id2"] } })
```

### 更新文档

-   `updateOne(filter, update)` 更新一个符合 `filter` 的文档
-   `updateMany(filter, update)` 更新多个符合 `filter` 的文档
-   `bulkUpdate(updates:{ filter, update }[])` 批量更新文档
-   `setMany(docs)` 批量设置文档（有则更新，无则插入）

```ts
let userTable = await useUserTable()
await userTable.updateMany({ age: { $lt: 18 } }, { $set: { isMinor: true } })
```

### 遍历文件

-   `forEach(filter, callback)` 遍历符合 `filter` 的文档，逐个文档执行 `callback`，适合少量数据
-   `eachBatch(filter, options, callback)` 遍历符合 `filter` 的文档，一批文档执行 `callback`，适合大量数据

-   `listPaging(filter, options)` 使用分页列出符合 `filter` 的文档，适合要求分页并且要跳转到指定页的场景，但性能较低

-   `listPagingByCursor(filter, options)` 使用游标分页列出符合 `filter` 的文档，高性能但无法跳转指定页，适合大量数据

## 数据类型

TableDB 的设计目标是与 JavaScript 保持一致的类型存储，
可以把 JavaScript 对象直接存入 TableDB 中，并且能查询后保持数据类型不变。

支持数据类型：

-   `string`, `number`, `boolean`, `null`, `undefined`, `Date`, `Map`, `Set`, `bigint`
-   `Blob`, `File`, `ArrayBuffer`
-   `Int8Array`, `Int16Array`, `Int32Array`, `Uint8Array`, `Uint8ClampedArray`, `Uint16Array`, `Uint32Array`, `Float32Array`, `Float64Array`, `BigInt64Array`, `BigUint64Array`

#### `undefined` 与 `null`

TableDB 中 `undefined` 和 `null` 的处理与 MongoDB 保持一致。也就是说，你明确设置为 `undefined` 的字段，取出后是 `null`。

查询行为：

-   相等查询 `{ key: null }`

    -   匹配 `key` 字段值为 `null` 的文档
    -   同时也匹配不包含 `key` 字段的文档（缺失字段被视为 `null`）

-   不等查询 `{ key: { $ne: null } }`

    -   仅匹配 `key` 字段存在且值不为非 `null` 的文档
    -   不匹配缺失 `key` 字段的文档

-   存在性查询 `{ key: { $exists: false } }`

    -   匹配 `key` 字段存在且值不为 null 的文档
    -   不匹配缺失 `key` 字段的文档

-   精确匹配 `null` `{ key: { $type: 10 } }` （SQLite 不支持）

    -   仅匹配 `key` 字段存在且值为 `null` 的文档 (10 是 BSON Null 类型码)
    -   不匹配缺失 `key` 字段的文档

所以简单来说，用 `null` 来代替 `undefined`，用 `val == null` 或者来判断类型，用 `null` 来匹配。

## 过滤器与操作符

TableDB 支持类似 MongoDB 的查询和更新的操作符，主要分为 3 种

-   `filter`：查询过滤器，用于指定查询条件
-   `updateOp`：更新命令，用于指定更新操作
-   `mergeDoc`： 合并文档，覆盖式设置文档内容

### `filter`

`filter` 用于指定查询条件，通常可以用对象字面量来表示：

```ts
// 匹配 name 为 "Alice" 且 age 为 30 的文档
table.findMany({ name: "Alice", age: 30 })
```

如果`fitler` 中包含对象，这表示要进行对象匹配：

```ts
// 文档 { ob: { a:1, b:2 }, ... }
// 匹配 ob 完全等于 { a:1, b:2 } 的文档
table.findMany({ ob: { a: 1, b: 2 } })
```

要注意如果要匹配多层对象中的字段，不能直接使用嵌套对象，而是要使用点号语法，用 `.` 来表示嵌套字段：

```ts
// 文档 { ob: { a:1, b:2 }, ... }
// 匹配 ob.b 为 2 的文档
table.findMany({ "ob.b": 2 })
```

除了简单的值匹配，`filter` 还支持使用操作符来进行更复杂的查询条件：

#### 逻辑组合

-   `$and: [ filter1, filter2, ... ]`：与逻辑，所有子条件都必须满足
-   `$or: [ filter1, filter2, ... ]`：或逻辑
-   `$nor: [ filter1, filter2, ... ]`： 非或逻辑，所有子条件都不满足
-   `$not : match`：非逻辑，条件不满足

```ts
// 匹配 status 为 "active" 且 age 大于等于 18 的文档
table.findMany({ $and: [{ status: "active" }, { age: { $gte: 18 } }] })
// 匹配 age 小于 18 或 大于 60 的文档
table.findMany({ $or: [{ age: { $lt: 18 } }, { age: { $gt: 60 } }] })
// 匹配 age 既不小于 18 也不大于 60 的文档
table.findMany({ $nor: [{ age: { $lt: 18 } }, { age: { $gt: 60 } }] })
// 匹配不包含 isDeleted 字段的文档
table.findMany({ isDeleted: { $not: { $exists: true } } })
```

#### 值比较

-   `$eq: value`：等于
-   `$ne: value`：不等于
-   `$gt: value`：大于
-   `$gte: value`：大于等于
-   `$lt: value`：小于
-   `$lte: value`：小于等于

```ts
// 匹配 age 大于等于 18 且小于等于 60
table.findMany({ age: { $gte: 18, $lte: 60 } })
// 匹配 status 不等于 "inactive"
table.findMany({ status: { $ne: "inactive" } })
// 比较时间
table.findMany({ createdAt: { $gt: new Date("2023-01-01") } })
```

#### 数组/集合运算

-   `$in: [value1, value2, ...]`：包含于数组
-   `$nin: [value1, value2, ...]`：不包含于数组
-   `$all: [value1, value2, ...]`：包含所有数组元素
-   `$elemMatch: filter`：数组元素匹配，对数组字段使用，表示数组中至少有一个元素满足子条件
-   `$size: number`：数组大小匹配，对数组字段使用，表示数组的长度

```ts
// 匹配 id 在指定列表中的文档
table.findMany({ id: { $in: ["id1", "id2"] } })
// 匹配 id 不在指定列表中的文档
table.findMany({ id: { $nin: ["id1", "id2"] } })
// 匹配 tags 包含 "tag1" 和 "tag2" 的文档
table.findMany({ tags: { $all: ["tag1", "tag2"] } })
// 匹配 tags 完全包含  ["tag1","tag2"]  并且没有其他元素的的文档
table.findMany({ tags: { $all: ["tag1", "tag2"], $size: 2 } })
// 匹配数组字段 scores 中至少有一个元素大于等于 90 并且小于 95 的文档
table.findMany({ scores: { $elemMatch: { $gte: 90, $lt: 95 } } })
// 匹配 tags 长度为 10 的文档
table.findMany({ tags: { $size: 10 } })
// 匹配 tags 长度小于 10 的文档（即 tags.10 不存在）
table.findMany({ "tags.10": { $exists: false } })
// 匹配 tags 长度大于 10 的文档（即 tags.10 存在）
table.findMany({ "tags.10": { $exists: true } })
```

#### 存在性检查

-   `$exists: boolean`：字段是否存在

```ts
// 匹配包含 email 字段的文档
table.findMany({ email: { $exists: true } })
//  匹配不包含 a.b.c 字段的文档
table.findMany({ "a.b.c": { $exists: false } })
```

#### 文本匹配

-   `$regex: regex`：正则表达式匹配
-   `$like: pattern`：SQL LIKE 模式匹配，支持 `%`（匹配任意字符序列）和 `_`（匹配单个字符）

```ts
// 使用正则表达式匹配 name 以 "A" 开头的文档
table.findMany({ name: { $regex: "^A" } })
// 使用 SQL LIKE 模式匹配 以 "A" 开头的文档
table.findMany({ name: { $like: "A%" } })
// 正则表达式匹配含有邮箱地址的文档
table.findMany({ email: { $regex: "^[\\w.-]+@[\\w.-]+\\.\\w+$" } })
// SQL LIKE 还有关键词 Japan 的文档
table.findMany({ description: { $like: "%Japan%" } })
// 正则表达式忽略大小写匹配 name 为 "alice" 的文档
table.findMany({ name: { $regex: /alice/i } })
```

### `updateOp`

`updateOp` 用于确定更新文档的操作，最常用的使用方式是使用 `$set` 来设置字段值：

```ts
table.updateMany(
    // filter
    { id: "docId" },
    // updateOp
    { $set: { name: "newName", age: 30 } }
)
```

如果要更新对象，需要使用`.`号语法来指定嵌套字段：

```ts
table.updateMany(
    { id: "docId" },
    {
        $set: { "address.city": "NewCity" },
    }
)
```

#### 字段更新操作

-   `$set: { key: value, ... }`：设置字段值
-   `$unset: { key: 1, ... }`：删除字段
-   `$setOnInsert: { key: value, ... }`：仅在插入新文档时设置字段值
-   `$rename: { oldKey: newKey, ... }`：重命名字段

```ts
// 设置字段值
table.updateOne({ id: "doc1" }, { $set: { name: "Bob", age: 25 } })
// 新对象覆盖旧对象
table.updateOne({ id: "doc1" }, { $set: { address: { city: "CityA", zip: "12345" } } })
// 修改对象的某个字段
table.updateOne({ id: "doc1" }, { $set: { "address.city": "CityB" } })
// 删除字段
table.updateOne({ id: "doc1" }, { $unset: { "address.zip": 1 } })

// 仅在插入新文档时设置字段值，需要 upsert: true
table.updateOne(
    { id: "doc2" },
    {
        $set: { name: "mydoc" },
        $setOnInsert: { createTime: new Date() } }
    { upsert: true }
)

// 重命名字段
table.updateOne({ id: "doc1" }, { $rename: { food: "foodNew" } })
```

#### 数字运算

-   `$inc: { key: number, ... }`：增加字段数字值（减法使用负数）
-   `$mul: { key: number, ... }`：乘字段数字值
-   `$min: { key: number, ... }`：将字段值更新为指定值和当前值中的较小值
-   `$max: { key: number, ... }`：将字段值更新为指定值和当前值中的较大值

```ts
// 给 count 字段增加 1
table.updateOne({ id: "doc1" }, { $inc: { count: 1 } })
// 给 count 字段减少 5
table.updateOne({ id: "doc1" }, { $inc: { count: -5 } })
// 将 score 字段乘以 2
table.updateOne({ id: "doc1" }, { $mul: { score: 2 } })
// 将 rating 字段更新为 4 和当前值中的较小值
table.updateOne({ id: "doc1" }, { $min: { rating: 4 } })
// 将 rating 字段更新为 100 和当前值中的较大值
table.updateOne({ id: "doc1" }, { $max: { rating: 100 } })
```

#### 数组/集合更新

-   `$push: { key: value | { $each: [values], $position?, $slice?, $sort? } }`：向数组字段添加元素
-   `$addToSet: { key: value | { $each: [values] } }`：向数组字段添加唯一元素
-   `$pop: { key: 1 | -1 }`：移除数组字段最后一个元素或者第一个元素
-   `$pull: { key: value | filter }`：从数组字段移除匹配值或条件的元素

注意 `$addToSet` 用在比较复杂类型（对象、数组）时，唯一性判断是深度比较，也就是说对象和数字会深度比较子级。

```ts
// 向 tags 末尾添加一个元素
table.updateOne({ id: "doc1" }, { $push: { tags: "newTag" } })
// 向 tags 开头添加多个元素
table.updateOne({ id: "doc1" }, { $push: { tags: { $each: ["tag1", "tag2"], $position: 0 } } })
// 向 tags 添加唯一元素（如果已经存在就不添加）
table.updateOne({ id: "doc1" }, { $addToSet: { tags: "tag2" } })
// 向 tags 添加多个唯一元素
table.updateOne({ id: "doc1" }, { $addToSet: { tags: { $each: ["tag1", "tag2"] } } })
// 移除 tags 最后一个元素
table.updateOne({ id: "doc1" }, { $pop: { tags: 1 } })
// 移除 tags 第一个元素
table.updateOne({ id: "doc1" }, { $pop: { tags: -1 } })
// 移除 tags 中值为 "tag1" 的元素
table.updateOne({ id: "doc1" }, { $pull: { tags: "tag1" } })
// 移除 tags 中的 ['tag1', 'tag2'] 元素
table.updateOne({ id: "doc1" }, { $pull: { tags: { $in: ["tag1", "tag2"] } } })
// 移除 scores 中大于等于 90 的元素
table.updateOne({ id: "doc1" }, { $pull: { scores: { $gte: 90 } } })
```

### `setDoc` 赋值文档

`setDoc` 用于覆盖式设置文档内容，用于 `setMany(docs)` 方法中。

根据 `setMany(docs)` 的参数有 3 种覆盖方式：

-   `default` （默认）：浅覆盖（`Object.assign`）\
     传入的每个文档会与数据库中已有的文档进行浅覆盖，相当于：`Object.assign(oldDoc, newDoc)`。

-   `overwrite`：完全覆盖\
     传入的每个文档会完全覆盖数据库中已有的文档，相当于：`oldDoc = newDoc`。

-   `merge`：深度合并\
     传入的每个文档会与数据库中已有的文档进行深度合并。\
     **如果字段是数组，则进行集合合并**（类似于 `$addToSet` 操作）。

#### 默认进行浅合并

```ts
// doc: { id: "doc1", name:'d1', ob: { a:1, b:2 } }
table.setMany([
    {
        id: "doc1",
        ob: { b: 100, c: 4 },
    },
    { merge: true },
])
// 结果：
// { id: "doc1", name:'d1', ob: { b: 100, c: 4 } }
```

```diff
// 结果：
{
  "id": "doc1",
  "name": "d1",
- "ob": { "a": 1, "b": 2 }
+ "ob": { "b": 100, "c": 4 }
}
```

#### `overwrite` 完全覆盖

```ts
// doc: { id: "doc1", name:'d1', ob: { a:1, b:2 } }
// 使用 overwrite 进行完全覆盖
table.setMany([
    {
        id: "doc1",
        more: { x: 1 },
    },
    { overwrite: true },
])
// 结果：
// { id: "doc1", more: { x: 1 } }
```

```diff
// 结果：
{
  "id": "doc1",
- "name": "d1",
- "ob": { "a": 1, "b": 2 }
+ "more": { "x": 1 }
}
```

#### `merge` 深度合并

```ts
// doc: { id: "doc1",  ob: { a:1, b:2 } }
// 使用 merge 进行深度合并
table.setMany([
    {
        id: "doc1",
        ob: { b: 100, c: 4 },
    },
    { merge: true },
])
```

```diff
// 结果：
{
  "id": "doc1",
- "ob": { "a": 1, "b": 2 }
+ "ob": { "a": 1, "b": 100, "c": 4 }
}
```

使用 merge 进行深度合并时数组会进行集合合并

```ts
// doc: { id: "doc1",  tags:[1,2,3] }
// 使用 merge 进行深度合并时数组会进行集合合并
table.setMany([
    {
        id: "doc1",
        tags: [1, 4, 5],
    },
    { merge: true },
])
```

```diff
// 结果：
{
  "id": "doc1",
- "tags": [1, 2, 3]
+ "tags": [1, 2, 3, 4, 5]
}
```

#### 深度合并时覆盖对象 `__overwrite__`

如果在深度合并时希望覆盖对象而不是合并对象，可以使用特殊的 `__overwrite__` 标识符：

```ts
// doc: { id: "doc1",  ob: { a:1, b:2 },  tags: [1,2] }
table.setMany([
    // mergeDoc
    {
        id: "doc1",
        ob: { y: 100, __overwrite__: true },
    },
])
// 结果：
// { id: "doc1", ob: { y:100 } , tags: [3] }
```

```diff
// 结果：
{
  "id": "doc1",
- "ob": { "a": 1, "b": 2 }
+ "ob": { "y": 100 },
- "tags": [1, 2]
+ "tags": [1, 2, 3]
}
```
