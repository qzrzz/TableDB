/**
 * 侧表机制边界情况 BUG 测试
 * 
 * 这些测试针对更极端的边界情况，旨在找出侧表机制中隐藏的 BUG
 * 
 * 主要测试点：
 * 1. 数组嵌套层级问题
 * 2. 特殊值（NaN, Infinity, undefined）在数组中的处理
 * 3. 重复元素处理
 * 4. 数组元素顺序变化
 * 5. 大量唯一值的性能和正确性
 * 6. 索引字段不存在或为 undefined
 * 7. 侧表与主表数据不一致检测
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from "vitest"
import { ITableDBAdapterInstance, ITableDebugResult } from "../../adapter"
import { SQLiteAdapter } from "../SQLiteAdapter"
import Database from "better-sqlite3"

describe("侧表机制边界情况 BUG 测试", () => {
    let adapter!: ITableDBAdapterInstance

    beforeAll(async () => {
        const factory = SQLiteAdapter({ filename: ":memory:" })
        adapter = await factory.useAdapterInstance("edgeCaseTable")
        await adapter.clearAll()
    })

    beforeEach(async () => {
        await adapter.clearAll()
    })

    afterAll(async () => {
        await adapter.close()
    })

    describe("边界 1: 数组嵌套层级", () => {
        test("嵌套数组的处理 - 一维数组 vs 二维数组", async () => {
            await adapter.defineIndexes([{ key: "matrix" }])

            await adapter.insertMany([
                { id: "doc1", matrix: [[1, 2], [3, 4]] },    // 二维数组
                { id: "doc2", matrix: [1, 2, 3] },           // 一维数组
            ])

            // 查询 matrix 包含 1 的文档
            // MongoDB 语义：一维数组应匹配，二维数组（嵌套数组元素）可能不匹配
            const results = await adapter.findMany({ matrix: 1 })

            // 预期：只有 doc2 匹配（因为 doc1 的元素是子数组，不是 1）
            // 如果 doc1 也匹配，说明侧表展开了嵌套数组，这可能是 BUG
            console.log("嵌套数组测试结果:", results.map(r => r.id))
            // 允许两种行为，记录结果供人工确认
        })

        test("查询嵌套数组内的元素", async () => {
            await adapter.defineIndexes([{ key: "data.nested" }])

            await adapter.insertMany([
                { id: "doc1", data: { nested: [["A", "B"], ["C", "D"]] } },
                { id: "doc2", data: { nested: ["A", "B", "C"] } },
            ])

            // 查询 data.nested 包含 "A" 的文档
            const results = await adapter.findMany({ "data.nested": "A" })
            console.log("嵌套字段测试结果:", results.map(r => r.id))
        })
    })

    describe("边界 2: 特殊值在数组中的处理", () => {
        test("数组包含 NaN 值", async () => {
            await adapter.defineIndexes([{ key: "values" }])

            await adapter.insertMany([
                { id: "doc1", values: [1, NaN, 3] },
                { id: "doc2", values: [4, 5, 6] },
            ])

            // 查询 values 包含 NaN 的文档
            // NaN !== NaN，MongoDB 使用特殊逻辑处理
            const results = await adapter.findMany({ values: NaN })
            console.log("NaN 测试结果:", results.map(r => r.id))

            // 预期：doc1 应该匹配
            expect(results.length).toBe(1)
            expect(results[0].id).toBe("doc1")
        })

        test("数组包含 Infinity 和 -Infinity", async () => {
            await adapter.defineIndexes([{ key: "numbers" }])

            await adapter.insertMany([
                { id: "doc1", numbers: [1, Infinity, 3] },
                { id: "doc2", numbers: [-Infinity, 2, 3] },
                { id: "doc3", numbers: [1, 2, 3] },
            ])

            // 查询包含 Infinity 的文档
            const infResults = await adapter.findMany({ numbers: Infinity })
            console.log("Infinity 测试结果:", infResults.map(r => r.id))
            expect(infResults.length).toBe(1)
            expect(infResults[0].id).toBe("doc1")

            // 查询包含 -Infinity 的文档
            const negInfResults = await adapter.findMany({ numbers: -Infinity })
            console.log("-Infinity 测试结果:", negInfResults.map(r => r.id))
            expect(negInfResults.length).toBe(1)
            expect(negInfResults[0].id).toBe("doc2")
        })

        test("数组包含 undefined 值", async () => {
            await adapter.defineIndexes([{ key: "items" }])

            await adapter.insertMany([
                { id: "doc1", items: [1, undefined, 3] },
                { id: "doc2", items: [1, 2, 3] },
            ])

            // 查询 items 包含 undefined 的文档
            const results = await adapter.findMany({ items: undefined })
            console.log("undefined 测试结果:", results.map(r => r.id))
        })

        test("数组包含 null 值", async () => {
            await adapter.defineIndexes([{ key: "items" }])

            await adapter.insertMany([
                { id: "doc1", items: [1, null, 3] },
                { id: "doc2", items: [1, 2, 3] },
            ])

            // 查询 items 包含 null 的文档
            const results = await adapter.findMany({ items: null })
            console.log("null 测试结果:", results.map(r => r.id))

            // 预期：doc1 应该匹配
            expect(results.length).toBe(1)
            expect(results[0].id).toBe("doc1")
        })
    })

    describe("边界 3: 重复元素处理", () => {
        test("数组包含大量重复元素", async () => {
            await adapter.defineIndexes([{ key: "tags" }])

            await adapter.insertMany([
                { id: "doc1", tags: ["A", "A", "A", "A", "A"] }, // 全是重复元素
                { id: "doc2", tags: ["A", "B"] },
            ])

            // 查询 tags 包含 "A" 的文档
            const results = await adapter.findMany({ tags: "A" })
            expect(results.length).toBe(2)

            // 验证侧表没有创建重复条目（使用 DISTINCT）
            // 这需要直接查询侧表来验证，暂时仅验证功能正确性
        })

        test("更新后数组元素变成重复", async () => {
            await adapter.defineIndexes([{ key: "tags" }])

            await adapter.insertMany([
                { id: "doc1", tags: ["A", "B", "C"] },
            ])

            // 更新：将 B 和 C 都改成 A
            await adapter.updateOne({ id: "doc1" }, { $set: { tags: ["A", "A", "A"] } })

            // 验证功能正确性
            const results = await adapter.findMany({ tags: "A" })
            expect(results.length).toBe(1)

            // 确认不再匹配 B 或 C
            const bResults = await adapter.findMany({ tags: "B" })
            expect(bResults.length).toBe(0)
        })
    })

    describe("边界 4: 数组元素的特殊字符串", () => {
        test("数组元素包含 SQL 特殊字符", async () => {
            await adapter.defineIndexes([{ key: "tags" }])

            await adapter.insertMany([
                { id: "doc1", tags: ["'; DROP TABLE users; --", "normal"] },
                { id: "doc2", tags: ["tag's quote", "normal"] },
                { id: "doc3", tags: ["100%", "normal"] },
            ])

            // 查询包含 SQL 注入字符串的文档
            const results1 = await adapter.findMany({ tags: "'; DROP TABLE users; --" })
            expect(results1.length).toBe(1)
            expect(results1[0].id).toBe("doc1")

            // 查询包含单引号的文档
            const results2 = await adapter.findMany({ tags: "tag's quote" })
            expect(results2.length).toBe(1)
            expect(results2[0].id).toBe("doc2")

            // 查询包含百分号的文档
            const results3 = await adapter.findMany({ tags: "100%" })
            expect(results3.length).toBe(1)
            expect(results3[0].id).toBe("doc3")
        })

        test("数组元素为空字符串", async () => {
            await adapter.defineIndexes([{ key: "tags" }])

            await adapter.insertMany([
                { id: "doc1", tags: ["", "A"] },
                { id: "doc2", tags: ["B"] },
            ])

            // 查询包含空字符串的文档
            const results = await adapter.findMany({ tags: "" })
            expect(results.length).toBe(1)
            expect(results[0].id).toBe("doc1")
        })

        test("数组元素包含 Unicode 和 Emoji", async () => {
            await adapter.defineIndexes([{ key: "tags" }])

            await adapter.insertMany([
                { id: "doc1", tags: ["中文标签", "🎉", "こんにちは"] },
                { id: "doc2", tags: ["English", "🚀"] },
            ])

            // 查询 Emoji
            const emojiResults = await adapter.findMany({ tags: "🎉" })
            expect(emojiResults.length).toBe(1)
            expect(emojiResults[0].id).toBe("doc1")

            // 查询中文
            const chineseResults = await adapter.findMany({ tags: "中文标签" })
            expect(chineseResults.length).toBe(1)
            expect(chineseResults[0].id).toBe("doc1")
        })
    })

    describe("边界 5: 大量唯一值", () => {
        test("单个文档包含大量唯一元素", async () => {
            await adapter.defineIndexes([{ key: "tags" }])

            // 创建包含 1000 个唯一元素的数组
            const tags = Array.from({ length: 1000 }, (_, i) => `tag_${i}`)
            await adapter.insertMany([
                { id: "doc1", tags },
            ])

            // 查询特定 tag
            const results = await adapter.findMany({ tags: "tag_500" })
            expect(results.length).toBe(1)
            expect(results[0].id).toBe("doc1")

            // 查询不存在的 tag
            const noResults = await adapter.findMany({ tags: "tag_9999" })
            expect(noResults.length).toBe(0)
        })

        test("大量文档，每个文档有不同的 tag", async () => {
            await adapter.defineIndexes([{ key: "uniqueTag" }])

            // 创建 500 个文档，每个有唯一的 tag
            const docs = Array.from({ length: 500 }, (_, i) => ({
                id: `doc${i}`,
                uniqueTag: [`unique_${i}`],
            }))
            await adapter.insertMany(docs)

            // 查询特定文档
            const results = await adapter.findMany({ uniqueTag: "unique_250" })
            expect(results.length).toBe(1)
            expect(results[0].id).toBe("doc250")
        })
    })

    describe("边界 6: 字段不存在或为 undefined", () => {
        test("部分文档没有索引字段", async () => {
            await adapter.defineIndexes([{ key: "optionalTags" }])

            await adapter.insertMany([
                { id: "doc1", optionalTags: ["A", "B"] },     // 有字段
                { id: "doc2", name: "no tags" },              // 无字段
                { id: "doc3", optionalTags: undefined },       // 字段为 undefined
            ])

            // 查询 optionalTags 包含 "A" 的文档
            const results = await adapter.findMany({ optionalTags: "A" })
            expect(results.length).toBe(1)
            expect(results[0].id).toBe("doc1")
        })

        test("更新添加之前不存在的索引字段", async () => {
            await adapter.defineIndexes([{ key: "lateTags" }])

            await adapter.insertMany([
                { id: "doc1", name: "initially no tags" },
            ])

            // 初始查询
            let results = await adapter.findMany({ lateTags: "new" })
            expect(results.length).toBe(0)

            // 添加 lateTags 字段
            await adapter.updateOne({ id: "doc1" }, { $set: { lateTags: ["new", "added"] } })

            // 再次查询
            results = await adapter.findMany({ lateTags: "new" })
            expect(results.length).toBe(1)
            expect(results[0].id).toBe("doc1")
        })

        test("更新移除索引字段", async () => {
            await adapter.defineIndexes([{ key: "removableTags" }])

            await adapter.insertMany([
                { id: "doc1", removableTags: ["A", "B"] },
            ])

            // 初始查询
            let results = await adapter.findMany({ removableTags: "A" })
            expect(results.length).toBe(1)

            // 使用 $unset 移除字段
            await adapter.updateOne({ id: "doc1" }, { $unset: { removableTags: true } })

            // 再次查询
            results = await adapter.findMany({ removableTags: "A" })
            expect(results.length).toBe(0)
        })
    })

    describe("边界 7: 多索引字段交互", () => {
        test("同一文档多个索引字段", async () => {
            await adapter.defineIndexes([
                { key: "tags" },
                { key: "categories" },
            ])

            await adapter.insertMany([
                { id: "doc1", tags: ["A", "B"], categories: ["cat1", "cat2"] },
                { id: "doc2", tags: ["B", "C"], categories: ["cat2", "cat3"] },
            ])

            // 复合查询
            const results = await adapter.findMany({
                tags: "B",
                categories: "cat2",
            })
            expect(results.length).toBe(2)
        })

        test("更新一个索引字段不影响另一个", async () => {
            await adapter.defineIndexes([
                { key: "field1" },
                { key: "field2" },
            ])

            await adapter.insertMany([
                { id: "doc1", field1: ["A"], field2: ["X"] },
            ])

            // 更新 field1
            await adapter.updateOne({ id: "doc1" }, { $set: { field1: ["B"] } })

            // field1 应该更新
            let results = await adapter.findMany({ field1: "A" })
            expect(results.length).toBe(0)
            results = await adapter.findMany({ field1: "B" })
            expect(results.length).toBe(1)

            // field2 应该不变
            results = await adapter.findMany({ field2: "X" })
            expect(results.length).toBe(1)
        })
    })

    describe("边界 8: BigInt 和 Date 在数组中", () => {
        test("数组包含 BigInt 值", async () => {
            await adapter.defineIndexes([{ key: "bigNumbers" }])

            const big1 = BigInt("123456789012345678901234567890")
            const big2 = BigInt("987654321098765432109876543210")

            await adapter.insertMany([
                { id: "doc1", bigNumbers: [big1, BigInt(100)] },
                { id: "doc2", bigNumbers: [big2] },
            ])

            // 查询包含特定 BigInt 的文档
            const results = await adapter.findMany({ bigNumbers: big1 })
            console.log("BigInt 测试结果:", results.map(r => r.id))
            expect(results.length).toBe(1)
            expect(results[0].id).toBe("doc1")
        })

        test("数组包含 Date 值", async () => {
            await adapter.defineIndexes([{ key: "dates" }])

            const date1 = new Date("2024-01-01")
            const date2 = new Date("2024-06-15")
            const date3 = new Date("2024-12-31")

            await adapter.insertMany([
                { id: "doc1", dates: [date1, date2] },
                { id: "doc2", dates: [date2, date3] },
            ])

            // 查询包含特定 Date 的文档
            const results = await adapter.findMany({ dates: date1 })
            console.log("Date 测试结果:", results.map(r => r.id))
            expect(results.length).toBe(1)
            expect(results[0].id).toBe("doc1")

            // date2 应该在两个文档中
            const date2Results = await adapter.findMany({ dates: date2 })
            expect(date2Results.length).toBe(2)
        })
    })

    describe("边界 9: 快速连续操作", () => {
        test("快速连续插入删除同一文档", async () => {
            await adapter.defineIndexes([{ key: "tags" }])

            // 快速插入
            await adapter.set("rapid1", { id: "rapid1", tags: ["fast"] })

            // 立即删除
            await adapter.delete("rapid1")

            // 再次插入相同 ID
            await adapter.set("rapid1", { id: "rapid1", tags: ["faster"] })

            // 验证最终状态
            const results = await adapter.findMany({ tags: "faster" })
            expect(results.length).toBe(1)

            // 旧 tags 不应该匹配
            const oldResults = await adapter.findMany({ tags: "fast" })
            expect(oldResults.length).toBe(0)
        })

        test("快速连续更新同一文档", async () => {
            await adapter.defineIndexes([{ key: "version" }])

            await adapter.set("update1", { id: "update1", version: ["v1"] })

            // 连续更新
            await adapter.updateOne({ id: "update1" }, { $set: { version: ["v2"] } })
            await adapter.updateOne({ id: "update1" }, { $set: { version: ["v3"] } })
            await adapter.updateOne({ id: "update1" }, { $set: { version: ["v4"] } })

            // 验证最终状态
            const results = await adapter.findMany({ version: "v4" })
            expect(results.length).toBe(1)

            // 之前的版本不应该匹配
            for (const v of ["v1", "v2", "v3"]) {
                const oldResults = await adapter.findMany({ version: v })
                expect(oldResults.length).toBe(0)
            }
        })
    })

    describe("边界 10: 复杂 $or 和 $and 组合", () => {
        test("$or 查询使用侧表", async () => {
            await adapter.defineIndexes([{ key: "tags" }])

            await adapter.insertMany([
                { id: "doc1", tags: ["A"] },
                { id: "doc2", tags: ["B"] },
                { id: "doc3", tags: ["C"] },
            ])

            // $or 查询
            const results = await adapter.findMany({
                $or: [
                    { tags: "A" },
                    { tags: "B" },
                ],
            })
            expect(results.length).toBe(2)
            expect(results.map(r => r.id).sort()).toEqual(["doc1", "doc2"])
        })

        test("嵌套 $and 和 $or 组合", async () => {
            await adapter.defineIndexes([
                { key: "tags" },
                { key: "status" },
            ])

            await adapter.insertMany([
                { id: "doc1", tags: ["A", "B"], status: ["active"] },
                { id: "doc2", tags: ["A", "C"], status: ["inactive"] },
                { id: "doc3", tags: ["B", "C"], status: ["active"] },
            ])

            // 复杂查询：(tags: A OR tags: B) AND status: active
            const results = await adapter.findMany({
                $and: [
                    { $or: [{ tags: "A" }, { tags: "B" }] },
                    { status: "active" },
                ],
            })
            expect(results.length).toBe(2)
            expect(results.map(r => r.id).sort()).toEqual(["doc1", "doc3"])
        })
    })

    describe("边界 11: 事务边界问题", () => {
        test("insertMany 部分失败时侧表状态", async () => {
            await adapter.defineIndexes([{ key: "tags", unique: true }])

            // 第一次插入
            await adapter.insertMany([
                { id: "unique1", tags: ["uniqueA"] },
            ])

            // 第二次插入包含重复的 unique 索引值
            // 注意：unique 索引是在主索引上，不是侧表
            // 这里测试的是 insertMany 的事务一致性
            try {
                await adapter.insertMany([
                    { id: "unique2", tags: ["uniqueB"] },
                    { id: "unique3", tags: ["uniqueA"] }, // 这会失败（如果 tags 是 unique 的话）
                ])
            } catch (e) {
                // 预期可能失败
            }

            // 验证数据一致性
            const results = await adapter.findMany({ tags: "uniqueA" })
            console.log("事务边界测试结果:", results.map(r => r.id))
        })
    })

    describe("边界 12: 数值类型精度", () => {
        test("数组包含接近的浮点数", async () => {
            await adapter.defineIndexes([{ key: "floats" }])

            await adapter.insertMany([
                { id: "doc1", floats: [0.1 + 0.2, 0.5] }, // 0.30000000000000004
                { id: "doc2", floats: [0.3, 0.5] },
            ])

            // 查询 0.3
            const results = await adapter.findMany({ floats: 0.3 })
            console.log("浮点数测试结果:", results.map(r => r.id))

            // JavaScript 的 0.1 + 0.2 !== 0.3，所以可能只有 doc2 匹配
            expect(results.length).toBe(1)
            expect(results[0].id).toBe("doc2")

            // 查询 0.30000000000000004
            const exactResults = await adapter.findMany({ floats: 0.1 + 0.2 })
            expect(exactResults.length).toBe(1)
            expect(exactResults[0].id).toBe("doc1")
        })

        test("数组包含极大和极小数值", async () => {
            await adapter.defineIndexes([{ key: "extremes" }])

            await adapter.insertMany([
                { id: "doc1", extremes: [Number.MAX_VALUE, Number.MIN_VALUE] },
                { id: "doc2", extremes: [Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER] },
            ])

            // 查询极值
            const maxResults = await adapter.findMany({ extremes: Number.MAX_VALUE })
            expect(maxResults.length).toBe(1)
            expect(maxResults[0].id).toBe("doc1")

            const safeIntResults = await adapter.findMany({ extremes: Number.MAX_SAFE_INTEGER })
            expect(safeIntResults.length).toBe(1)
            expect(safeIntResults[0].id).toBe("doc2")
        })
    })
})
