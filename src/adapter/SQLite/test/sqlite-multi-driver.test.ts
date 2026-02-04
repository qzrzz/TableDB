/**
 * SQLiteAdapter 多驱动测试
 * 
 * 测试 SQLiteAdapter 使用不同驱动（better-sqlite3 和 node:sqlite）时的功能一致性
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest"
import { SQLiteAdapter, isSqliteDriverAvailable } from "../index"
import type { SqliteDriverType } from "../driver"
import type { ITableDBAdapterInstance } from "../../adapter"

// 获取可用的驱动列表
const availableDrivers: SqliteDriverType[] = []

if (isSqliteDriverAvailable("better-sqlite3")) {
    availableDrivers.push("better-sqlite3")
}

if (isSqliteDriverAvailable("node:sqlite")) {
    availableDrivers.push("node:sqlite")
}

describe("SQLiteAdapter 多驱动测试", () => {
    describe.each(availableDrivers)("驱动: %s", (driverType) => {
        let adapter: ITableDBAdapterInstance

        beforeEach(async () => {
            const factory = SQLiteAdapter({
                filename: ":memory:",
                driver: driverType,
            })
            adapter = await factory.useAdapterInstance("test_table")
        })

        afterEach(async () => {
            if (adapter) {
                await adapter.close()
            }
        })

        describe("基本 CRUD 操作", () => {
            test("set 和 get", async () => {
                await adapter.set("doc1", { id: "doc1", name: "Alice", age: 25 })
                const doc = await adapter.get("doc1")
                
                expect(doc).toMatchObject({ name: "Alice", age: 25 })
            })

            test("has", async () => {
                await adapter.set("doc1", { id: "doc1", name: "Alice" })
                
                expect(await adapter.has("doc1")).toBe(true)
                expect(await adapter.has("doc2")).toBe(false)
            })

            test("delete", async () => {
                await adapter.set("doc1", { id: "doc1", name: "Alice" })
                await adapter.delete("doc1")
                
                expect(await adapter.has("doc1")).toBe(false)
            })

            test("count", async () => {
                await adapter.set("doc1", { id: "doc1", name: "Alice" })
                await adapter.set("doc2", { id: "doc2", name: "Bob" })
                
                expect(await adapter.count()).toBe(2)
                expect(await adapter.count({ name: "Alice" })).toBe(1)
            })
        })

        describe("MongoDB 风格查询", () => {
            beforeEach(async () => {
                await adapter.insertMany([
                    { id: "1", name: "Alice", age: 25, tags: ["a", "b"] },
                    { id: "2", name: "Bob", age: 30, tags: ["b", "c"] },
                    { id: "3", name: "Charlie", age: 35, tags: ["a", "c"] },
                ])
            })

            test("findMany 基本查询", async () => {
                const docs = await adapter.findMany({ age: { $gte: 30 } })
                expect(docs.length).toBe(2)
            })

            test("findMany 带排序", async () => {
                const docs = await adapter.findMany({}, { sort: { age: -1 } })
                expect(docs[0].name).toBe("Charlie")
            })

            test("findMany 带分页", async () => {
                const docs = await adapter.findMany({}, { sort: { age: 1 }, limit: 2 })
                expect(docs.length).toBe(2)
                expect(docs[0].name).toBe("Alice")
            })

            test("findOne", async () => {
                const doc = await adapter.findOne({ name: "Bob" })
                expect(doc?.age).toBe(30)
            })

            test("$in 操作符", async () => {
                const docs = await adapter.findMany({ name: { $in: ["Alice", "Charlie"] } })
                expect(docs.length).toBe(2)
            })

            test("$or 操作符", async () => {
                const docs = await adapter.findMany({
                    $or: [{ age: 25 }, { age: 35 }]
                })
                expect(docs.length).toBe(2)
            })
        })

        describe("更新操作", () => {
            beforeEach(async () => {
                await adapter.set("doc1", { id: "doc1", name: "Alice", age: 25, score: 100 })
            })

            test("updateOne $set", async () => {
                await adapter.updateOne({ id: "doc1" }, { $set: { age: 26 } })
                const doc = await adapter.get("doc1")
                expect(doc?.age).toBe(26)
            })

            test("updateOne $inc", async () => {
                await adapter.updateOne({ id: "doc1" }, { $inc: { score: 10 } })
                const doc = await adapter.get("doc1")
                expect(doc?.score).toBe(110)
            })

            test("updateOne $unset", async () => {
                await adapter.updateOne({ id: "doc1" }, { $unset: { score: 1 } })
                const doc = await adapter.get("doc1")
                expect(doc?.score).toBeUndefined()
            })

            test("updateMany", async () => {
                await adapter.set("doc2", { id: "doc2", name: "Bob", age: 25 })
                await adapter.updateMany({ age: 25 }, { $set: { verified: true } })
                
                const doc1 = await adapter.get("doc1")
                const doc2 = await adapter.get("doc2")
                expect(doc1?.verified).toBe(true)
                expect(doc2?.verified).toBe(true)
            })

            test("upsert", async () => {
                await adapter.updateOne(
                    { id: "newDoc" },
                    { $set: { name: "New User" } },
                    { upsert: true }
                )
                const doc = await adapter.get("newDoc")
                expect(doc?.name).toBe("New User")
            })
        })

        describe("批量操作", () => {
            test("insertMany", async () => {
                const result = await adapter.insertMany([
                    { id: "1", name: "A" },
                    { id: "2", name: "B" },
                    { id: "3", name: "C" },
                ])
                
                expect(result.insertedCount).toBe(3)
                expect(await adapter.count()).toBe(3)
            })

            test("insertMany 跳过重复", async () => {
                await adapter.set("1", { id: "1", name: "Existing" })
                
                const result = await adapter.insertMany([
                    { id: "1", name: "A" },
                    { id: "2", name: "B" },
                ])
                
                expect(result.insertedCount).toBe(1)
                expect(result.skippedCount).toBe(1)
            })

            test("setMany", async () => {
                await adapter.set("1", { id: "1", name: "Old", extra: "keep" })
                
                const result = await adapter.setMany([
                    { id: "1", name: "Updated" },
                    { id: "2", name: "New" },
                ])
                
                expect(result.insertedCount).toBe(1)
                expect(result.overwriteCount).toBe(1)
                
                const doc = await adapter.get("1")
                expect(doc?.name).toBe("Updated")
                expect(doc?.extra).toBe("keep") // 保留原有字段
            })

            test("deleteMany", async () => {
                await adapter.insertMany([
                    { id: "1", age: 20 },
                    { id: "2", age: 30 },
                    { id: "3", age: 40 },
                ])
                
                const result = await adapter.deleteMany({ age: { $gte: 30 } })
                expect(result.deletedCount).toBe(2)
                expect(await adapter.count()).toBe(1)
            })
        })

        describe("事务", () => {
            test("insertMany 在事务中", async () => {
                const result = await adapter.insertMany([
                    { id: "1", name: "A" },
                    { id: "2", name: "B" },
                    { id: "3", name: "C" },
                ])
                
                // 所有操作应该是原子的
                expect(result.insertedCount).toBe(3)
            })

            test("bulkUpdate", async () => {
                await adapter.insertMany([
                    { id: "1", status: "pending" },
                    { id: "2", status: "pending" },
                ])
                
                const result = await adapter.bulkUpdate([
                    { filter: { id: "1" }, updateOp: { $set: { status: "done" } } },
                    { filter: { id: "2" }, updateOp: { $set: { status: "done" } } },
                ])
                
                expect(result.modifiedCount).toBe(2)
            })
        })

        describe("特殊数据类型", () => {
            test("Date 类型", async () => {
                const now = new Date()
                await adapter.set("doc1", { id: "doc1", createdAt: now })
                
                const doc = await adapter.get("doc1") as any
                expect(doc?.createdAt).toBeInstanceOf(Date)
                expect(doc?.createdAt.getTime()).toBe(now.getTime())
            })

            test("null 值", async () => {
                await adapter.set("doc1", { id: "doc1", value: null })
                
                const doc = await adapter.get("doc1")
                expect(doc?.value).toBeNull()
            })

            test("嵌套对象", async () => {
                await adapter.set("doc1", {
                    id: "doc1",
                    nested: { a: { b: { c: 123 } } }
                })
                
                const doc = await adapter.get("doc1") as any
                expect(doc?.nested.a.b.c).toBe(123)
            })

            test("数组", async () => {
                await adapter.set("doc1", {
                    id: "doc1",
                    items: [1, 2, 3, "four", { five: 5 }]
                })
                
                const doc = await adapter.get("doc1")
                expect(doc?.items).toEqual([1, 2, 3, "four", { five: 5 }])
            })
        })
    })

    test("自动选择驱动", async () => {
        const factory = SQLiteAdapter({
            filename: ":memory:",
            driver: "auto",
        })
        const adapter = await factory.useAdapterInstance("test")
        
        // 应该能正常工作
        await adapter.set("doc1", { id: "doc1", test: true })
        const doc = await adapter.get("doc1")
        expect(doc?.test).toBe(true)
        
        await adapter.close()
    })
})
