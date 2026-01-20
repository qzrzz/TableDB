import { MongoClient, UUID, ObjectId } from "mongodb"
import { uuid, uuidToShort } from "fzz"

// MongoDB 连接配置
const uri = "mongodb://root:w2xO4Fd28Wc76o1sl8WAt3lo5sc42ver02@localhost:12779"
const dbName = "perf_test"

// 从命令行获取参数，默认 100 万
const TOTAL_DOCS = parseInt(process.argv[2]) || 1_000_000
const BATCH_SIZE = 10_000
const QUERY_COUNT = 1000

console.log(`性能测试配置:
  总文档数: ${TOTAL_DOCS.toLocaleString()}
  批量大小: ${BATCH_SIZE.toLocaleString()}
  查询次数: ${QUERY_COUNT.toLocaleString()}`)

// ID 生成函数
const generators = {
    uuidv4_str: () => uuid.v4(),
    uuidv4_short_str: () => uuidToShort(uuid.v4()),
    uuidv7_str: () => uuid.v7(),
    uuidv7_short_str: () => uuidToShort(uuid.v7()),
    uuidv4_bin: () => new UUID(uuid.v4()),
    uuidv7_bin: () => new UUID(uuid.v7()),
    objectId: () => new ObjectId(),
}

interface Result {
    name: string
    insertTime: number
    queryTime: number
    indexSizeMB: number
    dataSizeMB: number
}

async function runBenchmark() {
    const client = new MongoClient(uri)
    const results: Result[] = []
    try {
        await client.connect()
        console.log("成功连接到 MongoDB")
        const db = client.db(dbName)

        for (const [name, generateId] of Object.entries(generators)) {
            console.log(`\n>>> 测试类型: ${name}`)
            const collection = db.collection(`test_${name}`)
            await collection.drop().catch(() => {})

            let totalInsertTime = 0
            const idsForQuery: any[] = []

            for (let i = 0; i < TOTAL_DOCS; i += BATCH_SIZE) {
                // 1. 准备数据 (不计入数据库耗时)
                const batch = []
                for (let j = 0; j < BATCH_SIZE && i + j < TOTAL_DOCS; j++) {
                    const id = generateId()
                    if (idsForQuery.length < QUERY_COUNT && Math.random() < (QUERY_COUNT / TOTAL_DOCS) * 2) {
                        idsForQuery.push(id)
                    }
                    batch.push({
                        _id: id,
                        value: Math.random(),
                        name: `name_${i + j}`,
                    })
                }

                // 2. 执行插入 (只统计这部分时间)
                const batchStartTime = Date.now()
                await collection.insertMany(batch)
                totalInsertTime += Date.now() - batchStartTime

                if (i > 0 && i % (TOTAL_DOCS / 10) === 0) {
                    process.stdout.write(".")
                }
            }
            process.stdout.write("\n")

            // 补足查询 ID
            if (idsForQuery.length < QUERY_COUNT) {
                const docs = await collection
                    .find()
                    .limit(QUERY_COUNT - idsForQuery.length)
                    .toArray()
                idsForQuery.push(...docs.map((d) => d._id))
            }

            const queryStartTime = Date.now()
            for (const id of idsForQuery) {
                await collection.findOne({ _id: id })
            }
            const queryTime = Date.now() - queryStartTime

            const stats = await db.command({ collStats: `test_${name}` })

            results.push({
                name,
                insertTime: totalInsertTime,
                queryTime,
                indexSizeMB: stats.totalIndexSize / 1024 / 1024,
                dataSizeMB: stats.size / 1024 / 1024,
            })

            console.log(`  完成. 插入(DB耗时): ${totalInsertTime}ms, 查询: ${queryTime}ms`)
        }

        // 排序：按查询时间升序
        results.sort((a, b) => a.queryTime - b.queryTime)
        const minQueryTime = results[0].queryTime

        // 打印汇总表
        console.log("\n" + "=".repeat(95))
        console.log(
            `${"ID 类型".padEnd(18)} | ${"查询(ms)".padEnd(10)} | ${"查询 %".padEnd(10)} | ${"插入(ms)".padEnd(10)} | ${"数据(MB)".padEnd(10)} | ${"索引(MB)".padEnd(10)}`,
        )
        console.log("-".repeat(95))
        for (const r of results) {
            const diffPercent = ((r.queryTime - minQueryTime) / minQueryTime) * 100
            const percentStr = diffPercent === 0 ? "Ref" : `+${diffPercent.toFixed(1)}%`

            console.log(
                `${r.name.padEnd(18)} | ${r.queryTime.toString().padEnd(10)} | ${percentStr.padEnd(10)} | ${r.insertTime.toString().padEnd(10)} | ${r.dataSizeMB.toFixed(2).padEnd(10)} | ${r.indexSizeMB.toFixed(2).padEnd(10)}`,
            )
        }
        console.log("=".repeat(95))
    } catch (err) {
        console.error("测试出错:", err)
    } finally {
        await client.close()
    }
}

runBenchmark()
