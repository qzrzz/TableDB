---
sort: 4
icon: ri-filter-fill
---

# 查询过滤器 | Filter

TableDB 使用类似 MongoDB 的查询和更新的操作符，主要分为 3 种

- `filter`：查询过滤器，用于指定查询条件
- `updateOp`：更新命令，用于指定更新操作
- `mergeDoc`： 合并文档，覆盖式设置文档内容

`filter` 是查询过滤器，它是一个对象，每个键值对表示对目标文档中的一个字段的匹配，支持使用操作符来进行更复杂的查询条件。

## 基础字段匹配

一个扁平的对象表示要匹配的字段值，每个键值对表示一个存在匹配条件。

```ts
// 匹配 name 为 "Alice" 且 age 为 30 的文档
// 目标文档可以有其他字段，但必须包含 `name:"Alice"` 和 `age:30` 字段，
table.findMany({ name: "Alice", age: 30 })
```

### 对象完全匹配

如果`filter` 中包含对象字段，这会需要求目标文档中对应字段的值完全等于这个对象。
目标对象中不能有其他字段。

```ts
table.findMany({ ob: { a: 1, b: 2 } })
// ✅ ob: { a:1, b:2 } 完全匹配
// ❌ ob: { a:1, b:2, x:true } 不匹配包含其他字段的对象
```

### 对象部分匹配

如果要匹配对象字段中的部分成员，而不是完全匹配，有两种方式：

1. 使用点语法，来指定多层对象中包含指定成员的对象  
   如 `ob.a.b.c`

```ts
table.findMany({ "ob.a": 1 })
// ✅ ob: { a:1 } 匹配 a:1 的对象
// ✅ ob: { a:1, b:2 } 匹配 a:1 的对象
```

2. 使用 `$elemMatch` 操作符，匹配包含指定成员的对象

```ts
table.findMany({ ob: { $elemMatch: { a: 1 } } })
// ✅ ob: { a:1 } 匹配包含 a:1 的对象
// ✅ ob: { a:1, b:2 } 匹配包含 a:1 的对象
```

### 数组匹配

如果 `filter` 中包含数组字段，这会要求目标文档中对应字段的值包含这个数组中的所有元素，且元素顺序必须一致。

```ts
table.findMany({ arr: [1, 2, 3] })
// ✅ arr: [1, 2, 3] 完全匹配
// ❌ arr: [1, 2, 3, 4] 不匹配包含其他元素的数组
// ❌ arr: [3, 2, 1] 不匹配顺序不同的数组
```

如果不需要完全匹配数组，而是可以匹配包含指定元素的数组，可以使用 `$in`, `$all` 操作符,
更多请参考[数组/集合运算符](#%E6%95%B0%E7%BB%84%2F%E9%9B%86%E5%90%88%E8%BF%90%E7%AE%97%E7%AC%A6)章节。

```ts
// $in 匹配包含任一元素的数组
table.findMany({ arr: { $in: [1, 2] } })
// ✅ arr: [1, 4] 匹配包含 1 的数组
// ✅ arr: [2, 4] 匹配包含 2 的数组
// ❌ arr: [3, 4] 不匹配不包含 1 或 2 的数组
```

```ts
// $all 匹配包含所有元素的数组，元素顺序不限
table.findMany({ arr: { $all: [1, 2, 3] } })
// ✅ arr: [3, 2, 1] 匹配包含 1、2、3 的数组，无视顺序
// ✅ arr: [1, 2, 3, 4] 匹配包含 1、2、3 的数组
// ❌ arr: [1, 2] 不匹配不包含 3 的数组
```

## 匹配逻辑组合

除了简单的值匹配，`filter` 还支持使用操作符来进行更复杂的查询条件：

- `$and: [ filter1, ... ]`：与逻辑，所有子条件都必须满足
- `$or:  [ filter1, ... ]`：或逻辑，至少满足一个子条件
- `$nor: [ filter1, ... ]`： 非或逻辑，所有子条件都不满足
- `$not  : match`：非逻辑，不满足条件

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

## 值比较运算符

使用 `{$eq: value}` 这样的操作符可以进行更复杂的比较条件：

- `$eq: value`：等于 `=`
- `$ne: value`：不等于 `!=`
- `$gt: value`：大于 `>`
- `$gte: value`：大于等于 `>=`
- `$lt: value`：小于 `<`
- `$lte: value`：小于等于 `<=`

```ts
// 匹配 age 大于等于 18 且小于等于 60
table.findMany({ age: { $gte: 18, $lte: 60 } })
// 匹配 status 不等于 "inactive"
table.findMany({ status: { $ne: "inactive" } })
// 比较时间
table.findMany({ createdAt: { $gt: new Date("2023-01-01") } })
```

## 存在性检查

- `$exists: boolean`：字段是否存在

```ts
// 匹配包含 email 字段的文档
table.findMany({ email: { $exists: true } })
//  匹配不包含 a.b.c 字段的文档
table.findMany({ "a.b.c": { $exists: false } })
```

## 数组/集合运算符

- `$in: [value1, value2, ...]`：包含于数组
- `$nin: [value1, value2, ...]`：不包含于数组
- `$all: [value1, value2, ...]`：包含所有数组元素
- `$elemMatch: filter`：数组元素匹配，对数组字段使用，表示数组中至少有一个元素满足子条件
- `$size: number`：数组大小匹配，对数组字段使用，表示数组的长度

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

## 文本匹配

- `$regex: regex`：正则表达式匹配
- `$like: pattern`：SQL LIKE 模式匹配，支持 `%`（匹配任意字符序列）和 `_`（匹配单个字符）

> [!WARNING]
> Bun 运行时的 SQLite 驱动不支持自定义 SQL 函数，因此无法使用 `$regex` 和 `$like` 操作符进行文本匹配查询。

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
