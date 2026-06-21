import { Bench } from "tinybench"
import chalk from "chalk"
import { mkdirSync, rmSync, writeFileSync } from "fs"
import { resolve } from "path"
import { TableTree } from "../../TableTree"
import type { ITreeNode } from "../../tree.types"
import type { ITableDBAdapter } from "../../../../adapter/adapter"
import { SQLiteAdapter } from "../../../../adapter/SQLite"
import { MongoDBAdapter } from "../../../../adapter/MongoDB"

interface IBenchTreeNode extends ITreeNode {
    tag?: string
    meta?: {
        group?: string
        batch?: number
    }
}

interface IAdapterBenchConfig {
    key: "sqlite" | "mongodb"
    name: string
    enabled: boolean
    createAdapter: (scenarioName: string) => ITableDBAdapter
    cleanup: (scenarioName: string) => Promise<void> | void
}

interface ITreeFixtureOptions {
    rootCount?: number
    dirsPerRoot?: number
    filesPerDir?: number
    rootFilesPerRoot?: number
}

interface ITreeFixture {
    rootIds: string[]
    firstRootId: string
    secondRootId: string
    firstDirId: string
    firstFileIds: string[]
}

interface IAdapterBenchContext {
    config: IAdapterBenchConfig
    readTable: TableTree<IBenchTreeNode>
    readFixture: ITreeFixture
    writeTable: TableTree<IBenchTreeNode>
    writeFixture: ITreeFixture
    moveTable: TableTree<IBenchTreeNode>
    moveFixture: ITreeFixture
    copyTable: TableTree<IBenchTreeNode>
    copyFixture: ITreeFixture
    overwriteTable: TableTree<IBenchTreeNode>
    overwriteFixture: ITreeFixture
    syncTable: TableTree<IBenchTreeNode>
    syncFixture: ITreeFixture
    deleteTable: TableTree<IBenchTreeNode>
    deleteFixture: ITreeFixture
    counters: Record<string, number>
}

interface IBenchmarkReport {
    adapterName: string
    table: Record<string, string | number | undefined>[]
}

const BENCH_DIR = resolve(process.cwd(), "dist/table-tree-benchmark")
const REPORT_FILE = resolve(process.cwd(), "src/extension/tree/test/benchmark/benchmark.md")
const BENCH_TIME = Number(process.env.TABLE_TREE_BENCH_TIME ?? 500)
const DEFAULT_ADAPTERS = ["sqlite"]
const REQUESTED_ADAPTERS = parseRequestedAdapters()
const adapterConfigs = createAdapterConfigs()
const openedTables: TableTree<IBenchTreeNode>[] = []

run().catch((error) => {
    console.error(chalk.red("TableTree benchmark 运行失败"))
    console.error(error)
    process.exitCode = 1
})

async function run() {
    mkdirSync(BENCH_DIR, { recursive: true })

    const enabledConfigs = adapterConfigs.filter((config) => config.enabled)
    if (enabledConfigs.length === 0) {
        throw new Error("没有可用的 TableTree benchmark adapter")
    }

    const reports: IBenchmarkReport[] = []
    try {
        for (const config of enabledConfigs) {
            const context = await createAdapterBenchContext(config)
            reports.push(await runAdapterBenchmarks(context))
        }
        writeBenchmarkReport(reports)
    } finally {
        await closeOpenedTables()
    }
}

async function runAdapterBenchmarks(context: IAdapterBenchContext): Promise<IBenchmarkReport> {
    const bench = new Bench({ time: BENCH_TIME })
    const adapterName = context.config.name

    console.log(chalk.blue(`\n开始运行 ${adapterName} TableTree benchmark，单项时长 ${BENCH_TIME}ms`))

    bench.add(`[${adapterName}] 读取性能：listNodes 分页 + total`, async () => {
        await context.readTable.listNodes(context.readFixture.firstRootId, {
            pageIndex: 1,
            pageSize: 50,
            getTotal: true,
        })
    })

    bench.add(`[${adapterName}] 读取性能：listNodes 深分页`, async () => {
        await context.readTable.listNodes(context.readFixture.firstRootId, {
            pageIndex: 3,
            pageSize: 10,
            sort: { index: 1 },
        })
    })

    bench.add(`[${adapterName}] 读取性能：listNodesByCursor 游标分页`, async () => {
        await context.readTable.listNodesByCursor(context.readFixture.firstRootId, {
            pageSize: 50,
            sortKey: "id",
            sortOrder: 1,
        })
    })

    bench.add(`[${adapterName}] 读取性能：过滤 + 排序 + 投影`, async () => {
        await context.readTable.listNodes(context.readFixture.firstRootId, {
            pageSize: 30,
            onlyTypes: ["text"],
            filter: { tag: "keep" },
            sort: { name: -1 },
            projection: ["id", "name", "type", "tag"],
        })
    })

    bench.add(`[${adapterName}] 写入性能：createNodes 批量新增`, async () => {
        const batch = nextCounter(context, "create")
        await context.writeTable.createNodes(makeFiles(`create-${batch}`, 20), context.writeFixture.firstRootId, {
            index: { toEnd: true },
        })
    })

    bench.add(`[${adapterName}] 写入性能：setNodes 批量新增`, async () => {
        const batch = nextCounter(context, "set-insert")
        await context.writeTable.setNodes(makeFiles(`set-insert-${batch}`, 20, context.writeFixture.secondRootId), {
            index: { toEnd: true },
        })
    })

    bench.add(`[${adapterName}] 写入性能：setNodes 批量更新`, async () => {
        const batch = nextCounter(context, "set-update")
        await context.writeTable.setNodes(
            context.writeFixture.firstFileIds.slice(0, 20).map((id, index) => ({
                id,
                parentId: context.writeFixture.firstDirId,
                name: `更新文件-${index}.txt`,
                isDir: false,
                size: 100 + batch + index,
                tag: "updated",
            })),
            { returnChangedNodesIds: true },
        )
    })

    bench.add(`[${adapterName}] 写入性能：updateNodes 条件更新`, async () => {
        const batch = nextCounter(context, "update")
        await context.writeTable.updateNodes(
            { parentId: context.writeFixture.firstDirId, type: "text" },
            { $set: { tag: batch % 2 === 0 ? "keep" : "drop" } },
        )
    })

    bench.add(`[${adapterName}] 树结构变更：moveNodes 单节点移动`, async () => {
        const batch = nextCounter(context, "move")
        const nodeId = context.moveFixture.firstFileIds[batch % context.moveFixture.firstFileIds.length]
        const node = await context.moveTable.get(nodeId, { ignoreMarkDelete: true })
        const targetParentId = node?.parentId === context.moveFixture.firstDirId
            ? context.moveFixture.secondRootId
            : context.moveFixture.firstDirId
        await context.moveTable.moveNodes([nodeId], targetParentId, { index: { toEnd: true } })
    })

    bench.add(`[${adapterName}] 树结构变更：copyNodes 深度复制`, async () => {
        await context.copyTable.copyNodes([context.copyFixture.firstDirId], context.copyFixture.secondRootId, {
            deep: true,
            renameOnCopy: true,
            index: { toEnd: true },
        })
    })

    bench.add(`[${adapterName}] 覆盖与同步：preOverwriteNodes 预覆盖检测`, async () => {
        await context.overwriteTable.preOverwriteNodes(
            [{ id: "virtual-conflict", name: "固定冲突.txt", parentId: context.overwriteFixture.firstRootId }],
            [],
            context.overwriteFixture.firstRootId,
            { uniqueBy: "name", projection: ["id", "name"] },
        )
    })

    bench.add(`[${adapterName}] 覆盖与同步：setNodes overwrite replace`, async () => {
        const batch = nextCounter(context, "overwrite-replace")
        const name = `replace-${batch}.txt`
        await context.overwriteTable.createNodes([makeFile(`replace-target-${batch}`, name)], context.overwriteFixture.firstRootId)
        await context.overwriteTable.setNodes(
            [makeFile(`replace-source-${batch}`, name, context.overwriteFixture.firstRootId)],
            { uniqueBy: "name", overwriteMode: "replace" },
        )
    })

    bench.add(`[${adapterName}] 覆盖与同步：setNodes overwrite skip`, async () => {
        const batch = nextCounter(context, "overwrite-skip")
        const name = `skip-${batch}.txt`
        await context.overwriteTable.createNodes([makeFile(`skip-target-${batch}`, name)], context.overwriteFixture.firstRootId)
        await context.overwriteTable.setNodes(
            [makeFile(`skip-source-${batch}`, name, context.overwriteFixture.firstRootId)],
            { uniqueBy: "name", overwriteMode: "skip" },
        )
    })

    bench.add(`[${adapterName}] 覆盖与同步：setNodes overwrite merge`, async () => {
        const batch = nextCounter(context, "overwrite-merge")
        const name = `merge-${batch}`
        await context.overwriteTable.createNodes([makeDir(`merge-target-${batch}`, name)], context.overwriteFixture.firstRootId)
        await context.overwriteTable.setNodes(
            [makeDir(`merge-source-${batch}`, name, context.overwriteFixture.firstRootId)],
            { uniqueBy: "name", overwriteMode: "merge" },
        )
    })

    bench.add(`[${adapterName}] 覆盖与同步：setNodes overwrite newName`, async () => {
        const batch = nextCounter(context, "overwrite-new-name")
        const name = `new-name-${batch}.txt`
        await context.overwriteTable.createNodes([makeFile(`new-name-target-${batch}`, name)], context.overwriteFixture.firstRootId)
        await context.overwriteTable.setNodes(
            [makeFile(`new-name-source-${batch}`, name, context.overwriteFixture.firstRootId)],
            { uniqueBy: "name", overwriteMode: "newName" },
        )
    })

    bench.add(`[${adapterName}] 覆盖与同步：presyncNodes`, async () => {
        await context.syncTable.presyncNodes([
            ...context.syncFixture.firstFileIds.slice(0, 20).map((id) => ({ id, modif: 0, cmodif: 0 })),
            { id: "missing-sync-node", modif: 1 },
        ])
    })

    bench.add(`[${adapterName}] 覆盖与同步：setNodes presync`, async () => {
        const batch = nextCounter(context, "set-presync")
        await context.syncTable.setNodes(
            context.syncFixture.firstFileIds.slice(0, 10).map((id, index) => ({
                id,
                parentId: context.syncFixture.firstDirId,
                name: `预同步更新-${index}.txt`,
                isDir: false,
                size: batch + index,
                oldModif: 0,
                oldCmodif: 0,
            } as Partial<IBenchTreeNode> & { oldModif: number; oldCmodif: number })),
            { presync: true, returnChangedNodesIds: true },
        )
    })

    bench.add(`[${adapterName}] 删除恢复：deleteNodes 递归标记删除`, async () => {
        const nodeId = await createDisposableDir(
            context.deleteTable,
            context.deleteFixture.secondRootId,
            "mark-delete",
            nextCounter(context, "delete"),
        )
        await context.deleteTable.deleteNodes([nodeId])
    })

    bench.add(`[${adapterName}] 删除恢复：unDeleteNodes 恢复标记删除`, async () => {
        const nodeId = await createDisposableDir(
            context.deleteTable,
            context.deleteFixture.secondRootId,
            "undelete",
            nextCounter(context, "undelete"),
        )
        await context.deleteTable.deleteNodes([nodeId])
        await context.deleteTable.unDeleteNodes([nodeId])
    })

    bench.add(`[${adapterName}] 删除恢复：deleteNodes realDelete 物理删除`, async () => {
        const nodeId = await createDisposableDir(
            context.deleteTable,
            context.deleteFixture.secondRootId,
            "real-delete",
            nextCounter(context, "real-delete"),
        )
        await context.deleteTable.deleteNodes([nodeId], { realDelete: true })
    })

    await bench.run()
    console.log(chalk.green(`\n${adapterName} TableTree benchmark 结果`))
    const table = bench.table().filter((row): row is Record<string, string | number | undefined> => row !== null)
    console.table(table)

    return {
        adapterName,
        table,
    }
}

/** 每次运行都导出最新 benchmark.md，便于后续根据历史结果做性能优化判断。 */
function writeBenchmarkReport(reports: IBenchmarkReport[]) {
    const lines: string[] = [
        "# TableTree Benchmark",
        "",
        `- 生成时间：${new Date().toISOString()}`,
        `- 单项时长：${BENCH_TIME}ms`,
        `- 运行 Adapter：${reports.map((report) => report.adapterName).join(", ")}`,
        `- SQLite 文件目录：\`${BENCH_DIR}\``,
        `- 运行命令：\`bun run bench:tree\` 或 \`bun run bench:tree:all\``,
        "",
    ]

    for (const report of reports) {
        lines.push(`## ${report.adapterName}`, "")
        lines.push(markdownTable(report.table), "")
    }

    writeFileSync(REPORT_FILE, `${lines.join("\n")}\n`, "utf8")
    console.log(chalk.green(`benchmark 结果已导出：${REPORT_FILE}`))
}

function markdownTable(rows: Record<string, string | number | undefined>[]): string {
    if (rows.length === 0) return "_没有 benchmark 结果_"

    const headers = Object.keys(rows[0])
    const tableLines = [
        `| ${headers.map(escapeMarkdownCell).join(" | ")} |`,
        `| ${headers.map(() => "---").join(" | ")} |`,
    ]

    for (const row of rows) {
        tableLines.push(`| ${headers.map((header) => escapeMarkdownCell(row[header])).join(" | ")} |`)
    }

    return tableLines.join("\n")
}

function escapeMarkdownCell(value: string | number | undefined): string {
    return String(value ?? "")
        .replaceAll("\\", "\\\\")
        .replaceAll("|", "\\|")
        .replaceAll("\n", "<br>")
}

function parseRequestedAdapters(): string[] {
    const raw = process.env.TABLE_TREE_BENCH_ADAPTERS
    if (!raw) return DEFAULT_ADAPTERS

    return raw
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
}

function createAdapterConfigs(): IAdapterBenchConfig[] {
    return [
        {
            key: "sqlite",
            name: "SQLite",
            enabled: REQUESTED_ADAPTERS.includes("sqlite"),
            createAdapter: (scenarioName) => {
                const filename = sqliteBenchFile(scenarioName)
                return SQLiteAdapter({ filename, driver: "better-sqlite3" })
            },
            cleanup: (scenarioName) => {
                rmSync(sqliteBenchFile(scenarioName), { force: true })
            },
        },
        {
            key: "mongodb",
            name: "MongoDB",
            enabled: REQUESTED_ADAPTERS.includes("mongodb"),
            createAdapter: () => MongoDBAdapter({
                auth: process.env.TABLE_TREE_BENCH_MONGO_AUTH ?? "mongodb://localhost:27017",
                dbName: process.env.TABLE_TREE_BENCH_MONGO_DB ?? "table_tree_bench",
            }),
            cleanup: () => {},
        },
    ]
}

/** 为单个 adapter 准备所有 benchmark 场景，确保读写类场景互不污染数据。 */
async function createAdapterBenchContext(config: IAdapterBenchConfig): Promise<IAdapterBenchContext> {
    console.log(chalk.cyan(`\n准备 ${config.name} TableTree benchmark 数据...`))

    const readTable = await createBenchTreeTable(config, "read")
    const writeTable = await createBenchTreeTable(config, "write")
    const moveTable = await createBenchTreeTable(config, "move")
    const copyTable = await createBenchTreeTable(config, "copy")
    const overwriteTable = await createBenchTreeTable(config, "overwrite")
    const syncTable = await createBenchTreeTable(config, "sync")
    const deleteTable = await createBenchTreeTable(config, "delete")

    const context: IAdapterBenchContext = {
        config,
        readTable,
        readFixture: await createTreeFixture(readTable),
        writeTable,
        writeFixture: await createTreeFixture(writeTable),
        moveTable,
        moveFixture: await createTreeFixture(moveTable),
        copyTable,
        copyFixture: await createTreeFixture(copyTable, { rootCount: 2, dirsPerRoot: 4, filesPerDir: 6 }),
        overwriteTable,
        overwriteFixture: await createOverwriteFixture(overwriteTable),
        syncTable,
        syncFixture: await createTreeFixture(syncTable),
        deleteTable,
        deleteFixture: await createTreeFixture(deleteTable, { rootCount: 2, dirsPerRoot: 4, filesPerDir: 6 }),
        counters: {},
    }

    console.log(chalk.green(`已准备 ${config.name} benchmark 数据`))
    return context
}

/** 创建真实 TableTree 表；SQLite 在这里会清理并重建 dist 下对应场景的数据库文件。 */
async function createBenchTreeTable(config: IAdapterBenchConfig, scenarioName: string): Promise<TableTree<IBenchTreeNode>> {
    await config.cleanup(scenarioName)
    const table = new TableTree<IBenchTreeNode>({
        name: `table_tree_bench_${config.key}_${scenarioName}`,
        adapter: config.createAdapter(scenarioName),
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
    openedTables.push(table)
    return table
}

/** 生成稳定的多层目录树 fixture，用于模拟真实文件树的分页、排序和元数据维护压力。 */
async function createTreeFixture(
    table: TableTree<IBenchTreeNode>,
    options: ITreeFixtureOptions = {},
): Promise<ITreeFixture> {
    const rootCount = options.rootCount ?? 4
    const dirsPerRoot = options.dirsPerRoot ?? 10
    const filesPerDir = options.filesPerDir ?? 12
    const rootFilesPerRoot = options.rootFilesPerRoot ?? 10

    const rootNodes = Array.from({ length: rootCount }, (_, index) => makeDir(`root-${index}`, `根目录-${index}`))
    await table.createNodes(rootNodes, "/", { index: { toEnd: true } })

    const firstFileIds: string[] = []
    for (let rootIndex = 0; rootIndex < rootCount; rootIndex++) {
        const rootId = `root-${rootIndex}`
        const rootFiles = Array.from({ length: rootFilesPerRoot }, (_, fileIndex) => {
            const id = `root-${rootIndex}-file-${fileIndex}`
            if (rootIndex === 0) firstFileIds.push(id)
            return makeFile(id, `根文件-${rootIndex}-${fileIndex}.txt`)
        })
        const dirNodes = Array.from({ length: dirsPerRoot }, (_, dirIndex) => {
            return makeDir(`root-${rootIndex}-dir-${dirIndex}`, `目录-${rootIndex}-${dirIndex}`)
        })
        await table.createNodes([...rootFiles, ...dirNodes], rootId, { index: { toEnd: true } })

        for (let dirIndex = 0; dirIndex < dirsPerRoot; dirIndex++) {
            const dirId = `root-${rootIndex}-dir-${dirIndex}`
            const fileNodes = Array.from({ length: filesPerDir }, (_, fileIndex) => {
                const id = `${dirId}-file-${fileIndex}`
                if (rootIndex === 0 && dirIndex === 0) firstFileIds.push(id)
                return makeFile(id, `文件-${rootIndex}-${dirIndex}-${fileIndex}.txt`)
            })
            await table.createNodes(fileNodes, dirId, { index: { toEnd: true } })
        }
    }

    return {
        rootIds: rootNodes.map((node) => node.id!),
        firstRootId: "root-0",
        secondRootId: rootCount > 1 ? "root-1" : "root-0",
        firstDirId: "root-0-dir-0",
        firstFileIds,
    }
}

/** 覆盖测试需要固定冲突节点，避免预覆盖检测 benchmark 没有命中样本。 */
async function createOverwriteFixture(table: TableTree<IBenchTreeNode>): Promise<ITreeFixture> {
    const fixture = await createTreeFixture(table, { rootCount: 2, dirsPerRoot: 4, filesPerDir: 6 })
    await table.createNodes([makeFile("fixed-conflict", "固定冲突.txt")], fixture.firstRootId)
    return fixture
}

/** 生成目录节点，统一补齐 TableTree 关心的基础字段。 */
function makeDir(id: string, name: string, parentId?: string): Partial<IBenchTreeNode> {
    return makeNode({
        id,
        parentId,
        name,
        isDir: true,
        type: "dir",
        size: 0,
    })
}

/** 生成文件节点，并附带 type/tag/meta 字段给过滤和投影 benchmark 使用。 */
function makeFile(id: string, name: string, parentId?: string): Partial<IBenchTreeNode> {
    return makeNode({
        id,
        parentId,
        name,
        isDir: false,
        type: "text",
        size: 10,
        tag: Number(id.length) % 2 === 0 ? "keep" : "drop",
        meta: {
            group: "bench",
            batch: id.length,
        },
    })
}

/** 生成一组同父级文件，主要用于批量写入和临时删除场景。 */
function makeFiles(prefix: string, count: number, parentId?: string): Partial<IBenchTreeNode>[] {
    return Array.from({ length: count }, (_, index) => makeFile(`${prefix}-${index}`, `${prefix}-${index}.txt`, parentId))
}

/** 统一创建节点默认值，避免各个 benchmark 场景重复补字段。 */
function makeNode(node: Partial<IBenchTreeNode>): Partial<IBenchTreeNode> {
    return {
        modif: Date.now(),
        size: 0,
        ...node,
    }
}

/** 创建一次性小子树，让删除/恢复类 benchmark 每轮都有真实可变更对象。 */
async function createDisposableDir(
    table: TableTree<IBenchTreeNode>,
    parentId: string,
    prefix: string,
    batch: number,
): Promise<string> {
    const dirId = `${prefix}-dir-${batch}`
    await table.createNodes([makeDir(dirId, `${prefix}-${batch}`)], parentId, { index: { toEnd: true } })
    await table.createNodes(makeFiles(`${prefix}-file-${batch}`, 5), dirId, { index: { toEnd: true } })
    return dirId
}

function nextCounter(context: IAdapterBenchContext, key: string): number {
    context.counters[key] = (context.counters[key] ?? 0) + 1
    return context.counters[key]
}

async function closeOpenedTables() {
    for (const table of openedTables) {
        try {
            await table.close()
        } catch {
            // benchmark 结束时尽力关闭连接；MongoDB 多表共享连接时重复关闭可以忽略。
        }
    }
}

function sqliteBenchFile(scenarioName: string): string {
    return resolve(BENCH_DIR, `sqlite-${scenarioName}.sqlite`)
}
