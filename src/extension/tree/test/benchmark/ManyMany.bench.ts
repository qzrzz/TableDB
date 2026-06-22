import { SQLiteAdapter } from "../../../../adapter/SQLite"
import { TableTree } from "../../TableTree"
import type { ITreeNode } from "../../tree.types"
import chalk from "chalk"
import assert from "node:assert/strict"

const __dirname = import.meta.dirname

async function run() {
    const table = new TableTree<ITreeNode>({
        name: "manymany_bench_table",
        adapter: SQLiteAdapter({ filename: `${__dirname}/dist/many_many_bench.db`, driver: "better-sqlite3" }),
        enableMarkDelete: true,
        indexes: [
            { key: "parentId" },
            { key: "type" },
            { key: "name" },
            { key: "index" },
            { key: { parentId: 1, index: 1 } },
        ],
    })

    await table.inited
    await table.clearAll()

    console.log(chalk.bold.magenta("\n=================================================="))
    console.log(chalk.bold.magenta("    TableTree 极限性能与正确性校验 (Node 脚本)"))
    console.log(chalk.bold.magenta("=================================================="))

    // 1. 创建 "/" 下 1 万个文件夹
    console.log(chalk.blue("1. 正在创建 '/' 下 10,000 个文件夹..."))
    const start1 = performance.now()
    const folders = Array.from({ length: 10000 }, (_, i) => ({
        id: `dir-${i}`,
        name: `dir-${i}`,
        isDir: true,
        parentId: "/",
    }))
    await table.createNodes(folders, "/")
    const end1 = performance.now()
    const time1 = end1 - start1
    console.log(chalk.green(`   -> 创建完成！耗时: ${time1.toFixed(2)}ms`))

    // 2. 每个文件夹下放入 100 个文件
    console.log(chalk.blue("2. 正在向每个文件夹放入 100 个文件 (共 1,000,000 个文件)..."))
    const start2 = performance.now()
    for (let i = 0; i < 10000; i++) {
        const parentId = `dir-${i}`
        const files = []
        for (let j = 0; j < 100; j++) {
            files.push({
                id: `file-${i}-${j}`,
                name: `file-${i}-${j}.txt`,
                parentId,
                isDir: false,
                size: 10,
            })
        }
        await table.createNodes(files, parentId)
        if ((i + 1) % 2000 === 0) {
            console.log(chalk.gray(`   - 已写入 ${(i + 1) * 100} 个文件 (已处理至第 ${i + 1} 个目录)...`))
        }
    }
    const end2 = performance.now()
    const time2 = end2 - start2
    console.log(chalk.green(`   -> 写入完成！耗时: ${time2.toFixed(2)}ms`))

    // 3. 在第一个文件夹下放入 100 层文件夹，每层 1 万个文件
    console.log(
        chalk.blue(
            "3. 正在在第一个文件夹 (dir-0) 下创建 100 层嵌套文件夹，每层 10,000 个文件 (共 1,000,000 个文件)...",
        ),
    )
    const start3 = performance.now()
    let currentParentId = "dir-0"
    for (let k = 1; k <= 100; k++) {
        const layerNodes = []
        // 每层 1 万个文件
        for (let j = 0; j < 10000; j++) {
            layerNodes.push({
                id: `file-layer-${k}-${j}`,
                name: `file-layer-${k}-${j}.txt`,
                parentId: currentParentId,
                isDir: false,
                size: 10,
            })
        }
        // 下一层文件夹
        if (k < 100) {
            layerNodes.push({
                id: `sub-dir-${k}`,
                name: `sub-dir-${k}`,
                parentId: currentParentId,
                isDir: true,
                size: 0,
            })
        }
        await table.createNodes(layerNodes, currentParentId)
        currentParentId = `sub-dir-${k}`
        if (k % 20 === 0) {
            console.log(chalk.gray(`   - 已创建嵌套到第 ${k} 层...`))
        }
    }
    const end3 = performance.now()
    const time3 = end3 - start3
    console.log(chalk.green(`   -> 嵌套创建完成！耗时: ${time3.toFixed(2)}ms`))

    // 验证初始状态正确性
    console.log(chalk.blue("正在验证初始数据状态与元数据统计..."))
    const dir0Before = await table.get("dir-0")
    assert.ok(dir0Before, "dir-0 节点不存在")
    // ctotal 应为 100 (第二步直接子文件) + 1,000,000 (第三步100层所有文件) + 99 (第三步99层文件夹) = 1,000,199
    // cftotal 应为 100 + 1,000,000 = 1,000,100
    assert.equal(dir0Before?.ctotal, 1000199, "直属及后代总数不符合预期")
    assert.equal(dir0Before?.cftotal, 1000100, "文件总数不符合预期")
    console.log(chalk.green("   -> 初始状态统计验证通过！"))

    // 4. 在第一个文件夹下每层文件夹中的文件中进行设置属性、重命名、删除操作 (100层)
    console.log(
        chalk.blue(
            "4. 正在对 100 层嵌套文件夹中的文件依次进行 设置属性、重命名、删除操作 (已批量优化以防止大量独立事务卡顿)...",
        ),
    )

    const targetFileIds = Array.from({ length: 100 }, (_, i) => `file-layer-${i + 1}-0`)

    // A. 设置属性
    const tAttrStart = performance.now()
    await table.updateNodes({ id: { $in: targetFileIds } }, { $set: { tag: "updated-tag" } })
    const attrTime = performance.now() - tAttrStart

    // 验证属性设置正确性
    for (const fileId of targetFileIds) {
        const file = await table.get(fileId)
        assert.equal(file?.tag, "updated-tag")
    }

    // B. 重命名
    const tRenameStart = performance.now()
    const renameUpdates = targetFileIds.map((id, index) => ({
        id,
        name: `renamed-file-${index + 1}.txt`,
    }))
    await table.setNodes(renameUpdates)
    const renameTime = performance.now() - tRenameStart

    // 验证重命名正确性
    for (let index = 0; index < 100; index++) {
        const file = await table.get(targetFileIds[index])
        assert.equal(file?.name, `renamed-file-${index + 1}.txt`)
    }

    // C. 删除操作
    const tDeleteStart = performance.now()
    await table.deleteNodes(targetFileIds)
    const deleteTime = performance.now() - tDeleteStart

    // 验证删除正确性
    for (const fileId of targetFileIds) {
        const file = await table.get(fileId)
        assert.equal(file, undefined)
    }

    console.log(chalk.green("   -> 操作及其正确性校验完成！"))

    // 5. 校验最终正确性
    console.log(chalk.blue("正在验证最终的元数据统计是否正确刷新..."))
    const dir0After = await table.get("dir-0")
    // 删除了 100 个文件后：
    // ctotal 应为 1,000,199 - 100 = 1,000,099
    // cftotal 应为 1,000,100 - 100 = 1,000,000
    assert.equal(dir0After?.ctotal, 1000099, "最终后代总数不符合预期")
    assert.equal(dir0After?.cftotal, 1000000, "最终文件总数不符合预期")
    console.log(chalk.green("   -> 最终状态统计验证通过！"))

    // 输出汇总报告
    console.log(chalk.bold.magenta("\n=================================================="))
    console.log(chalk.bold.magenta("                 极限性能试验报告"))
    console.log(chalk.bold.magenta("=================================================="))
    console.log(chalk.white(`1. 创建 '/' 下 10,000 个文件夹: `) + chalk.yellow(`${time1.toFixed(2)}ms`))
    console.log(chalk.white(`2. 每个文件夹下放 100 个文件 (共 100 万文件): `) + chalk.yellow(`${time2.toFixed(2)}ms`))
    console.log(
        chalk.white(`3. 第一个文件夹下放 100 层, 每层 1 万文件 (共 100 万文件): `) +
            chalk.yellow(`${time3.toFixed(2)}ms`),
    )
    console.log(chalk.white(`4. 100层节点 批量设置属性 总耗时: `) + chalk.yellow(`${attrTime.toFixed(2)}ms`))
    console.log(chalk.white(`5. 100层节点 批量重命名 总耗时: `) + chalk.yellow(`${renameTime.toFixed(2)}ms`))
    console.log(chalk.white(`6. 100层节点 批量删除 总耗时: `) + chalk.yellow(`${deleteTime.toFixed(2)}ms`))
    console.log(chalk.bold.magenta("==================================================\n"))

    await table.close()
}

run().catch((err) => {
    console.error(chalk.red("极限测试运行失败:"), err)
    process.exitCode = 1
})
