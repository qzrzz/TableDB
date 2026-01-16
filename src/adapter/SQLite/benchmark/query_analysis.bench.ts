import { SQLiteAdapter } from "../SQLiteAdapter"
import { Table } from "../../../core/Table"
import { ITableDoc, ITableDebugResult } from "../../adapter"
import fs from "fs"

// ======================================================================
// 基准测试配置
// ======================================================================

const DB_PATH = "./dist/bench_query_analysis.db"
const DATA_SIZE = 50_000
const ITERATIONS = 5

// ======================================================================
// 数据模型定义
// ======================================================================

/**
 * 字段命名规范：
 * - `*_idx`: 有索引的字段
 * - `*_noidx`: 无索引的字段
 * - 便于快速识别查询是否使用索引
 */
interface IBenchDoc extends ITableDoc {
    id: string

    // --- 基础类型测试 ---
    type_idx: string           // 有索引 - 字符串精确匹配
    type_noidx: string         // 无索引 - 字符串精确匹配

    val_idx: number            // 有索引 - 数字范围查询
    val_noidx: number          // 无索引 - 数字范围查询

    // --- 数组测试 ---
    tags_idx: string[]         // 有索引 - 数组隐式匹配 (Side Table)
    tags_noidx: string[]       // 无索引 - 数组隐式匹配

    // --- 嵌套对象测试 ---
    nested_idx: { info: string }   // 有索引 - 嵌套对象 (Dot Notation)
    meta: {                        // 无索引 - 嵌套对象 (Dot Notation)
        created: Date
        status: string
        info: string
    }

    // --- 边缘情况测试 ---
    mixed_idx: string | string[]     // 有索引 - 混合类型 (标量/数组)
    scalar_idx: string               // 有索引 - 纯标量
    abnormal_idx?: number | null     // 有索引 - 含特殊值 (null, NaN, Infinity)
    normal_idx: number               // 有索引 - 无特殊值

    // --- Date 类型测试 ---
    date_pure_idx: Date              // 有索引 - 纯 Date
    date_pure_noidx: Date            // 无索引 - 纯 Date
    date_mixed_idx: Date | string | null  // 有索引 - 混合 Date
}

// ======================================================================
// 表设置与索引定义
// ======================================================================

async function setupTable() {
    try { fs.unlinkSync(DB_PATH) } catch (e) { }
    try { fs.mkdirSync("./dist", { recursive: true }) } catch (e) { }

    const table = new Table<IBenchDoc>({
        name: "bench_query",
        adapter: SQLiteAdapter({ filename: DB_PATH }),
    })
    await table.init()

    // 索引定义 - 仅 *_idx 字段有索引
    await table.defineIndexes([
        { key: "type_idx" },
        { key: "val_idx" },
        { key: "tags_idx" },
        { key: "nested_idx.info" },  // 嵌套对象索引
        { key: "mixed_idx" },
        { key: "scalar_idx" },
        { key: "abnormal_idx" },
        { key: "normal_idx" },
        { key: "date_pure_idx" },
        { key: "date_mixed_idx" },
    ])

    return table
}

// ======================================================================
// 数据生成
// ======================================================================

async function generateData(table: Table<IBenchDoc>) {
    console.log(`正在生成 ${DATA_SIZE} 条文档...`)
    const docs: IBenchDoc[] = []
    const types = ["A", "B", "C", "D", "E"]

    for (let i = 0; i < DATA_SIZE; i++) {
        // 混合类型: 20% 数组, 80% 标量
        const mixed = i % 5 === 0 ? [`mix_${i}`, `common`] : `mix_${i}`

        // 异常值分布
        let abnormal: number | null | undefined = i
        const check = i % 100
        if (check < 10) abnormal = null
        else if (check < 20) abnormal = undefined
        else if (check < 30) abnormal = Infinity
        else if (check < 40) abnormal = NaN

        const dateVal = new Date(1700000000000 + i * 100000)

        const doc: IBenchDoc = {
            id: `id_${i}`,

            // 基础类型
            type_idx: types[i % types.length],
            type_noidx: types[i % types.length],
            val_idx: i,
            val_noidx: i,

            // 数组
            tags_idx: [`tag_${i % 100}`, `tag_${i % 10}`],
            tags_noidx: [`tag_${i % 100}`, `tag_${i % 10}`],

            // 嵌套对象
            nested_idx: { info: `info_${i}` },
            meta: {
                created: new Date(Date.now() - Math.floor(Math.random() * 10000000)),
                status: i % 2 === 0 ? "active" : "inactive",
                info: `info_${i}`
            },

            // 边缘情况
            mixed_idx: mixed,
            scalar_idx: `scalar_${i}`,
            normal_idx: i,

            // Date
            date_pure_idx: dateVal,
            date_pure_noidx: dateVal,
            date_mixed_idx: null as any,
        }

        if (abnormal !== undefined) {
            doc.abnormal_idx = abnormal
        }

        // Date 混合: 80% Date, 10% null, 10% string
        if (i % 10 === 0) {
            doc.date_mixed_idx = null
        } else if (i % 10 === 1) {
            doc.date_mixed_idx = "not-a-date"
        } else {
            doc.date_mixed_idx = dateVal
        }

        docs.push(doc)
    }

    await table.insertMany(docs)
    console.log("数据生成完成。\n")
}

// ======================================================================
// 指标收集
// ======================================================================

interface IMetric {
    "分类": string
    "测试项": string
    "策略": string
    "耗时(ms)": number
    "DB(ms)": number
    "结果数": number | string
    "脏字段": string
}

const metrics: IMetric[] = []

async function benchmark(
    category: string,
    action: string,
    fn: (debug: ITableDebugResult) => Promise<any>
) {
    const stats = { total: 0, db: 0 }
    let lastDebug: ITableDebugResult = {}
    let result: any

    // 预热
    await fn({})

    for (let i = 0; i < ITERATIONS; i++) {
        const debug: ITableDebugResult = {}
        result = await fn(debug)
        stats.total += debug.totalTimeMs || 0
        stats.db += debug.dbExecTimeMs || 0
        lastDebug = debug
    }

    const avgTotal = stats.total / ITERATIONS
    const avgDb = stats.db / ITERATIONS
    const dirtyFields = lastDebug.dirtyReasons?.map(r => r.path).filter(Boolean).join(", ") || "-"
    const resultCount = Array.isArray(result) ? result.length : (typeof result === 'number' ? result : '-')

    console.log(`[${category}] ${action} (${resultCount} results):`, JSON.stringify(lastDebug, null, 2), "\n")

    metrics.push({
        "分类": category,
        "测试项": action,
        "策略": lastDebug.strategy || "?",
        "耗时(ms)": Number(avgTotal.toFixed(2)),
        "DB(ms)": Number(avgDb.toFixed(2)),
        "结果数": resultCount,
        "脏字段": dirtyFields,
    })
}

// ======================================================================
// 测试场景
// ======================================================================

async function main() {
    const table = await setupTable()
    await generateData(table)

    console.log(`正在运行基准测试 (每项运行 ${ITERATIONS} 次取平均)...\n`)

    // ==================== 精确匹配 ====================
    await benchmark("精确匹配", "string 有索引 (type_idx)",
        d => table.findMany({ type_idx: "A" }, { limit: 1, debug: d }))

    await benchmark("精确匹配", "string 无索引 (type_noidx)",
        d => table.findMany({ type_noidx: "A" }, { limit: 1, debug: d }))

    await benchmark("精确匹配", "number 有索引 (val_idx)",
        d => table.findMany({ val_idx: 42 }, { limit: 1, debug: d }))

    await benchmark("精确匹配", "number 无索引 (val_noidx)",
        d => table.findMany({ val_noidx: 42 }, { limit: 1, debug: d }))

    await benchmark("精确匹配", "点号路径-有索引 (nested_idx.info)",
        d => table.findMany({ "nested_idx.info": "info_25000" }, { debug: d }))

    await benchmark("精确匹配", "点号路径-无索引 (meta.info)",
        d => table.findMany({ "meta.info": "info_25000" }, { debug: d }))

    // ==================== 范围查询 ====================
    await benchmark("范围查询", "有索引 (val_idx > 49900)",
        d => table.findMany({ val_idx: { $gt: 49900 } }, { debug: d }))

    await benchmark("范围查询", "无索引 (val_noidx > 49900)",
        d => table.findMany({ val_noidx: { $gt: 49900 } }, { debug: d }))

    // ==================== 数组隐式匹配 ====================
    await benchmark("数组匹配", "有索引 (tags_idx)",
        d => table.findMany({ tags_idx: "tag_50" }, { debug: d }))

    await benchmark("数组匹配", "无索引 (tags_noidx)",
        d => table.findMany({ tags_noidx: "tag_50" }, { debug: d }))

    await benchmark("数组匹配", "$in 有索引",
        d => table.findMany({ tags_idx: { $in: ["tag_1", "tag_99"] } }, { debug: d }))

    await benchmark("数组匹配", "$in 无索引",
        d => table.findMany({ tags_noidx: { $in: ["tag_1", "tag_99"] } }, { debug: d }))

    await benchmark("数组匹配", "$size",
        d => table.findMany({ tags_idx: { $size: 2 } }, { debug: d }))

    // ==================== Date 类型 ====================
    const targetDate = new Date(1700000000000 + 55 * 100000)
    const targetDate2 = new Date(1700000000000 + 72 * 100000)

    await benchmark("Date", "精确-有索引 (date_pure_idx)",
        d => table.findMany({ date_pure_idx: targetDate }, { debug: d }))

    await benchmark("Date", "精确-无索引 (date_pure_noidx)",
        d => table.findMany({ date_pure_noidx: targetDate }, { debug: d }))

    await benchmark("Date", "范围-有索引",
        d => table.findMany({ date_pure_idx: { $gt: targetDate, $lt: targetDate2 } }, { debug: d }))

    await benchmark("Date", "范围-无索引",
        d => table.findMany({ date_pure_noidx: { $gt: targetDate, $lt: targetDate2 } }, { debug: d }))

    await benchmark("Date", "混合类型精确",
        d => table.findMany({ date_mixed_idx: targetDate }, { debug: d }))

    // ==================== 边缘情况 ====================
    await benchmark("边缘", "混合类型字段 (Scalar/Array)",
        d => table.findMany({ mixed_idx: "mix_1" }, { debug: d }))

    await benchmark("边缘", "纯标量字段",
        d => table.findMany({ scalar_idx: "scalar_1" }, { debug: d }))

    await benchmark("边缘", "含特殊值字段查普通值",
        d => table.findMany({ abnormal_idx: 55 }, { debug: d }))

    await benchmark("边缘", "查 null",
        d => table.findMany({ abnormal_idx: null }, { debug: d }))

    // ==================== 其他 ====================
    await benchmark("其他", "Count 有索引",
        d => table.count({ type_idx: "B" }, { debug: d }))

    await benchmark("其他", "$or 复合查询",
        d => table.findMany({ $or: [{ type_idx: "A" }, { val_idx: { $lt: 100 } }] }, { limit: 100, debug: d }))

    await benchmark("其他", "深度分页 (offset 40000)",
        d => table.findMany({}, { offset: 40000, limit: 10, debug: d }))

    await benchmark("其他", "正则匹配",
        d => table.findMany({ type_idx: { $regex: "^A" } }, { limit: 100, debug: d }))

    // ==================== 输出结果 ====================
    console.table(metrics)

    await table.close()
}

main().catch(console.error)
