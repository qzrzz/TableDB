---
sort: 5
icon: ri-braces-fill
---

# 更新操作符 | Operators

## 更新操作符 `updateOp`

`updateOp` 用于确定更新文档的操作，最常用的使用方式是使用 `$set` 来设置字段值：

```ts
table.updateMany(
    // filter
    { id: "docId" },
    // updateOp
    { $set: { name: "newName", age: 30 } },
)
```

如果要更新多层对象的属性，可以使用`.`号语法来指定嵌套字段：

```ts
table.updateMany(
    { id: "docId" },
    {
        $set: { "address.city": "NewCity" },
    },
)
```

### 字段更新

- `$set: { key: value, ... }`：设置字段值
- `$unset: { key: 1, ... }`：删除字段
- `$setOnInsert: { key: value, ... }`：仅在插入新文档时设置字段值
- `$rename: { oldKey: newKey, ... }`：重命名字段

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

### 数字运算

- `$inc: { key: number, ... }`：增加字段数字值（减法使用负数）
- `$mul: { key: number, ... }`：乘字段数字值
- `$min: { key: number, ... }`：将字段值更新为指定值和当前值中的较小值
- `$max: { key: number, ... }`：将字段值更新为指定值和当前值中的较大值

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

### 数组/集合更新

- `$push: { key: value | { $each: [values], $position?, $slice?, $sort? } }`：向数组字段添加元素
- `$addToSet: { key: value | { $each: [values] } }`：向数组字段添加唯一元素
- `$pop: { key: 1 | -1 }`：移除数组字段最后一个元素或者第一个元素
- `$pull: { key: value | filter }`：从数组字段移除匹配值或条件的元素

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

## `setDoc` 赋值文档

`setDoc` 用于覆盖式设置文档内容，用于 `setMany(docs, options)` 方法中。

```ts
{id: "doc1", name: "Alice", age: 20}
```

根据 `setMany(docs, options)` 的 `options` 参数有 3 种覆盖方式：

- `default`: 浅覆盖 (默认) \
   传入的每个文档会与数据库中已有的文档进行浅覆盖\
   相当于：`Object.assign(oldDoc, newDoc)`。

- `overwrite`: 完全覆盖\
   传入的每个文档会完全覆盖数据库中已有的文档\
   相当于：`oldDoc = newDoc`。

- `merge`: 深度合并\
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
])
// 结果：
// { id: "doc1", name:'d1', ob: { b: 100, c: 4 } }
```

```ts
// 结果：
{
  "id": "doc1",
  "name": "d1",
  "ob": { "a": 1, "b": 2 } // [!code --]
  "ob": { "b": 100, "c": 4 } // [!code ++]
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

```ts
// 结果：
{
  "id": "doc1",
  "name": "d1", // [!code --]
  "ob": { "a": 1, "b": 2 } // [!code --]
  "more": { "x": 1 } // [!code ++]
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

```ts
// 结果：
{
  "id": "doc1",
  "ob": { "a": 1, "b": 2 } // [!code --]
  "ob": { "a": 1, "b": 100, "c": 4 } // [!code ++]
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

```ts
// 结果：
{
  "id": "doc1",
  "tags": [1, 2, 3] // [!code --]
  "tags": [1, 2, 3, 4, 5] // [!code ++]
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

```ts
// 结果：
{
  "id": "doc1",
  "ob": { "a": 1, "b": 2 } // [!code --]
  "ob": { "y": 100 }, // [!code ++]
  "tags": [1, 2] // [!code --]
  "tags": [1, 2, 3] // [!code ++]
}
```
