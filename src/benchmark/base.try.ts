import { createBenchTable } from "./utils"
import { readableMs, stopwatch } from "fzz"

let table = await createBenchTable("base_try_table", false)

console.log("简单测试", table.adapter.name)

let testItems: { title: string; time: number; avg: number }[] = []

// 准备数据

console.log("\n准备数据...")
const DATA_SIZE = 5 * 10000
const docs: any[] = []
for (let i = 0; i < DATA_SIZE; i++) {
    docs.push({
        id: `id_${i}`,
        name: `name_${i}`,
        value: i,
        tags: [`tag_${i % 10}`],
    })
}

{
    // 插入大量数据

    console.log(`\n插入 ${DATA_SIZE} docs...`)
    let sw = stopwatch(true)
    await table.insertMany(docs)
    let time = sw()
    console.log(`[insertMany]: ${readableMs(time)}`)
    testItems.push({ title: `插入 ${DATA_SIZE} 个文档`, time: time, avg: time / DATA_SIZE })
}
{
    // 查询表数量
    console.log("\n查询表数量...")
    let sw = stopwatch(true)
    let count = await table.count()
    let time = sw()
    console.log(`[count]: ${readableMs(time)}`)
    console.log(`表数量: ${count}`)
    testItems.push({ title: `查询表数量`, time: time, avg: time })
}

{
    // 按 ID 查找表 （200 个 id）
    console.log("\n查询文档 by IDs...")

    let ids = []
    for (let i = 0; i < 200; i++) {
        ids.push(`id_${i * 50}`)
    }

    let sw = stopwatch(true)
    let docs = await table.findMany({ id: { $in: ids } })
    let time = sw()
    console.log(`[findMany]: ${readableMs(time)}`)
    console.log(`找到的数量: ${docs.length}`)
    testItems.push({ title: `findMany(200 ids) x 1`, time: time, avg: time })
}

{
    // 按数值比较查找表 （200 个 value $gte,$lt）
    console.log("\n查询文档 by value$gte,$lt...")

    let sw = stopwatch(true)
    let docs = await table.findMany({
        value: {
            $lt: 10000,
            $gte: 9800,
        },
    })
    let time = sw()
    console.log(`[findMany,$lt,$gte]: ${readableMs(time)}`)
    console.log(`找到的数量: ${docs.length}`)
    testItems.push({ title: `findMany(200 $lt,$gte) x 1`, time: time, avg: time })
}

{
    // 多次修改单个文档
    console.log("\n修改 1000 次文档")
    const docs = []
    for (let i = 0; i < 1000; i++) {
        docs.push({
            $set: {
                name: `updated_name_${i}`,
                updatedAt: Date.now(),
            },
            $inc: {
                value: 10,
            },
            $push: {
                tags: `updated_tag_${i % 5}`,
            },
        })
    }

    let sw = stopwatch(true)
    for (let i = 0; i < 1000; i++) {
        await table.updateOne({ id: `id_${i}` }, docs[i])
    }
    let time = sw()
    console.log(`[updateOne]: ${readableMs(time)}`)
    testItems.push({ title: `updateOne x 1000`, time: time, avg: time / 1000 })
}

{
    // 单次修改多个文档
    console.log("\n修改 1000 个文档(bulkUpdate)")
    const updates: any[] = []
    for (let i = 0; i < 1000; i++) {
        updates.push({
            filter: { id: `id_${i}` },
            updateOp: {
                $set: {
                    name: `bulkupdate_name_${i}`,
                    bulkUpdatedAt: Date.now(),
                },
                $inc: {
                    value: 50,
                },
                $push: {
                    tags: `bulkupdate_tag_${i % 7}`,
                },
            },
        })
    }
    let sw = stopwatch(true)
    await table.bulkUpdate(updates)
    let time = sw()
    console.log(`[bulkUpdate]: ${readableMs(time)}`)
    testItems.push({ title: `bulkUpdate(1000 docs) x 1`, time: time, avg: time / 1000 })
}

{
    // 覆盖 1000 个文档
    console.log("\n覆盖 1000 个文档(setMany)")
    const docsToUpdate: any[] = []
    for (let i = 0; i < 1000; i++) {
        docsToUpdate.push({
            id: `id_${i}`,
            name: `setmany_name_${i}`,
            buffer: Buffer.from(`buffer_data_${i}`).buffer,
            tags: [`setmany_tag_${i % 3}`],
            ob: {
                a: i,
                b: `name_${i}`,
                ob2: {
                    aa: i,
                    bb: i,
                    cc: `name_${i}`,
                    ob3: {
                        aaa: 1 * 100,
                        bbb: `name_${i}_nested`,
                    },
                },
            },
        })
    }
    let sw = stopwatch(true)
    await table.setMany(docsToUpdate)
    let time = sw()
    console.log(`[setMany]: ${readableMs(time)}`)
    testItems.push({ title: `setMany(1000 docs) x 1`, time: time, avg: time / 1000 })
}

{
    // 覆盖 1000 个文档 merge
    console.log("\n覆盖 1000 个文档(setMany, merge)")
    const docsToUpdate: any[] = []
    for (let i = 0; i < 1000; i++) {
        docsToUpdate.push({
            id: `id_${i}`,
            name: `setmany_name_${i}`,
            buffer: Buffer.from(`buffer_data_${i}`).buffer,
            tags: [`setmany_tag_${i % 3}`],
            ob: {
                a: i,
                b: `name_${i}`,
                ob2: {
                    aa: i,
                    bb: i,
                    cc: `name_${i}`,
                    ob3: {
                        aaa: 1 * 100,
                        bbb: `name_${i}_nested`,
                    },
                },
            },
        })
    }
    let sw = stopwatch(true)
    await table.setMany(docsToUpdate)
    let time = sw()
    console.log(`[setMany]: ${readableMs(time)}`)
    testItems.push({ title: `setMany(1000 docs, merge) x 1`, time: time, avg: time / 1000 })
}
{
    // 批量遍历
    console.log("\n遍历表... (eachBatch)")
    let sw = stopwatch(true)
    let total = 0
    await table.eachBatch({}, { pageSize: 100 }, async (list) => {
        total += list.length
    })
    let time = sw()
    console.log(`[eachBatch]: ${readableMs(time)}`)
    console.log(`遍历总数: ${total}`)
    testItems.push({ title: `eachBatch ${DATA_SIZE}`, time: time, avg: time / total })
}

{
    // 删除 1000 个文档
    const idsToDelete: any[] = []
    console.log("\n删除 1000 个文档")
    for (let i = 0; i < 1000; i++) {
        idsToDelete.push(i)
    }
    let sw = stopwatch(true)
    await table.deleteMany({ id: { $in: idsToDelete } })
    let time = sw()
    console.log(`[deleteMany]: ${readableMs(time)}`)
    testItems.push({ title: `deleteMany 1000 docs`, time: time, avg: time / 1000 })
}

{
    // 查询表数量 2
    console.log("\n查询表数量 2...")
    let sw = stopwatch(true)
    let count = await table.count()
    let time = sw()
    console.log(`[count]: ${readableMs(time)}`)
    console.log(`表数量: ${count}`)
    testItems.push({ title: `查询表数量 2`, time: time, avg: time })
}

// 输出结果'

console.log(`\n结果汇总: ${table.adapter.name}`)
if (testItems.length === 0) {
    console.log("无测试项")
} else {
    const rows = testItems.map((t) => ({
        Title: t.title,
        Time: readableMs(t.time).padStart(10),
        Avg: t.avg.toFixed(5).padStart(10),
    }))
    console.table(rows)
}

console.log("Done.")

await table.close()
process.exit(0)

/*
结果汇总: SQLiteAdapter
┌─────────┬─────────────────────────────────┬──────────────┬──────────────┐
│ (index) │ Title                           │ Time         │ Avg          │
├─────────┼─────────────────────────────────┼──────────────┼──────────────┤
│ 0       │ '插入 50000 个文档'             │ '  125.92ms' │ '   0.00252' │
│ 1       │ '查询表数量'                    │ '    0.16ms' │ '   0.16000' │
│ 2       │ 'findMany(200 ids) x 1'         │ '    5.24ms' │ '   5.24000' │
│ 3       │ 'findMany(200 $lt,$gte) x 1'    │ '   12.45ms' │ '  12.45000' │
│ 4       │ 'updateOne x 1000'              │ '   31.43ms' │ '   0.03143' │
│ 5       │ 'bulkUpdate(1000 docs) x 1'     │ '   27.08ms' │ '   0.02708' │
│ 6       │ 'setMany(1000 docs) x 1'        │ '   72.34ms' │ '   0.07234' │
│ 7       │ 'setMany(1000 docs, merge) x 1' │ '   65.17ms' │ '   0.06517' │
│ 8       │ 'eachBatch 50000'               │ '  142.01ms' │ '   0.00284' │
│ 9       │ 'deleteMany 1000 docs'          │ '    1.06ms' │ '   0.00106' │
│ 10      │ '查询表数量 2'                  │ '    0.09ms' │ '   0.09000' │
└─────────┴─────────────────────────────────┴──────────────┴──────────────┘


结果汇总: SQLiteAdapter (safe:true)
┌─────────┬─────────────────────────────────┬──────────────┬──────────────┐
│ (index) │ Title                           │ Time         │ Avg          │
├─────────┼─────────────────────────────────┼──────────────┼──────────────┤
│ 0       │ '插入 50000 个文档'             │ '  145.83ms' │ '   0.00292' │
│ 1       │ '查询表数量'                    │ '    0.22ms' │ '   0.22000' │
│ 2       │ 'findMany(200 ids) x 1'         │ '    5.86ms' │ '   5.86000' │
│ 3       │ 'findMany(200 $lt,$gte) x 1'    │ '   13.34ms' │ '  13.34000' │
│ 4       │ 'updateOne x 1000'              │ '   51.99ms' │ '   0.05199' │
│ 5       │ 'bulkUpdate(1000 docs) x 1'     │ '   35.70ms' │ '   0.03570' │
│ 6       │ 'setMany(1000 docs) x 1'        │ '  107.98ms' │ '   0.10798' │
│ 7       │ 'setMany(1000 docs, merge) x 1' │ '   83.18ms' │ '   0.08318' │
│ 8       │ 'eachBatch 50000'               │ '  149.78ms' │ '   0.00300' │
│ 9       │ 'deleteMany 1000 docs'          │ '    1.21ms' │ '   0.00121' │
│ 10      │ '查询表数量 2'                  │ '    0.11ms' │ '   0.11000' │
└─────────┴─────────────────────────────────┴──────────────┴──────────────┘


结果汇总: SQLiteAdapter (safe:'full')
┌─────────┬─────────────────────────────────┬──────────────┬──────────────┐
│ (index) │ Title                           │ Time         │ Avg          │
├─────────┼─────────────────────────────────┼──────────────┼──────────────┤
│ 0       │ '插入 50000 个文档'             │ '  138.98ms' │ '   0.00278' │
│ 1       │ '查询表数量'                    │ '    0.15ms' │ '   0.15000' │
│ 2       │ 'findMany(200 ids) x 1'         │ '    5.28ms' │ '   5.28000' │
│ 3       │ 'findMany(200 $lt,$gte) x 1'    │ '   12.36ms' │ '  12.36000' │
│ 4       │ 'updateOne x 1000'              │ '   57.09ms' │ '   0.05709' │
│ 5       │ 'bulkUpdate(1000 docs) x 1'     │ '   53.87ms' │ '   0.05387' │
│ 6       │ 'setMany(1000 docs) x 1'        │ '  123.04ms' │ '   0.12304' │
│ 7       │ 'setMany(1000 docs, merge) x 1' │ '   97.11ms' │ '   0.09711' │
│ 8       │ 'eachBatch 50000'               │ '  139.68ms' │ '   0.00279' │
│ 9       │ 'deleteMany 1000 docs'          │ '    1.04ms' │ '   0.00104' │
│ 10      │ '查询表数量 2'                  │ '    0.10ms' │ '   0.10000' │
└─────────┴─────────────────────────────────┴──────────────┴──────────────┘


结果汇总: MongoDBAdapter
┌─────────┬─────────────────────────────────┬──────────────┬──────────────┐
│ (index) │ Title                           │ Time         │ Avg          │
├─────────┼─────────────────────────────────┼──────────────┼──────────────┤
│ 0       │ '插入 50000 个文档'             │ '  307.88ms' │ '   0.00616' │
│ 1       │ '查询表数量'                    │ '   13.61ms' │ '  13.61000' │
│ 2       │ 'findMany(200 ids) x 1'         │ '   14.58ms' │ '  14.58000' │
│ 3       │ 'findMany(200 $lt,$gte) x 1'    │ '   11.01ms' │ '  11.01000' │
│ 4       │ 'updateOne x 1000'              │ '  320.51ms' │ '   0.32051' │
│ 5       │ 'bulkUpdate(1000 docs) x 1'     │ '  128.43ms' │ '   0.12843' │
│ 6       │ 'setMany(1000 docs) x 1'        │ '  392.09ms' │ '   0.39209' │
│ 7       │ 'setMany(1000 docs, merge) x 1' │ '  775.90ms' │ '   0.77590' │
│ 8       │ 'eachBatch 50000'               │ '  237.39ms' │ '   0.00475' │
│ 9       │ 'deleteMany 1000 docs'          │ '    9.62ms' │ '   0.00962' │
│ 10      │ '查询表数量 2'                  │ '    7.11ms' │ '   7.11000' │
└─────────┴─────────────────────────────────┴──────────────┴──────────────┘

 
 */
