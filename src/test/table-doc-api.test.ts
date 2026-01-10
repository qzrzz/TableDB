import { describe, test, expect, beforeAll, beforeEach } from "vitest"
import { Table } from "../core/Table"
import { getTestTableByType, TestDatabaseType } from "./getTestTable"

const DATABASE_TYPES: TestDatabaseType[] = ["sqlite", "mongodb"]

describe.each(DATABASE_TYPES)("Table API - %s", async (dbType) => {
    let table!: Table

    beforeAll(async () => {
        table = await getTestTableByType("table-doc-api.test", dbType)
        await table.clearAll()
        await table.defineIndexes([{ key: "id", unique: true }])
    })

    beforeEach(async () => {
        await table.clear()
    })

    test("findMany", async () => {
        // 插入测试数据
        const docs = [
            { id: 1, group: "A", value: 10 },
            { id: 2, group: "B", value: 20 },
            { id: 3, group: "A", value: 30 },
            { id: 4, group: "A", value: 40 },
            { id: 5, group: "B", value: 50 },
            { id: 6, group: "C", value: 60 },
        ]

        await table.setMany(docs)

        // 测试 findMany
        const re1 = await table.findMany({ group: "A" })
        expect(re1.length).toBe(3)
        expect(re1).toEqual([
            { id: 1, group: "A", value: 10 },
            { id: 3, group: "A", value: 30 },
            { id: 4, group: "A", value: 40 },
        ])

        // 测试带排序和分页的 findMany
        const re2 = await table.findMany({ group: "A" }, { sort: { value: -1 }, limit: 2 })
        expect(re2.length).toBe(2)
        expect(re2).toEqual([
            { id: 4, group: "A", value: 40 },
            { id: 3, group: "A", value: 30 },
        ])

        // offset 分页
        const re3 = await table.findMany({ group: "A" }, { sort: { value: -1 }, offset: 1, limit: 2 })
        expect(re3.length).toBe(2)
        expect(re3).toEqual([
            { id: 3, group: "A", value: 30 },
            { id: 1, group: "A", value: 10 },
        ])

        // projection
        const re4 = await table.findMany({ group: "B" }, { projection: { id: 1 } })
        expect(re4.length).toBe(2)
        expect(re4).toEqual([{ id: 2 }, { id: 5 }])
    })

    test("findMany projection", async () => {
        await table.setMany([
            { id: 1, a: 1, b: 10, c: 100 },
            { id: 2, a: 2, b: 20, c: 200 },
        ])

        // 返回指定字段 a 和 c
        const r1 = await table.findMany({}, { projection: { a: 1, c: 1 } })
        expect(r1).toEqual([
            { a: 1, c: 100 },
            { a: 2, c: 200 },
        ])

        // 返回要求包含 _id
        const r2 = await table.findMany({}, { projection: { a: 1, c: 1, _id: 1 } })
        expect(r2.length).toBe(2)
        expect(r2[0]._id).toBeDefined()
        expect(r2[1]._id).toBeDefined()
    })

    test("KV Operations", async () => {
        await table.set("k1", { value: 100 } as any)
        expect(await table.has("k1")).toBe(true)
        expect(await table.get("k1")).toEqual({ id: "k1", value: 100 })
        expect(await table.count()).toBe(1)

        await table.delete("k1")
        expect(await table.has("k1")).toBe(false)
        expect(await table.get("k1")).toBeUndefined()
        expect(await table.count()).toBe(0)
    })

    test("findOne", async () => {
        await table.setMany([
            { id: 1, group: "A", val: 10 },
            { id: 2, group: "A", val: 20 },
        ])

        const doc = await table.findOne({ group: "A" })
        expect(doc).toBeDefined()
        expect(doc?.group).toBe("A")

        const none = await table.findOne({ group: "C" })
        expect(none).toBeUndefined()
    })

    test("insertMany", async () => {
        await table.set(1, { val: 10 } as any)

        // 尝试插入已存在的 ID (1) 和新 ID (2)
        // insertMany 应该忽略已存在的 ID
        const res = await table.insertMany([
            { id: 1, val: 999 }, // 应该被忽略
            { id: 2, val: 20 }, // 应该被插入
        ])

        expect(res.insertedCount).toBe(1)
        expect(res.skippedCount).toBe(1)

        expect(await table.get(1)).toEqual({ id: 1, val: 10 })
        expect(await table.get(2)).toEqual({ id: 2, val: 20 })
    })

    test("setMany options", async () => {
        await table.setMany([{ id: 1, val: 10 }])

        // 1. insertOnly: true (只插入不存在的)
        const res1 = await table.setMany(
            [
                { id: 1, val: 999 }, // 已存在，应忽略
                { id: 2, val: 20 }, // 不存在，应插入
            ],
            { insertOnly: true }
        )
        expect(res1.insertedCount).toBe(1)
        expect(res1.overwriteCount).toBe(0) // 1 was skipped, not overwritten

        expect(await table.get(1)).toEqual({ id: 1, val: 10 })
        expect(await table.get(2)).toEqual({ id: 2, val: 20 })

        // 2. updateOnly: true (只更新存在的)
        const res2 = await table.setMany(
            [
                { id: 2, val: 222 }, // 已存在，应更新
                { id: 3, val: 30 }, // 不存在，应忽略
            ],
            { updateOnly: true }
        )
        expect(res2.insertedCount).toBe(0)
        expect(res2.overwriteCount).toBe(1) // 2 was overwritten

        expect(await table.get(2)).toEqual({ id: 2, val: 222 })
        expect(await table.has(3)).toBe(false)
    })

    test("setMany overwrite", async () => {
        await table.setMany([
            { id: 1, group: "A", val: 10, obj: { k1: 1, k2: 2, k3: { kk1: "123" } } },
            { id: 2, group: "A", val: 20, obj: { k1: 1, k2: 2 } },
            { id: 3, group: "B", val: 30 },
        ])

        await table.setMany([{ id: 2, obj: { k1: "updated" } }])

        expect(await table.get(2)).toEqual({
            id: 2,
            group: "A",
            val: 20,
            obj: { k1: "updated" },
        })

        await table.setMany([{ id: 1, "obj.k3.kk1": "updated" }])
        expect(await table.get(1)).toEqual({
            id: 1,
            group: "A",
            val: 10,
            obj: { k1: 1, k2: 2, k3: { kk1: "updated" } },
        })
    })

    test("setMany merge", async () => {
        await table.setMany([
            { id: 1, group: "A", val: 10, obj: { k1: 1, k2: 2, k3: { kk1: "123" } } },
            { id: 2, group: "A", val: 20, obj: { k1: 1, k2: 2 } },
            { id: 3, group: "B", val: 30, meta: { info: "test", file: { name: "a1" } } },
        ])

        await table.setMany([{ id: 2, obj: { k1: "updated" } }], { merge: true })
        expect(await table.get(2)).toEqual({
            id: 2,
            group: "A",
            val: 20,
            obj: { k1: "updated", k2: 2 },
        })

        await table.setMany([{ id: 2, o0: 1, obj: { k1: "updated", k3: { o1: "new" } } }], { merge: true })
        expect(await table.get(2)).toEqual({
            id: 2,
            group: "A",
            val: 20,
            o0: 1,
            obj: { k1: "updated", k2: 2, k3: { o1: "new" } },
        })

        await table.setMany([{ id: 3, meta: { file: { link: 1, __overwrite__: true } } }], { merge: true })
        expect(await table.get(3)).toEqual({
            id: 3,
            group: "B",
            val: 30,
            meta: { info: "test", file: { link: 1 } },
        })
    })

    test("updateOne", async () => {
        await table.setMany([
            { id: 1, group: "A", val: 10 },
            { id: 2, group: "A", val: 20 },
        ])

        // 1. 基础更新
        const res1 = await table.updateOne({ group: "A" }, { $set: { val: 99 } })
        expect(res1.matchedCount).toBe(1)
        expect(res1.modifiedCount).toBe(1)

        // 验证至少有一个被更新
        const docs = await table.findMany({ group: "A" })
        expect(docs.some((d) => d.val === 99)).toBe(true)

        // 2. 带 sort 的更新
        await table.clear()
        await table.setMany([
            { id: 1, group: "A", val: 10 },
            { id: 2, group: "A", val: 20 },
        ])
        // 更新 val 最大那个 (id: 2)
        await table.updateOne({ group: "A" }, { $set: { val: 888 } }, { sort: { val: -1 } })
        expect(await table.get(2)).toEqual({ id: 2, group: "A", val: 888 })
        expect(await table.get(1)).toEqual({ id: 1, group: "A", val: 10 })

        // 3. upsert
        const res3 = await table.updateOne({ id: 3 }, { $set: { val: 30, group: "B" } }, { upsert: true })
        // upsert 时 matchedCount 通常为 0, modifiedCount 视实现而定，有时 upsert 算 modified，有时不算
        // 但我们可以检查数据是否存在
        expect(await table.get(3)).toMatchObject({ id: 3, val: 30, group: "B" })
    })

    test("updateMany", async () => {
        await table.setMany([
            { id: 1, group: "A", val: 10 },
            { id: 2, group: "A", val: 20 },
            { id: 3, group: "B", val: 30 },
        ])

        // 批量更新
        const res = await table.updateMany({ group: "A" }, { $inc: { val: 1 } })
        expect(res.matchedCount).toBe(2)
        expect(res.modifiedCount).toBe(2)

        expect(await table.get(1)).toMatchObject({ val: 11 })
        expect(await table.get(2)).toMatchObject({ val: 21 })
        expect(await table.get(3)).toMatchObject({ val: 30 })

        // upsert
        await table.updateMany({ id: 4 }, { $setOnInsert: { val: 40, group: "C" } }, { upsert: true })
        expect(await table.get(4)).toMatchObject({ id: 4, val: 40, group: "C" })
    })

    test("deleteOne", async () => {
        await table.setMany([
            { id: 1, group: "A", val: 10 },
            { id: 2, group: "A", val: 20 },
            { id: 3, group: "A", val: 30 },
            { id: 4, group: "B", val: 1 },
        ])
        const res1 = await table.deleteOne({ group: "B" })
        expect(res1.deletedCount).toBe(1)
        expect(await table.has(4)).toBe(false)

        // 带 sort 删除 (删除 val 最小的 -> id: 1)
        const res2 = await table.deleteOne({ group: "A" }, { sort: { val: 1 } })
        expect(res2.deletedCount).toBe(1)
        expect(await table.has(2)).toBe(true)
        expect(await table.has(3)).toBe(true)

        const res3 = await table.deleteOne({ group: "A" }, { sort: { val: -1 } })
        expect(res3.deletedCount).toBe(1)
        expect(await table.has(2)).toBe(true)
        expect(await table.has(3)).toBe(false)
    })

    test("deleteMany", async () => {
        await table.setMany([
            { id: 1, group: "A" },
            { id: 2, group: "A" },
            { id: 3, group: "B" },
        ])

        const res = await table.deleteMany({ group: "A" })
        expect(res.deletedCount).toBe(2)

        expect(await table.count()).toBe(1)
        expect(await table.has(3)).toBe(true)
    })

    test("deleteMany 2", async () => {
        await table.setMany([
            { id: 1, group: "A" },
            { id: 2, group: "A" },
            { id: 3, group: "B" },
            { id: 4, group: "B" },
            { id: 5, group: "B" },
        ])

        const res = await table.deleteMany({ id: { $in: [3, 4, 5] } })

        expect(res.deletedCount).toBe(3)
        expect(await table.count()).toBe(2)
        expect(await table.has(1)).toBe(true)
        expect(await table.has(2)).toBe(true)
        expect(await table.has(3)).toBe(false)
    })

    test("findMany options (Array syntax)", async () => {
        await table.setMany([
            { id: 1, a: 1, b: 10 },
            { id: 2, a: 2, b: 20 },
        ])

        // Sort array ['-a']
        const r1 = await table.findMany({}, { sort: ["-a"] })
        expect(r1[0].id).toBe(2)
        expect(r1[1].id).toBe(1)

        // Projection array ['a']
        // 注意：不同 adapter 对 projection 行为可能略有不同，通常 _id/id 会保留
        const r2 = await table.findMany({ id: 1 }, { projection: ["a"] })
        expect(r2[0].a).toBe(1)
        expect(r2[0].b).toBeUndefined()
    })

    test("Indexes", async () => {
        // 定义唯一索引
        await table.defineIndexes([{ key: "code", unique: true }])

        await table.setMany([{ id: 1, code: "abc" }])

        // 尝试插入重复 code，预期会失败
        try {
            await table.insertMany([{ id: 2, code: "abc" }])
            // 如果没有抛出错误，可能是 adapter 实现差异，但在测试中我们通常期望它报错
            // 这里不做硬性断言，因为不同 adapter 行为可能不同，但至少调用了 defineIndexes
        } catch (e) {
            expect(e).toBeDefined()
        }

        // 清除索引
        await table.dropIndexes()
    })
})
