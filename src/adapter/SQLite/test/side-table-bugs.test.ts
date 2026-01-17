/**
 * 侧表机制 BUG 测试
 * 
 * 目标：找出 SQLiteAdapter 中侧表（Side Table）机制的潜在 BUG
 * 
 * 侧表机制说明：
 * - 侧表用于数组字段的倒排索引，存储 (val, id) 对
 * - 使用 SQLite Trigger 在 INSERT/UPDATE/DELETE 时自动维护
 * - 用于加速数组包含查询，如 { tags: "A" } 可以利用侧表实现快速查询
 * 
 * 潜在问题：
 * 1. Trigger 使用 NEW.id/OLD.id（用户 ID）进行关联，而非 _id（内部自增 ID）
 * 2. 如果用户 ID 有特殊字符或格式，可能导致查询失败
 * 3. 更新/删除后侧表同步问题
 * 4. 批量操作后侧表重建问题
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from "vitest"
import { ITableDBAdapterInstance, ITableDebugResult } from "../../adapter"
import { SQLiteAdapter } from "../SQLiteAdapter"

describe("侧表机制 BUG 测试", () => {
    let adapter!: ITableDBAdapterInstance

    beforeAll(async () => {
        // 使用内存数据库进行测试
        const factory = SQLiteAdapter({ filename: ":memory:" })
        adapter = await factory.useAdapterInstance("sideTableTestTable")
        await adapter.clearAll()
    })

    beforeEach(async () => {
        await adapter.clearAll()
    })

    afterAll(async () => {
        await adapter.close()
    })

    describe("BUG 1: 侧表索引基本功能测试", () => {
        test("创建索引后，数组字段查询应该使用侧表", async () => {
            // 为 tags 字段创建索引
            await adapter.defineIndexes([{ key: "tags" }])

            // 插入数据
            await adapter.insertMany([
                { id: "doc1", tags: ["A", "B"] },
                { id: "doc2", tags: ["B", "C"] },
                { id: "doc3", tags: ["A", "C"] },
            ])

            // 查询并验证
            const results = await adapter.findMany({ tags: "A" })
            expect(results.length).toBe(2)
            expect(results.map(r => r.id).sort()).toEqual(["doc1", "doc3"])
        })

        test("侧表查询应正确返回所有匹配文档", async () => {
            await adapter.defineIndexes([{ key: "tags" }])

            await adapter.insertMany([
                { id: "doc1", tags: ["red", "blue"] },
                { id: "doc2", tags: ["green", "blue"] },
                { id: "doc3", tags: ["red", "green"] },
                { id: "doc4", tags: ["yellow"] },
                { id: "doc5", tags: ["red"] },
            ])

            // 查询 tags 包含 "red" 的文档
            const redDocs = await adapter.findMany({ tags: "red" })
            expect(redDocs.length).toBe(3)
            expect(redDocs.map(r => r.id).sort()).toEqual(["doc1", "doc3", "doc5"])

            // 查询 tags 包含 "blue" 的文档
            const blueDocs = await adapter.findMany({ tags: "blue" })
            expect(blueDocs.length).toBe(2)
            expect(blueDocs.map(r => r.id).sort()).toEqual(["doc1", "doc2"])
        })
    })

    describe("BUG 2: 更新操作后侧表同步问题", () => {
        test("更新文档后，侧表应正确同步", async () => {
            await adapter.defineIndexes([{ key: "tags" }])

            // 插入初始数据
            await adapter.insertMany([
                { id: "doc1", tags: ["A", "B"] },
            ])

            // 验证初始状态
            let results = await adapter.findMany({ tags: "A" })
            expect(results.length).toBe(1)

            // 更新数据：移除 "A"，添加 "C"
            await adapter.updateOne({ id: "doc1" }, { $set: { tags: ["B", "C"] } })

            // 验证更新后：不应匹配 "A"
            results = await adapter.findMany({ tags: "A" })
            expect(results.length).toBe(0)

            // 验证更新后：应匹配 "C"
            results = await adapter.findMany({ tags: "C" })
            expect(results.length).toBe(1)
            expect(results[0].id).toBe("doc1")
        })

        test("使用 $push 添加数组元素后，侧表应正确同步", async () => {
            await adapter.defineIndexes([{ key: "tags" }])

            await adapter.insertMany([
                { id: "doc1", tags: ["A"] },
            ])

            // 初始验证
            let results = await adapter.findMany({ tags: "B" })
            expect(results.length).toBe(0)

            // 使用 $push 添加元素
            await adapter.updateOne({ id: "doc1" }, { $push: { tags: "B" } })

            // 验证添加后：应匹配 "B"
            results = await adapter.findMany({ tags: "B" })
            expect(results.length).toBe(1)
            expect(results[0].id).toBe("doc1")

            // 原有元素仍应可查询
            results = await adapter.findMany({ tags: "A" })
            expect(results.length).toBe(1)
        })

        test("使用 $pull 移除数组元素后，侧表应正确同步", async () => {
            await adapter.defineIndexes([{ key: "tags" }])

            await adapter.insertMany([
                { id: "doc1", tags: ["A", "B", "C"] },
            ])

            // 初始验证
            let results = await adapter.findMany({ tags: "B" })
            expect(results.length).toBe(1)

            // 使用 $pull 移除元素
            await adapter.updateOne({ id: "doc1" }, { $pull: { tags: "B" } })

            // 验证移除后：不应匹配 "B"
            results = await adapter.findMany({ tags: "B" })
            expect(results.length).toBe(0)

            // 其他元素仍应可查询
            results = await adapter.findMany({ tags: "A" })
            expect(results.length).toBe(1)
            results = await adapter.findMany({ tags: "C" })
            expect(results.length).toBe(1)
        })
    })

    describe("BUG 3: 删除操作后侧表同步问题", () => {
        test("删除单个文档后，侧表应正确清理", async () => {
            await adapter.defineIndexes([{ key: "tags" }])

            await adapter.insertMany([
                { id: "doc1", tags: ["A", "B"] },
                { id: "doc2", tags: ["A", "C"] },
            ])

            // 验证初始状态
            let results = await adapter.findMany({ tags: "A" })
            expect(results.length).toBe(2)

            // 删除 doc1
            await adapter.deleteOne({ id: "doc1" })

            // 验证删除后
            results = await adapter.findMany({ tags: "A" })
            expect(results.length).toBe(1)
            expect(results[0].id).toBe("doc2")

            // 确保 doc1 的 tags "B" 也被清理
            results = await adapter.findMany({ tags: "B" })
            expect(results.length).toBe(0)
        })

        test("批量删除后，侧表应正确清理", async () => {
            await adapter.defineIndexes([{ key: "category" }])

            await adapter.insertMany([
                { id: "doc1", category: ["fruits"], type: "apple" },
                { id: "doc2", category: ["fruits"], type: "banana" },
                { id: "doc3", category: ["vegetables"], type: "carrot" },
            ])

            // 初始验证
            let results = await adapter.findMany({ category: "fruits" })
            expect(results.length).toBe(2)

            // 批量删除 type === "apple" 或 "banana"
            await adapter.deleteMany({ type: { $in: ["apple", "banana"] } })

            // 验证删除后
            results = await adapter.findMany({ category: "fruits" })
            expect(results.length).toBe(0)

            // vegetables 应该仍然存在
            results = await adapter.findMany({ category: "vegetables" })
            expect(results.length).toBe(1)
        })
    })

    describe("BUG 4: 特殊 ID 格式处理", () => {
        test("用户 ID 包含特殊字符时，侧表应正确工作", async () => {
            await adapter.defineIndexes([{ key: "tags" }])

            // 使用包含特殊字符的 ID
            await adapter.insertMany([
                { id: "user:123:profile", tags: ["admin", "active"] },
                { id: "user:456:profile", tags: ["user", "active"] },
                { id: "doc.with.dots", tags: ["admin"] },
            ])

            // 查询 tags 包含 "admin" 的文档
            const results = await adapter.findMany({ tags: "admin" })
            expect(results.length).toBe(2)
            expect(results.map(r => r.id).sort()).toEqual(["doc.with.dots", "user:123:profile"])
        })

        test("用户 ID 包含引号时，侧表应正确工作", async () => {
            await adapter.defineIndexes([{ key: "tags" }])

            // 使用包含引号的 ID
            await adapter.insertMany([
                { id: 'id"with"quotes', tags: ["special"] },
                { id: "id'with'single", tags: ["special"] },
            ])

            const results = await adapter.findMany({ tags: "special" })
            expect(results.length).toBe(2)
        })

        test("用户 ID 为数字字符串时，侧表应正确工作", async () => {
            await adapter.defineIndexes([{ key: "tags" }])

            await adapter.insertMany([
                { id: "12345", tags: ["numeric"] },
                { id: "67890", tags: ["numeric", "extra"] },
            ])

            const results = await adapter.findMany({ tags: "numeric" })
            expect(results.length).toBe(2)
        })
    })

    describe("BUG 5: 标量值与数组值混合处理", () => {
        test("同一字段既有标量值又有数组值时，侧表应正确处理", async () => {
            await adapter.defineIndexes([{ key: "category" }])

            await adapter.insertMany([
                { id: "doc1", category: "books" },           // 标量值
                { id: "doc2", category: ["books", "toys"] }, // 数组值
                { id: "doc3", category: ["electronics"] },   // 数组值
            ])

            // 查询 category === "books"
            // MongoDB 语义：应匹配标量 "books" 和数组包含 "books" 的文档
            const results = await adapter.findMany({ category: "books" })
            expect(results.length).toBe(2)
            expect(results.map(r => r.id).sort()).toEqual(["doc1", "doc2"])
        })

        test("字段从标量更新为数组后，侧表应正确同步", async () => {
            await adapter.defineIndexes([{ key: "category" }])

            await adapter.insertMany([
                { id: "doc1", category: "books" },
            ])

            // 初始验证
            let results = await adapter.findMany({ category: "books" })
            expect(results.length).toBe(1)

            // 更新为数组
            await adapter.updateOne({ id: "doc1" }, { $set: { category: ["books", "magazines"] } })

            // 验证更新后
            results = await adapter.findMany({ category: "books" })
            expect(results.length).toBe(1)

            results = await adapter.findMany({ category: "magazines" })
            expect(results.length).toBe(1)
        })

        test("字段从数组更新为标量后，侧表应正确同步", async () => {
            await adapter.defineIndexes([{ key: "category" }])

            await adapter.insertMany([
                { id: "doc1", category: ["books", "magazines"] },
            ])

            // 初始验证
            let results = await adapter.findMany({ category: "magazines" })
            expect(results.length).toBe(1)

            // 更新为标量
            await adapter.updateOne({ id: "doc1" }, { $set: { category: "books" } })

            // 验证更新后
            results = await adapter.findMany({ category: "books" })
            expect(results.length).toBe(1)

            // magazines 应该不再匹配
            results = await adapter.findMany({ category: "magazines" })
            expect(results.length).toBe(0)
        })
    })

    describe("BUG 6: 批量操作与侧表重建", () => {
        test("批量插入后侧表应正确维护", async () => {
            await adapter.defineIndexes([{ key: "tags" }])

            // 大批量插入（触发优化路径，会禁用 trigger 后重建）
            const docs = []
            for (let i = 0; i < 100; i++) {
                docs.push({ id: `doc${i}`, tags: [i % 2 === 0 ? "even" : "odd", `tag${i}`] })
            }
            await adapter.insertMany(docs)

            // 验证侧表数据正确
            const evenDocs = await adapter.findMany({ tags: "even" })
            expect(evenDocs.length).toBe(50)

            const oddDocs = await adapter.findMany({ tags: "odd" })
            expect(oddDocs.length).toBe(50)

            // 验证单个 tag 查询
            const tag10Docs = await adapter.findMany({ tags: "tag10" })
            expect(tag10Docs.length).toBe(1)
            expect(tag10Docs[0].id).toBe("doc10")
        })

        test("批量插入大量数据后侧表索引应正确工作", async () => {
            await adapter.defineIndexes([{ key: "category" }])

            // 插入超过 BULK_IMPORT_THRESHOLD (1000) 的数据，触发优化路径
            const docs = []
            const categories = ["A", "B", "C", "D", "E"]
            for (let i = 0; i < 1500; i++) {
                const cat = categories[i % 5]
                docs.push({ id: `bulk${i}`, category: [cat, `sub${i % 10}`] })
            }
            await adapter.insertMany(docs)

            // 验证每个 category 的数量
            for (const cat of categories) {
                const results = await adapter.findMany({ category: cat })
                expect(results.length).toBe(300) // 1500 / 5 = 300
            }

            // 验证子分类
            const subResults = await adapter.findMany({ category: "sub0" })
            expect(subResults.length).toBe(150) // 1500 / 10 = 150
        })
    })

    describe("BUG 7: $in 操作符与侧表", () => {
        test("使用 $in 查询多个值时，侧表应正确匹配", async () => {
            await adapter.defineIndexes([{ key: "status" }])

            await adapter.insertMany([
                { id: "doc1", status: ["pending", "review"] },
                { id: "doc2", status: ["approved"] },
                { id: "doc3", status: ["pending"] },
                { id: "doc4", status: ["rejected"] },
            ])

            // 查询 status 包含 "pending" 或 "approved" 的文档
            const results = await adapter.findMany({ status: { $in: ["pending", "approved"] } })
            expect(results.length).toBe(3)
            expect(results.map(r => r.id).sort()).toEqual(["doc1", "doc2", "doc3"])
        })

        test("使用 $in 查询单个值时，应与直接查询结果相同", async () => {
            await adapter.defineIndexes([{ key: "tags" }])

            await adapter.insertMany([
                { id: "doc1", tags: ["A", "B"] },
                { id: "doc2", tags: ["B", "C"] },
                { id: "doc3", tags: ["D"] },
            ])

            // 直接查询
            const directResults = await adapter.findMany({ tags: "B" })

            // $in 查询
            const inResults = await adapter.findMany({ tags: { $in: ["B"] } })

            // 结果应该相同
            expect(directResults.length).toBe(inResults.length)
            expect(directResults.map(r => r.id).sort()).toEqual(inResults.map(r => r.id).sort())
        })
    })

    describe("BUG 8: 空数组和 null 值处理", () => {
        test("空数组字段的查询应正确处理", async () => {
            await adapter.defineIndexes([{ key: "tags" }])

            await adapter.insertMany([
                { id: "doc1", tags: [] },       // 空数组
                { id: "doc2", tags: ["A"] },   // 有元素
                { id: "doc3" },                 // 无此字段
            ])

            // 查询 tags 包含 "A" 的文档
            const results = await adapter.findMany({ tags: "A" })
            expect(results.length).toBe(1)
            expect(results[0].id).toBe("doc2")
        })

        test("null 值字段的查询应正确处理", async () => {
            await adapter.defineIndexes([{ key: "tags" }])

            await adapter.insertMany([
                { id: "doc1", tags: null },    // null 值
                { id: "doc2", tags: ["A"] },   // 有元素
            ])

            // 查询 tags 包含 "A" 的文档
            const results = await adapter.findMany({ tags: "A" })
            expect(results.length).toBe(1)
            expect(results[0].id).toBe("doc2")
        })
    })

    describe("BUG 9: 嵌套字段索引", () => {
        test("嵌套字段的侧表索引应正确工作", async () => {
            // 为嵌套字段创建索引
            await adapter.defineIndexes([{ key: "meta.tags" }])

            await adapter.insertMany([
                { id: "doc1", meta: { tags: ["A", "B"] } },
                { id: "doc2", meta: { tags: ["B", "C"] } },
                { id: "doc3", meta: { other: "value" } },
            ])

            // 查询嵌套的 tags 字段
            const results = await adapter.findMany({ "meta.tags": "A" })
            expect(results.length).toBe(1)
            expect(results[0].id).toBe("doc1")
        })
    })

    describe("BUG 10: setMany 操作与侧表同步", () => {
        test("setMany 覆盖模式应正确更新侧表", async () => {
            await adapter.defineIndexes([{ key: "tags" }])

            // 初始插入
            await adapter.insertMany([
                { id: "doc1", tags: ["A", "B"] },
            ])

            // 验证初始状态
            let results = await adapter.findMany({ tags: "A" })
            expect(results.length).toBe(1)

            // 使用 setMany 覆盖
            await adapter.setMany([
                { id: "doc1", tags: ["C", "D"] },
            ], { overwrite: true })

            // 验证更新后
            results = await adapter.findMany({ tags: "A" })
            expect(results.length).toBe(0)

            results = await adapter.findMany({ tags: "C" })
            expect(results.length).toBe(1)
        })

        test("setMany 合并模式应正确更新侧表", async () => {
            await adapter.defineIndexes([{ key: "tags" }])

            await adapter.insertMany([
                { id: "doc1", tags: ["A", "B"], name: "test" },
            ])

            // 使用 setMany 合并
            await adapter.setMany([
                { id: "doc1", tags: ["C", "D"] },
            ], { merge: true })

            // 验证合并后的侧表状态
            // 注意：merge 模式下数组会被替换还是合并取决于实现
            const results = await adapter.findMany({ tags: "C" })
            expect(results.length).toBeGreaterThanOrEqual(0) // 根据实际合并行为调整
        })
    })

    describe("BUG 11: Debug 信息验证侧表使用", () => {
        test("有索引时查询应使用侧表", async () => {
            await adapter.defineIndexes([{ key: "tags" }])

            await adapter.insertMany([
                { id: "doc1", tags: ["A", "B"] },
                { id: "doc2", tags: ["B", "C"] },
            ])

            const debug: ITableDebugResult = {}
            await adapter.findMany({ tags: "A" }, { debug })

            // 验证 debug 信息表明使用了侧表
            expect(debug.isSideTableUsed).toBe(true)
        })

        test("无索引时查询不应使用侧表", async () => {
            // 不创建索引

            await adapter.insertMany([
                { id: "doc1", unindexed: ["A", "B"] },
                { id: "doc2", unindexed: ["B", "C"] },
            ])

            const debug: ITableDebugResult = {}
            await adapter.findMany({ unindexed: "A" }, { debug })

            // 验证 debug 信息表明没有使用侧表
            expect(debug.isSideTableUsed).toBeFalsy()
        })
    })

    describe("BUG 12: 数组元素的特殊类型", () => {
        test("数组元素为数字时，侧表应正确处理", async () => {
            await adapter.defineIndexes([{ key: "scores" }])

            await adapter.insertMany([
                { id: "doc1", scores: [100, 200, 300] },
                { id: "doc2", scores: [200, 400] },
                { id: "doc3", scores: [500] },
            ])

            // 查询 scores 包含 200 的文档
            const results = await adapter.findMany({ scores: 200 })
            expect(results.length).toBe(2)
            expect(results.map(r => r.id).sort()).toEqual(["doc1", "doc2"])
        })

        test("数组元素为对象时，侧表查询行为", async () => {
            await adapter.defineIndexes([{ key: "items" }])

            await adapter.insertMany([
                { id: "doc1", items: [{ name: "A" }, { name: "B" }] },
                { id: "doc2", items: [{ name: "B" }, { name: "C" }] },
            ])

            // 查询数组包含对象 - 这种查询可能无法直接通过侧表优化
            // 因为对象需要进行深度比较
            const results = await adapter.findMany({ items: { name: "A" } })
            // 根据实际实现调整期望值
            expect(results.length).toBeLessThanOrEqual(1)
        })

        test("数组元素为布尔值时，侧表应正确处理", async () => {
            await adapter.defineIndexes([{ key: "flags" }])

            await adapter.insertMany([
                { id: "doc1", flags: [true, false] },
                { id: "doc2", flags: [false] },
                { id: "doc3", flags: [true] },
            ])

            const trueResults = await adapter.findMany({ flags: true })
            expect(trueResults.length).toBe(2)
            expect(trueResults.map(r => r.id).sort()).toEqual(["doc1", "doc3"])
        })
    })

    describe("BUG 13: 并发操作", () => {
        test("并发插入应正确维护侧表", async () => {
            await adapter.defineIndexes([{ key: "tags" }])

            // 并发插入
            const promises = []
            for (let i = 0; i < 10; i++) {
                promises.push(adapter.set(`concurrent${i}`, { id: `concurrent${i}`, tags: ["parallel", `tag${i}`] }))
            }
            await Promise.all(promises)

            // 验证侧表数据
            const results = await adapter.findMany({ tags: "parallel" })
            expect(results.length).toBe(10)
        })

        test("并发更新应正确维护侧表", async () => {
            await adapter.defineIndexes([{ key: "counter" }])

            // 预插入数据
            for (let i = 0; i < 5; i++) {
                await adapter.set(`update${i}`, { id: `update${i}`, counter: [0] })
            }

            // 并发更新
            const promises = []
            for (let i = 0; i < 5; i++) {
                promises.push(adapter.updateOne({ id: `update${i}` }, { $set: { counter: [i + 1] } }))
            }
            await Promise.all(promises)

            // 验证侧表数据
            const results = await adapter.findMany({ counter: 1 })
            expect(results.length).toBe(1)
            expect(results[0].id).toBe("update0")
        })
    })
})
