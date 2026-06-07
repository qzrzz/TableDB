---
sort: 3
icon: ri-pencil-ruler-2-line
---

# 增删改查 | CRUD

## 创建文档

- `insertOne(doc)` 插入单个新文档
- `insertMany(docs)` 插入多个新文档
- `setMany(docs)` 批量设置文档（有则更新，无则插入）

创建新文档时需要提供一个 `id` 字段，作为文档的唯一标识符。 如果表中已有相同 `id` 的问题，插入操作会忽略，不会进行覆盖。

如果你想要一个“有则更新，无则插入”的功能，可以使用 `setMany()`，它会根据提供的文档 `id` 来判断文档是否存在。`setMany()` 的用法请去参考[批量设置文档](#批量设置文档)。

```ts
await userTable.insertOne({ id: "user1", name: "Alice" })
await userTable.insertMany([doc1, doc2, doc3])
```

## 查询文档

- `findOne(filter)` 查找一个符合 `filter` 的文档
- `findMany(filter, options)` 查找全部符合 `filter` 的文档

```ts
let user = await userTable.findOne({ id: "123" })
let users = await userTable.findMany({ age: { $gt: 20 } })
```

### 结果排序`sort`

- 可以是字符串数组， 前面加 `-` 表示降序。例如 `["name", "-age"]` 表示先按 name 升序排序，再按 age 降序排序
- 也可以是字段映射对象，1 表示升序，-1 表示降序

```ts
type sort = string[] | Record<string, 1 | -1>
let sort1 = ["name", "-age"]
let sort2 = { name: 1, age: -1 }
```

### 返回字段映射 `projection`

通过 `projection` 参数可以指定返回文档的部分字段，而不是全部文档字段。`projection` 的格式有三种：

- 可以是字符串数组，表示包含的字段列表
- 也可以是字段映射对象，1 表示包含该字段，-1 表示排除该字段 （不能同时包含和排除字段）
- 也可以是 plv 预设投影名称，根据 Table 定义的 projections 返回字段

```ts
type projection = string[] | Record<string, 1 | -1> | string
let projection1 = ["name", "age"] // 只返回 name 和 age 字段
let projection2 = { name: 1, age: 1 } // 只返回 name 和 age 字段
let projectionLv = "full" // 根据 Table 定义的 projections 返回字段
```

## 更新文档

- `updateOne(filter, update)` 更新一个符合 `filter` 的文档
- `updateMany(filter, update)` 更新多个符合 `filter` 的文档
- `bulkUpdate(updates:{ filter, update }[])` 批量更新文档
- `setMany(docs, options)` 批量设置文档（有则更新，无则插入）

```ts
let filter = { id: "user1" }
let update = { $set: { name: "Bob" } }
await userTable.updateMany(filter, update)
```

### `setMany()` 批量设置文档

`setMany()` 是个非常强大的批量更新、新建文档的方法，它可以让你提供文档对象或者其部分对象来进行更新操作，而不用使用 update 操作符。它会根据提供的文档 `id` 来判断文档是否存在，如果存在则进行更新，如果不存在则进行插入。

具体参考 [setDoc 赋值文档](#setdoc-%E8%B5%8B%E5%80%BC%E6%96%87%E6%A1%A3)

## 删除文档

- `deleteOne(filter)` 删除一个符合 `filter` 的文档
- `deleteMany(filter)` 删除多个符合 `filter` 的文档

```ts
await userTable.deleteOne({ id: "user1" })
await userTable.deleteMany({ id: { $in: ["id1", "id2"] } })
```

## 遍历文件

- `forEach(filter, callback)`  
   遍历符合 `filter` 的文档，逐个文档执行 `callback`。适合少量数据
- `eachBatch(filter, options, callback)`  
   遍历符合 `filter` 的文档，每一批文档执行一次 `callback`。适合大量数据

- `listPaging(filter, options)`  
  使用分页列出符合 `filter` 的文档。适合要求分页并且要跳转到指定页的场景，但性能较低

- `listPagingByCursor(filter, options)`  
  使用游标分页列出符合 `filter` 的文档。高性能但无法跳转指定页，适合大量数据
