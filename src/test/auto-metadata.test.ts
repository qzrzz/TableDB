import "fake-indexeddb/auto"
import { describe, test, expect, beforeAll, beforeEach } from 'vitest'
import { Table } from '../core/Table'
import { TestDatabaseType } from './getTestTable'
import { SQLiteAdapter } from '../adapter/SQLite/SQLiteAdapter'
import { MongoDBAdapter } from '../adapter/MongoDB'
import { IndexedDBAdapter } from '../adapter/IndexedDB'
import { defineTable } from '../core/defineTable'

/**
 * enableAutoMetadata 功能测试
 * 
 * 测试目标：验证开启 enableAutoMetadata 后，文档操作会自动添加元数据字段
 * - _createDate：文档创建时间
 * - _updateDate：文档最后更新时间
 * - _deleteDate：文档标记删除时间（仅 enableMarkDelete 启用时）
 */

const DATABASE_TYPES: TestDatabaseType[] = ["sqlite", "mongodb", "indexeddb"]

// 根据数据库类型获取适配器
function getAdapterByType(type: TestDatabaseType) {
    switch (type) {
        case "sqlite":
            return SQLiteAdapter({ filename: `:memory:` })
        case "mongodb":
            return MongoDBAdapter({
                auth: "mongodb://root:w2xO4Fd28Wc76o1sl8WAt3lo5sc42ver02@localhost:12779",
                dbName: "tableDbTest",
            })
        case "indexeddb":
            return IndexedDBAdapter({ dbName: "TableDBTestDB" })
    }
}

describe.each(DATABASE_TYPES)('enableAutoMetadata 功能测试 - %s', (dbType) => {
    // 使用 defineTable 创建启用 enableAutoMetadata 的表
    const useTable = defineTable({
        name: 'auto_metadata_test',
        adapter: getAdapterByType(dbType),
        enableAutoMetadata: true,
    })

    let table!: Table

    beforeAll(async () => {
        table = await useTable()
        await table.clearAll()
    })

    beforeEach(async () => {
        await table.clear()
    })

    describe('insertMany/insertOne 测试', () => {
        test('插入文档时应自动添加 _createDate 和 _updateDate', async () => {
            const now = Date.now()

            await table.insertOne({ id: 'doc1', name: 'test1' })

            const doc = (await table.get('doc1'))!
            expect(doc).toBeDefined()
            expect(doc._createDate).toBeDefined()
            expect(doc._createDate).toBeInstanceOf(Date)
            expect(doc._updateDate).toBeDefined()
            expect(doc._updateDate).toBeInstanceOf(Date)
            expect(doc._createDate!.getTime()).toBeGreaterThanOrEqual(now)
            expect(doc._createDate!.getTime()).toBe(doc._updateDate!.getTime())
        })

        test('批量插入时每个文档都应有元数据', async () => {
            await table.insertMany([
                { id: 'doc1', name: 'test1' },
                { id: 'doc2', name: 'test2' },
                { id: 'doc3', name: 'test3' },
            ])

            const docs = await table.findMany({})
            expect(docs.length).toBe(3)
            for (const doc of docs) {
                expect(doc._createDate).toBeDefined()
                expect(doc._updateDate).toBeDefined()
            }
        })
    })

    describe('updateOne/updateMany 测试', () => {
        test('更新文档时应自动更新 _updateDate', async () => {
            await table.insertOne({ id: 'doc1', name: 'test1' })
            const docAfterInsert = (await table.get('doc1'))!
            const originalUpdateDate = docAfterInsert._updateDate!

            await new Promise(resolve => setTimeout(resolve, 10))

            await table.updateOne({ id: 'doc1' }, { $set: { name: 'updated' } })

            const docAfterUpdate = (await table.get('doc1'))!
            expect((docAfterUpdate as any).name).toBe('updated')
            expect(docAfterUpdate._updateDate!.getTime()).toBeGreaterThan(originalUpdateDate.getTime())
            expect(docAfterUpdate._createDate!.getTime()).toBe(docAfterInsert._createDate!.getTime())
        })

        test('upsert 插入新文档时应添加 _createDate', async () => {
            await table.updateOne(
                { id: 'newdoc' },
                { $set: { name: 'upserted' } },
                { upsert: true }
            )

            const doc = (await table.get('newdoc'))!
            expect(doc).toBeDefined()
            expect(doc._createDate).toBeDefined()
            expect(doc._updateDate).toBeDefined()
        })
    })

    describe('set/setMany 测试', () => {
        test('set 新文档时应添加 _createDate 和 _updateDate', async () => {
            await table.set('doc1', { name: 'test1' })

            const doc = (await table.get('doc1'))!
            expect(doc._createDate).toBeDefined()
            expect(doc._updateDate).toBeDefined()
        })

        test('set 已存在文档时只更新 _updateDate', async () => {
            await table.set('doc1', { name: 'test1' })
            const docAfterCreate = (await table.get('doc1'))!

            await new Promise(resolve => setTimeout(resolve, 10))

            await table.set('doc1', { name: 'updated' })

            const docAfterUpdate = (await table.get('doc1'))!
            expect((docAfterUpdate as any).name).toBe('updated')
            expect(docAfterUpdate._updateDate!.getTime()).toBeGreaterThan(docAfterCreate._updateDate!.getTime())
            expect(docAfterUpdate._createDate!.getTime()).toBe(docAfterCreate._createDate!.getTime())
        })

        test('setMany 批量设置时正确处理元数据', async () => {
            await table.set('doc1', { name: 'test1' })
            const docAfterCreate = (await table.get('doc1'))!

            await new Promise(resolve => setTimeout(resolve, 10))

            await table.setMany([
                { id: 'doc1', name: 'updated1' },
                { id: 'doc2', name: 'test2' },
            ])

            const doc1 = (await table.get('doc1'))!
            const doc2 = (await table.get('doc2'))!

            expect(doc1._createDate!.getTime()).toBe(docAfterCreate._createDate!.getTime())
            expect(doc1._updateDate!.getTime()).toBeGreaterThan(docAfterCreate._updateDate!.getTime())
            expect(doc2._createDate).toBeDefined()
            expect(doc2._updateDate).toBeDefined()
        })
    })
})

describe.each(DATABASE_TYPES)('标记删除时的 _deleteDate 测试 - %s', (dbType) => {
    const useTable = defineTable({
        name: 'auto_metadata_mark_delete_test',
        adapter: getAdapterByType(dbType),
        enableAutoMetadata: true,
        enableMarkDelete: true,
    })

    let table!: Table

    beforeAll(async () => {
        table = await useTable()
        await table.clearAll()
    })

    beforeEach(async () => {
        await table.clear()
    })

    test('标记删除时应添加 _deleteDate 和更新 _updateDate', async () => {
        await table.insertOne({ id: 'doc1', name: 'test1' })
        const docAfterInsert = (await table.get('doc1'))!

        await new Promise(resolve => setTimeout(resolve, 10))

        await table.delete('doc1')

        const docAfterDelete = (await table.get('doc1', { ignoreMarkDelete: true }))!

        expect(docAfterDelete).toBeDefined()
        expect(docAfterDelete._isDeleted).toBe(true)
        expect(docAfterDelete._deleteDate).toBeDefined()
        expect(docAfterDelete._deleteDate).toBeInstanceOf(Date)
        expect(docAfterDelete._updateDate!.getTime()).toBeGreaterThan(docAfterInsert._updateDate!.getTime())
    })

    test('deleteMany 时应为所有文档添加 _deleteDate', async () => {
        await table.insertMany([
            { id: 'doc1', category: 'A' },
            { id: 'doc2', category: 'A' },
            { id: 'doc3', category: 'B' },
        ])

        await table.deleteMany({ category: 'A' })

        const allDocs = await table.findMany({}, { ignoreMarkDelete: true })

        const deletedDocs = allDocs.filter(d => d._isDeleted)
        expect(deletedDocs.length).toBe(2)
        for (const doc of deletedDocs) {
            expect(doc._deleteDate).toBeDefined()
        }
    })
})

// 边缘情况测试：尝试找出潜在 BUG
describe.each(DATABASE_TYPES)('边缘情况测试 - %s', (dbType) => {
    const useTable = defineTable({
        name: 'auto_metadata_edge_test',
        adapter: getAdapterByType(dbType),
        enableAutoMetadata: true,
    })

    let table!: Table

    beforeAll(async () => {
        table = await useTable()
        await table.clearAll()
    })

    beforeEach(async () => {
        await table.clear()
    })

    test('bulkUpdate 应为每个更新添加 _updateDate', async () => {
        await table.insertMany([
            { id: 'doc1', name: 'test1' },
            { id: 'doc2', name: 'test2' },
        ])

        const doc1Before = (await table.get('doc1'))!
        const doc2Before = (await table.get('doc2'))!

        await new Promise(resolve => setTimeout(resolve, 10))

        await table.bulkUpdate([
            { filter: { id: 'doc1' }, updateOp: { $set: { name: 'updated1' } } },
            { filter: { id: 'doc2' }, updateOp: { $set: { name: 'updated2' } } },
        ])

        const doc1After = (await table.get('doc1'))!
        const doc2After = (await table.get('doc2'))!

        // 验证 _updateDate 已更新
        expect(doc1After._updateDate!.getTime()).toBeGreaterThan(doc1Before._updateDate!.getTime())
        expect(doc2After._updateDate!.getTime()).toBeGreaterThan(doc2Before._updateDate!.getTime())
        // _createDate 不变
        expect(doc1After._createDate!.getTime()).toBe(doc1Before._createDate!.getTime())
        expect(doc2After._createDate!.getTime()).toBe(doc2Before._createDate!.getTime())
    })

    test('setMany 使用 insertOnly 选项：已存在文档不更新', async () => {
        await table.insertOne({ id: 'doc1', name: 'original' })
        const originalDoc = (await table.get('doc1'))!

        await new Promise(resolve => setTimeout(resolve, 10))

        // 使用 insertOnly，doc1 不应被更新，doc2 应被创建
        await table.setMany([
            { id: 'doc1', name: 'should_not_update' },
            { id: 'doc2', name: 'new_doc' },
        ], { insertOnly: true })

        const doc1 = (await table.get('doc1'))!
        const doc2 = (await table.get('doc2'))!

        // doc1 应该保持不变
        expect((doc1 as any).name).toBe('original')
        expect(doc1._updateDate!.getTime()).toBe(originalDoc._updateDate!.getTime())

        // doc2 应该被创建并有元数据
        expect((doc2 as any).name).toBe('new_doc')
        expect(doc2._createDate).toBeDefined()
    })

    test('setMany 使用 updateOnly 选项：新文档不创建', async () => {
        await table.insertOne({ id: 'doc1', name: 'original' })
        const originalDoc = (await table.get('doc1'))!

        await new Promise(resolve => setTimeout(resolve, 10))

        await table.setMany([
            { id: 'doc1', name: 'updated' },
            { id: 'doc2', name: 'should_not_create' },
        ], { updateOnly: true })

        const doc1 = (await table.get('doc1'))!
        const doc2 = await table.get('doc2')

        // doc1 应该被更新
        expect((doc1 as any).name).toBe('updated')
        expect(doc1._updateDate!.getTime()).toBeGreaterThan(originalDoc._updateDate!.getTime())

        // doc2 不应该存在
        expect(doc2).toBeUndefined()
    })

    test('setMany 使用 overwrite 选项应保留 _createDate', async () => {
        await table.insertOne({ id: 'doc1', name: 'original', extra: 'data' })
        const originalDoc = (await table.get('doc1'))!

        await new Promise(resolve => setTimeout(resolve, 10))

        // 使用 overwrite 完全覆盖
        await table.setMany([
            { id: 'doc1', name: 'overwritten' },
        ], { overwrite: true })

        const doc1 = (await table.get('doc1'))!

        expect((doc1 as any).name).toBe('overwritten')
        expect((doc1 as any).extra).toBeUndefined()
        // _createDate 应保持不变
        expect(doc1._createDate!.getTime()).toBe(originalDoc._createDate!.getTime())
    })

    test('updateMany 更新多个文档', async () => {
        await table.insertMany([
            { id: 'doc1', category: 'A', name: 'test1' },
            { id: 'doc2', category: 'A', name: 'test2' },
        ])

        const doc1Before = (await table.get('doc1'))!

        await new Promise(resolve => setTimeout(resolve, 10))

        await table.updateMany({ category: 'A' }, { $set: { status: 'updated' } })

        const doc1After = (await table.get('doc1'))!

        expect(doc1After._updateDate!.getTime()).toBeGreaterThan(doc1Before._updateDate!.getTime())
        expect(doc1After._createDate!.getTime()).toBe(doc1Before._createDate!.getTime())
    })

    test('多次连续更新，_updateDate 应持续递增', async () => {
        await table.insertOne({ id: 'doc1', count: 0 })
        const timestamps: number[] = []

        const doc0 = (await table.get('doc1'))!
        timestamps.push(doc0._updateDate!.getTime())

        for (let i = 1; i <= 3; i++) {
            await new Promise(resolve => setTimeout(resolve, 10))
            await table.updateOne({ id: 'doc1' }, { $inc: { count: 1 } })
            const doc = (await table.get('doc1'))!
            timestamps.push(doc._updateDate!.getTime())
        }

        // 验证时间戳严格递增
        for (let i = 1; i < timestamps.length; i++) {
            expect(timestamps[i]).toBeGreaterThan(timestamps[i - 1])
        }
    })

    test('bulkUpdate 使用 upsert 创建新文档应有 _createDate', async () => {
        await table.bulkUpdate([
            {
                filter: { id: 'newdoc' },
                updateOp: { $set: { name: 'upserted' } },
                options: { upsert: true }
            },
        ])

        const doc = (await table.get('newdoc'))!
        expect(doc).toBeDefined()
        expect(doc._createDate).toBeDefined()
        expect(doc._updateDate).toBeDefined()
    })
})
