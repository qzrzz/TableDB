import { Bench } from "tinybench"
import { createBenchTable, generateDoc, prepareTableData, IBenchDoc } from "./utils"

async function run() {
    const bench = new Bench({ time: 1000 })

    const DATA_SIZE = 5000
    const tableNormal = await createBenchTable("bench_batch_normal", false)
    const tableMarkDel = await createBenchTable("bench_batch_markdel", true)
    
    // 预填充数据用于 find/update
    await prepareTableData(tableNormal, DATA_SIZE)
    await prepareTableData(tableMarkDel, DATA_SIZE)

    // 用于 delete 测试的表
    const tableDelNormal = await createBenchTable("bench_batch_del_normal", false)
    const tableDelMarkDel = await createBenchTable("bench_batch_del_markdel", true)

    let incId = DATA_SIZE + 1
    const BATCH_SIZE = 100

    // --- InsertMany ---
    bench.add("insertMany (100 docs) - Normal", async () => {
        const docs: IBenchDoc[] = []
        for(let i=0; i<BATCH_SIZE; i++) {
            docs.push(generateDoc(incId++))
        }
        await tableNormal.insertMany(docs)
    })
    bench.add("insertMany (100 docs) - MarkDelete", async () => {
        const docs: IBenchDoc[] = []
        for(let i=0; i<BATCH_SIZE; i++) {
            docs.push(generateDoc(incId++))
        }
        await tableMarkDel.insertMany(docs)
    })

    // --- FindMany ---
    // 注意：未建立索引，这将是全表扫描
    bench.add("findMany (match ~10%) - Normal", async () => {
        // tag_0 匹配约 10% 的数据
        await tableNormal.findMany({ tags: "tag_0" }) 
    })
    bench.add("findMany (match ~10%) - MarkDelete", async () => {
        await tableMarkDel.findMany({ tags: "tag_0" })
    })

    // --- UpdateMany ---
    bench.add("updateMany (match ~10%) - Normal", async () => {
        await tableNormal.updateMany({ tags: "tag_1" }, { $inc: { age: 1 } })
    })
    bench.add("updateMany (match ~10%) - MarkDelete", async () => {
        await tableMarkDel.updateMany({ tags: "tag_1" }, { $inc: { age: 1 } })
    })

    // --- DeleteMany ---
    // 采用 Insert + Delete 模式以保证每次都有数据可删
    bench.add("insertMany + deleteMany (100 docs) - Normal", async () => {
        const batchId = `batch_${Math.random()}`
        const docs = Array.from({length: 100}, (_, i) => ({
            ...generateDoc(0),
            id: `${batchId}_${i}`,
            tags: [batchId]
        }))
        await tableDelNormal.insertMany(docs)
        await tableDelNormal.deleteMany({ tags: batchId })
    })
    bench.add("insertMany + deleteMany (100 docs) - MarkDelete", async () => {
        const batchId = `batch_${Math.random()}`
        const docs = Array.from({length: 100}, (_, i) => ({
            ...generateDoc(0),
            id: `${batchId}_${i}`,
            tags: [batchId]
        }))
        await tableDelMarkDel.insertMany(docs)
        await tableDelMarkDel.deleteMany({ tags: batchId })
    })

    console.log("Running Batch CRUD Benchmark...")
    // await bench.warmup()
    await bench.run()

    console.table(bench.table())
}

run()
