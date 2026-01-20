import "fake-indexeddb/auto"
import { describe, test, expect, beforeAll, beforeEach } from "vitest"
import { ITableDBAdapterInstance } from "../../adapter"
import { IndexedDBAdapter } from "../IndexedDBAdapter"

describe("IndexedDB Adapter API", () => {
    let adapter!: ITableDBAdapterInstance

    beforeAll(async () => {
        const factory = IndexedDBAdapter({ dbName: "testDB" })
        adapter = await factory.useAdapterInstance("baseTestTable")
        await adapter.clearAll()
    })

    beforeEach(async () => {
        await adapter.clearAll()
    })

    describe("键值操作", () => {
        test("get, set 意图：验证基础的文档存储和获取是否正确", async () => {
            let doc = { id: "test1", name: "Test Document", value: 42 }
            await adapter.set("test1", doc)
            let doc2 = await adapter.get("test1")
            expect(doc2).toBeDefined()
            expect(doc2?.name).toBe(doc.name)
            expect(doc2?.value).toBe(doc.value)

            await adapter.set("test1", { id: "test1", name: "Updated Document", value: 100 })
            let doc3 = await adapter.get("test1")
            expect(doc3?.name).toBe("Updated Document")
        })

        test("has, delete 意图：验证文档的存在性检查和删除操作是否有效", async () => {
            await adapter.set("test2", { id: "test2", data: "foo" })
            expect(await adapter.has("test2")).toBe(true)
            await adapter.delete("test2")
            expect(await adapter.has("test2")).toBe(false)
            expect(await adapter.get("test2")).toBeUndefined()
        })

        test("count, clear 意图：验证文档计数和清空表操作是否正确", async () => {
            await adapter.set("c1", { id: "c1" })
            await adapter.set("c2", { id: "c2" })
            expect(await adapter.count()).toBe(2)
            await adapter.clear()
            expect(await adapter.count()).toBe(0)
        })
    })

    describe("MongoDB 风格操作", () => {
        test("insertMany 与 findMany 意图：验证批量插入和基础查询逻辑", async () => {
            const docs = [
                { id: "m1", tags: ["a", "b"], val: 10 },
                { id: "m2", tags: ["b", "c"], val: 20 },
                { id: "m3", tags: ["a", "c"], val: 30 },
            ]
            await adapter.insertMany(docs)

            const all = await adapter.findMany({})
            expect(all.length).toBe(3)

            // 过滤查询
            const result = await adapter.findMany({ tags: "a" })
            expect(result.length).toBe(2)
            expect(result.map(d => d.id)).toContain("m1")
            expect(result.map(d => d.id)).toContain("m3")
        })

        test("updateOne 与 updateMany 意图：验证文档更新逻辑，包括 upsert", async () => {
            await adapter.insertMany([
                { id: "u1", score: 10 },
                { id: "u2", score: 20 },
            ])

            await adapter.updateOne({ id: "u1" }, { $set: { score: 15 } })
            let u1 = await adapter.get("u1")
            expect(u1?.score).toBe(15)

            await adapter.updateMany({ score: { $gt: 10 } }, { $inc: { score: 5 } })
            let u1_new = await adapter.get("u1")
            let u2_new = await adapter.get("u2")
            expect(u1_new?.score).toBe(20)
            expect(u2_new?.score).toBe(25)

            // Upsert
            await adapter.updateOne({ id: "u3" }, { $set: { score: 30 } }, { upsert: true })
            expect(await adapter.has("u3")).toBe(true)
            expect((await adapter.get("u3"))?.score).toBe(30)
        })

        test("deleteMany 意图：验证根据条件批量删除文档", async () => {
            await adapter.insertMany([
                { id: "d1", status: "active" },
                { id: "d2", status: "inactive" },
                { id: "d3", status: "active" },
            ])

            await adapter.deleteMany({ status: "active" })
            expect(await adapter.count()).toBe(1)
            expect(await adapter.has("d2")).toBe(true)
        })
    })

    describe("索引管理", () => {
        test("defineIndexes 意图：验证动态创建和使用索引", async () => {
            await adapter.insertMany([
                { id: "i1", category: "A", price: 100 },
                { id: "i2", category: "B", price: 200 },
                { id: "i3", category: "A", price: 150 },
            ])

            // 定义索引
            await adapter.defineIndexes([
                { key: "category", name: "idx_category" }
            ])

            // 虽然目前的实现 findMany 主要是游标 + matches，但 defineIndexes 应该成功执行
            const res = await adapter.findMany({ category: "A" })
            expect(res.length).toBe(2)
        })
    })
})
