import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { SQLiteAdapter } from "../../SQLite/SQLiteAdapter"
import { resolve } from "path"
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs"

const DB_PATH = resolve(__dirname, "./dist/zstd_test.db")
const DB_PATH_HASH = resolve(__dirname, "./dist/zstd_hash.db")

function cleanup() {
    if (existsSync(DB_PATH)) unlinkSync(DB_PATH)
    if (existsSync(`${DB_PATH}.tmp`)) unlinkSync(`${DB_PATH}.tmp`)
    if (existsSync(`${DB_PATH}-wal`)) unlinkSync(`${DB_PATH}-wal`)
    if (existsSync(`${DB_PATH}-shm`)) unlinkSync(`${DB_PATH}-shm`)

    if (existsSync(DB_PATH_HASH)) unlinkSync(DB_PATH_HASH)
    if (existsSync(`${DB_PATH_HASH}-wal`)) unlinkSync(`${DB_PATH_HASH}-wal`)
    if (existsSync(`${DB_PATH_HASH}-shm`)) unlinkSync(`${DB_PATH_HASH}-shm`)
}

function isZstdFile(filepath: string): boolean {
    if (!existsSync(filepath)) return false
    try {
        const buf = readFileSync(filepath, { flag: "r" } as any).slice(0, 4)
        if (buf.length < 4) return false
        // 0xFD2FB528 => LE: 28 B5 2F FD
        return buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd
    } catch (e) {
        return false
    }
}

describe("SQLiteAdapter ZSTD Compression", () => {
    beforeEach(() => {
        cleanup()
    })

    afterEach(() => {
        cleanup()
    })

    it("should compress database file on close when zstd is enabled", async () => {
        const adapter = SQLiteAdapter({ filename: DB_PATH, zstd: true })
        const db = await adapter.useAdapterInstance("test_table")

        await db.set("doc1", { id: "doc1", value: "hello zstd" })

        // At this point, the file should be a regular SQLite file (headers "SQLite format 3")
        const buf = readFileSync(DB_PATH)
        expect(buf.toString().startsWith("SQLite format 3")).toBe(true)

        // Close should trigger compression
        await db.close()

        // db file should exist and be zstd compressed
        expect(existsSync(DB_PATH)).toBe(true)
        expect(isZstdFile(DB_PATH)).toBe(true)
    })

    it("should decompress zstd database file on open", async () => {
        // 1. Create and compress
        {
            const adapter = SQLiteAdapter({ filename: DB_PATH, zstd: true })
            const db = await adapter.useAdapterInstance("test_table")
            await db.set("doc1", { id: "doc1", value: "hello zstd" })
            await db.close()
        }

        expect(isZstdFile(DB_PATH)).toBe(true)

        // 2. Open again (should decompress)
        const adapter = SQLiteAdapter({ filename: DB_PATH, zstd: true })

        // This call triggers getDb(), which triggers file checks and decompression
        const db = await adapter.useAdapterInstance("test_table")

        // Check if file is decompressed (regular SQLite)
        // Wait, decompression happens, then we open it with better-sqlite3.
        // While open, it must be a regular SQLite file.
        const buf = readFileSync(DB_PATH)
        expect(buf.toString().startsWith("SQLite format 3")).toBe(true)
        expect(isZstdFile(DB_PATH)).toBe(false)

        // Verify data
        const doc = await db.get("doc1")
        expect(doc).toEqual({ id: "doc1", value: "hello zstd" })

        await db.close()
        // Should be compressed again
        expect(isZstdFile(DB_PATH)).toBe(true)
    })

    it("should handle large data", async () => {
        const adapter = SQLiteAdapter({ filename: DB_PATH, zstd: true })
        const db = await adapter.useAdapterInstance("test_table")

        const largeString = "x".repeat(1024 * 1024) // 1MB
        await db.set("large", { id: "large", value: largeString })

        await db.close()
        expect(isZstdFile(DB_PATH)).toBe(true)

        // Verify size is significantly smaller than 1MB + overhead if strictly text,
        // but SQLite file has overhead. Simple check: it is compressed.

        const compressedSize = readFileSync(DB_PATH).length
        // 1MB of 'x' compresses very well (to few bytes) + sqlite overhead.
        // Raw sqlite file with 1MB data is > 1MB.
        // Compressed should be much smaller.
        expect(compressedSize).toBeLessThan(1024 * 100) // Expect < 100KB

        // Reopen
        const adapter2 = SQLiteAdapter({ filename: DB_PATH, zstd: true })
        const db2 = await adapter2.useAdapterInstance("test_table")
        const doc = await db2.get("large")
        expect(doc?.value).toBe(largeString)
        await db2.close()
    })

    it("should recover if decompression fails (not zstd file but zstd option on)", async () => {
        // Setup: Create a regular SQLite file, but enable zstd option.
        // This simulates a crash where file was not compressed on close.
        {
            const adapter = SQLiteAdapter({ filename: DB_PATH, zstd: false }) // Create regular
            const db = await adapter.useAdapterInstance("test")
            await db.set("a", { id: "a", v: 1 })
            await db.close()
        }

        expect(isZstdFile(DB_PATH)).toBe(false)
        expect(readFileSync(DB_PATH).toString().startsWith("SQLite format 3")).toBe(true)

        // Open with zstd: true
        const adapter = SQLiteAdapter({ filename: DB_PATH, zstd: true })
        const db = await adapter.useAdapterInstance("test")

        // It should detect it's NOT zstd and skip decompression, proceeding to open logic.
        const doc = await db.get("a")
        expect(doc).toEqual({ id: "a", v: 1 })

        await db.close()
        // Now it should be compressed!
        expect(isZstdFile(DB_PATH)).toBe(true)
    })
})
