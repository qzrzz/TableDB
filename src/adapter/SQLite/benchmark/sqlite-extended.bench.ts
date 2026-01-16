/**
 * SQLite 适配器扩展基准测试
 * 覆盖以下场景：
 * 1. 大文档测试（1KB/10KB/100KB payload）
 * 2. 深层嵌套查询（depth=2/5/10）
 * 3. 大规模批量导入（10K/50K/100K 文档，对比默认/禁用触发器/分块导入）
 * 4. 索引数量对写入性能的影响（0/3/5 个索引字段）
 */

import { Bench } from 'tinybench'
import { SQLiteAdapter } from '../SQLiteAdapter'
import { ITableDBAdapterInstance } from '../../adapter'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync, existsSync, rmSync } from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const BENCH_DIR = resolve(__dirname, './dist')

if (!existsSync(BENCH_DIR)) mkdirSync(BENCH_DIR, { recursive: true })

// ============================================
// 辅助函数
// ============================================

/**
 * 生成指定大小的随机字符串
 */
function generateRandomString(sizeKB: number): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    const length = sizeKB * 1024
    let result = ''
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    return result
}

/**
 * 生成指定深度的嵌套对象
 */
function generateNestedObject(depth: number, value: any): any {
    if (depth <= 1) return { value }
    return { nested: generateNestedObject(depth - 1, value) }
}

/**
 * 获取嵌套对象的访问路径
 */
function getNestedPath(depth: number): string {
    if (depth <= 1) return 'value'
    return 'nested.' + getNestedPath(depth - 1)
}

/**
 * 清理数据库文件
 */
function cleanupDb(path: string) {
    try {
        if (existsSync(path)) rmSync(path)
        if (existsSync(path + '-wal')) rmSync(path + '-wal')
        if (existsSync(path + '-shm')) rmSync(path + '-shm')
    } catch (e) {
        // ignore
    }
}

/**
 * 格式化毫秒为可读字符串
 */
function formatMs(ms: number): string {
    if (ms < 1) return `${(ms * 1000).toFixed(2)}μs`
    if (ms < 1000) return `${ms.toFixed(2)}ms`
    return `${(ms / 1000).toFixed(2)}s`
}

// ============================================
// 基准测试 1：大文档性能测试
// ============================================

async function benchLargeDocuments() {
    console.log('\n========================================')
    console.log('基准测试 1：大文档性能测试')
    console.log('========================================\n')

    const DB_PATH = resolve(BENCH_DIR, 'bench_large_doc.sqlite')
    cleanupDb(DB_PATH)

    const adapter = SQLiteAdapter({ filename: DB_PATH })
    const table = await adapter.useAdapterInstance('large_docs')

    const bench = new Bench({ time: 1000 })

    // 准备不同大小的文档
    const doc1KB = { id: 'doc_1kb', payload: generateRandomString(1), size: '1KB' }
    const doc10KB = { id: 'doc_10kb', payload: generateRandomString(10), size: '10KB' }
    const doc100KB = { id: 'doc_100kb', payload: generateRandomString(100), size: '100KB' }

    // 插入测试
    bench
        .add('插入 1KB 文档', async () => {
            await table.set(`doc_1kb_${Date.now()}`, { ...doc1KB, id: `doc_1kb_${Date.now()}` })
        })
        .add('插入 10KB 文档', async () => {
            await table.set(`doc_10kb_${Date.now()}`, { ...doc10KB, id: `doc_10kb_${Date.now()}` })
        })
        .add('插入 100KB 文档', async () => {
            await table.set(`doc_100kb_${Date.now()}`, { ...doc100KB, id: `doc_100kb_${Date.now()}` })
        })

    // 预插入用于读取测试
    await table.set('doc_1kb', doc1KB)
    await table.set('doc_10kb', doc10KB)
    await table.set('doc_100kb', doc100KB)

    bench
        .add('读取 1KB 文档', async () => {
            await table.get('doc_1kb')
        })
        .add('读取 10KB 文档', async () => {
            await table.get('doc_10kb')
        })
        .add('读取 100KB 文档', async () => {
            await table.get('doc_100kb')
        })

    // 批量读取测试 - 预插入 100 个 10KB 文档
    const docs10KB = Array.from({ length: 100 }, (_, i) => ({
        id: `batch_10kb_${i}`,
        payload: generateRandomString(10),
        category: 'batch'
    }))
    await table.insertMany(docs10KB)

    bench.add('findMany 100 个 10KB 文档', async () => {
        await table.findMany({ category: 'batch' })
    })

    console.log('运行基准测试...')
    await bench.run()
    console.table(bench.table())

    await table.close()
    cleanupDb(DB_PATH)
}

// ============================================
// 基准测试 2：深层嵌套查询性能测试
// ============================================

async function benchDeepNestedQueries() {
    console.log('\n========================================')
    console.log('基准测试 2：深层嵌套查询性能测试')
    console.log('========================================\n')

    const DB_PATH = resolve(BENCH_DIR, 'bench_nested.sqlite')
    cleanupDb(DB_PATH)

    const adapter = SQLiteAdapter({ filename: DB_PATH })
    const table = await adapter.useAdapterInstance('nested_docs')

    const DATA_SIZE = 5000

    // 生成带有不同深度嵌套的文档
    const docs = Array.from({ length: DATA_SIZE }, (_, i) => ({
        id: `doc_${i}`,
        meta: { active: i % 2 === 0 },
        level2: { level3: { value: i % 100 } },
        level5: generateNestedObject(5, i % 100),
        level10: generateNestedObject(10, i % 100)
    }))

    console.log(`插入 ${DATA_SIZE} 条嵌套文档...`)
    await table.insertMany(docs)

    const bench = new Bench({ time: 500 })

    // 不同深度的查询测试
    bench
        .add('查询 depth=2 ($.meta.active)', async () => {
            await table.findMany({ 'meta.active': true })
        })
        .add('查询 depth=3 ($.level2.level3.value)', async () => {
            await table.findMany({ 'level2.level3.value': 50 })
        })
        .add('查询 depth=5', async () => {
            await table.findMany({ [getNestedPath(5).replace('value', 'level5.nested.nested.nested.nested.value')]: 50 })
        })

    // 更新嵌套字段测试
    bench
        .add('更新 depth=2 字段', async () => {
            await table.updateOne(
                { id: 'doc_0' },
                { $set: { 'meta.active': false } }
            )
        })
        .add('更新 depth=3 字段', async () => {
            await table.updateOne(
                { id: 'doc_0' },
                { $set: { 'level2.level3.value': 999 } }
            )
        })

    console.log('运行基准测试...')
    await bench.run()
    console.table(bench.table())

    await table.close()
    cleanupDb(DB_PATH)
}

// ============================================
// 基准测试 3：大规模批量导入性能测试
// ============================================

async function benchBulkImport() {
    console.log('\n========================================')
    console.log('基准测试 3：大规模批量导入性能测试')
    console.log('========================================\n')

    const dataSizes = [10000, 50000, 100000]

    for (const size of dataSizes) {
        console.log(`\n--- 测试数据量: ${size.toLocaleString()} 条 ---\n`)

        // 生成测试数据
        const docs = Array.from({ length: size }, (_, i) => ({
            id: `doc_${i}`,
            name: `User ${i}`,
            age: i % 100,
            category: ['A', 'B', 'C'][i % 3],
            tags: [`tag_${i % 10}`, `group_${i % 5}`],
            score: i * 1.5
        }))

        // 测试 1：有索引的 insertMany（自动优化）
        // 当文档数量 >= 1000 且有索引时，自动启用高性能导入策略
        const DB_PATH_1 = resolve(BENCH_DIR, `bench_bulk_indexed_${size}.sqlite`)
        cleanupDb(DB_PATH_1)
        const adapter1 = SQLiteAdapter({ filename: DB_PATH_1 })
        const table1 = await adapter1.useAdapterInstance('bulk_test')
        await table1.defineIndexes([{ key: 'age' }, { key: 'category' }, { key: 'tags' }])

        const start1 = performance.now()
        await table1.insertMany(docs)  // 自动启用优化策略
        const time1 = performance.now() - start1

        await table1.close()
        cleanupDb(DB_PATH_1)

        // 测试 2：无索引 insertMany（作为基准）
        const DB_PATH_2 = resolve(BENCH_DIR, `bench_bulk_noindex_${size}.sqlite`)
        cleanupDb(DB_PATH_2)
        const adapter2 = SQLiteAdapter({ filename: DB_PATH_2 })
        const table2 = await adapter2.useAdapterInstance('bulk_test')

        const start2 = performance.now()
        await table2.insertMany(docs)
        const time2 = performance.now() - start2

        await table2.close()
        cleanupDb(DB_PATH_2)

        console.log(`insertMany（有 3 个索引，自动优化）: ${formatMs(time1)} (${(size / time1 * 1000).toFixed(0)} docs/s)`)
        console.log(`insertMany（无索引基准）:         ${formatMs(time2)} (${(size / time2 * 1000).toFixed(0)} docs/s)`)
    }
}

// ============================================
// 基准测试 4：索引数量对写入性能的影响
// ============================================

async function benchIndexImpact() {
    console.log('\n========================================')
    console.log('基准测试 4：索引数量对写入性能的影响')
    console.log('========================================\n')

    const DATA_SIZE = 10000
    const indexConfigs = [
        { name: '0 个索引', indexes: [] },
        { name: '3 个索引', indexes: [{ key: 'age' }, { key: 'category' }, { key: 'score' }] },
        { name: '5 个索引', indexes: [{ key: 'age' }, { key: 'category' }, { key: 'score' }, { key: 'tags' }, { key: 'name' }] }
    ]

    const results: { name: string; insertTime: number; updateTime: number }[] = []

    for (const config of indexConfigs) {
        const DB_PATH = resolve(BENCH_DIR, `bench_index_${config.name.replace(/\s/g, '_')}.sqlite`)
        cleanupDb(DB_PATH)

        const adapter = SQLiteAdapter({ filename: DB_PATH })
        const table = await adapter.useAdapterInstance('index_test')

        // 创建索引
        if (config.indexes.length > 0) {
            await table.defineIndexes(config.indexes as any)
        }

        // 生成测试数据
        const docs = Array.from({ length: DATA_SIZE }, (_, i) => ({
            id: `doc_${i}`,
            name: `User ${i}`,
            age: i % 100,
            category: ['A', 'B', 'C'][i % 3],
            tags: [`tag_${i % 10}`],
            score: i * 1.5
        }))

        // 测试 insertMany
        const insertStart = performance.now()
        await table.insertMany(docs)
        const insertTime = performance.now() - insertStart

        // 测试 updateMany
        const updateStart = performance.now()
        await table.updateMany({ category: 'A' }, { $set: { score: 999 } })
        const updateTime = performance.now() - updateStart

        results.push({
            name: config.name,
            insertTime,
            updateTime
        })

        await table.close()
        cleanupDb(DB_PATH)
    }

    console.log(`数据量: ${DATA_SIZE.toLocaleString()} 条\n`)
    console.log('| 配置 | insertMany | updateMany |')
    console.log('|------|------------|------------|')
    for (const r of results) {
        console.log(`| ${r.name} | ${formatMs(r.insertTime)} | ${formatMs(r.updateTime)} |`)
    }

    // 计算性能影响
    if (results.length >= 2) {
        const baseline = results[0]
        console.log('\n性能影响（相对于无索引基准）:')
        for (let i = 1; i < results.length; i++) {
            const r = results[i]
            console.log(`${r.name}: 插入慢 ${(r.insertTime / baseline.insertTime).toFixed(2)}x, 更新慢 ${(r.updateTime / baseline.updateTime).toFixed(2)}x`)
        }
    }
}

// ============================================
// 基准测试 5：setMany 事务优化对比
// ============================================

async function benchSetManyOptimization() {
    console.log('\n========================================')
    console.log('基准测试 5：setMany 事务优化测试')
    console.log('========================================\n')

    const DATA_SIZE = 5000

    // 生成测试数据
    const docs = Array.from({ length: DATA_SIZE }, (_, i) => ({
        id: `doc_${i}`,
        name: `User ${i}`,
        age: i % 100,
        counter: 0
    }))

    // 测试新数据的 setMany (insertOnly 场景)
    const DB_PATH_1 = resolve(BENCH_DIR, 'bench_setmany_insert.sqlite')
    cleanupDb(DB_PATH_1)
    const adapter1 = SQLiteAdapter({ filename: DB_PATH_1 })
    const table1 = await adapter1.useAdapterInstance('setmany_test')

    const insertStart = performance.now()
    await table1.setMany(docs)
    const insertTime = performance.now() - insertStart

    // 测试更新已存在数据的 setMany (overwrite 场景)
    const updatedDocs = docs.map(d => ({ ...d, counter: 1 }))
    const overwriteStart = performance.now()
    await table1.setMany(updatedDocs, { overwrite: true })
    const overwriteTime = performance.now() - overwriteStart

    // 测试合并场景
    const mergeDocs = docs.map(d => ({ id: d.id, counter: 2 }))
    const mergeStart = performance.now()
    await table1.setMany(mergeDocs)
    const mergeTime = performance.now() - mergeStart

    await table1.close()
    cleanupDb(DB_PATH_1)

    console.log(`数据量: ${DATA_SIZE.toLocaleString()} 条\n`)
    console.log(`setMany 插入新数据:        ${formatMs(insertTime)} (${(DATA_SIZE / insertTime * 1000).toFixed(0)} docs/s)`)
    console.log(`setMany 覆盖已有数据:      ${formatMs(overwriteTime)} (${(DATA_SIZE / overwriteTime * 1000).toFixed(0)} docs/s)`)
    console.log(`setMany 合并已有数据:      ${formatMs(mergeTime)} (${(DATA_SIZE / mergeTime * 1000).toFixed(0)} docs/s)`)
}

// ============================================
// 主函数
// ============================================

async function run() {
    console.log('========================================')
    console.log('SQLite 适配器扩展基准测试')
    console.log('========================================')
    console.log(`运行时间: ${new Date().toISOString()}`)

    try {
        await benchLargeDocuments()
        await benchDeepNestedQueries()
        await benchBulkImport()
        await benchIndexImpact()
        await benchSetManyOptimization()

        console.log('\n========================================')
        console.log('所有基准测试完成')
        console.log('========================================')
    } catch (e) {
        console.error('基准测试执行失败:', e)
        throw e
    }
}

run().catch(e => {
    console.error(e)
    process.exit(1)
})
