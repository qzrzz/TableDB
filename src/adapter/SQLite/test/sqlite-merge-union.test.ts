
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SQLiteAdapter } from '../../SQLite/SQLiteAdapter'
import { ITableDBAdapterInstance } from '../../adapter'
import { existsSync, unlinkSync } from 'fs'

const testDbPath = './test-merge-union.db'

describe('SQLiteAdapter setMany merge array union', () => {
    let adapter: ITableDBAdapterInstance

    beforeEach(async () => {
        if (existsSync(testDbPath)) unlinkSync(testDbPath)
        const factory = SQLiteAdapter({ filename: testDbPath })
        adapter = await factory.useAdapterInstance('test_table')
        await adapter.clear()
    })

    afterEach(async () => {
        await adapter.close()
        if (existsSync(testDbPath)) unlinkSync(testDbPath)
    })

    it('should add new elements to array when merge is true', async () => {
        // 1. Setup
        await adapter.set('1', { id: '1', tags: ['a', 'b'], nested: { list: [1] } })

        // 2. Merge setMany
        await adapter.setMany([{ id: '1', tags: ['b', 'c'], nested: { list: [2] } }], { merge: true })

        // 3. Verify
        const result: any = await adapter.get('1')
        expect(result.tags).toHaveLength(3)
        expect(result.tags).toEqual(expect.arrayContaining(['a', 'b', 'c']))
        expect(result.nested.list).toHaveLength(2)
        expect(result.nested.list).toEqual(expect.arrayContaining([1, 2]))
    })

    it('should NOT duplicate existing elements', async () => {
        await adapter.set('1', { id: '1', tags: ['a'] })
        await adapter.setMany([{ id: '1', tags: ['a', 'a'] }], { merge: true })
        const result: any = await adapter.get('1')
        expect(result.tags).toEqual(['a'])
    })

    it('should overwrite array if __overwrite__ is used', async () => {
        await adapter.set('1', { id: '1', tags: ['a', 'b'] })
        await adapter.setMany([{ id: '1', tags: { __overwrite__: true, 0: 'c' } as any }], { merge: true })
        // Wait, strict types might complain about array as object with overwrite. 
        // But in JS/JSON it is possible.
        // Effectively `tags` becomes the new object? No, user wants to replace ARRAY with ARRAY.
        // doc: { tags: { __overwrite__: true, ...['c'] } } ? No arrays are arrays.
        // If user wants to OVERWRITE an array, they must wrap it?
        // { tags: { __overwrite__: true, value: ['c'] } }? No.
        // { tags: ['c'], __overwrite__: true } is invalid for array.
        // If they want to overwrite array, they might need to use `overwrite: true` (top level) or maybe we support `{ tags: { __overwrite__: true, ... } }` but tags must be object??
        // Actually, standard `setMany` logic for merge usually doesn't strictly support `__overwrite__` on ARRAYS unless the tool supports it.
        // `collectMergeUpdates` (Mongo) logic:
        // `if (isPlainObject(val)) ... check __overwrite__`.
        // `if (Array.isArray(val)) ...addToSet`.
        // So if user passes Array, it ALWAYS unions.
        // If user wants to replace array, they can't do it via `merge` on that specific field easily?
        // Unless they pass an Object with `__overwrite__` that *contains* the array?
        // e.g. parent: { __overwrite__: true, tags: ['c'] }.

        await adapter.set('1', { id: '1', group: { tags: ['a'] } })
        await adapter.setMany([{ id: '1', group: { __overwrite__: true, tags: ['c'] } }], { merge: true })
        const result: any = await adapter.get('1')
        expect(result.group.tags).toEqual(['c'])
    })
})
