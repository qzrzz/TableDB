import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { SQLiteAdapter } from "../../SQLite/SQLiteAdapter"
import { ITableDBAdapterInstance } from "../../adapter"
import { existsSync, unlinkSync } from "fs"

// Mock or real adapter tests?
// Since I cannot easily run MongoDB, I will focus on SQLite for local verification,
// but code logic for MongoDB should be correct by inspection (standard Mongo API).
// However, the user environment *might* have MongoDB available if previous conversations imply it.
// Given "Implementing SQLite bulkUpdate" conversation, they definitely use SQLite.

// Let's create a test for SQLite first to verify logic.
const testDbPath = "./dist/test-overwrite.db"

describe("SQLiteAdapter setMany overwrite", () => {
    let adapter: ITableDBAdapterInstance

    beforeEach(async () => {
        if (existsSync(testDbPath)) unlinkSync(testDbPath)
        const factory = SQLiteAdapter({ filename: testDbPath }) // Using file for persistence check during test
        adapter = await factory.useAdapterInstance("test_table")
        await adapter.clear()
    })

    afterEach(async () => {
        await adapter.close()
        if (existsSync(testDbPath)) unlinkSync(testDbPath)
    })

    it("should overwrite existing document when options.overwrite is true", async () => {
        // 1. Setup initial doc
        await adapter.set("1", { id: "1", name: "Original", fieldKept: "Yes", deeply: { nested: 1 } })

        // 2. Overwrite
        const newDoc = { id: "1", name: "New", extra: "Added" }
        await adapter.setMany([newDoc], { overwrite: true })

        // 3. Verify
        const result = await adapter.get("1")
        expect(result).toBeDefined()
        expect(result).toEqual({ id: "1", name: "New", extra: "Added" })
        // Should NOT have 'fieldKept' or 'deeply'
        expect((result as any).fieldKept).toBeUndefined()
        expect((result as any).deeply).toBeUndefined()
    })

    it("should merge by default (without overwrite)", async () => {
        // 1. Setup initial doc
        await adapter.set("1", { id: "1", name: "Original", fieldKept: "Yes", deeply: { nested: 1 } })

        // 2. Set without overwrite
        const newDoc = { id: "1", name: "New", extra: "Added" }
        await adapter.setMany([newDoc]) // default merge behavior (top-level merge usually)

        // 3. Verify
        const result = await adapter.get("1")
        expect(result).toBeDefined()
        // Default setMany in SQLite calls setMany with merge behavior??
        // Wait, let's check code.
        // In SQLiteAdapter.ts:
        // if (options?.merge) { deep merge } else { op = { $set: normalizedDoc } }
        // $set on top level means it merges fields at top level.

        expect(result).toMatchObject({
            id: "1",
            name: "New",
            extra: "Added",
            fieldKept: "Yes",
            deeply: { nested: 1 },
        })
    })

    it("should respect updateOnly with overwrite", async () => {
        // overwrite + updateOnly means: replace IF exists, ignore IF not exists

        // Case 1: Exists
        await adapter.set("1", { id: "1", val: "old" })
        await adapter.setMany([{ id: "1", val: "new" }], { overwrite: true, updateOnly: true })
        const res1 = await adapter.get("1")
        expect(res1).toEqual({ id: "1", val: "new" })

        // Case 2: Not exists
        await adapter.setMany([{ id: "2", val: "new" }], { overwrite: true, updateOnly: true })
        const res2 = await adapter.get("2")
        expect(res2).toBeUndefined()
    })
})
