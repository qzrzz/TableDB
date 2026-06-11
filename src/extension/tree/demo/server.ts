import { readFileSync, existsSync } from "fs"
import { join, extname } from "path"
import { SQLiteAdapter } from "../../../adapter/SQLite/SQLiteAdapter"
import { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"
import { createCollector, instrumentAdapter, withCollector, type ICallStats } from "./instrument"
import { seedTree } from "./seed"

const BunRT = (globalThis as any).Bun
const PORT = Number(process.env.PORT ?? 4812)
const DEMO_DIR = import.meta.dir ?? join(process.cwd(), "src/extension/tree/demo")
const PUBLIC_DIR = join(DEMO_DIR, "public")
const DB_FILE = join(DEMO_DIR, "data", "tree-demo.sqlite")

// ---------------------------------------------------------------------------
// 初始化 TableTree（SQLite 文件存储）
// ---------------------------------------------------------------------------

// 把 SQLiteAdapter 包一层，用于统计每个操作触发了多少次底层数据库命令
const adapter = instrumentAdapter(SQLiteAdapter({ filename: DB_FILE, safe: true }))

const table = new TableTree<ITreeNode>({
    name: "tree_demo",
    adapter,
    enableMarkDelete: true, // 让 deleteNodes 走“标记删除”，配合 unDeleteNodes 恢复
    enableAutoMetadata: true, // 自动维护 _createDate / _updateDate / _deleteDate
})

await table.inited

// 首次启动若为空库则灌入种子数据
const rootChildren = await table.listNodes("/", { pageSize: 1 })
if (rootChildren.list.length === 0) {
    await seedTree(table)
    console.log("[demo] 已写入种子目录树")
}

// ---------------------------------------------------------------------------
// API 调度表：每个 op 对应一个 TableTree 操作
// ---------------------------------------------------------------------------

type Handler = (body: any) => Promise<unknown>

const dispatch: Record<string, Handler> = {
    listNodes: (b) => table.listNodes(b.parentId, b.options),
    listAllNodes: (b) => table.listAllNodes(b.parentId, b.options),
    createNodes: (b) => table.createNodes(b.nodes, b.parentId, b.options),
    updateNodes: (b) => table.updateNodes(b.filter, b.updateOp, b.options),
    moveNodes: (b) => table.moveNodes(b.nodeIds, b.parentId, b.options),
    copyNodes: (b) => table.copyNodes(b.srcNodeIds, b.parentId, b.options),
    deleteNodes: (b) => table.deleteNodes(b.nodeIds, b.options),
    unDeleteNodes: (b) => table.unDeleteNodes(b.nodeIds),
    setNodes: (b) => table.setNodes(b.nodes, b.options),
    checkNodes: (b) => table.checkNodes(b.nodes, b.targetId, b.options),
    get: (b) => table.get(b.id),

    /** 列出被标记删除的节点（供“回收站”展示与恢复使用） */
    listDeleted: () =>
        table.findMany({ _isDeleted: true } as any, { ignoreMarkDelete: true, sort: { _deleteDate: -1 } }),

    /** 清空并重新灌入种子数据 */
    reset: async () => {
        await table.clearAll()
        await seedTree(table)
        return { seeded: true }
    },
}

function summarizeStats(collector: ICallStats, wallMs: number) {
    return {
        wallMs: Math.round(wallMs * 1000) / 1000,
        dbTimeMs: Math.round(collector.dbTimeMs * 1000) / 1000,
        totalDbCalls: collector.totalCalls,
        calls: collector.calls,
    }
}

// 把所有 API 请求串行化：保证统计准确，也避免 SQLite 写入争用
let queue: Promise<unknown> = Promise.resolve()
function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn)
    queue = run.then(
        () => undefined,
        () => undefined,
    )
    return run
}

async function handleApi(op: string, body: any) {
    const handler = dispatch[op]
    if (!handler) {
        return { status: 404, json: { ok: false, error: `未知操作: ${op}` } }
    }
    return runExclusive(async () => {
        const collector = createCollector()
        const start = performance.now()
        try {
            const result = await withCollector(collector, () => handler(body))
            return {
                status: 200,
                json: { ok: true, result, stats: summarizeStats(collector, performance.now() - start) },
            }
        } catch (e: any) {
            return {
                status: 200,
                json: {
                    ok: false,
                    error: e?.message ?? String(e),
                    stats: summarizeStats(collector, performance.now() - start),
                },
            }
        }
    })
}

// ---------------------------------------------------------------------------
// 静态资源
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
}

function serveStatic(pathname: string): Response {
    const rel = pathname === "/" ? "/index.html" : pathname
    const filePath = join(PUBLIC_DIR, rel)
    if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) {
        return new Response("Not Found", { status: 404 })
    }
    const body = readFileSync(filePath)
    return new Response(body, { headers: { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" } })
}

// ---------------------------------------------------------------------------
// 启动服务
// ---------------------------------------------------------------------------

BunRT.serve({
    port: PORT,
    async fetch(req: Request) {
        const url = new URL(req.url)
        if (url.pathname.startsWith("/api/")) {
            const op = url.pathname.slice("/api/".length)
            const body = req.method === "POST" ? await req.json().catch(() => ({})) : {}
            const { status, json } = await handleApi(op, body)
            return new Response(JSON.stringify(json), {
                status,
                headers: { "content-type": "application/json; charset=utf-8" },
            })
        }
        return serveStatic(url.pathname)
    },
})

console.log(`\n  TableTree 演示已启动 →  http://localhost:${PORT}\n  数据库文件: ${DB_FILE}\n`)
