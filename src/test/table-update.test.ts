import { Table } from "../core/Table"
import { getTestTableByType, TestDatabaseType } from "./getTestTable"

const DATABASE_TYPES: TestDatabaseType[] = ["sqlite", "mongodb", "indexeddb"]

describe.each(DATABASE_TYPES)("Table update - %s", async (dbType) => {
    let table!: Table

    beforeAll(async () => {
        table = await getTestTableByType("table-update.test", dbType)
        await table.clearAll()
    })

    beforeEach(async () => {
        await table.clearAll()
    })

    test("update operations", async () => {
        let doc = {
            id: "upd1",
            name: "Original Name",
            count: 10,
            tags: ["a", "b", "c"],
            info: { score: 50, level: 1 },
            ob: { a: 1, b: 2, c: [1, 2, 3] },
        }
        await table.set("upd1", doc)

        await table.updateOne(
            { id: "upd1" },
            {
                $set: { "ob.a": 10 },
            }
        )
    })

    test("mergeDoc operations", async () => {
        let doc = {
            id: "doc1",
            ob: {
                a: 1,
                b: 2,
            },
            tags: [1, 2, 3],
        }
        await table.set("doc1", doc)

        // 添加字段
        await table.setMany([{ id: "doc1", name: "n1" }])
        let re1 = await table.get("doc1")
        expect(re1!.name).toEqual("n1")

        // 默认浅合并对象
        await table.setMany([{ id: "doc1", ob: { c: 3 } }])
        let re2 = (await table.get("doc1")) as any
 
        expect(re2?.ob).toEqual({ c: 3 })
        expect(re2?.tags).toEqual([1, 2, 3])

        // 深度合并对象
        await table.setMany([{ id: "doc1", ob: { d: 5 }, tags: [6] }], { merge: true })
        let re3 = (await table.get("doc1")) as any

        expect(re3?.ob).toEqual({
            c: 3,
            d: 5,
        })

        expect(re3?.tags).toEqual([1, 2, 3, 6])

         // 深度合并对象，并使用 __overwrite__ 覆盖子对象

        await table.setMany([{ id: "doc1", ob: { __overwrite__: true, b: 100, e: 200 }, tags: [7, 8] }], {
            merge: true,
        })
        let re4 = (await table.get("doc1")) as any

        expect(re4?.ob).toEqual({
            b: 100,
            e: 200,
        })
        expect(re4?.tags).toEqual([1, 2, 3, 6, 7, 8])
    })
})
