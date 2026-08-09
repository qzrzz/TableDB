import "./styles.css"

interface DemoNode {
    id: string
    parentId: string
    name: string
    isDir: boolean
    size: number
    ctotal?: number
    cftotal?: number
    csize?: number
    index?: string
    owner?: string
}

interface TreeWindow {
    id: string
    name: string
    expanded: Set<string>
    selectedId?: string
    loading: boolean
    error?: string
    children: Map<string, DemoNode[]>
}

const API = "http://127.0.0.1:5173"
const app = document.querySelector<HTMLDivElement>("#app")!
const windows: TreeWindow[] = []
let statusText = "正在连接后端..."
let currentDbPath = ""
let total = 0
let dragNode: { id: string; parentId: string } | undefined
let dragHint = "拖到节点上半部/下半部可排序；拖到文件夹中间可移动进去。"

addWindow("用户 A")
addWindow("用户 B")
void refreshStatus()
void Promise.all(windows.map((win) => loadChildren(win, "/")))

function render() {
    app.innerHTML = `
        <section class="topbar">
            <div>
                <h1>TableTree 多用户目录树 Demo</h1>
                <p>${statusText}</p>
            </div>
            <div class="top-actions">
                <input id="db-path" value="${escapeHtml(currentDbPath)}" placeholder="SQLite DB 文件路径，例如 dist/test.db" />
                <button id="open-db">载入 DB</button>
                <label class="upload">
                    上传 DB
                    <input id="upload-db" type="file" accept=".db,.sqlite,.sqlite3" />
                </label>
                <button id="reset-tree">生成 10 万示例</button>
                <button id="add-window">新增用户小窗</button>
            </div>
        </section>
        <section class="windows">
            ${windows.map(renderWindow).join("")}
        </section>
    `
    bindGlobalEvents()
    for (const win of windows) bindWindowEvents(win)
}

function renderWindow(win: TreeWindow) {
    return `
        <article class="window" data-window-id="${win.id}">
            <header class="window-head">
                <input class="user-name" value="${escapeHtml(win.name)}" aria-label="用户名" />
                <div class="window-actions">
                    <button data-action="batch">自动批量操作</button>
                    <button data-action="refresh">刷新</button>
                    <button data-action="close">关闭</button>
                </div>
            </header>
            <div class="create-row">
                <button data-action="new-dir">新建文件夹</button>
                <button data-action="new-file">新建文件</button>
                <span>${win.error ? `<b class="error">${escapeHtml(win.error)}</b>` : `${total.toLocaleString("zh-CN")} 个节点 · ${escapeHtml(dragHint)}`}</span>
            </div>
            <div class="tree">
                ${renderChildren(win, "/", 0)}
            </div>
        </article>
    `
}

function renderChildren(win: TreeWindow, parentId: string, depth: number): string {
    const children = win.children.get(parentId)
    if (!children) return depth === 0 ? `<button class="load-root" data-action="refresh">载入根目录</button>` : ""
    if (children.length === 0) return `<div class="empty" style="--depth:${depth}">空目录</div>`
    return children.map((node) => renderNode(win, node, depth)).join("")
}

function renderNode(win: TreeWindow, node: DemoNode, depth: number): string {
    const expanded = win.expanded.has(node.id)
    const selected = win.selectedId === node.id ? " selected" : ""
    const count = node.isDir ? `<span class="count">${node.ctotal ?? 0}</span>` : `<span class="size">${formatSize(node.size)}</span>`
    const indexText = node.index || "-"
    return `
        <div class="node${selected}" style="--depth:${depth}" draggable="true" data-node-id="${node.id}" data-parent-id="${node.parentId}">
            <button class="twisty" data-action="toggle" ${node.isDir ? "" : "disabled"}>${node.isDir ? (expanded ? "▾" : "▸") : "·"}</button>
            <span class="icon">${node.isDir ? "📁" : "📄"}</span>
            <span class="name" title="${escapeHtml(node.name)}">${escapeHtml(node.name)}</span>
            <code class="index" title="index: ${escapeHtml(indexText)}">${escapeHtml(shortIndex(indexText))}</code>
            ${count}
            <button data-action="rename">改名</button>
            <button data-action="delete">删除</button>
        </div>
        ${node.isDir && expanded ? `<div class="children">${renderChildren(win, node.id, depth + 1)}</div>` : ""}
    `
}

function bindGlobalEvents() {
    qs("#open-db")?.addEventListener("click", async () => {
        const dbPath = (qs<HTMLInputElement>("#db-path")?.value ?? "").trim()
        if (!dbPath) return
        await api("/api/open", { method: "POST", body: { dbPath } })
        resetAllWindows()
    })
    qs("#upload-db")?.addEventListener("change", async (event) => {
        const file = (event.target as HTMLInputElement).files?.[0]
        if (!file) return
        await fetch(`${API}/api/upload-db`, {
            method: "POST",
            headers: { "x-db-name": file.name },
            body: await file.arrayBuffer(),
        })
        resetAllWindows()
    })
    qs("#reset-tree")?.addEventListener("click", async () => {
        statusText = "正在生成 10 万级默认目录树，页面会在后端写完后刷新..."
        render()
        await api("/api/reset", { method: "POST", body: { count: 100_000 } })
        resetAllWindows()
    })
    qs("#add-window")?.addEventListener("click", () => {
        addWindow(`用户 ${String.fromCharCode(65 + windows.length)}`)
        render()
        void loadChildren(windows[windows.length - 1], "/")
    })
}

function bindWindowEvents(win: TreeWindow) {
    const root = app.querySelector<HTMLElement>(`[data-window-id="${win.id}"]`)
    if (!root) return
    root.querySelector<HTMLInputElement>(".user-name")?.addEventListener("input", (event) => {
        win.name = (event.target as HTMLInputElement).value || win.name
    })
    root.addEventListener("click", async (event) => {
        const target = event.target as HTMLElement
        const action = target.dataset.action
        if (!action) return
        const nodeEl = target.closest<HTMLElement>("[data-node-id]")
        const nodeId = nodeEl?.dataset.nodeId
        if (action === "close") {
            windows.splice(windows.indexOf(win), 1)
            render()
            return
        }
        if (action === "refresh") {
            await reloadWindow(win)
            return
        }
        if (action === "batch") {
            await api("/api/batch", { method: "POST", body: { userId: win.name } })
            await reloadWindow(win)
            return
        }
        if (action === "new-dir" || action === "new-file") {
            const parentId = win.selectedId && findNode(win, win.selectedId)?.isDir ? win.selectedId : "/"
            const isDir = action === "new-dir"
            const name = prompt(isDir ? "文件夹名称" : "文件名称", isDir ? "新建文件夹" : "新建文件.txt")
            if (!name) return
            await api("/api/nodes", { method: "POST", body: { parentId, name, isDir, userId: win.name } })
            win.expanded.add(parentId)
            await loadChildren(win, parentId, true)
            return
        }
        if (!nodeId) return
        win.selectedId = nodeId
        if (action === "toggle") {
            const node = findNode(win, nodeId)
            if (!node?.isDir) return
            if (win.expanded.has(nodeId)) win.expanded.delete(nodeId)
            else {
                win.expanded.add(nodeId)
                await loadChildren(win, nodeId)
            }
            render()
            return
        }
        if (action === "rename") {
            const node = findNode(win, nodeId)
            const name = prompt("新名称", node?.name ?? "")
            if (!name) return
            await api(`/api/nodes/${encodeURIComponent(nodeId)}`, { method: "PATCH", body: { name, owner: win.name } })
            await loadChildren(win, node?.parentId ?? "/", true)
            return
        }
        if (action === "delete") {
            const node = findNode(win, nodeId)
            if (!confirm(`确定删除 ${node?.name ?? nodeId} 及其子节点吗？`)) return
            await api(`/api/nodes/${encodeURIComponent(nodeId)}`, { method: "DELETE" })
            await loadChildren(win, node?.parentId ?? "/", true)
        }
    })
    root.addEventListener("dragstart", (event) => {
        const nodeEl = (event.target as HTMLElement).closest<HTMLElement>("[data-node-id]")
        if (!nodeEl) return
        dragNode = { id: nodeEl.dataset.nodeId!, parentId: nodeEl.dataset.parentId! }
        nodeEl.classList.add("dragging")
        dragHint = "拖动中：上半部=排到目标前面，下半部=排到目标后面，文件夹中间=移动进去。"
        event.dataTransfer?.setData("text/plain", dragNode.id)
        event.dataTransfer?.setDragImage(nodeEl, 16, 16)
        render()
    })
    root.addEventListener("dragover", (event) => {
        const targetEl = (event.target as HTMLElement).closest<HTMLElement>("[data-node-id]")
        if (!targetEl || !dragNode) return
        event.preventDefault()
        markDropTarget(win, targetEl, event.clientY)
    })
    root.addEventListener("drop", async (event) => {
        event.preventDefault()
        const targetEl = (event.target as HTMLElement).closest<HTMLElement>("[data-node-id]")
        if (!targetEl || !dragNode || dragNode.id === targetEl.dataset.nodeId) return
        const target = findNode(win, targetEl.dataset.nodeId!)
        if (!target) return
        const rect = targetEl.getBoundingClientRect()
        const y = event.clientY - rect.top
        const middleBand = rect.height * 0.35
        const moveToChild = target.isDir && y > middleBand && y < rect.height - middleBand
        const body = moveToChild
            ? { nodeIds: [dragNode.id], parentId: target.id, index: { toEnd: true } }
            : {
                nodeIds: [dragNode.id],
                parentId: target.parentId,
                index: y <= middleBand ? { nextNodeId: target.id } : { prevNodeId: target.id },
            }
        await api("/api/move", { method: "POST", body })
        if (moveToChild) win.expanded.add(target.id)
        dragHint = moveToChild
            ? `已移动到「${target.name}」目录。`
            : `已按 index 重新排序到「${target.name}」${y <= middleBand ? "之前" : "之后"}。`
        clearDropMarks(root)
        await reloadWindow(win)
        dragNode = undefined
    })
    root.addEventListener("dragleave", (event) => {
        if (!root.contains(event.relatedTarget as Node | null)) {
            clearDropMarks(root)
        }
    })
    root.addEventListener("dragend", () => {
        dragNode = undefined
        dragHint = "拖到节点上半部/下半部可排序；拖到文件夹中间可移动进去。"
        clearDropMarks(root)
        render()
    })
}

async function reloadWindow(win: TreeWindow) {
    const parents = new Set(["/", ...Array.from(win.expanded)])
    for (const parentId of parents) {
        await loadChildren(win, parentId, true)
    }
    await refreshStatus()
}

async function resetAllWindows() {
    await refreshStatus()
    for (const win of windows) {
        win.expanded.clear()
        win.children.clear()
        await loadChildren(win, "/", true)
    }
    render()
}

async function loadChildren(win: TreeWindow, parentId: string, force = false) {
    if (!force && win.children.has(parentId)) return
    win.loading = true
    win.error = undefined
    try {
        const result = await api<{ list: DemoNode[] }>(`/api/nodes?parentId=${encodeURIComponent(parentId)}&limit=300`)
        win.children.set(parentId, result.list)
    } catch (error) {
        win.error = error instanceof Error ? error.message : String(error)
    } finally {
        win.loading = false
        render()
    }
}

async function refreshStatus() {
    try {
        const status = await api<{ dbPath: string; total: number }>("/api/status")
        currentDbPath = status.dbPath
        total = status.total
        statusText = `当前 DB：${status.dbPath}`
    } catch (error) {
        statusText = `后端未连接：${error instanceof Error ? error.message : String(error)}`
    }
    render()
}

async function api<T>(path: string, options?: { method?: string; body?: unknown }): Promise<T> {
    const res = await fetch(`${API}${path}`, {
        method: options?.method ?? "GET",
        headers: options?.body ? { "content-type": "application/json" } : undefined,
        body: options?.body ? JSON.stringify(options.body) : undefined,
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? "请求失败")
    return data as T
}

function addWindow(name: string) {
    windows.push({
        id: crypto.randomUUID(),
        name,
        expanded: new Set(),
        loading: false,
        children: new Map(),
    })
}

function findNode(win: TreeWindow, nodeId: string) {
    for (const children of win.children.values()) {
        const node = children.find((item) => item.id === nodeId)
        if (node) return node
    }
}

function formatSize(size: number) {
    if (size > 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
    if (size > 1024) return `${(size / 1024).toFixed(1)} KB`
    return `${size} B`
}

function shortIndex(index: string) {
    if (index.length <= 12) return index
    return `${index.slice(0, 5)}…${index.slice(-5)}`
}

function markDropTarget(win: TreeWindow, targetEl: HTMLElement, clientY: number) {
    const root = targetEl.closest<HTMLElement>(".window")
    if (!root) return
    clearDropMarks(root)

    const target = findNode(win, targetEl.dataset.nodeId!)
    const rect = targetEl.getBoundingClientRect()
    const y = clientY - rect.top
    const middleBand = rect.height * 0.35

    // 用落点区域明确表达 TableTree 的 index 操作：前后排序或移动到目录内部。
    if (target?.isDir && y > middleBand && y < rect.height - middleBand) {
        targetEl.classList.add("drop-into")
        dragHint = `松手：移动到「${target.name}」目录内部`
    } else if (y <= middleBand) {
        targetEl.classList.add("drop-before")
        dragHint = `松手：排序到「${target?.name ?? "目标"}」之前`
    } else {
        targetEl.classList.add("drop-after")
        dragHint = `松手：排序到「${target?.name ?? "目标"}」之后`
    }
}

function clearDropMarks(root: ParentNode) {
    root.querySelectorAll(".drop-before, .drop-after, .drop-into, .dragging").forEach((node) => {
        node.classList.remove("drop-before", "drop-after", "drop-into", "dragging")
    })
}

function qs<T extends Element = Element>(selector: string) {
    return document.querySelector<T>(selector)
}

function escapeHtml(value: string) {
    return value.replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;",
    }[char]!))
}
