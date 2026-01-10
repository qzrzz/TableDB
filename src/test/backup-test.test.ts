import { Table } from "../core/Table"
import fs from "fs-extra"
import path from "path"
import { fileURLToPath } from "url"
import { getTestTableByType, TestDatabaseType } from "./getTestTable"

/**
 * Table 备份与恢复测试
 *
 * 测试重点：
 * 1. 数据类型序列化完整性 - 验证各种 JS 数据类型在备份/恢复后保持一致
 *    - 基础类型: string, number, boolean, null
 *    - 特殊类型: Date, BigInt
 *    - 二进制类型: Uint8Array, Float64Array, Int32Array, ArrayBuffer, Blob
 *    - 复合类型: 嵌套对象, 数组
 * 2. 压缩功能 - gzip 压缩与非压缩模式
 * 3. 导入选项 - clear 模式、部分导入 (docIds)
 * 4. 流式操作 - 文件读写的流式处理
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(__dirname, "./dist")
const backupPath = path.join(distDir, "backup.cbor")
const backupPathUncompressed = path.join(distDir, "backup-uncompressed.cbor")

const DATABASE_TYPES: TestDatabaseType[] = ["sqlite", "mongodb"]

// ============================================================================
// 测试套件
// ============================================================================

describe.each(DATABASE_TYPES)("Table 备份与恢复 - %s", async (dbType) => {
    let table: Table
    const totalDocs = 1000

    beforeAll(async () => {
        // 确保 dist 目录存在
        fs.ensureDirSync(distDir)
        // 清理旧备份文件
        if (fs.existsSync(backupPath)) fs.removeSync(backupPath)
        if (fs.existsSync(backupPathUncompressed)) fs.removeSync(backupPathUncompressed)

        table = await getTestTableByType("backup-test", dbType)
        await table.init()
        await table.clear()
    })

    afterAll(async () => {
        await table.close()
    })

    // ------------------------------------------------------------------------
    // 数据准备
    // ------------------------------------------------------------------------

    it("插入测试数据", async () => {
        const docs = Array.from({ length: totalDocs }, (_, i) => generateDoc(i))
        await table.insertMany(docs)

        const count = await table.count()
        expect(count).toBe(totalDocs)
    })

    // ------------------------------------------------------------------------
    // 压缩导出/导入测试
    // ------------------------------------------------------------------------

    describe("压缩模式备份", () => {
        it("导出压缩备份文件", async () => {
            await table.exportBinaryToFile(backupPath, { compress: true })

            expect(fs.existsSync(backupPath)).toBe(true)
            const stats = fs.statSync(backupPath)
            expect(stats.size).toBeGreaterThan(0)
            console.log(`压缩备份文件大小: ${(stats.size / 1024).toFixed(2)} KB`)
        })

        it("从压缩备份恢复数据", async () => {
            await table.clear()
            expect(await table.count()).toBe(0)

            const result = await table.importBinaryFromFile(backupPath, { clear: true })

            expect(result.docsCount).toBe(totalDocs)
            expect(await table.count()).toBe(totalDocs)
        })
    })

    // ------------------------------------------------------------------------
    // 非压缩导出/导入测试
    // ------------------------------------------------------------------------

    describe("非压缩模式备份", () => {
        it("导出非压缩备份文件", async () => {
            await table.exportBinaryToFile(backupPathUncompressed, { compress: false })

            expect(fs.existsSync(backupPathUncompressed)).toBe(true)
            const stats = fs.statSync(backupPathUncompressed)
            expect(stats.size).toBeGreaterThan(0)
            console.log(`非压缩备份文件大小: ${(stats.size / 1024).toFixed(2)} KB`)
        })

        it("从非压缩备份恢复数据", async () => {
            await table.clear()
            expect(await table.count()).toBe(0)

            const result = await table.importBinaryFromFile(backupPathUncompressed, { clear: true })

            expect(result.docsCount).toBe(totalDocs)
            expect(await table.count()).toBe(totalDocs)
        })
    })

    // ------------------------------------------------------------------------
    // 数据类型完整性验证（核心测试）
    // ------------------------------------------------------------------------

    describe("数据类型完整性验证", () => {
        const testIds = [0, 100, 500, 999]

        it.each(testIds)("验证文档 id=%i 的所有数据类型", async (id) => {
            const doc = (await table.get(id.toString())) as any
            expect(doc).toBeDefined()

            const original = generateDoc(id)
            await verifyDoc(doc, original)
        })
    })

    // ------------------------------------------------------------------------
    // 内存操作测试
    // ------------------------------------------------------------------------

    describe("内存备份操作", () => {
        it("exportBinary/importBinary 内存操作", async () => {
            // 导出到内存
            const binary = await table.exportBinary({ compress: true })
            expect(binary).toBeInstanceOf(Uint8Array)
            expect(binary.length).toBeGreaterThan(0)

            // 清空并恢复
            await table.clear()
            expect(await table.count()).toBe(0)

            const result = await table.importBinary(binary, { clear: true })
            expect(result.docsCount).toBe(totalDocs)

            // 验证一条数据
            const doc = (await table.get("500")) as any
            const original = generateDoc(500)
            await verifyDoc(doc, original)
        })
    })

    // ------------------------------------------------------------------------
    // 部分导入测试
    // ------------------------------------------------------------------------

    describe("部分导入功能", () => {
        it("使用 docIds 只导入指定文档", async () => {
            const binary = await table.exportBinary({ compress: false })

            await table.clear()
            expect(await table.count()).toBe(0)

            // 只导入 3 条指定的文档
            const targetIds = ["10", "20", "30"]
            const result = await table.importBinary(binary, {
                clear: true,
                docIds: targetIds,
            })

            expect(result.docsCount).toBe(3)
            expect(await table.count()).toBe(3)

            // 验证导入的文档
            for (const id of targetIds) {
                const doc = await table.get(id)
                expect(doc).toBeDefined()
            }

            // 验证未导入的文档不存在
            const notImported = await table.get("0")
            expect(notImported).toBeUndefined()
        })
    })
})

// ============================================================================
// 测试数据生成
// ============================================================================

/** 生成包含各种数据类型的测试文档 */
function generateDoc(id: number) {
    return {
        id: id.toString(),
        // 基础类型
        str: `字符串-${id}`,
        num: id * 1.5,
        int: id,
        bool: id % 2 === 0,
        nullVal: null,

        // 特殊类型
        date: new Date(1704067200000 + id * 1000), // 2024-01-01 + id 秒
        bigint: BigInt(Number.MAX_SAFE_INTEGER) + BigInt(id),

        // TypedArray 类型
        u8: new Uint8Array([1, 2, 3, id % 255]),
        i32: new Int32Array([id, -id, id * 2]),
        f64: new Float64Array([1.1, 2.2, id * 0.1]),

        // ArrayBuffer
        buf: new Uint8Array([10, 20, 30, id % 255]).buffer,

        // Blob
        blob: new Blob([new Uint8Array([40, 50, 60, id % 255])], { type: "application/octet-stream" }),

        // 复合类型
        nested: {
            a: id,
            b: [id, id + 1],
            deep: { x: id * 10 },
        },
        arr: [id, `item-${id}`, id % 2 === 0],
    }
}

/** 验证文档数据完整性 */
async function verifyDoc(restored: any, original: any) {
    // 基础类型
    expect(restored.str).toBe(original.str)
    expect(restored.num).toBe(original.num)
    expect(restored.int).toBe(original.int)
    expect(restored.bool).toBe(original.bool)
    expect(restored.nullVal).toBe(original.nullVal)

    // Date
    expect(restored.date).toBeInstanceOf(Date)
    expect(restored.date.toISOString()).toBe(original.date.toISOString())

    // BigInt
    expect(BigInt(restored.bigint)).toBe(original.bigint)

    // Uint8Array
    expect(restored.u8).toBeInstanceOf(Uint8Array)
    expect(restored.u8).toEqual(original.u8)

    // Int32Array
    expect(restored.i32).toBeInstanceOf(Int32Array)
    expect(restored.i32).toEqual(original.i32)

    // Float64Array
    expect(restored.f64).toBeInstanceOf(Float64Array)
    expect(restored.f64).toEqual(original.f64)

    // ArrayBuffer
    expect(restored.buf).toBeInstanceOf(ArrayBuffer)
    expect(new Uint8Array(restored.buf)).toEqual(new Uint8Array(original.buf))

    // Blob
    if (restored.blob instanceof Blob) {
        const restoredBuf = await restored.blob.arrayBuffer()
        const originalBuf = await original.blob.arrayBuffer()
        expect(new Uint8Array(restoredBuf)).toEqual(new Uint8Array(originalBuf))
    }

    // 嵌套对象
    expect(restored.nested.a).toBe(original.nested.a)
    expect(restored.nested.b).toEqual(original.nested.b)
    expect(restored.nested.deep.x).toBe(original.nested.deep.x)

    // 数组
    expect(restored.arr).toEqual(original.arr)
}
