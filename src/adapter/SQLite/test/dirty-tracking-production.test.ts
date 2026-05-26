/**
 * Dirty Tracking 生产环境模拟测试
 * 
 * 模拟真实生产环境中的各种操作组合：
 * - 频繁的增删改查
 * - 字段类型动态变化
 * - 并发操作
 * - 大量数据操作
 * - 复杂查询场景
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from "vitest"
import { ITableDBAdapterInstance, ITableDoc } from "../../adapter"
import { SQLiteAdapter } from "../SQLiteAdapter"

type OrderDoc = ITableDoc & {
    items: Array<{ sku: string; qty: number; price: number }>
    tags: string[]
}

type TagsDoc = ITableDoc & {
    tags: string[]
}

type PersistentDoc = ITableDoc & {
    items: string[]
    counter: number
}

describe("Dirty Tracking 生产环境模拟测试", () => {
    let adapter!: ITableDBAdapterInstance

    beforeAll(async () => {
        const factory = SQLiteAdapter({ filename: ":memory:" })
        adapter = await factory.useAdapterInstance("productionSimTable")
    })

    beforeEach(async () => {
        await adapter.clearAll()
    })

    afterAll(async () => {
        await adapter.close()
    })

    describe("场景 1: 电商订单系统模拟", () => {
        /**
         * 模拟电商系统的订单操作：
         * - 订单包含商品数组
         * - 订单状态频繁更新
         * - 添加/移除商品
         */
        test("订单全生命周期操作", async () => {
            // 1. 创建订单
            await adapter.set("order-001", {
                id: "order-001",
                userId: "user-123",
                items: [
                    { sku: "PROD-A", qty: 2, price: 99.99 },
                    { sku: "PROD-B", qty: 1, price: 199.99 },
                ],
                tags: ["new", "priority"],
                status: "pending",
                createdAt: new Date(),
            })

            // 2. 查询订单（验证 dirty tracking 正确处理数组字段）
            let orders = await adapter.findMany({ tags: "priority" })
            expect(orders.length).toBe(1)

            // 3. 更新订单状态
            await adapter.updateOne({ id: "order-001" }, { $set: { status: "paid" } })

            // 4. 添加商品到订单
            await adapter.updateOne(
                { id: "order-001" },
                { $push: { items: { sku: "PROD-C", qty: 3, price: 49.99 } } }
            )

            // 5. 添加标签
            await adapter.updateOne({ id: "order-001" }, { $push: { tags: "express" } })

            // 6. 查询带有新标签的订单
            orders = await adapter.findMany({ tags: "express" })
            expect(orders.length).toBe(1)
            expect((orders[0] as OrderDoc).items).toHaveLength(3)

            // 7. 移除标签
            await adapter.updateOne({ id: "order-001" }, { $pull: { tags: "new" } })

            // 8. 验证移除后的查询
            orders = await adapter.findMany({ tags: "new" })
            expect(orders.length).toBe(0)

            orders = await adapter.findMany({ tags: "priority" })
            expect(orders.length).toBe(1)
        })

        test("批量订单操作和查询", async () => {
            // 批量创建 100 个订单
            const orders = []
            for (let i = 0; i < 100; i++) {
                orders.push({
                    id: `order-${i.toString().padStart(3, "0")}`,
                    userId: `user-${i % 10}`,
                    items: [
                        { sku: `SKU-${i % 5}`, qty: (i % 3) + 1, price: 10 + (i % 50) },
                    ],
                    tags: i % 2 === 0 ? ["regular"] : ["priority"],
                    status: i % 3 === 0 ? "pending" : "completed",
                    total: null,  // 测试 null 值
                })
            }
            await adapter.insertMany(orders)

            // 查询所有 priority 订单
            let results = await adapter.findMany({ tags: "priority" })
            expect(results.length).toBe(50)

            // 查询 pending 状态订单
            results = await adapter.findMany({ status: "pending" })
            expect(results.length).toBe(34)  // Math.ceil(100/3)

            // 复合查询
            results = await adapter.findMany({
                $and: [{ tags: "priority" }, { status: "pending" }],
            })
            expect(results.length).toBeGreaterThan(0)

            // 批量更新
            await adapter.updateMany({ status: "pending" }, { $set: { status: "processing" } })
            results = await adapter.findMany({ status: "processing" })
            expect(results.length).toBe(34)
        })
    })

    describe("场景 2: 用户权限系统模拟", () => {
        /**
         * 模拟用户权限系统：
         * - 用户角色数组
         * - 权限动态变化
         * - 角色继承
         */
        test("用户角色和权限操作", async () => {
            // 创建用户
            await adapter.insertMany([
                { id: "user-1", name: "Admin", roles: ["admin", "user"], permissions: ["read", "write", "delete"] },
                { id: "user-2", name: "Editor", roles: ["editor", "user"], permissions: ["read", "write"] },
                { id: "user-3", name: "Viewer", roles: ["user"], permissions: ["read"] },
            ])

            // 查询管理员
            let admins = await adapter.findMany({ roles: "admin" })
            expect(admins.length).toBe(1)

            // 查询有写权限的用户
            let writers = await adapter.findMany({ permissions: "write" })
            expect(writers.length).toBe(2)

            // 授予新权限
            await adapter.updateOne({ id: "user-3" }, { $push: { permissions: "comment" } })
            let user = await adapter.get("user-3")
            expect(user?.permissions).toContain("comment")

            // 移除角色
            await adapter.updateOne({ id: "user-2" }, { $pull: { roles: "editor" } })
            let editors = await adapter.findMany({ roles: "editor" })
            expect(editors.length).toBe(0)

            // 查询拥有 user 角色的所有用户
            let users = await adapter.findMany({ roles: "user" })
            expect(users.length).toBe(3)
        })
    })

    describe("场景 3: 标签系统压力测试", () => {
        /**
         * 模拟标签系统的高频操作：
         * - 大量标签
         * - 频繁添加删除
         */
        test("高频标签操作", async () => {
            // 创建文档
            await adapter.set("doc-1", { id: "doc-1", tags: ["initial"] })

            // 循环添加和删除标签
            for (let i = 0; i < 50; i++) {
                await adapter.updateOne({ id: "doc-1" }, { $push: { tags: `tag-${i}` } })
            }

            let doc = await adapter.get("doc-1") as TagsDoc | void
            expect(doc).toBeDefined()
            expect((doc as TagsDoc).tags).toHaveLength(51)  // initial + 50 tags

            // 查询特定标签
            let results = await adapter.findMany({ tags: "tag-25" })
            expect(results.length).toBe(1)

            // 删除一半标签
            for (let i = 0; i < 25; i++) {
                await adapter.updateOne({ id: "doc-1" }, { $pull: { tags: `tag-${i}` } })
            }

            doc = await adapter.get("doc-1") as TagsDoc | void
            expect(doc).toBeDefined()
            expect((doc as TagsDoc).tags).toHaveLength(26)  // initial + 25 remaining

            // 验证删除的标签查询不到
            results = await adapter.findMany({ tags: "tag-10" })
            expect(results.length).toBe(0)

            // 验证保留的标签仍可查询
            results = await adapter.findMany({ tags: "tag-30" })
            expect(results.length).toBe(1)
        })

        test("多文档标签关联查询", async () => {
            // 创建带有共享标签的多个文档
            const docs = []
            const commonTags = ["common-1", "common-2", "common-3"]
            for (let i = 0; i < 100; i++) {
                const docTags = [...commonTags.slice(0, (i % 3) + 1), `unique-${i}`]
                docs.push({ id: `doc-${i}`, tags: docTags })
            }
            await adapter.insertMany(docs)

            // 查询包含公共标签的文档
            let results = await adapter.findMany({ tags: "common-1" })
            expect(results.length).toBe(100)  // 所有文档都有 common-1

            results = await adapter.findMany({ tags: "common-3" })
            expect(results.length).toBe(33)  // i%3 = 2 的文档 (i=2,5,8...98，共33个)

            // $in 查询
            results = await adapter.findMany({ tags: { $in: ["unique-50", "unique-75"] } })
            expect(results.length).toBe(2)
        })
    })

    describe("场景 4: 混合类型字段测试", () => {
        /**
         * 测试同一字段存储不同类型值的情况
         */
        test("字段类型变化后查询仍正确", async () => {
            // 创建不同类型值的文档
            await adapter.insertMany([
                { id: "doc-1", value: "string" },
                { id: "doc-2", value: 123 },
                { id: "doc-3", value: ["array", "value"] },
                { id: "doc-4", value: { nested: "object" } },
                { id: "doc-5", value: true },
                { id: "doc-6", value: null },
            ])

            // 各类型查询
            expect((await adapter.findMany({ value: "string" })).length).toBe(1)
            expect((await adapter.findMany({ value: 123 })).length).toBe(1)
            expect((await adapter.findMany({ value: "array" })).length).toBe(1)  // 数组包含
            expect((await adapter.findMany({ value: true })).length).toBe(1)
            expect((await adapter.findMany({ value: null })).length).toBe(1)

            // 更新字段类型
            await adapter.updateOne({ id: "doc-1" }, { $set: { value: ["now", "array"] } })

            // 验证更新后查询正确
            expect((await adapter.findMany({ value: "string" })).length).toBe(0)
            expect((await adapter.findMany({ value: "now" })).length).toBe(1)
        })
    })

    describe("场景 5: 特殊值处理", () => {
        test("NaN 和 Infinity 的完整操作流程", async () => {
            // 创建包含特殊值的文档
            await adapter.insertMany([
                { id: "doc-1", score: NaN, multiplier: Infinity },
                { id: "doc-2", score: 100, multiplier: -Infinity },
                { id: "doc-3", score: 50, multiplier: 1.5 },
            ])

            // 查询 NaN
            let results = await adapter.findMany({ score: NaN })
            expect(results.length).toBe(1)
            expect(results[0].id).toBe("doc-1")

            // 查询 Infinity
            results = await adapter.findMany({ multiplier: Infinity })
            expect(results.length).toBe(1)
            expect(results[0].id).toBe("doc-1")

            // 查询 -Infinity
            results = await adapter.findMany({ multiplier: -Infinity })
            expect(results.length).toBe(1)
            expect(results[0].id).toBe("doc-2")

            // 更新 NaN 值
            await adapter.updateOne({ id: "doc-1" }, { $set: { score: 999 } })
            results = await adapter.findMany({ score: NaN })
            expect(results.length).toBe(0)

            results = await adapter.findMany({ score: 999 })
            expect(results.length).toBe(1)
        })

        test("null 和 undefined 的完整操作流程", async () => {
            // 创建文档
            await adapter.insertMany([
                { id: "doc-1", field: null },
                { id: "doc-2", field: "value" },
                // doc-3 没有 field 字段
            ])
            await adapter.set("doc-3", { id: "doc-3", otherField: "test" })

            // 查询 null（应匹配 doc-1 和 doc-3）
            let results = await adapter.findMany({ field: null })
            expect(results.length).toBe(2)
            expect(results.map((r: any) => r.id).sort()).toEqual(["doc-1", "doc-3"])

            // $exists 查询
            results = await adapter.findMany({ field: { $exists: true } })
            expect(results.length).toBe(2)  // doc-1 和 doc-2

            results = await adapter.findMany({ field: { $exists: false } })
            expect(results.length).toBe(1)  // doc-3
        })
    })

    describe("场景 6: 删除操作后的一致性", () => {
        test("删除文档后查询不应返回已删除数据", async () => {
            // 创建数据
            await adapter.insertMany([
                { id: "doc-1", tags: ["A", "B"] },
                { id: "doc-2", tags: ["B", "C"] },
                { id: "doc-3", tags: ["C", "D"] },
            ])

            // 验证初始状态
            expect((await adapter.findMany({ tags: "B" })).length).toBe(2)

            // 删除一个文档
            await adapter.deleteOne({ id: "doc-1" })

            // 验证删除后查询
            expect((await adapter.findMany({ tags: "A" })).length).toBe(0)
            expect((await adapter.findMany({ tags: "B" })).length).toBe(1)

            // 批量删除
            await adapter.deleteMany({ tags: "C" })

            // 验证批量删除后
            expect((await adapter.findMany({ tags: "B" })).length).toBe(0)
            expect((await adapter.findMany({ tags: "D" })).length).toBe(0)
        })
    })

    describe("场景 7: 长时间运行模拟", () => {
        test("连续 500 次混合操作", async () => {
            // 初始数据
            await adapter.insertMany([
                { id: "persistent-1", counter: 0, items: ["init"] },
                { id: "persistent-2", counter: 0, items: ["init"] },
            ])

            // 执行 500 次混合操作
            for (let i = 0; i < 500; i++) {
                const op = i % 5

                switch (op) {
                    case 0:
                        // 插入新文档
                        await adapter.set(`temp-${i}`, { id: `temp-${i}`, items: [`item-${i}`] })
                        break
                    case 1:
                        // 更新计数器
                        await adapter.updateOne({ id: "persistent-1" }, { $inc: { counter: 1 } })
                        break
                    case 2:
                        // 添加数组元素
                        await adapter.updateOne({ id: "persistent-2" }, { $push: { items: `item-${i}` } })
                        break
                    case 3:
                        // 删除临时文档
                        await adapter.deleteOne({ id: `temp-${i - 3}` })
                        break
                    case 4:
                        // 查询验证
                        const results = await adapter.findMany({ items: "init" })
                        expect(results.length).toBe(2)
                        break
                }
            }

            // 最终验证
            const p1 = await adapter.get("persistent-1") as PersistentDoc | void
            const p2 = await adapter.get("persistent-2") as PersistentDoc | void

            expect(p1?.counter).toBe(100)  // 500/5 = 100 次 $inc
            expect(p2).toBeDefined()
            expect((p2 as PersistentDoc).items).toHaveLength(101)  // init + 100 次 $push

            // 查询仍然正确
            const results = await adapter.findMany({ items: "init" })
            expect(results.length).toBe(2)
        })
    })

    describe("场景 8: 并发安全测试", () => {
        test("并发写入和查询", async () => {
            // 初始化
            await adapter.set("shared-doc", { id: "shared-doc", items: [], counter: 0 })

            // 注意：SQLite 的 $inc 不是原子操作，并发 $inc 会有竞态条件
            // 这里测试并发查询的正确性，不测试并发写入的原子性

            // 串行执行更新，但并发执行查询
            for (let i = 0; i < 20; i++) {
                await adapter.updateOne({ id: "shared-doc" }, { $inc: { counter: 1 } })
            }

            // 并发查询
            const queryPromises = []
            for (let i = 0; i < 100; i++) {
                queryPromises.push(adapter.findMany({ id: "shared-doc" }))
            }
            const results = await Promise.all(queryPromises)

            // 验证所有查询返回正确结果
            for (const result of results) {
                expect(result.length).toBe(1)
                expect(result[0].id).toBe("shared-doc")
            }

            // 验证最终状态
            const doc = await adapter.get("shared-doc")
            expect(doc?.counter).toBe(20)
        })
    })

    describe("场景 9: 混沌测试 - 随机操作序列", () => {
        /**
         * 混沌测试：随机混合增删改查操作
         * 验证 dirty tracking 在任意操作顺序下的健壮性
         */
        test("1000 次随机混合操作", async () => {
            // 记录当前状态用于验证
            const docIds = new Set<string>()
            const docTags = new Map<string, string[]>()  // docId -> tags

            // 随机选择操作
            const operations = [
                "insert", "insert", "insert",  // 权重更高
                "update", "update",
                "delete",
                "query",
                "push", "pull",
                "set",
            ]

            for (let i = 0; i < 1000; i++) {
                const op = operations[Math.floor(Math.random() * operations.length)]
                const docId = `doc-${Math.floor(Math.random() * 100)}`
                const tag = `tag-${Math.floor(Math.random() * 20)}`

                try {
                    switch (op) {
                        case "insert":
                            if (!docIds.has(docId)) {
                                const tags = [tag, `rand-${Math.random().toString(36).slice(2, 7)}`]
                                await adapter.set(docId, { id: docId, tags, counter: 0 })
                                docIds.add(docId)
                                docTags.set(docId, tags)
                            }
                            break

                        case "update":
                            if (docIds.has(docId)) {
                                await adapter.updateOne({ id: docId }, { $inc: { counter: 1 } })
                            }
                            break

                        case "delete":
                            if (docIds.has(docId)) {
                                await adapter.deleteOne({ id: docId })
                                docIds.delete(docId)
                                docTags.delete(docId)
                            }
                            break

                        case "query":
                            // 随机查询验证
                            const results = await adapter.findMany({ tags: tag })
                            // 验证返回的都是实际存在的文档
                            for (const r of results) {
                                expect(docIds.has(r.id as string)).toBe(true)
                            }
                            break

                        case "push":
                            if (docIds.has(docId)) {
                                const newTag = `added-${i}`
                                await adapter.updateOne({ id: docId }, { $push: { tags: newTag } })
                                const tags = docTags.get(docId) || []
                                tags.push(newTag)
                                docTags.set(docId, tags)
                            }
                            break

                        case "pull":
                            if (docIds.has(docId)) {
                                const tags = docTags.get(docId) || []
                                if (tags.length > 1) {
                                    const tagToRemove = tags[0]
                                    await adapter.updateOne({ id: docId }, { $pull: { tags: tagToRemove } })
                                    tags.shift()
                                    docTags.set(docId, tags)
                                }
                            }
                            break

                        case "set":
                            // 完全覆盖文档
                            const newTags = [tag, `new-${i}`]
                            await adapter.set(docId, { id: docId, tags: newTags, counter: i })
                            docIds.add(docId)
                            docTags.set(docId, newTags)
                            break
                    }
                } catch (e) {
                    // 忽略预期的错误（如删除不存在的文档）
                }
            }

            // 最终验证：查询所有现存文档
            const allDocs = await adapter.findMany({})
            expect(allDocs.length).toBe(docIds.size)

            // 验证每个标签查询返回正确数量
            for (let t = 0; t < 5; t++) {
                const testTag = `tag-${t}`
                const results = await adapter.findMany({ tags: testTag })

                // 计算期望的匹配数
                let expectedCount = 0
                for (const [id, tags] of docTags) {
                    if (tags.includes(testTag)) expectedCount++
                }

                expect(results.length).toBe(expectedCount)
            }
        })

        test("快速交替操作 - 同一文档的增删改查", async () => {
            const docId = "chaos-doc"

            for (let round = 0; round < 100; round++) {
                // 创建
                await adapter.set(docId, { id: docId, tags: ["a"], value: round })

                // 立即查询
                let results = await adapter.findMany({ tags: "a" })
                expect(results.length).toBe(1)

                // 更新
                await adapter.updateOne({ id: docId }, { $push: { tags: "b" } })

                // 查询新标签
                results = await adapter.findMany({ tags: "b" })
                expect(results.length).toBe(1)

                // 删除
                await adapter.deleteOne({ id: docId })

                // 验证删除
                results = await adapter.findMany({ tags: "a" })
                expect(results.length).toBe(0)

                results = await adapter.findMany({ tags: "b" })
                expect(results.length).toBe(0)
            }
        })

        test("字段类型频繁变化", async () => {
            const docId = "type-chaos"

            for (let i = 0; i < 100; i++) {
                const typeChoice = i % 5
                let field: any

                switch (typeChoice) {
                    case 0: field = "string-value"; break
                    case 1: field = ["array", "value"]; break
                    case 2: field = 12345; break
                    case 3: field = null; break
                    case 4: field = { nested: "object" }; break
                }

                await adapter.set(docId, { id: docId, field })

                // 立即查询验证
                if (typeChoice === 0) {
                    const results = await adapter.findMany({ field: "string-value" })
                    expect(results.length).toBe(1)
                } else if (typeChoice === 1) {
                    const results = await adapter.findMany({ field: "array" })
                    expect(results.length).toBe(1)
                } else if (typeChoice === 2) {
                    const results = await adapter.findMany({ field: 12345 })
                    expect(results.length).toBe(1)
                } else if (typeChoice === 3) {
                    const results = await adapter.findMany({ field: null })
                    expect(results.length).toBe(1)
                }
            }
        })

        test("批量与单条操作交替", async () => {
            for (let round = 0; round < 20; round++) {
                // 批量插入
                const batch = []
                for (let i = 0; i < 10; i++) {
                    batch.push({ id: `batch-${round}-${i}`, tags: ["batch", `round-${round}`] })
                }
                await adapter.insertMany(batch)

                // 单条查询验证
                let results = await adapter.findMany({ tags: `round-${round}` })
                expect(results.length).toBe(10)

                // 批量更新
                await adapter.updateMany({ tags: `round-${round}` }, { $push: { tags: "updated" } })

                // 验证更新
                results = await adapter.findMany({ tags: "updated" })
                expect(results.length).toBeGreaterThanOrEqual(10)

                // 删除一半
                for (let i = 0; i < 5; i++) {
                    await adapter.deleteOne({ id: `batch-${round}-${i}` })
                }

                // 验证删除
                results = await adapter.findMany({ tags: `round-${round}` })
                expect(results.length).toBe(5)

                // 批量删除剩余
                await adapter.deleteMany({ tags: `round-${round}` })

                // 验证全部删除
                results = await adapter.findMany({ tags: `round-${round}` })
                expect(results.length).toBe(0)
            }
        })

        test("特殊值与普通值交替存储", async () => {
            const values = [
                NaN, 1, Infinity, 2, -Infinity, 3, null, 4, 0, 5,
                NaN, 6, Infinity, 7, -Infinity, 8, null, 9, 0, 10,
            ]

            for (let i = 0; i < values.length; i++) {
                await adapter.set(`special-${i % 5}`, {
                    id: `special-${i % 5}`,
                    value: values[i],
                    round: i,
                })

                // 查询刚设置的值
                if (Number.isNaN(values[i])) {
                    const results = await adapter.findMany({ value: NaN })
                    expect(results.length).toBeGreaterThanOrEqual(1)
                } else if (values[i] === Infinity) {
                    const results = await adapter.findMany({ value: Infinity })
                    expect(results.length).toBeGreaterThanOrEqual(1)
                } else if (values[i] === -Infinity) {
                    const results = await adapter.findMany({ value: -Infinity })
                    expect(results.length).toBeGreaterThanOrEqual(1)
                } else if (values[i] === null) {
                    const results = await adapter.findMany({ value: null })
                    expect(results.length).toBeGreaterThanOrEqual(1)
                } else if (typeof values[i] === "number") {
                    const results = await adapter.findMany({ value: values[i] })
                    expect(results.length).toBeGreaterThanOrEqual(1)
                }
            }
        })
    })
})

