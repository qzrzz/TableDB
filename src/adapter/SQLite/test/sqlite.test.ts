import { describe, test, expect, beforeAll, beforeEach } from "vitest"
import { ITableDBAdapterInstance } from "../../adapter"
import { SQLiteAdapter } from "../SQLiteAdapter"

describe("SQLite Adapter API", () => {
    let adapter!: ITableDBAdapterInstance

    beforeAll(async () => {
        // Use in-memory DB
        const factory = SQLiteAdapter({ filename: ":memory:" })
        adapter = await factory.useAdapterInstance("baseTestTable")
        await adapter.clearAll()
    })

    beforeEach(async () => {
        await adapter.clearAll()
    })

    describe("键值操作", () => {
        test("get,set", async () => {
            let doc = { id: "test1", name: "Test Document", value: 42 }
            await adapter.set("test1", doc)
            let doc2 = await adapter.get("test1")
            expect(doc2).toBeDefined()
            expect(doc2?.name).toBe(doc.name)
            expect(doc2?.value).toBe(doc.value)

            await adapter.set("test1", { id: "test1", name: "Updated Document", value: 100 })
        })

        test("has,delete", async () => {
            await adapter.set("test2", { id: "test2", data: "foo" })
            expect(await adapter.has("test2")).toBe(true)
            await adapter.delete("test2")
            expect(await adapter.has("test2")).toBe(false)
            expect(await adapter.get("test2")).toBeUndefined()
        })

        test("count,clear", async () => {
            await adapter.set("c1", { id: "c1" })
            await adapter.set("c2", { id: "c2" })
            expect(await adapter.count()).toBe(2)
            await adapter.clear()
            expect(await adapter.count()).toBe(0)
        })
    })

    describe("数据类型 (ITablePrimitive)", () => {
        test("复杂类型", async () => {
            const now = new Date()
            const buffer = new Uint8Array([1, 2, 3]).buffer
            const u8 = new Uint8Array([4, 5, 6])
            const big = BigInt("900719925474099123456")

            const doc = {
                id: "types1",
                date: now,
                buf: buffer,
                u8: u8,
                big: big,
                bool: true,
                nil: null,
                nested: { a: 1, b: [2, 3] },
            }

            await adapter.set("types1", doc)
            const res = await adapter.get("types1")

            expect(res).toBeDefined()
            expect(res?.date).toBeInstanceOf(Date)
            expect((res?.date as Date).getTime()).toBe(now.getTime())
            expect(res?.buf).toBeInstanceOf(ArrayBuffer)
            expect(res?.buf).toEqual(buffer)

            // Checking content
            expect(new Uint8Array(res?.buf as any)).toEqual(new Uint8Array(buffer))

            // Expected to be Uint8Array because we store constructor name in serializer
            expect(res?.u8).toBeInstanceOf(Uint8Array)
            expect(res?.u8).toEqual(u8)

            expect(res?.big).toBe(big)
            expect(res?.bool).toBe(true)
            expect(res?.nil).toBe(null)
            expect(res?.nested).toEqual(doc.nested)
        })
    })

    describe("MongoDB 风格操作", () => {
        test("批量插入与查询", async () => {
            const docs = [
                { id: "m1", tags: ["a", "b"], val: 10 },
                { id: "m2", tags: ["b", "c"], val: 20 },
                { id: "m3", tags: ["a", "c"], val: 30 },
            ]
            await adapter.insertMany(docs)

            const all = await adapter.findMany({})
            expect(all.length).toBe(3)

            const filtered = await adapter.findMany({ tags: { $all: ["a"] } })
            expect(filtered.length).toBe(2) // m1, m3

            const sorted = await adapter.findMany({}, { sort: { val: -1 } })
            expect(sorted[0].id).toBe("m3")

            const limited = await adapter.findMany({}, { limit: 1, offset: 1, sort: ["id"] }) // m1, m2, m3 sorted by id asc
            expect(limited.length).toBe(1)
            expect(limited[0].id).toBe("m2")
        })

        test("更新单条与批量更新", async () => {
            await adapter.insertMany([
                { id: "u1", score: 10 },
                { id: "u2", score: 20 },
            ])

            await adapter.updateOne({ id: "u1" }, { $set: { score: 15 } })
            const u1 = await adapter.get("u1")
            expect(u1?.score).toBe(15)

            await adapter.updateMany({ score: { $gt: 0 } }, { $inc: { score: 5 } })
            const u1_2 = await adapter.get("u1")
            const u2_2 = await adapter.get("u2")
            expect(u1_2?.score).toBe(20)
            expect(u2_2?.score).toBe(25)
        })

        test("批量设置", async () => {
            await adapter.set("s1", { id: "s1", v: 1 })
            const docs = [
                { id: "s1", v: 10 },
                { id: "s2", v: 20 },
            ]
            await adapter.setMany(docs)

            expect((await adapter.get("s1"))?.v).toBe(10)
            expect((await adapter.get("s2"))?.v).toBe(20)
        })

        test("删除单条与批量删除", async () => {
            await adapter.insertMany([
                { id: "d1", type: "x" },
                { id: "d2", type: "x" },
                { id: "d3", type: "y" },
            ])

            await adapter.deleteOne({ type: "x" })
            expect(await adapter.count()).toBe(2)

            await adapter.deleteMany({ type: "x" })
            expect(await adapter.count()).toBe(1)
            expect(await adapter.has("d3")).toBe(true)
        })

        test("删除单条 sort", async () => {
            await adapter.insertMany([
                { id: "d1", age: 1, type: "x" },
                { id: "d2", age: 2, type: "x" },
                { id: "d3", age: 3, type: "x" },
            ])

            // Delete type=x, sort age desc (-1).
            // Data sorted age desc: d3(3), d2(2), d1(1).
            // First match is d3. So d3 should be deleted.

            await adapter.deleteOne({ type: "x" }, { sort: { age: -1 } })
            expect(await adapter.has("d3")).toBe(false)
            expect(await adapter.has("d2")).toBe(true)
            expect(await adapter.has("d1")).toBe(true)

            // Remaining: d1 (age 1), d2 (age 2). Type x.

            // Delete type=x, sort age asc (1).
            // Data sorted age asc: d1(1), d2(2).
            // First match is d1. So d1 should be deleted.
            await adapter.deleteOne({ type: "x" }, { sort: { age: 1 } })
            expect(await adapter.has("d1")).toBe(false)
            expect(await adapter.has("d2")).toBe(true)
        })
    })

    describe("索引", () => {
        test("定义 unique 索引", async () => {
            const indexName = "email_unique"
            await adapter.defineIndexes([{ key: "email", name: indexName, unique: true }])

            //  unique 索引生效，插入重复值应报错
            await adapter.set("user1", { id: "user1", email: "a@b.com", age: 20 })
            // SQLITE CONSTRAINT should throw
            await expect(adapter.set("user2", { id: "user2", email: "a@b.com", age: 25 })).rejects.toThrow()

            // 删除索引后，应允许插入重复值
            await adapter.defineIndexes([{ key: "email", name: indexName, disabled: true }])

            await expect(adapter.set("user2", { id: "user2", email: "a@b.com", age: 25 })).resolves.toBeUndefined()
        })
    })


})
