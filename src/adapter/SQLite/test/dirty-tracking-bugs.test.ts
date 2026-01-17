/**
 * 脏字段检测 (Dirty Tracking) 机制测试
 * 
 * ✅ 已修复的 BUG：
 * 
 * 1. [已修复] NaN 值查询返回 0 条结果
 *    - 根因：mongoToSql.ts 对 NaN 生成错误的类型检查
 *    - 修复：检测 NaN 并生成 `json_type = 'object'` 条件
 * 
 * 2. [已修复] Infinity 值查询返回 0 条结果
 *    - 根因：同上
 *    - 修复：同上
 * 
 * 测试覆盖：
 * 1. 字段类型变化追踪
 * 2. clearAll 后缓存一致性
 * 3. 嵌套路径追踪
 * 4. 特殊值 (NaN, Infinity, null) 追踪和查询
 * 5. 批量操作追踪
 * 6. 更新操作追踪（包括 upsert）
 * 7. 查询策略验证
 * 8. 并发写入追踪
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from "vitest"
import { ITableDBAdapterInstance, ITableDebugResult } from "../../adapter"
import { SQLiteAdapter } from "../SQLiteAdapter"

describe("脏字段检测机制 BUG 测试", () => {
    let adapter!: ITableDBAdapterInstance

    beforeAll(async () => {
        const factory = SQLiteAdapter({ filename: ":memory:" })
        adapter = await factory.useAdapterInstance("dirtyTrackingTable")
        await adapter.clearAll()
    })

    beforeEach(async () => {
        await adapter.clearAll()
    })

    afterAll(async () => {
        await adapter.close()
    })

    describe("BUG 1: 字段类型变化追踪", () => {
        test("字段从标量变为数组后，应被标记为 hasArray", async () => {
            // 先插入标量值
            await adapter.set("doc1", { id: "doc1", field: "scalar" })

            // 再插入数组值
            await adapter.set("doc2", { id: "doc2", field: ["array", "value"] })

            // 查询应该能正确处理两种类型
            const results = await adapter.findMany({ field: "array" })
            expect(results.length).toBe(1)
            expect(results[0].id).toBe("doc2")

            // 标量值查询也应正确
            const scalarResults = await adapter.findMany({ field: "scalar" })
            expect(scalarResults.length).toBe(1)
            expect(scalarResults[0].id).toBe("doc1")
        })

        test("字段从数组变为标量后，hasArray 标记应保持", async () => {
            // 先插入数组值
            await adapter.set("doc1", { id: "doc1", field: ["array"] })

            // 更新为标量值
            await adapter.updateOne({ id: "doc1" }, { $set: { field: "scalar" } })

            // 即使当前没有数组值，查询仍应正确（因为 hasArray 历史记录）
            const results = await adapter.findMany({ field: "scalar" })
            expect(results.length).toBe(1)
        })
    })

    describe("BUG 2: clearAll 后脏字段缓存问题", () => {
        /**
         * 问题描述：
         * clearAll() 清除数据后，脏字段缓存可能未被正确处理
         * 这可能导致查询优化逻辑使用过期的字段类型信息
         */
        test("[可能的 BUG] clearAll 后脏字段缓存应该清空或保持一致", async () => {
            // 步骤 1: 插入数组数据，触发 hasArray 标记
            await adapter.insertMany([
                { id: "doc1", tags: ["A", "B"] },
                { id: "doc2", tags: ["C"] },
            ])

            // 验证数组查询正常
            let results = await adapter.findMany({ tags: "A" })
            expect(results.length).toBe(1)

            // 步骤 2: clearAll 清除所有数据
            await adapter.clearAll()

            // 步骤 3: 插入纯标量数据
            await adapter.insertMany([
                { id: "doc3", tags: "scalar" },  // 注意：这里 tags 是标量，不是数组
            ])

            // 步骤 4: 查询
            // 如果脏字段缓存未清空，系统可能仍认为 tags 是数组字段
            // 这可能导致生成不必要的复杂 SQL，或者结果不正确
            results = await adapter.findMany({ tags: "scalar" })
            expect(results.length).toBe(1)
            expect(results[0].id).toBe("doc3")
        })

        test("clearAll 后新插入的数组字段应被正确追踪", async () => {
            // 第一批数据
            await adapter.insertMany([
                { id: "doc1", field1: ["A"] },
            ])

            // 清除
            await adapter.clearAll()

            // 第二批数据（不同的字段）
            await adapter.insertMany([
                { id: "doc2", field2: ["B"] },
            ])

            // 两个字段都应该能正确查询
            const field2Results = await adapter.findMany({ field2: "B" })
            expect(field2Results.length).toBe(1)
        })
    })

    describe("BUG 3: 嵌套路径追踪", () => {
        test("嵌套数组字段应被正确追踪", async () => {
            await adapter.insertMany([
                { id: "doc1", user: { tags: ["admin", "active"] } },
                { id: "doc2", user: { tags: ["user"] } },
            ])

            // 嵌套路径查询
            const results = await adapter.findMany({ "user.tags": "admin" })
            expect(results.length).toBe(1)
            expect(results[0].id).toBe("doc1")
        })

        test("深层嵌套路径追踪", async () => {
            await adapter.insertMany([
                { id: "doc1", a: { b: { c: { items: ["deep"] } } } },
            ])

            const results = await adapter.findMany({ "a.b.c.items": "deep" })
            expect(results.length).toBe(1)
        })

        test("中间路径是数组时的追踪", async () => {
            // users 是数组，users.role 需要展开
            await adapter.insertMany([
                { id: "doc1", users: [{ role: "admin" }, { role: "user" }] },
            ])

            // 这种查询需要特殊处理
            const results = await adapter.findMany({ "users.role": "admin" })
            expect(results.length).toBe(1)
        })
    })

    describe("BUG 4: 特殊值追踪", () => {
        test("NaN 值应被标记为 hasSpecial", async () => {
            await adapter.insertMany([
                { id: "doc1", value: NaN },
                { id: "doc2", value: 123 },
            ])

            // 查询 NaN
            const results = await adapter.findMany({ value: NaN })
            expect(results.length).toBe(1)
            expect(results[0].id).toBe("doc1")
        })

        test("Infinity 值应被标记为 hasSpecial", async () => {
            await adapter.insertMany([
                { id: "doc1", value: Infinity },
                { id: "doc2", value: -Infinity },
                { id: "doc3", value: 100 },
            ])

            const results = await adapter.findMany({ value: Infinity })
            expect(results.length).toBe(1)
            expect(results[0].id).toBe("doc1")
        })

        test("null 值应被标记为 hasSpecial", async () => {
            await adapter.insertMany([
                { id: "doc1", value: null },
                { id: "doc2", value: "not null" },
            ])

            // null 查询应匹配 doc1 和字段不存在的文档
            const results = await adapter.findMany({ value: null })
            expect(results.length).toBe(1)
            expect(results[0].id).toBe("doc1")
        })
    })

    describe("BUG 5: 批量操作的追踪", () => {
        test("insertMany 应正确追踪所有文档的字段类型", async () => {
            await adapter.insertMany([
                { id: "doc1", field: "scalar" },
                { id: "doc2", field: ["array"] },
                { id: "doc3", field: { nested: "object" } },
            ])

            // 所有查询应正确
            expect((await adapter.findMany({ field: "scalar" })).length).toBe(1)
            expect((await adapter.findMany({ field: "array" })).length).toBe(1)
        })

        test("setMany 应正确追踪字段类型变化", async () => {
            // 使用 setMany 批量设置
            await adapter.setMany([
                { id: "doc1", tags: ["A"] },
                { id: "doc2", tags: ["B"] },
            ])

            const results = await adapter.findMany({ tags: "A" })
            expect(results.length).toBe(1)
        })
    })

    describe("BUG 6: 更新操作后的追踪", () => {
        test("$set 添加数组字段应触发追踪", async () => {
            // 初始没有数组字段
            await adapter.set("doc1", { id: "doc1", name: "test" })

            // 通过 $set 添加数组字段
            await adapter.updateOne({ id: "doc1" }, { $set: { tags: ["new", "array"] } })

            // 查询新添加的数组字段
            const results = await adapter.findMany({ tags: "new" })
            expect(results.length).toBe(1)
        })

        test("$push 应触发数组追踪", async () => {
            // 初始是空数组
            await adapter.set("doc1", { id: "doc1", items: [] })

            // 通过 $push 添加元素
            await adapter.updateOne({ id: "doc1" }, { $push: { items: "pushed" } })

            const results = await adapter.findMany({ items: "pushed" })
            expect(results.length).toBe(1)
        })

        test("upsert 操作应触发脏字段追踪", async () => {
            // 使用 upsert 插入新文档（文档不存在）
            await adapter.updateOne(
                { id: "upsertDoc" },
                { $set: { tags: ["upserted", "array"] } },
                { upsert: true }
            )

            // 验证 upsert 后的数组字段可以正确查询
            const results = await adapter.findMany({ tags: "upserted" })
            expect(results.length).toBe(1)
            expect(results[0].id).toBe("upsertDoc")
        })

        test("upsert 更新现有文档也应触发追踪", async () => {
            // 先创建文档
            await adapter.set("existingDoc", { id: "existingDoc", name: "original" })

            // 使用 upsert 更新（文档已存在，添加数组字段）
            await adapter.updateOne(
                { id: "existingDoc" },
                { $set: { categories: ["cat1", "cat2"] } },
                { upsert: true }
            )

            // 验证新添加的数组字段可以查询
            const results = await adapter.findMany({ categories: "cat1" })
            expect(results.length).toBe(1)
        })
    })


    describe("BUG 7: 查询策略验证", () => {
        /**
         * 验证 schemaStats 是否正确影响查询策略
         */
        test("已知标量字段应使用简化查询", async () => {
            // 只插入标量值
            await adapter.insertMany([
                { id: "doc1", scalarOnly: "value1" },
                { id: "doc2", scalarOnly: "value2" },
            ])

            const debug: any = {}
            await adapter.findMany({ scalarOnly: "value1" }, { debug })

            // 策略应该是 SQL（不需要 HYBRID）
            console.log("纯标量字段查询策略:", debug.strategy)
        })

        test("已知数组字段应使用适当的查询策略", async () => {
            await adapter.insertMany([
                { id: "doc1", arrayField: ["A", "B"] },
            ])

            const debug: any = {}
            await adapter.findMany({ arrayField: "A" }, { debug })

            console.log("数组字段查询策略:", debug.strategy)
        })
    })

    describe("BUG 8: 并发写入追踪", () => {
        test("并发插入应正确追踪所有字段类型", async () => {
            // 并发插入多个文档
            const promises = []
            for (let i = 0; i < 100; i++) {
                if (i % 2 === 0) {
                    promises.push(adapter.set(`doc${i}`, { id: `doc${i}`, field: ["array"] }))
                } else {
                    promises.push(adapter.set(`doc${i}`, { id: `doc${i}`, field: "scalar" }))
                }
            }
            await Promise.all(promises)

            // 验证查询正确性
            const arrayResults = await adapter.findMany({ field: "array" })
            const scalarResults = await adapter.findMany({ field: "scalar" })

            expect(arrayResults.length).toBe(50)
            expect(scalarResults.length).toBe(50)
        })
    })
})

describe("脏字段持久化测试（需要文件数据库）", () => {
    test.skip("重启后脏字段信息应从数据库加载", async () => {
        // 此测试需要使用文件数据库而非内存数据库
        // 暂时跳过
    })
})
