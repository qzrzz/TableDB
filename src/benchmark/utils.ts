import { MongoDBAdapter } from "../adapter/MongoDB/MongoDBAdapter"
import { SQLiteAdapter } from "../adapter/SQLite/SQLiteAdapter"
import { Table } from "../core/Table"
import { ITableDoc } from "../adapter/adapter"
import fs from "fs"

export interface IBenchDoc extends ITableDoc {
    id: string
    name: string
    age: number
    tags: string[]
    meta: {
        created: number
        updated: number
    }
}

export async function createBenchTable(name: string, enableMarkDelete: boolean = false) {
    const filename = `./dist/test_tabledb_${name}.db`
    //删除测试数据库文件
    try {
        if (fs.existsSync(filename)) fs.unlinkSync(filename)
    } catch (e) {
        console.warn(e)
    }

    const table = new Table<IBenchDoc>({
        name: name,
        adapter: SQLiteAdapter({ filename }),
        // adapter: MongoDBAdapter({
        //     auth: "mongodb://root:w2xO4Fd28Wc76o1sl8WAt3lo5sc42ver02@localhost:12779",
        //     dbName: "tableDbTest",
        // }),
        enableMarkDelete: enableMarkDelete,
    })

    console.log(`Initializing table ${table.options.adapter?.name} (enableMarkDelete=${enableMarkDelete})`)
    await table.init()
    await table.clearAll()
    return table
}

export function generateDoc(i: number): IBenchDoc {
    return {
        id: `doc_${i}`,
        name: `User ${i}`,
        age: i % 100,
        tags: [`tag_${i % 10}`, `tag_${i % 5}`],
        meta: {
            created: Date.now(),
            updated: Date.now(),
        },
    }
}

export async function prepareTableData(table: Table<IBenchDoc>, count: number) {
    await table.clearAll()
    const docs: IBenchDoc[] = []
    for (let i = 0; i < count; i++) {
        docs.push(generateDoc(i))
    }
    await table.insertMany(docs)
}
