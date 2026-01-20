import { Table } from "../core/Table"
import { getTestTableByType, TestDatabaseType } from "./getTestTable"

const DATABASE_TYPES: TestDatabaseType[] = ["sqlite", "mongodb", "indexeddb"]

describe.each(DATABASE_TYPES)("Table KV - %s", async (dbType) => {
    let table!: Table

    beforeAll(async () => {
        table = await getTestTableByType("table-kv.test", dbType)
        await table.clearAll()
    })

    beforeEach(async () => {
        await table.clearAll()
    })

    test("get, set", async () => {
        let doc = {
            id: "test1",
            name: "Test Document",
            value: 42,
            tags: ["sample", "test"],
            null: null,
            bool: true,
            arr: [1, 2, 3],
            obj: { a: 1, c: { a: "" } },
            u8n: new Uint8Array([1, 2, 3]),
            u16n: new Uint16Array([256, 512]),
            f32n: new Float32Array([1.5, 2.5]),
            bi64n: new BigInt64Array([1000n, 2000n]),
            blob: new Blob(["Hello, Blob!"], { type: "text/plain" }),
            af: new ArrayBuffer(8),
            date: new Date("2024-01-01T00:00:00Z"),
            BigInt: 9007199254741991n,
            regexp: /^test.*$/i,
            dataView: new DataView(new ArrayBuffer(16)),
        }
        await table.set("test1", doc)

        let re1 = await table.get("test1")
        expect(re1).toEqual(doc)

        let doc2 = { id: "test1", a1: "Another Field" }
        await table.set("test1", doc2)
        let re2 = await table.get("test1")
        expect(re2).toEqual(doc2)

        // set 指定的 id 会优先
        let doc3 = { id: "test5", a2: "Third Field" }
        await table.set("test1", doc3)
        let re3 = await table.get("test1")
        expect(re3).toEqual(doc3)
    })

    test("delete, has", async () => {
        let doc = { id: "test2", name: "Test 2" }
        await table.set("test2", doc)

        expect(await table.has("test2")).toBe(true)

        await table.delete("test2")

        expect(await table.has("test2")).toBe(false)
        expect(await table.get("test2")).toBeUndefined()
    })

    test("count, clear", async () => {
        await table.set("c1", { id: "c1" })
        await table.set("c2", { id: "c2" })
        await table.set("c3", { id: "c3" })

        expect(await table.count()).toBe(3)

        await table.delete("c2")
        expect(await table.count()).toBe(2)

        await table.clear()
        expect(await table.count()).toBe(0)
        expect(await table.get("c1")).toBeUndefined()
    })

    test("edge cases", async () => {
        // 测试获取不存在的文档
        expect(await table.get("non-existent")).toBeUndefined()

        // 测试删除不存在的文档
        await table.delete("non-existent")

        // set overwrite
        await table.set("overwrite", { id: "overwrite", val: 1 })
        expect((await table.get("overwrite"))?.val).toBe(1)
        await table.set("overwrite", { id: "overwrite", val: 2 })
        expect((await table.get("overwrite"))?.val).toBe(2)
    })
})
