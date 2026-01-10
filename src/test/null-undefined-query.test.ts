import { Table } from "../core/Table"
import { getTestTableByType, TestDatabaseType } from "./getTestTable"

/**
 * 测试 null 和 undefined 查询的 MongoDB 一致性
 * MongoDB 查询 null 时的核心行为：
 * 1. { field: null } 同时匹配 field 值为 null 的文档和不包含 field 的文档
 * 2. { field: { $ne: null } } 仅匹配 field 存在且值不为 null 的文档
 * 3. { field: { $type: 10 } } 仅匹配 field 值为 null 的文档（不包括缺失字段）
 * 4. { field: { $exists: false } } 仅匹配不包含 field 的文档
 */
const DATABASE_TYPES: TestDatabaseType[] = ["sqlite", "mongodb"]

describe.each(DATABASE_TYPES)("Null & Undefined Query - %s", (dbType) => {
    let table!: Table

    beforeAll(async () => {
        table = await getTestTableByType("null-undefined-query.test", dbType)
        await table.clearAll()
    })

    beforeEach(async () => {
        await table.clearAll()
    })

    describe("插入数据和规范化", () => {
        test("undefined 应该被规范化为 null", async () => {
            const doc = {
                name: "test",
                value: undefined,
            }

            await table.set("doc1", doc)
            const retrieved = await table.get("doc1")

            // undefined 应该被规范化为 null
            expect(retrieved!.value).toBeNull()
        })

        test("嵌套的 undefined 也应该被规范化为 null", async () => {
            const doc = {
                name: "test",
                nested: {
                    a: undefined,
                    b: null,
                    c: "value",
                },
            }

            await table.set("doc1", doc)
            const retrieved: any = await table.get("doc1")

            expect(retrieved!.nested.a).toBeNull()
            expect(retrieved!.nested.b).toBeNull()
            expect(retrieved!.nested.c).toBe("value")
        })
    })

    describe("相等查询 (field: null)", () => {
        beforeEach(async () => {
            // 插入测试数据
            await table.insertMany([
                { id: "with-null", name: "Alice", status: null },
                { id: "with-value", name: "Bob", status: "active" },
                { id: "missing-field", name: "Charlie" }, // 没有 status 字段
            ])
        })

        test("{ status: null } 应该同时匹配 null 和缺失字段", async () => {
            const result = await table.findMany({ status: null })
            const ids = result.map((r) => r.id).sort()

            // MongoDB 行为：应该同时匹配 status: null 和不包含 status 字段的文档
            expect(ids).toEqual(["missing-field", "with-null"])
        })

        test("{ status: { $eq: null } } 应该同时匹配 null 和缺失字段", async () => {
            const result = await table.findMany({ status: { $eq: null } })
            const ids = result.map((r) => r.id).sort()

            expect(ids).toEqual(["missing-field", "with-null"])
        })
    })

    describe("不等查询 (field: { $ne: null })", () => {
        beforeEach(async () => {
            await table.insertMany([
                { id: "with-null", name: "Alice", status: null },
                { id: "with-value", name: "Bob", status: "active" },
                { id: "missing-field", name: "Charlie" }, // 没有 status 字段
            ])
        })

        test("{ status: { $ne: null } } 仅匹配存在且不为 null 的字段", async () => {
            const result = await table.findMany({ status: { $ne: null } })
            const ids = result.map((r) => r.id).sort()

            // MongoDB 行为：只有值不为 null 的字段匹配（缺失字段和 null 值都不匹配）
            expect(ids).toEqual(["with-value"])
        })
    })

    describe("存在性查询 ($exists)", () => {
        beforeEach(async () => {
            await table.insertMany([
                { id: "with-null", name: "Alice", status: null },
                { id: "with-value", name: "Bob", status: "active" },
                { id: "missing-field", name: "Charlie" }, // 没有 status 字段
            ])
        })

        test("{ status: { $exists: true } } 应该匹配存在的字段（包括 null 值）", async () => {
            const result = await table.findMany({ status: { $exists: true } })
            const ids = result.map((r) => r.id).sort()

            // 字段存在，即使值为 null，也应该匹配
            expect(ids).toEqual(["with-null", "with-value"])
        })

        test("{ status: { $exists: false } } 仅匹配不包含该字段的文档", async () => {
            const result = await table.findMany({ status: { $exists: false } })
            const ids = result.map((r) => r.id).sort()

            // 仅匹配不包含 status 字段的文档
            expect(ids).toEqual(["missing-field"])
        })
    })

    describe("组合查询", () => {
        beforeEach(async () => {
            await table.insertMany([
                { id: "doc1", name: "Alice", status: null, priority: 1 },
                { id: "doc2", name: "Bob", status: "active", priority: 2 },
                { id: "doc3", name: "Charlie", status: "inactive" }, // 没有 priority 字段
                { id: "doc4", name: "David", priority: null }, // 没有 status 字段
            ])
        })

        test("$and 应该正确处理 null 查询", async () => {
            const result = await table.findMany({
                $and: [{ status: null }, { priority: { $exists: true } }],
            })
            const ids = result.map((r) => r.id).sort()

            // status 为 null 或缺失，AND priority 存在
            // doc1: status=null (✓), priority=1 exists (✓)
            // doc4: status missing (✓ 缺失视为null), priority=null exists (✓)
            expect(ids).toEqual(["doc1", "doc4"])
        })

        test("$or 应该正确处理 null 查询", async () => {
            const result = await table.findMany({
                $or: [{ status: null }, { priority: null }],
            })
            const ids = result.map((r) => r.id).sort()

            // status 为 null 或缺失 OR priority 为 null 或缺失
            expect(ids).toEqual(["doc1", "doc3", "doc4"])
        })
    })

    describe("多字段混合查询", () => {
        beforeEach(async () => {
            await table.insertMany([
                { id: "doc1", a: null, b: "value1" },
                { id: "doc2", a: "value2", b: null },
                { id: "doc3", a: "value3", b: "value3" },
                { id: "doc4", b: "value4" }, // 缺失 a
                { id: "doc5", a: null }, // 缺失 b
            ])
        })

        test("多个 null 查询的组合", async () => {
            const result = await table.findMany({ a: null, b: null })
            const ids = result.map((r) => r.id).sort()

            // a 为 null 或缺失 AND b 为 null 或缺失
            expect(ids).toEqual(["doc5"])
        })

        test("null 和非 null 查询的混合", async () => {
            const result = await table.findMany({
                a: { $ne: null },
                b: { $ne: null },
            })
            const ids = result.map((r) => r.id).sort()

            // a 存在且不为 null AND b 存在且不为 null
            expect(ids).toEqual(["doc3"])
        })
    })
})
