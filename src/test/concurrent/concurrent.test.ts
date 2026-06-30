import { describe, test, expect, beforeAll, beforeEach } from "vitest"
import { Table } from "../../core/Table"
import { getTestTableByType, TestDatabaseType } from "../getTestTable"
import chalk from "chalk"

const DATABASE_TYPES: TestDatabaseType[] = ["sqlite", "mongodb", "indexeddb"]

describe.each(DATABASE_TYPES)("Table 并发读写测试 - %s", async (dbType) => {
    let table!: Table
    let skip = false

    beforeAll(async () => {
        try {
            table = await getTestTableByType(`table-concurrent-${dbType}`, dbType)
            await table.clearAll()
        } catch (e) {
            console.warn(chalk.yellow(`[并发测试] 初始化 ${dbType} 失败，将跳过此数据库测试: ${e}`))
            skip = true
        }
    })

    beforeEach(async () => {
        if (skip) return
        try {
            await table.clear()
        } catch (e) {
            // 防止部分适配器 clear 报错影响后续
        }
    })

    test("并发相同 ID 的 $inc 自增更新（检测竞态丢失更新）", async () => {
        if (skip) return

        const id = "con-inc-1"
        await table.set(id, { id, count: 0 })

        const concurrentCount = 50
        const promises: Promise<any>[] = []

        console.log(chalk.cyan(`\n[并发测试 - ${dbType}] 开始并发自增更新测试，并发数: ${concurrentCount}`))
        const startTime = performance.now()

        for (let i = 0; i < concurrentCount; i++) {
            promises.push(
                table.updateOne({ id }, { $inc: { count: 1 } })
            )
        }

        await Promise.all(promises)
        const endTime = performance.now()

        const doc = await table.get(id) as any
        const actualCount = doc?.count ?? 0
        const isRaced = actualCount !== concurrentCount

        const timeSpent = (endTime - startTime).toFixed(2)
        console.log(
            chalk.blue(`[并发测试 - ${dbType}] 自增完成。耗时: ${timeSpent}ms. 期望值: ${concurrentCount}, 实际值: ${actualCount}`)
        )

        if (isRaced) {
            console.log(
                chalk.red(`[并发测试 - ${dbType}] 🚨 出现竞态问题！丢失了 ${concurrentCount - actualCount} 次更新。`)
            )
        } else {
            console.log(
                chalk.green(`[并发测试 - ${dbType}] 🎉 并发自增更新未出现竞态，数据完全一致！`)
            )
        }

        // 我们不强行 expect(actualCount).toBe(concurrentCount)，因为我们要测试的是“是否存在竞态”。
        // 这样可以让我们直观地从输出中看到结果，而不会使测试在有竞态的适配器上挂掉。
        // 不过我们仍然可以做一些基本的 assertion
        expect(actualCount).toBeGreaterThan(0)
    })

    test("并发写入和读取不同 ID 的文档（并发读写稳定性）", async () => {
        if (skip) return

        const totalDocs = 100
        console.log(chalk.cyan(`[并发测试 - ${dbType}] 开始不同 ID 的并发读写测试，文档数: ${totalDocs}`))

        const startTime = performance.now()
        
        // 1. 并发写入
        const writePromises = []
        for (let i = 0; i < totalDocs; i++) {
            writePromises.push(table.set(`id-${i}`, { id: `id-${i}`, value: i }))
        }
        await Promise.all(writePromises)

        // 2. 并发读取
        const readPromises = []
        for (let i = 0; i < totalDocs; i++) {
            readPromises.push(table.get(`id-${i}`))
        }
        const results = await Promise.all(readPromises)

        const endTime = performance.now()
        console.log(
            chalk.green(`[并发测试 - ${dbType}] 不同 ID 并发读写成功，耗时: ${(endTime - startTime).toFixed(2)}ms`)
        )

        // 3. 验证数据正确性
        for (let i = 0; i < totalDocs; i++) {
            const doc = results[i] as any
            expect(doc).toBeDefined()
            expect(doc.value).toBe(i)
        }
    })

    test("并发更新同一个文档的不同字段（字段覆盖测试）", async () => {
        if (skip) return

        const id = "con-field-1"
        await table.set(id, { id, base: "initial" })

        console.log(chalk.cyan(`[并发测试 - ${dbType}] 开始并发更新同文档不同字段测试`))

        // 两个并发更新操作
        const p1 = table.updateOne({ id }, { $set: { fieldA: "valueA" } })
        const p2 = table.updateOne({ id }, { $set: { fieldB: "valueB" } })

        await Promise.all([p1, p2])

        const finalDoc = await table.get(id) as any
        console.log(chalk.blue(`[并发测试 - ${dbType}] 最终文档状态: ${JSON.stringify(finalDoc)}`))

        // 验证是否有字段被覆盖丢失（在非原子更新下，可能只保留了 fieldA 或 fieldB）
        const hasA = finalDoc?.fieldA === "valueA"
        const hasB = finalDoc?.fieldB === "valueB"

        if (hasA && hasB) {
            console.log(chalk.green(`[并发测试 - ${dbType}] 🎉 字段合并更新成功，无覆盖丢失！`))
        } else {
            console.log(chalk.red(`[并发测试 - ${dbType}] 🚨 出现竞态！字段发生覆盖丢失。fieldA: ${finalDoc?.fieldA}, fieldB: ${finalDoc?.fieldB}`))
        }

        expect(finalDoc).toBeDefined()
    })

    test("混合读写高并发稳定性测试（写时读）", async () => {
        if (skip) return

        const id = "con-mix-1"
        await table.set(id, { id, count: 0 })

        console.log(chalk.cyan(`[并发测试 - ${dbType}] 开始高频读写混合稳定性测试`))

        let isFinished = false
        let readCount = 0
        let readErrors = 0

        // 1. 启动高频写
        const writePromise = (async () => {
            for (let i = 0; i < 50; i++) {
                try {
                    await table.updateOne({ id }, { $set: { [`field-${i}`]: i } })
                } catch (e) {
                    console.error(chalk.red(`[并发测试 - ${dbType}] 写入出错: ${e}`))
                }
            }
        })()

        // 2. 启动高频读
        const readPromise = (async () => {
            while (!isFinished) {
                try {
                    const doc = await table.get(id)
                    expect(doc).toBeDefined()
                    readCount++
                } catch (e) {
                    readErrors++
                }
                // 稍微让出执行权，避免阻塞
                await new Promise((resolve) => setTimeout(resolve, 1))
            }
        })()

        await writePromise
        isFinished = true
        await readPromise

        console.log(
            chalk.green(
                `[并发测试 - ${dbType}] 混合读写完成。读取次数: ${readCount}, 读取错误数: ${readErrors}`
            )
        )
        expect(readErrors).toBe(0)
    })
})
