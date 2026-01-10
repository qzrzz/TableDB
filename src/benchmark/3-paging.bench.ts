import { Bench } from "tinybench"
import { createBenchTable, generateDoc, prepareTableData } from "./utils"

async function run() {
    // 遍历全表比较耗时，设置每个测试只跑 3 次
    const bench = new Bench({ iterations: 3 })

    const DATA_SIZE = 10000
    const PAGE_SIZE = 100 // 使用较小的页大小，会产生 500 次查询，放大 Skip/Limit 的性能劣势

    console.log(`Preparing data: ${DATA_SIZE} docs...`)
    const table = await createBenchTable("bench_paging_traversal", false)
    await prepareTableData(table, DATA_SIZE)
    console.log(`Data prepared.`)

    // --- 1. listPaging (Skip/Limit) 全表遍历 ---
    // 随着页码增加，OFFSET 越来越大，性能会呈线性下降 (O(N^2))
    bench.add("Traverse All - listPaging (Skip/Limit)", async () => {
        let pageIndex = 1
        while (true) {
            const re = await table.listPaging({}, { pageIndex, pageSize: PAGE_SIZE })
            if (re.list.length === 0) break
            if (!re.hasNext) break
            pageIndex++
        }
    })

    // --- 2. listPagingByCursor (Cursor) 全表遍历 ---
    // 使用 WHERE id > cursor，性能稳定 (O(N))
    bench.add("Traverse All - listPagingByCursor (Cursor)", async () => {
        let cursor = undefined
        while (true) {
            const re: any = await table.listPagingByCursor({}, { pageSize: PAGE_SIZE, cursor })
            if (re.list.length === 0) break
            if (!re.hasNext) break
            cursor = re.nextCursor
        }
    })

    // --- 3. eachBatch (Skip/Limit internally) 全表遍历 ---
    // 内部实现目前是基于 Skip/Limit 的，所以性能特征应与 listPaging 类似
    bench.add("Traverse All - eachBatch", async () => {
        await table.eachBatch({}, { pageSize: PAGE_SIZE }, async (list) => {
            // no-op
        })
    })

    console.log(`Running Traversal Benchmark (${DATA_SIZE} docs, pageSize=${PAGE_SIZE})...`)
    console.log("Note: Skip/Limit based methods will be significantly slower due to O(N^2) complexity.")

    await bench.run()

    console.table(bench.table())
}

run()
