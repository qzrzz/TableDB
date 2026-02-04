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

    describe("Error 类型存储", () => {
        test("Error - 基本 Error 意图：验证基本 Error 对象的存储和恢复", async () => {
            const error = new Error("测试错误消息")
            const doc = { id: "error1", value: error }
            await adapter.set("error1", doc as any)
            const result = await adapter.get("error1")
            expect(result?.value).toBeInstanceOf(Error)
            expect((result?.value as Error).name).toBe("Error")
            expect((result?.value as Error).message).toBe("测试错误消息")
            expect((result?.value as Error).stack).toBeDefined()
        })

        test("Error - TypeError 意图：验证内置 Error 子类的存储和恢复", async () => {
            const error = new TypeError("类型错误")
            const doc = { id: "error2", value: error }
            await adapter.set("error2", doc as any)
            const result = await adapter.get("error2")
            expect(result?.value).toBeInstanceOf(TypeError)
            expect((result?.value as Error).name).toBe("TypeError")
            expect((result?.value as Error).message).toBe("类型错误")
        })

        test("Error - 带 cause 的 Error（3层嵌套）意图：验证 cause 链的存储和恢复", async () => {
            const cause3 = new Error("第三层原因")
            const cause2 = new Error("第二层原因", { cause: cause3 })
            const cause1 = new Error("第一层原因", { cause: cause2 })
            const error = new Error("主错误", { cause: cause1 })
            const doc = { id: "error3", value: error }
            await adapter.set("error3", doc as any)
            const result = await adapter.get("error3")
            const resultError = result?.value as Error
            expect(resultError.message).toBe("主错误")
            expect((resultError.cause as Error).message).toBe("第一层原因")
            expect(((resultError.cause as Error).cause as Error).message).toBe("第二层原因")
            expect((((resultError.cause as Error).cause as Error).cause as Error).message).toBe("第三层原因")
        })

        test("Error - cause 超过3层时只保留前3层 意图：验证 cause 深度限制", async () => {
            const cause4 = new Error("第四层原因")
            const cause3 = new Error("第三层原因", { cause: cause4 })
            const cause2 = new Error("第二层原因", { cause: cause3 })
            const cause1 = new Error("第一层原因", { cause: cause2 })
            const error = new Error("主错误", { cause: cause1 })
            const doc = { id: "error4", value: error }
            await adapter.set("error4", doc as any)
            const result = await adapter.get("error4")
            const resultError = result?.value as Error
            const level3 = ((resultError.cause as Error).cause as Error).cause as Error
            expect(level3.message).toBe("第三层原因")
            expect(level3.cause).toBeUndefined()
        })

        test("Error - cause 为非 Error 类型 意图：验证非 Error cause 的存储", async () => {
            const error = new Error("主错误", { cause: { code: 500, reason: "服务器错误" } })
            const doc = { id: "error5", value: error }
            await adapter.set("error5", doc as any)
            const result = await adapter.get("error5")
            const resultError = result?.value as Error
            expect(resultError.message).toBe("主错误")
            expect(resultError.cause).toEqual({ code: 500, reason: "服务器错误" })
        })

        test("Error - findMany 返回包含 Error 的文档 意图：验证 findMany 能正确恢复 Error", async () => {
            const error = new TypeError("查询测试错误")
            await adapter.insertMany([
                { id: "find_err1", type: "error", value: error as any },
                { id: "find_err2", type: "normal", value: "普通值" },
            ])
            const results = await adapter.findMany({ type: "error" })
            expect(results.length).toBe(1)
            expect(results[0].value).toBeInstanceOf(TypeError)
            expect((results[0].value as Error).message).toBe("查询测试错误")
        })
    })
})
