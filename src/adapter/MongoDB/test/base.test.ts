
import { ITableDBAdapterInstance } from "../../adapter"
import { getTestAdapter } from "./getTestMongo"

describe("MongoDB Adapter API", () => {
    let adapter!: ITableDBAdapterInstance

    beforeAll(async () => {
        adapter = await getTestAdapter("baseTestTable")
        await adapter.clearAll()
        // await adapter.drop()
    })

    beforeEach(async () => {
        await adapter.clearAll()
        // await adapter.drop()
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
            // estimatedDocumentCount might not be immediate in some Mongo versions/configs
            // but for test it should be fine or we might need a small delay or use countDocuments
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
                undef: undefined,
                nested: { a: 1, b: [2, 3] },
            }

            await adapter.set("types1", doc)
            const res = await adapter.get("types1")

            expect(res).toBeDefined()
            expect(res?.date).toBeInstanceOf(Date)
            expect((res?.date as Date).getTime()).toBe(now.getTime())
            expect(res?.buf).toBeInstanceOf(ArrayBuffer)
            expect(new Uint8Array(res?.buf as ArrayBuffer)).toEqual(new Uint8Array(buffer))
            expect(res?.u8).toBeInstanceOf(Uint8Array)
            expect(res?.u8).toEqual(u8)
            expect(res?.big).toBe(big)
            expect(res?.bool).toBe(true)
            expect(res?.nil).toBe(null)
            // undefined is usually not stored in Mongo or returned as null/omitted
            // depending on implementation. jsToMongo/mongoToJs should handle it.
            expect(res?.nested).toEqual(doc.nested)
        })

        test("Blob 类型", async () => {
            if (typeof Blob !== "undefined") {
                const blob = new Blob(["hello world"], { type: "text/plain" })
                await adapter.set("blob1", { id: "blob1", data: blob })
                const res = await adapter.get("blob1")
                expect(res?.data).toBeInstanceOf(Blob)
                const text = await (res?.data as Blob).text()
                expect(text).toBe("hello world")
            }
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

            const filtered = await adapter.findMany({ tags: "a" })
            expect(filtered.length).toBe(2)

            const sorted = await adapter.findMany({}, { sort: { val: -1 } })
            expect(sorted[0].id).toBe("m3")

            const limited = await adapter.findMany({}, { limit: 1, offset: 1, sort: ["id"] })
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

            await adapter.deleteOne({ type: "x" }, { sort: { age: -1 } })
            expect(await adapter.count()).toBe(2)
            expect(await adapter.has("d3")).toBe(false)
            expect(await adapter.has("d1")).toBe(true)
            expect(await adapter.has("d2")).toBe(true)

            await adapter.deleteOne({ type: "x" }, { sort: { age: 1 } })
            expect(await adapter.count()).toBe(1)
            expect(await adapter.has("d1")).toBe(false)
            expect(await adapter.has("d2")).toBe(true)
        })
    })

    describe("索引", () => {
        test("定义 unique 索引", async () => {
            const indexName = "email_unique_" + Date.now()
            await adapter.defineIndexes([{ key: indexName, unique: true }])

            //  unique 索引生效，插入重复值应报错
            await adapter.set("user1", { id: "user1", [indexName]: "a@b.com", age: 20 })
            await expect(adapter.set("user2", { id: "user2", [indexName]: "a@b.com", age: 25 })).rejects.toThrow()

            // 删除索引后，应允许插入重复值
            await adapter.defineIndexes([{ key: indexName, disabled: true }])

            // 等待索引删除生效
            await new Promise((resolve) => setTimeout(resolve, 100))

            await expect(
                adapter.set("user2", { id: "user2", [indexName]: "a@b.com", age: 25 })
            ).resolves.toBeUndefined()
        })
    })
})
