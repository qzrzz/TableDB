import { SQLiteAdapter, defineTable, Table } from "../../dist/index.js"
import { test } from "vitest"

test("base", async () => {
    const table = defineTable({
        name: "TestTable",
        adapter: SQLiteAdapter({ filename: "./dist/dist-test.sqlite" }),
    })
    let t1 = await table()

    expect(t1).toBeDefined()
})
