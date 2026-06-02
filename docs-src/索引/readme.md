---
sort: 6
icon: ri-book-shelf-line
---

# 索引 | Indexes

TableDB 支持在表中定义索引，以提高查询性能。索引在 Schema 中的中定义，也可以在 `defineTable()` 时通过 `indexes` 选项单独定义。

## 通过 Schema 定义索引

```ts
import { dto } from "fzz"
class UserSchema {
    id = dto.String({ index: { unique: true } })
    name = dto.String({ index: true })
}

const useUserTable = defineTable({
    name: "user",
    schema: new UserSchema(),
})
```

## 通过 `indexes` 选项定义索引

```ts
const useUserTable = defineTable({
    name: "user",
    indexes: [{ key: "id", unique: true }, { key: "name" }],
})
```

```ts
indexes?: ITableIndexConfig[]
```

@import "../../src/adapter/adapter.ts" @only=ITableIndexConfig @title=索引数据类型
