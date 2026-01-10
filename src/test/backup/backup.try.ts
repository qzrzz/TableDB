import { rollString, readableByte } from "fzz"
import fs from "fs"
import ansis from "ansis"
import { SQLiteAdapter } from "../../adapter/SQLite/SQLiteAdapter"
import { defineTable } from "../../core/defineTable"
import { Table } from "../../core/Table"

const __dirname = import.meta.dirname
const distDir = `${__dirname}/dist`
const dbPath = `${distDir}/test.db`
const backupPath = `${distDir}/backup.cbor.gzip`

// 颜色辅助函数
const log = {
    title: (msg: string) => console.log(ansis.bold.cyan(`\n${"═".repeat(60)}\n  ${msg}\n${"═".repeat(60)}`)),
    step: (msg: string) => console.log(ansis.yellow("▶ ") + ansis.white(msg)),
    success: (msg: string) => console.log(ansis.green("✔ ") + ansis.greenBright(msg)),
    info: (msg: string) => console.log(ansis.blue("ℹ ") + ansis.gray(msg)),
    error: (msg: string) => console.log(ansis.red("✖ ") + ansis.redBright(msg)),
    warn: (msg: string) => console.log(ansis.yellow("⚠ ") + ansis.yellowBright(msg)),
    data: (label: string, value: string | number) => console.log(ansis.magenta(`  ${label}: `) + ansis.white(String(value))),
}

// ======================================================================
// 主流程
// ======================================================================

log.title("🗄️  TableDB 备份与恢复测试")

// 1. 创建测试表并插入数据
let table = await createTestTable()
const originalCount = await table.count()
log.data("原始数据条数", originalCount)

// 2. 创建备份
let backupData = await createBackup(table)

// 3. 恢复备份（清空后恢复）
await restoreBackup(table, backupData)

// 4. 数据校验
await verifyData(table, originalCount)

log.title("🎉 全部流程完成")

// ======================================================================
// 创建测试表
// ======================================================================
async function createTestTable() {
    log.title("📦 创建测试表")

    log.step(`删除旧数据库: ${dbPath}`)
    fs.rmSync(dbPath, { recursive: true, force: true })

    const adapterFactory = SQLiteAdapter({ filename: dbPath, safe: false })

    const useTestTable = defineTable({
        name: "test_backup",
        adapter: adapterFactory,
    })

    log.step("初始化测试表...")
    const table = await useTestTable()

    log.step("插入测试数据 (20000 条)...")
    const startTime = Date.now()
    for (let i = 0; i < 20000; i++) {
        await table.insertMany([generateDoc(i)])
        if ((i + 1) % 5000 === 0) {
            log.info(`已插入 ${i + 1} 条数据...`)
        }
    }
    const insertTime = Date.now() - startTime
    log.success(`测试数据插入完成，耗时: ${insertTime}ms`)

    let dbSize = fs.statSync(dbPath).size
    log.data("数据库大小", readableByte(dbSize))
    return table
}

// ======================================================================
// 创建备份
// ======================================================================
async function createBackup(table: Table) {
    log.title("💾 创建备份")

    log.step("正在导出二进制备份...")
    const startTime = Date.now()
    const data = await table.exportBinary()
    const exportTime = Date.now() - startTime

    fs.writeFileSync(backupPath, data)
    log.success(`备份创建完成，耗时: ${exportTime}ms`)
    log.data("备份文件路径", backupPath)
    log.data("备份文件大小", readableByte(data.byteLength))

    return data
}

// ======================================================================
// 恢复备份（清空后恢复）
// ======================================================================
async function restoreBackup(table: Table, backupData: Uint8Array) {
    log.title("🔄 恢复备份")

    // 清空表
    log.step("清空当前表数据...")
    await table.clear()
    const afterClearCount = await table.count()
    log.info(`清空后数据条数: ${afterClearCount}`)

    if (afterClearCount !== 0) {
        log.error("清空表失败！表中仍有数据")
        throw new Error("清空表失败")
    }
    log.success("表数据已清空")

    // 恢复数据
    log.step("正在从备份恢复数据...")
    const startTime = Date.now()
    const result = await table.importBinary(backupData, { clear: true })
    const importTime = Date.now() - startTime

    log.success(`备份恢复完成，耗时: ${importTime}ms`)
    log.data("恢复的文档数", result.docsCount)

    return result
}

// ======================================================================
// 数据校验
// ======================================================================
async function verifyData(table: Table, expectedCount: number) {
    log.title("🔍 数据校验")

    // 验证数据条数
    log.step("验证数据条数...")
    const actualCount = await table.count()
    log.data("期望条数", expectedCount)
    log.data("实际条数", actualCount)

    if (actualCount !== expectedCount) {
        log.error(`数据条数不匹配！期望 ${expectedCount}，实际 ${actualCount}`)
        throw new Error("数据条数校验失败")
    }
    log.success("数据条数校验通过")

    // 验证几条抽样数据的完整性
    log.step("验证抽样数据完整性...")
    const checkIds = [0, 100, 500, 1000, 5000, 10000, 19999]

    for (const id of checkIds) {
        const doc = (await table.get(id.toString())) as any
        const original = generateDoc(id)

        if (!doc) {
            log.error(`文档 ID=${id} 不存在！`)
            throw new Error(`文档 ${id} 校验失败`)
        }

        // 验证基础类型
        const errors: string[] = []

        // str 是随机生成的，只验证格式（以 String- 开头、-END 结尾）
        if (!doc.str?.startsWith("String-") || !doc.str?.endsWith("-END")) {
            errors.push("str 格式不匹配")
        }
        if (doc.num !== original.num) errors.push("num 不匹配")
        if (doc.bool !== original.bool) errors.push("bool 不匹配")
        if (doc.nullVal !== null) errors.push("nullVal 不匹配")

        // 验证 Date
        if (!(doc.date instanceof Date) || doc.date.getTime() !== original.date.getTime()) {
            errors.push("date 不匹配")
        }

        // 验证 BigInt
        if (doc.bigint !== original.bigint) errors.push("bigint 不匹配")

        // 验证 Uint8Array
        if (!(doc.u8 instanceof Uint8Array) || !arraysEqual(doc.u8, original.u8)) {
            errors.push("u8 不匹配")
        }

        // 验证 Float64Array
        if (!(doc.f64 instanceof Float64Array) || !arraysEqual(doc.f64, original.f64)) {
            errors.push("f64 不匹配")
        }

        // 验证嵌套对象
        if (doc.nested?.a !== original.nested.a) errors.push("nested.a 不匹配")
        if (!arraysEqual(doc.nested?.b, original.nested.b)) errors.push("nested.b 不匹配")

        // 验证数组
        if (doc.arr[0] !== 1 || doc.arr[1] !== "2" || doc.arr[2] !== true) {
            errors.push("arr 不匹配")
        }

        if (errors.length > 0) {
            log.error(`文档 ID=${id} 校验失败: ${errors.join(", ")}`)
            throw new Error(`文档 ${id} 校验失败`)
        }

        log.info(`文档 ID=${id} 校验通过`)
    }

    log.success(`全部 ${checkIds.length} 条抽样数据校验通过`)

    // 验证二进制数据内存独立性
    log.step("验证二进制数据内存独立性...")
    const doc1 = (await table.get("0")) as any
    const doc2 = (await table.get("1")) as any

    const originalDoc2U8 = new Uint8Array(doc2.u8)
    doc1.u8[0] = 255 // 修改 doc1

    if (doc2.u8[0] === 255) {
        log.error("二进制数据共享内存！doc1 的修改影响了 doc2")
        throw new Error("内存独立性校验失败")
    }
    log.success("二进制数据内存独立性校验通过")

    log.success("✅ 全部数据校验完成，备份恢复正确！")
}

// ======================================================================
// 辅助函数
// ======================================================================
function arraysEqual(a: any, b: any): boolean {
    if (!a || !b) return false
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false
    }
    return true
}

function generateDoc(id: number) {
    return {
        id: id.toString(),
        str: `String-${rollString(2000)}-END`,
        num: id * 1.5,
        numArray: Array.from({ length: 100 }, (_, i) => i + id),
        numObject: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`key${i}`, i + id])),
        bool: id % 2 === 0,
        boolArray: Array.from({ length: 100 }, (_, i) => (i + id) % 2 === 0),
        boolObject: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`key${i}`, (i + id) % 2 === 0])),
        nullVal: null,
        nullArray: Array.from({ length: 100 }, () => null),
        // undefinedVal: undefined, // 通常 undefined 不会被存储或被忽略
        date: new Date(1704067200000 + id * 1000), // 2024-01-01 + id seconds
        dateArray: Array.from({ length: 100 }, (_, i) => new Date(1704067200000 + i * 1000 + id)),
        dateObject: Object.fromEntries(
            Array.from({ length: 10 }, (_, i) => [`key${i}`, new Date(1704067200000 + i * 1000 + id)])
        ),
        bigint: BigInt(Number.MAX_SAFE_INTEGER) + BigInt(id),
        u8: new Uint8Array([1, 2, 3, id % 255]),
        f64: new Float64Array([1.1, 2.2, id * 0.1]),
        buf: new Uint8Array([10, 20, 30]).buffer,
        bufArray: Array.from({ length: 10 }, () => new Uint8Array([10, 20, 30]).buffer),
        bufObject: Object.fromEntries(
            Array.from({ length: 5 }, (_, i) => [`key${i}`, new Uint8Array([10 + i, 20 + i, 30 + i]).buffer])
        ),
        blob: new Blob([new Uint8Array([40, 50, 60])], { type: "application/octet-stream" }),
        blobArray: Array.from(
            { length: 10 },
            () => new Blob([new Uint8Array([40, 50, 60])], { type: "application/octet-stream" })
        ),
        blobObject: Object.fromEntries(
            Array.from({ length: 5 }, (_, i) => [
                `key${i}`,
                new Blob([new Uint8Array([40 + i, 50 + i, 60 + i])], { type: "application/octet-stream" }),
            ])
        ),
        nested: {
            a: 1,
            b: [2, 3],
            c: { d: "deep", e: new Date(), u8: new Uint8Array([7, 8, 9]), list: [null, true, 123] },
        },
        arr: [1, "2", true],
    }
}
