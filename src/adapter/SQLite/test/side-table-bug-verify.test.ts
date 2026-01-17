/**
 * 侧表机制验证测试
 * 
 * 此测试文件验证侧表机制的正确性，包括 null/undefined 查询
 * 
 * ✅ 已修复的问题：
 * - null/undefined 查询现在使用纯 SQL 实现
 * - 生成的 SQL 正确匹配：字段不存在、字段值为 null、数组包含 null
 * 
 * MongoDB 语义说明：
 * - undefined 在存入时会被转换为 null
 * - 查询 { field: null } 应匹配：字段值为 null、字段不存在、数组包含 null
 */


import { describe, test, expect, beforeAll, beforeEach, afterAll } from "vitest"
import { ITableDBAdapterInstance, ITableDebugResult } from "../../adapter"
import { SQLiteAdapter } from "../SQLiteAdapter"

describe("侧表机制 BUG 验证 - 严格断言", () => {
    let adapter!: ITableDBAdapterInstance

    beforeAll(async () => {
        const factory = SQLiteAdapter({ filename: ":memory:" })
        adapter = await factory.useAdapterInstance("bugVerifyTable")
        await adapter.clearAll()
    })

    beforeEach(async () => {
        await adapter.clearAll()
    })

    afterAll(async () => {
        await adapter.close()
    })

    describe("验证 1: undefined 查询行为（符合 MongoDB 语义）", () => {
        /**
         * MongoDB 语义说明：
         * - undefined 在存入 MongoDB 时会被转换为 null
         * - 查询 { field: undefined } 等效于查询 { field: null }
         * - 会匹配字段为 null、undefined 或字段不存在的文档
         */
        test("查询 undefined 应匹配包含 null/undefined 的文档（MongoDB 行为）", async () => {
            await adapter.defineIndexes([{ key: "items" }])

            await adapter.insertMany([
                { id: "doc1", items: [1, undefined, 3] },  // 包含 undefined（存储为 null）
                { id: "doc2", items: [1, 2, 3] },          // 不包含 null/undefined
            ])

            // MongoDB 语义：undefined 被存储为 null
            // 查询 undefined 会匹配包含 null 的数组
            // 但 doc2 的数组不包含 null，所以不应匹配
            const results = await adapter.findMany({ items: undefined })

            // 实际上这取决于 undefined 是否被正确存储为 null
            // 并且查询是否能正确匹配数组中的 null
            expect(results.length).toBe(1)
            expect(results[0].id).toBe("doc1")
        })

        test("无索引时 undefined 查询行为应一致", async () => {
            // 不创建索引，使用 JsMatch

            await adapter.insertMany([
                { id: "doc1", unindexedItems: [1, undefined, 3] },
                { id: "doc2", unindexedItems: [1, 2, 3] },
            ])

            const results = await adapter.findMany({ unindexedItems: undefined })

            // undefined 存储为 null，查询 undefined 等效于查询 null
            expect(results.length).toBe(1)
            expect(results[0].id).toBe("doc1")
        })
    })

    describe("验证 2: null 与 undefined 在 MongoDB 中等效", () => {
        test("null 和 undefined 在 MongoDB 语义下是等效的", async () => {
            await adapter.defineIndexes([{ key: "values" }])

            await adapter.insertMany([
                { id: "doc1", values: [null, 1] },      // 包含 null
                { id: "doc2", values: [undefined, 2] }, // 包含 undefined（存储为 null）
                { id: "doc3", values: [3, 4] },         // 都不包含
            ])

            // MongoDB 语义：null 查询会匹配 null 和 undefined（存储为 null）
            const nullResults = await adapter.findMany({ values: null })
            // doc1 和 doc2 都包含 null（undefined 被存储为 null）
            expect(nullResults.length).toBe(2)
            expect(nullResults.map(r => r.id).sort()).toEqual(["doc1", "doc2"])

            // undefined 查询等效于 null 查询
            const undefinedResults = await adapter.findMany({ values: undefined })
            expect(undefinedResults.length).toBe(2)
            expect(undefinedResults.map(r => r.id).sort()).toEqual(["doc1", "doc2"])
        })
    })

    describe("BUG 验证 3: 字段缺失 vs 字段值为 null/undefined", () => {
        /**
         * MongoDB 语义：
         * - { field: null } 匹配 field 为 null 或字段不存在的文档
         * - { field: undefined } 行为复杂，通常与 null 类似
         * - { field: { $exists: false } } 仅匹配字段不存在的文档
         */
        test("字段不存在 vs 字段值为 null", async () => {
            await adapter.defineIndexes([{ key: "optional" }])

            await adapter.insertMany([
                { id: "doc1", optional: null },    // 字段存在，值为 null
                { id: "doc2", optional: ["A"] },   // 字段存在，有值
                { id: "doc3", name: "no optional" }, // 字段不存在
            ])

            // 使用 $exists: false 查询字段不存在的文档
            const notExistsResults = await adapter.findMany({ optional: { $exists: false } })
            expect(notExistsResults.length).toBe(1)
            expect(notExistsResults[0].id).toBe("doc3")

            // 查询 optional 为 null
            // MongoDB 语义：匹配 null 值和字段不存在
            const nullResults = await adapter.findMany({ optional: null })
            // 预期匹配 doc1 和 doc3
            expect(nullResults.length).toBe(2)
            expect(nullResults.map(r => r.id).sort()).toEqual(["doc1", "doc3"])
        })
    })

    describe("BUG 验证 4: 侧表数据一致性", () => {
        test("连续操作后侧表数据应保持一致", async () => {
            await adapter.defineIndexes([{ key: "tags" }])

            // 步骤 1: 插入
            await adapter.insertMany([
                { id: "doc1", tags: ["A", "B", "C"] },
            ])

            // 验证
            let results = await adapter.findMany({ tags: "A" })
            expect(results.length).toBe(1)

            // 步骤 2: 更新 - 移除 A，添加 D
            await adapter.updateOne({ id: "doc1" }, { $set: { tags: ["B", "C", "D"] } })

            // 验证 A 不再匹配
            results = await adapter.findMany({ tags: "A" })
            expect(results.length).toBe(0)

            // 验证 D 匹配
            results = await adapter.findMany({ tags: "D" })
            expect(results.length).toBe(1)

            // 步骤 3: 删除文档
            await adapter.deleteOne({ id: "doc1" })

            // 验证所有 tags 都不再匹配
            for (const tag of ["B", "C", "D"]) {
                results = await adapter.findMany({ tags: tag })
                expect(results.length).toBe(0)
            }

            // 步骤 4: 重新插入相同 ID
            await adapter.insertMany([
                { id: "doc1", tags: ["E", "F"] },
            ])

            // 验证新 tags 匹配
            results = await adapter.findMany({ tags: "E" })
            expect(results.length).toBe(1)

            // 验证旧 tags 不匹配
            results = await adapter.findMany({ tags: "D" })
            expect(results.length).toBe(0)
        })
    })

    describe("BUG 验证 5: 索引与无索引查询结果一致性", () => {
        /**
         * 问题描述：
         * 有索引时使用侧表查询，无索引时使用 JsMatch
         * 两者的结果应该完全一致
         */
        test("有索引和无索引的查询结果应一致", async () => {
            // 为 indexedField 创建索引
            await adapter.defineIndexes([{ key: "indexedField" }])

            // 插入测试数据
            await adapter.insertMany([
                { id: "doc1", indexedField: ["A", "B"], noIndexField: ["A", "B"] },
                { id: "doc2", indexedField: ["B", "C"], noIndexField: ["B", "C"] },
                { id: "doc3", indexedField: ["A"], noIndexField: ["A"] },
                { id: "doc4", indexedField: "A", noIndexField: "A" },  // 标量值
            ])

            // 比较查询结果
            const indexedResults = await adapter.findMany({ indexedField: "A" })
            const noIndexResults = await adapter.findMany({ noIndexField: "A" })

            // 结果应该完全一致
            expect(indexedResults.length).toBe(noIndexResults.length)
            expect(indexedResults.map(r => r.id).sort()).toEqual(noIndexResults.map(r => r.id).sort())
        })

        test("$in 操作符有索引和无索引结果一致", async () => {
            await adapter.defineIndexes([{ key: "status" }])

            await adapter.insertMany([
                { id: "doc1", status: ["pending"], rawStatus: ["pending"] },
                { id: "doc2", status: ["approved"], rawStatus: ["approved"] },
                { id: "doc3", status: ["pending", "review"], rawStatus: ["pending", "review"] },
            ])

            const indexedResults = await adapter.findMany({ status: { $in: ["pending", "approved"] } })
            const noIndexResults = await adapter.findMany({ rawStatus: { $in: ["pending", "approved"] } })

            expect(indexedResults.length).toBe(noIndexResults.length)
            expect(indexedResults.map(r => r.id).sort()).toEqual(noIndexResults.map(r => r.id).sort())
        })
    })

    describe("BUG 验证 6: 批量操作后侧表完整性", () => {
        test("大批量插入后侧表数据完整", async () => {
            await adapter.defineIndexes([{ key: "category" }])

            // 插入 1500 条数据，触发批量优化路径
            const docs = []
            for (let i = 0; i < 1500; i++) {
                docs.push({
                    id: `bulk${i}`,
                    category: [i % 5 === 0 ? "special" : "normal", `cat${i % 100}`]
                })
            }
            await adapter.insertMany(docs)

            // 验证 special 分类数量 (1500 / 5 = 300)
            const specialResults = await adapter.findMany({ category: "special" })
            expect(specialResults.length).toBe(300)

            // 验证特定 cat 分类数量 (1500 / 100 = 15)
            const cat50Results = await adapter.findMany({ category: "cat50" })
            expect(cat50Results.length).toBe(15)
        })

        test("批量更新后侧表数据一致", async () => {
            await adapter.defineIndexes([{ key: "status" }])

            // 插入初始数据
            const docs = []
            for (let i = 0; i < 100; i++) {
                docs.push({ id: `doc${i}`, status: ["pending"] })
            }
            await adapter.insertMany(docs)

            // 验证初始状态
            let pendingResults = await adapter.findMany({ status: "pending" })
            expect(pendingResults.length).toBe(100)

            // 批量更新
            await adapter.updateMany({ status: "pending" }, { $set: { status: ["approved"] } })

            // 验证更新后
            pendingResults = await adapter.findMany({ status: "pending" })
            expect(pendingResults.length).toBe(0)

            const approvedResults = await adapter.findMany({ status: "approved" })
            expect(approvedResults.length).toBe(100)
        })
    })

    describe("BUG 验证 7: 嵌套路径索引", () => {
        test("嵌套路径索引应正确工作", async () => {
            await adapter.defineIndexes([{ key: "user.tags" }])

            await adapter.insertMany([
                { id: "doc1", user: { tags: ["admin", "active"], name: "Alice" } },
                { id: "doc2", user: { tags: ["user", "active"], name: "Bob" } },
                { id: "doc3", user: { name: "Charlie" } },  // 无 tags 字段
            ])

            // 查询嵌套 tags
            const adminResults = await adapter.findMany({ "user.tags": "admin" })
            expect(adminResults.length).toBe(1)
            expect(adminResults[0].id).toBe("doc1")

            // 查询 active
            const activeResults = await adapter.findMany({ "user.tags": "active" })
            expect(activeResults.length).toBe(2)
            expect(activeResults.map(r => r.id).sort()).toEqual(["doc1", "doc2"])
        })

        test("深层嵌套路径索引", async () => {
            await adapter.defineIndexes([{ key: "a.b.c.tags" }])

            await adapter.insertMany([
                { id: "doc1", a: { b: { c: { tags: ["deep", "nested"] } } } },
                { id: "doc2", a: { b: { c: { tags: ["shallow"] } } } },
            ])

            const deepResults = await adapter.findMany({ "a.b.c.tags": "deep" })
            expect(deepResults.length).toBe(1)
            expect(deepResults[0].id).toBe("doc1")
        })
    })

    describe("BUG 验证 8: 特殊类型在数组中的序列化", () => {
        test("Date 类型数组元素应正确序列化和查询", async () => {
            await adapter.defineIndexes([{ key: "timestamps" }])

            const date1 = new Date("2024-01-01T00:00:00.000Z")
            const date2 = new Date("2024-06-15T12:30:00.000Z")

            await adapter.insertMany([
                { id: "doc1", timestamps: [date1, date2] },
                { id: "doc2", timestamps: [date2] },
            ])

            // 精确查询 date1
            const date1Results = await adapter.findMany({ timestamps: date1 })
            expect(date1Results.length).toBe(1)
            expect(date1Results[0].id).toBe("doc1")

            // 精确查询 date2
            const date2Results = await adapter.findMany({ timestamps: date2 })
            expect(date2Results.length).toBe(2)
        })

        test("BigInt 类型数组元素应正确序列化和查询", async () => {
            await adapter.defineIndexes([{ key: "bigNumbers" }])

            const big1 = BigInt("9007199254740993")  // 超过 MAX_SAFE_INTEGER
            const big2 = BigInt("9007199254740994")

            await adapter.insertMany([
                { id: "doc1", bigNumbers: [big1, BigInt(100)] },
                { id: "doc2", bigNumbers: [big2] },
            ])

            // 精确查询 big1
            const big1Results = await adapter.findMany({ bigNumbers: big1 })
            expect(big1Results.length).toBe(1)
            expect(big1Results[0].id).toBe("doc1")

            // 精确查询 big2
            const big2Results = await adapter.findMany({ bigNumbers: big2 })
            expect(big2Results.length).toBe(1)
            expect(big2Results[0].id).toBe("doc2")
        })
    })

    describe("BUG 验证 9: 数组与标量混合查询", () => {
        test("同一字段有标量和数组值时，查询应正确匹配", async () => {
            await adapter.defineIndexes([{ key: "mixedField" }])

            await adapter.insertMany([
                { id: "doc1", mixedField: "solo" },           // 标量
                { id: "doc2", mixedField: ["solo", "multi"] }, // 数组包含 solo
                { id: "doc3", mixedField: ["other"] },         // 数组不包含 solo
            ])

            // 查询 mixedField === "solo"
            // MongoDB 语义：匹配标量 "solo" 和数组包含 "solo"
            const results = await adapter.findMany({ mixedField: "solo" })
            expect(results.length).toBe(2)
            expect(results.map(r => r.id).sort()).toEqual(["doc1", "doc2"])
        })
    })

    describe("BUG 验证 10: 空数组处理", () => {
        test("空数组不应匹配任何值查询", async () => {
            await adapter.defineIndexes([{ key: "emptyCheck" }])

            await adapter.insertMany([
                { id: "doc1", emptyCheck: [] },        // 空数组
                { id: "doc2", emptyCheck: ["value"] }, // 有值
            ])

            // 查询任意值
            const results = await adapter.findMany({ emptyCheck: "value" })
            expect(results.length).toBe(1)
            expect(results[0].id).toBe("doc2")

            // 空数组文档不应匹配
            const anyResults = await adapter.findMany({ emptyCheck: "anything" })
            expect(anyResults.length).toBe(0)
        })

        test("$size: 0 应匹配空数组", async () => {
            await adapter.defineIndexes([{ key: "sizeCheck" }])

            await adapter.insertMany([
                { id: "doc1", sizeCheck: [] },
                { id: "doc2", sizeCheck: ["A"] },
                { id: "doc3", sizeCheck: ["A", "B"] },
            ])

            const emptyResults = await adapter.findMany({ sizeCheck: { $size: 0 } })
            expect(emptyResults.length).toBe(1)
            expect(emptyResults[0].id).toBe("doc1")
        })
    })

    describe("BUG 验证 11: 删除索引后的行为", () => {
        test("删除索引后查询应仍然正确（使用 JsMatch）", async () => {
            // 创建索引
            await adapter.defineIndexes([{ key: "tempIndex", name: "idx_tempIndex" }])

            await adapter.insertMany([
                { id: "doc1", tempIndex: ["A", "B"] },
                { id: "doc2", tempIndex: ["B", "C"] },
            ])

            // 有索引时查询
            let results = await adapter.findMany({ tempIndex: "A" })
            expect(results.length).toBe(1)

            // 删除索引
            await adapter.defineIndexes([{ key: "tempIndex", name: "idx_tempIndex", disabled: true }])

            // 无索引时查询仍应正确
            results = await adapter.findMany({ tempIndex: "A" })
            expect(results.length).toBe(1)
            expect(results[0].id).toBe("doc1")
        })
    })
})

describe("侧表数据完整性检查（需要直接访问 SQLite）", () => {
    // 这些测试需要直接访问底层 SQLite 来验证侧表数据
    // 在实际场景中可以通过 debug 接口或直接连接数据库来验证

    test.skip("侧表数据与主表数据应一一对应", async () => {
        // 此测试需要直接查询侧表来验证数据一致性
        // 暂时跳过，需要扩展 adapter 接口来支持
    })
})
