import "fake-indexeddb/auto"

import { IndexedDBAdapter } from "../adapter/IndexedDB"
import { MongoDBAdapter } from "../adapter/MongoDB"
import { SQLiteAdapter } from "../adapter/SQLite/SQLiteAdapter"
import { defineTable } from "../core/defineTable"

export type TestDatabaseType = "mongodb" | "sqlite" | "indexeddb"

export async function getMongoDBTable(name: string) {
    let useTestTable_mongodb = defineTable({
        name,
        adapter: MongoDBAdapter({
            auth: "mongodb://root:w2xO4Fd28Wc76o1sl8WAt3lo5sc42ver02@localhost:12779",
            dbName: "tableDbTest",
        }),
    })
    return await useTestTable_mongodb()
}

export async function getSQLiteTable(name: string) {
    let useTestTable_sqlite = defineTable({
        name,
        adapter: SQLiteAdapter({ filename: `:memory:` }),
    })
    return await useTestTable_sqlite()
}

export async function getIndexedDBTable(name: string) {
    let useTestTable_indexeddb = defineTable({
        name,
        adapter: IndexedDBAdapter({ dbName: "TableDBTestDB" }),
    })
    return await useTestTable_indexeddb()
}

// 获取指定类型的测试表
export async function getTestTableByType(tableName: string, type: TestDatabaseType = "sqlite") {
    if (type === "mongodb") {
        return await getMongoDBTable(tableName)
    } else if (type === "sqlite") {
        return await getSQLiteTable(tableName)
    } else if (type === "indexeddb") {
        return await getIndexedDBTable(tableName)
    }
    throw new Error(`Unsupported test database type: ${type}`)
}

// 默认使用 SQLite（向后兼容）
export async function getTestTable(tableName: string) {
    return await getSQLiteTable(tableName)
}

let useTestTable_mongodb_User = defineTable({
    name: "TestTable",
    adapter: MongoDBAdapter({
        auth: "mongodb://root:w2xO4Fd28Wc76o1sl8WAt3lo5sc42ver02@localhost:12779",
        dbName: "tableDbTest",
    }),
    schema: {
        id: "string",
        name: "string",
        age: "number",
        email: "string",
        xxx: { type: "object" },
    },
})

let table1 = await useTestTable_mongodb_User()
let d1 = await table1.get("user1")

table1.updateOne(
    {
        nma: 1,
    },
    {
        $set: {},
    }
)
