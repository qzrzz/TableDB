import { Table } from "../core/Table"
import { getTestTableByType, TestDatabaseType } from "./getTestTable"

const DATABASE_TYPES: TestDatabaseType[] = ["sqlite", "mongodb"]

describe.each(DATABASE_TYPES)("Table bulkUpdate() - %s", async (dbType) => {
    let table: Table

    beforeAll(async () => {
        table = (await getTestTableByType("bulkUpdateTestTable", dbType)) as any
    })

    beforeEach(async () => {
        await table.clearAll()
    })

    test("bulkUpdate 修改多个文档", async () => {
        // 插入初始数据
        const initialDocs = []
        for (let i = 0; i < 5; i++) {
            initialDocs.push({ id: `doc_${i}`, name: `Name ${i}`, value: i * 10 })
        }
        await table.insertMany(initialDocs)

        // 执行 bulkUpdate
        const updates = [
            {
                filter: { id: "doc_0" },
                updateOp: { $set: { name: "Updated Name 0" }, $inc: { value: 5 } },
            },
            {
                filter: { id: "doc_1" },
                updateOp: { $set: { name: "Updated Name 1" }, $inc: { value: 10 } },
            },
            {
                filter: { id: "doc_2" },
                updateOp: { $set: { name: "Updated Name 2" }, $inc: { value: 15 } },
            },
        ]

        const result = await table.bulkUpdate(updates)

        expect(result.matchedCount).toBe(3)
        expect(result.modifiedCount).toBe(3)

        // 验证修改结果
        const updatedDocs = await table.findMany({ id: { $in: ["doc_0", "doc_1", "doc_2"] } })
        const doc0 = updatedDocs.find((d) => d.id === "doc_0")
        const doc1 = updatedDocs.find((d) => d.id === "doc_1")
        const doc2 = updatedDocs.find((d) => d.id === "doc_2")

        expect(doc0).toBeDefined()
        expect(doc0!.name).toBe("Updated Name 0")
        expect(doc0!.value).toBe(5)

        expect(doc1).toBeDefined()
        expect(doc1!.name).toBe("Updated Name 1")
        expect(doc1!.value).toBe(20)

        expect(doc2).toBeDefined()
        expect(doc2!.name).toBe("Updated Name 2")
        expect(doc2!.value).toBe(35)
    })

    test("bulkUpdate 包含 upsert 操作", async () => {
        // 插入初始数据
        const initialDocs = []
        for (let i = 0; i < 2; i++) {
            initialDocs.push({ id: `doc_${i}`, name: `Name ${i}`, value: i * 10 })
        }
        await table.insertMany(initialDocs)

        // 执行 bulkUpdate 包含 upsert
        const updates = [
            {
                filter: { id: "doc_1" },
                updateOp: { $set: { name: "Updated Name 1" }, $inc: { value: 10 } },
                options: { upsert: true },
            },
            {
                filter: { id: "doc_2" },
                updateOp: { $set: { name: "New Name 2" }, $setOnInsert: { value: 20 } },
                options: { upsert: true },
            },
        ]

        const result = await table.bulkUpdate(updates)

        // 验证修改和插入结果
        const allDocs = await table.findMany({ id: { $in: ["doc_1", "doc_2"] } })
        const doc1 = allDocs.find((d) => d.id === "doc_1")
        const doc2 = allDocs.find((d) => d.id === "doc_2")

        expect(result.matchedCount).toBe(1) // 只有 doc_1 匹配
        expect(result.modifiedCount).toBe(1) // 只有 doc_1 被修改
        expect(result.upsertedIds).toEqual(["doc_2"]) // doc_2 被插入

        expect(doc1).toEqual({ id: "doc_1", name: "Updated Name 1", value: 20 })
        expect(doc2).toEqual({ id: "doc_2", name: "New Name 2", value: 20 })
    })

    test("bulkUpdate 空数组", async () => {
        const result = await table.bulkUpdate([])
        expect(result.matchedCount).toBe(0)
        expect(result.modifiedCount).toBe(0)
    })

    test("bulkUpdate 中的单个操作只影响单个文档 (updateOne 行为)", async () => {
        await table.insertMany([
            { id: "doc_1", category: "A", value: 10 },
            { id: "doc_2", category: "A", value: 10 },
            { id: "doc_3", category: "B", value: 10 },
        ])

        const updates = [{ filter: { category: "A" }, updateOp: { $inc: { value: 5 } } }]

        const result = await table.bulkUpdate(updates)
        // bulkUpdate uses updateOne, so only 1 doc matched/modified
        expect(result.matchedCount).toBe(1)
        expect(result.modifiedCount).toBe(1)

        const docs = await table.findMany({ category: "A" })
        // One should be 15, the other 10. Order is not guaranteed without sort, but usually insertion order
        const updated = docs.filter((d) => d.value === 15)
        const unchanged = docs.filter((d) => d.value === 10)
        expect(updated.length).toBe(1)
        expect(unchanged.length).toBe(1)
    })
    test("bulkUpdate 部分 filter 不匹配", async () => {
        await table.insertMany([{ id: "doc_1", value: 10 }])

        const updates = [
            { filter: { id: "doc_1" }, updateOp: { $set: { value: 20 } } },
            { filter: { id: "doc_non_existent" }, updateOp: { $set: { value: 30 } } },
        ]

        const result = await table.bulkUpdate(updates)
        expect(result.matchedCount).toBe(1)
        expect(result.modifiedCount).toBe(1)

        const doc1 = await table.get("doc_1")
        expect(doc1!.value).toBe(20)
    })

    test("bulkUpdate 多个操作影响同一个文档", async () => {
        await table.insertMany([{ id: "doc_1", value: 10 }])

        const updates = [
            { filter: { id: "doc_1" }, updateOp: { $inc: { value: 5 } } },
            { filter: { id: "doc_1" }, updateOp: { $inc: { value: 10 } } },
        ]

        const result = await table.bulkUpdate(updates)
        // MongoDB bulkWrite ordered: true by default
        expect(result.matchedCount).toBe(2)
        expect(result.modifiedCount).toBe(2)

        const doc1 = await table.get("doc_1")
        expect(doc1!.value).toBe(25)
    })

    test("bulkUpdate upsert: true 且文档已存在", async () => {
        await table.insertMany([{ id: "doc_1", value: 10 }])

        const updates = [
            {
                filter: { id: "doc_1" },
                updateOp: { $set: { value: 20 } },
                options: { upsert: true },
            },
        ]

        const result = await table.bulkUpdate(updates)
        expect(result.matchedCount).toBe(1)
        expect(result.modifiedCount).toBe(1)
        // upsertedIds 应该为空或 undefined，因为是更新而不是插入
        expect(result.upsertedIds || []).toHaveLength(0)

        const doc1 = await table.get("doc_1")
        expect(doc1!.value).toBe(20)
    })

    test("bulkUpdate upsert: false 且文档不存在", async () => {
        const updates = [
            {
                filter: { id: "doc_non_existent" },
                updateOp: { $set: { value: 20 } },
                options: { upsert: false },
            },
        ]

        const result = await table.bulkUpdate(updates)
        expect(result.matchedCount).toBe(0)
        expect(result.modifiedCount).toBe(0)

        const doc = await table.get("doc_non_existent")
        expect(doc).toBeUndefined()
    })

    test("bulkUpdate 与 enableMarkDelete", async () => {
        // 修改当前表的选项来测试标记删除
        const originalEnableMarkDelete = table.options.enableMarkDelete
        table.options.enableMarkDelete = true

        try {
            await table.insertMany([
                { id: "doc_active", value: 10 },
                { id: "doc_deleted", value: 10, _isDeleted: true },
            ])

            const updates = [
                { filter: { id: "doc_active" }, updateOp: { $inc: { value: 5 } } },
                { filter: { id: "doc_deleted" }, updateOp: { $inc: { value: 5 } } },
            ]

            const result = await table.bulkUpdate(updates)
            // 因为启用了 enableMarkDelete，__check_filter 会自动加上 _isDeleted: { $ne: true }
            // 所以 doc_deleted 不应该被匹配到
            expect(result.matchedCount).toBe(1)
            expect(result.modifiedCount).toBe(1)

            const docActive = await table.get("doc_active")
            expect(docActive!.value).toBe(15)

            // 直接从 adapter 获取，绕过 Table 的标记删除过滤
            const docDeleted = await table.adapter.get("doc_deleted")
            expect(docDeleted!.value).toBe(10) // 不应该被修改
        } finally {
            table.options.enableMarkDelete = originalEnableMarkDelete
        }
    })

    test("bulkUpdate 多个 upsert 操作", async () => {
        const updates = [
            { filter: { id: "new_1" }, updateOp: { $set: { value: 1 } }, options: { upsert: true } },
            { filter: { id: "new_2" }, updateOp: { $set: { value: 2 } }, options: { upsert: true } },
        ]

        const result = await table.bulkUpdate(updates)
        expect(result.matchedCount).toBe(0)
        expect(result.upsertedIds).toContain("new_1")
        expect(result.upsertedIds).toContain("new_2")
        expect(result.upsertedIds).toHaveLength(2)

        const doc1 = await table.get("new_1")
        expect(doc1!.value).toBe(1)
        const doc2 = await table.get("new_2")
        expect(doc2!.value).toBe(2)
    })

    test("bulkUpdate 包含无效操作符时，其他有效操作应该成功 (ordered: false)", async () => {
        await table.insertMany([{ id: "doc_1", value: 10 }])

        const updates = [
            { filter: { id: "doc_1" }, updateOp: { $inc: { value: 5 } } },
            { filter: { id: "doc_2" }, updateOp: { $notAnOp: { value: 1 } } as any },
        ]

        const result = await table.bulkUpdate(updates)
        // doc_1 应该被更新
        expect(result.matchedCount).toBe(1)
        expect(result.modifiedCount).toBe(1)

        const doc1 = await table.get("doc_1")
        expect(doc1!.value).toBe(15)
    })
})
