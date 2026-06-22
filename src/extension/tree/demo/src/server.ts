import chalk from "chalk"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { basename, dirname, extname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { TableTree } from "../../TableTree"
import type { ITreeIndexOptions, ITreeNode } from "../../tree.types"
import { SQLiteAdapter } from "../../../../adapter/SQLite"

interface DemoTreeNode extends ITreeNode {
    ext?: string
    owner?: string
}

interface DemoState {
    dbPath: string
    tree: TableTree<DemoTreeNode>
}

const DEMO_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)))
const DIST_DIR = resolve(DEMO_DIR, "dist")
const DEFAULT_DB_PATH = resolve(DIST_DIR, "test.db")
const PORT = Number(process.env.TABLE_TREE_DEMO_API_PORT ?? 5173)

let state: DemoState

async function main() {
    await mkdir(DIST_DIR, { recursive: true })
    state = await openTree(DEFAULT_DB_PATH)

    createServer(async (req, res) => {
        try {
            await handleRequest(req, res)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            json(res, 500, { error: message })
            console.error(chalk.red("[TableTree Demo] 请求失败"), error)
        }
    }).listen(PORT, "127.0.0.1", () => {
        console.log(chalk.cyan("[TableTree Demo] API 已启动:"), chalk.bold(`http://127.0.0.1:${PORT}`))
        console.log(chalk.gray("[TableTree Demo] 当前 DB:"), state.dbPath)
    })
}

async function openTree(dbPath: string): Promise<DemoState> {
    const filename = resolve(dbPath)
    await mkdir(dirname(filename), { recursive: true })
    const tree = new TableTree<DemoTreeNode>({
        name: "table_tree_demo_nodes",
        adapter: SQLiteAdapter({ filename, driver: "better-sqlite3", multi: true }),
        enableMarkDelete: false,
        enableAutoMetadata: true,
        indexes: [
            { key: "parentId" },
            { key: "index" },
            { key: { parentId: 1, index: 1 } },
            { key: { parentId: 1, name: 1 } },
            { key: "isDir" },
        ],
    })
    await tree.inited
    return { dbPath: filename, tree }
}

async function switchDb(dbPath: string) {
    const oldTree = state?.tree
    state = await openTree(dbPath)
    await oldTree?.close().catch(() => undefined)
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`)
    if (req.method === "OPTIONS") {
        writeCors(res)
        res.writeHead(204).end()
        return
    }

    if (url.pathname === "/api/status" && req.method === "GET") {
        const total = await state.tree.count({})
        json(res, 200, { dbPath: state.dbPath, exists: existsSync(state.dbPath), total })
        return
    }

    if (url.pathname === "/api/open" && req.method === "POST") {
        const body = await readJson<{ dbPath?: string }>(req)
        if (!body.dbPath) throw new Error("缺少 dbPath")
        await switchDb(body.dbPath)
        json(res, 200, { dbPath: state.dbPath, total: await state.tree.count({}) })
        return
    }

    if (url.pathname === "/api/upload-db" && req.method === "POST") {
        const rawName = String(req.headers["x-db-name"] ?? "uploaded.db")
        const safeName = basename(rawName).replace(/[^\w.-]/g, "_")
        const target = resolve(DIST_DIR, safeName || "uploaded.db")
        await writeFile(target, await readBody(req))
        await switchDb(target)
        json(res, 200, { dbPath: state.dbPath, total: await state.tree.count({}) })
        return
    }

    if (url.pathname === "/api/reset" && req.method === "POST") {
        const body = await readJson<{ count?: number }>(req)
        const count = Math.max(1_000, Math.min(body.count ?? 100_000, 120_000))
        const startedAt = performance.now()
        await createDefaultTree(count)
        json(res, 200, {
            dbPath: state.dbPath,
            total: await state.tree.count({}),
            ms: Math.round(performance.now() - startedAt),
        })
        return
    }

    if (url.pathname === "/api/nodes" && req.method === "GET") {
        const parentId = url.searchParams.get("parentId") ?? "/"
        const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") ?? 80), 300))
        const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0))
        const result = await state.tree.listNodes(parentId, { pageSize: limit, pageIndex: Math.floor(offset / limit) + 1 })
        json(res, 200, result)
        return
    }

    if (url.pathname.startsWith("/api/nodes/") && req.method === "GET") {
        const node = await state.tree.get(decodeURIComponent(url.pathname.slice("/api/nodes/".length)))
        json(res, 200, { node })
        return
    }

    if (url.pathname === "/api/nodes" && req.method === "POST") {
        const body = await readJson<Partial<DemoTreeNode> & { parentId?: string; userId?: string }>(req)
        const result = await state.tree.createNodes([{
            name: body.name || (body.isDir ? "新建文件夹" : "新建文件.txt"),
            isDir: body.isDir === true,
            size: body.isDir ? 0 : body.size ?? 1024,
            owner: body.userId,
            ext: body.ext ?? resolveExt(body.name),
        }], body.parentId ?? "/", { returnNewNodes: true, index: { toEnd: true } })
        json(res, 200, result)
        return
    }

    if (url.pathname.startsWith("/api/nodes/") && req.method === "PATCH") {
        const id = decodeURIComponent(url.pathname.slice("/api/nodes/".length))
        const body = await readJson<Partial<DemoTreeNode>>(req)
        const $set: Partial<DemoTreeNode> = {}
        if (body.name !== undefined) {
            $set.name = body.name
            $set.ext = resolveExt(body.name)
        }
        if (body.size !== undefined) $set.size = body.size
        if (body.owner !== undefined) $set.owner = body.owner
        const result = await state.tree.updateNodes({ id }, { $set } as any)
        json(res, 200, result)
        return
    }

    if (url.pathname.startsWith("/api/nodes/") && req.method === "DELETE") {
        const id = decodeURIComponent(url.pathname.slice("/api/nodes/".length))
        const result = await state.tree.deleteNodes([id], { realDelete: true })
        json(res, 200, result)
        return
    }

    if (url.pathname === "/api/move" && req.method === "POST") {
        const body = await readJson<{ nodeIds?: string[]; parentId?: string; index?: unknown }>(req)
        const result = await state.tree.moveNodes(body.nodeIds ?? [], body.parentId ?? "/", {
            index: normalizeMoveIndexOptions(body.index),
            overwriteMode: "newName",
            uniqueBy: "name",
        })
        json(res, 200, result)
        return
    }

    if (url.pathname === "/api/batch" && req.method === "POST") {
        const body = await readJson<{ userId?: string }>(req)
        const result = await runPresetOperations(body.userId ?? "user")
        json(res, 200, result)
        return
    }

    if (url.pathname === "/" || url.pathname.startsWith("/assets/")) {
        await serveBuiltFile(url.pathname, res)
        return
    }

    json(res, 404, { error: "Not Found" })
}

async function runPresetOperations(userId: string) {
    const batchRootName = `批量操作-${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`
    const rootResult = await state.tree.createNodes([{ name: batchRootName, isDir: true, owner: userId }], "/", {
        returnNewNodes: true,
        index: { toStart: true },
    })
    const root = rootResult.newNodes?.[0]
    if (!root) return { steps: ["创建批量目录失败"] }

    const createResult = await state.tree.createNodes([
        { name: "需求.md", isDir: false, size: 2048, owner: userId, ext: ".md" },
        { name: "设计稿.fig", isDir: false, size: 8192, owner: userId, ext: ".fig" },
        { name: "归档", isDir: true, owner: userId },
    ], root.id, { returnNewNodes: true, index: { toEnd: true } })

    const archive = createResult.newNodes?.find((node) => node.name === "归档")
    const doc = createResult.newNodes?.find((node) => node.name === "需求.md")
    if (archive && doc) {
        await state.tree.moveNodes([doc.id], archive.id, { index: { toEnd: true }, overwriteMode: "newName", uniqueBy: "name" })
        await state.tree.updateNodes({ id: doc.id }, { $set: { name: "需求-已整理.md", owner: userId } as any })
    }
    const fig = createResult.newNodes?.find((node) => node.name === "设计稿.fig")
    if (fig) {
        await state.tree.deleteNodes([fig.id], { realDelete: true })
    }

    return {
        rootId: root.id,
        steps: ["创建批量目录", "创建 3 个子节点", "移动需求文档到归档", "重命名需求文档", "删除设计稿示例文件"],
    }
}

async function createDefaultTree(targetCount: number) {
    console.log(chalk.yellow("[TableTree Demo] 正在生成默认目录树..."), chalk.gray(`${targetCount} nodes`))
    await recreateDefaultDemoDb()

    const topDirCount = 100
    const subDirPerTop = 20
    const fixedDirCount = topDirCount + topDirCount * subDirPerTop
    const fileCount = Math.max(1, targetCount - fixedDirCount)
    const baseFilePerSub = Math.floor(fileCount / (topDirCount * subDirPerTop))
    let remainFiles = fileCount % (topDirCount * subDirPerTop)
    let writtenCount = 0
    const topBatchSize = 10

    // 示例数据必须经过 TableTree 接口写入，让 TableTree 自己维护分数 index 和目录元数据。
    // setNodes 支持同批次父子节点；按多个顶层项目分批可把 2000+ 次 createNodes 降到 10 次左右。
    for (let batchStart = 0; batchStart < topDirCount; batchStart += topBatchSize) {
        const nodes: Partial<DemoTreeNode>[] = []
        const batchEnd = Math.min(batchStart + topBatchSize, topDirCount)

        for (let top = batchStart; top < batchEnd; top++) {
            const topId = `dir-${pad(top)}`
            nodes.push({
                id: topId,
                parentId: "/",
                name: `项目-${pad(top)}`,
                isDir: true,
                type: "dir",
                size: 0,
            })

            nodes.push(...Array.from({ length: subDirPerTop }, (_, sub) => ({
                id: `${topId}-sub-${pad(sub)}`,
                parentId: topId,
                name: `子目录-${pad(sub)}`,
                isDir: true,
                type: "dir",
                size: 0,
            })))

            for (let sub = 0; sub < subDirPerTop; sub++) {
                const subId = `${topId}-sub-${pad(sub)}`
                const currentFileCount = baseFilePerSub + (remainFiles-- > 0 ? 1 : 0)
                nodes.push(...Array.from({ length: currentFileCount }, (_, file) => {
                    const size = 512 + ((top * 97 + sub * 31 + file * 17) % 98_000)
                    return {
                        id: `${subId}-file-${pad(file)}`,
                        parentId: subId,
                        name: `文件-${pad(top)}-${pad(sub)}-${pad(file)}.txt`,
                        isDir: false,
                        type: "file",
                        size,
                        ext: ".txt",
                    }
                }))
            }
        }

        await state.tree.setNodes(nodes, { index: { toEnd: true } })
        writtenCount += nodes.length
        console.log(chalk.gray(`  TableTree 写入 ${Math.min(writtenCount, targetCount)}/${targetCount}`))
    }
    console.log(chalk.green("[TableTree Demo] 默认目录树生成完成"), chalk.bold(String(writtenCount)))
}

async function recreateDefaultDemoDb() {
    const oldTree = state.tree
    await oldTree.close().catch(() => undefined)

    // “生成示例”是 demo 数据库初始化动作：重建默认 DB 文件，再让 TableTree.createNodes 负责全部树结构写入。
    await Promise.all([
        rm(DEFAULT_DB_PATH, { force: true }),
        rm(`${DEFAULT_DB_PATH}-wal`, { force: true }),
        rm(`${DEFAULT_DB_PATH}-shm`, { force: true }),
    ])
    state = await openTree(DEFAULT_DB_PATH)
}

function normalizeMoveIndexOptions(index: unknown): ITreeIndexOptions | undefined {
    if (!index || typeof index !== "object") return undefined
    const input = index as Record<string, unknown>
    const normalized: ITreeIndexOptions = {}

    // API 层只允许透传 TableTree 已定义的排序意图，不接受外部直接写入 index 值。
    if (typeof input.prevNodeId === "string") normalized.prevNodeId = input.prevNodeId
    if (typeof input.nextNodeId === "string") normalized.nextNodeId = input.nextNodeId
    if (input.toStart === true) normalized.toStart = true
    if (input.toEnd === true) normalized.toEnd = true

    return Object.keys(normalized).length > 0 ? normalized : undefined
}

function resolveExt(name?: string) {
    const ext = extname(name ?? "")
    return ext || undefined
}

function pad(value: number) {
    return String(value).padStart(6, "0")
}

async function serveBuiltFile(pathname: string, res: ServerResponse) {
    const distPath = resolve(DEMO_DIR, "dist-web", pathname === "/" ? "index.html" : pathname.slice(1))
    const data = await readFile(distPath)
    const contentType = distPath.endsWith(".js")
        ? "application/javascript"
        : distPath.endsWith(".css")
          ? "text/css"
          : "text/html; charset=utf-8"
    res.writeHead(200, { "content-type": contentType })
    res.end(data)
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
    const raw = await readBody(req)
    if (raw.length === 0) return {} as T
    return JSON.parse(raw.toString("utf8")) as T
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
}

function json(res: ServerResponse, status: number, data: unknown) {
    writeCors(res)
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
    res.end(JSON.stringify(data))
}

function writeCors(res: ServerResponse) {
    res.setHeader("access-control-allow-origin", "*")
    res.setHeader("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS")
    res.setHeader("access-control-allow-headers", "content-type,x-db-name")
}

main().catch((error) => {
    console.error(chalk.red("[TableTree Demo] 启动失败"), error)
    process.exitCode = 1
})
