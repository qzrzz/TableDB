import { Bench } from "tinybench"
import { createBenchTable, generateDoc, prepareTableData } from "./utils"

async function run() {
    const bench = new Bench({ time: 1000 })

    // 准备数据
    const DATA_SIZE = 5000
    const tableNormal = await createBenchTable("bench_single_normal", false)
    const tableMarkDel = await createBenchTable("bench_single_markdel", true)
    
    await prepareTableData(tableNormal, DATA_SIZE)
    await prepareTableData(tableMarkDel, DATA_SIZE)

    // 专门用于删除测试的表 (避免影响其他测试)
    const tableDelNormal = await createBenchTable("bench_del_normal", false)
    const tableDelMarkDel = await createBenchTable("bench_del_markdel", true)
    const DEL_DATA_SIZE = 20000
    await prepareTableData(tableDelNormal, DEL_DATA_SIZE)
    await prepareTableData(tableDelMarkDel, DEL_DATA_SIZE)

    let incId = DATA_SIZE + 1

    // --- Insert (set) ---
    bench.add("set (Insert) - Normal", async () => {
        const id = `new_${incId++}`
        await tableNormal.set(id, generateDoc(incId))
    })
    bench.add("set (Insert) - MarkDelete", async () => {
        const id = `new_md_${incId++}`
        await tableMarkDel.set(id, generateDoc(incId))
    })

    // --- Get ---
    bench.add("get (by ID) - Normal", async () => {
        const id = `doc_${Math.floor(Math.random() * DATA_SIZE)}`
        await tableNormal.get(id)
    })
    bench.add("get (by ID) - MarkDelete", async () => {
        const id = `doc_${Math.floor(Math.random() * DATA_SIZE)}`
        await tableMarkDel.get(id)
    })

    // --- Has ---
    bench.add("has (by ID) - Normal", async () => {
        const id = `doc_${Math.floor(Math.random() * DATA_SIZE)}`
        await tableNormal.has(id)
    })
    bench.add("has (by ID) - MarkDelete", async () => {
        const id = `doc_${Math.floor(Math.random() * DATA_SIZE)}`
        await tableMarkDel.has(id)
    })

    // --- Update (updateOne) ---
    bench.add("updateOne - Normal", async () => {
        const id = `doc_${Math.floor(Math.random() * DATA_SIZE)}`
        await tableNormal.updateOne({ id }, { $inc: { age: 1 } })
    })
    bench.add("updateOne - MarkDelete", async () => {
        const id = `doc_${Math.floor(Math.random() * DATA_SIZE)}`
        await tableMarkDel.updateOne({ id }, { $inc: { age: 1 } })
    })

    // --- Delete (delete) ---
    bench.add("delete (by ID) - Normal", async () => {
        const id = `doc_${Math.floor(Math.random() * DEL_DATA_SIZE)}`
        await tableDelNormal.delete(id)
    })
    bench.add("delete (by ID) - MarkDelete", async () => {
        const id = `doc_${Math.floor(Math.random() * DEL_DATA_SIZE)}`
        await tableDelMarkDel.delete(id)
    })

    console.log("Running Single CRUD Benchmark...")
    // await bench.warmup() // tinybench v3+ uses warmupTasks or just run
    await bench.run()

    console.table(bench.table())
}

run()
