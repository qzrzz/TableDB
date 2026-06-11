// ===========================================================================
// TableTree 目录树演示 —— 前端逻辑
//
// 通过 /api/* 调用服务端的 TableTree 方法，把每次调用的命令数与耗时打印到控制台。
// ===========================================================================

const ROOT = "/"

// ---- 全局状态 -------------------------------------------------------------
const state = {
    nodesById: new Map(), // id -> node 文档
    childIds: new Map(), // parentId -> [childId...]，顺序即展示顺序
    loaded: new Set(), // 已加载过子节点的 parentId（含 "/"）
    expanded: new Set(), // 处于展开状态的文件夹 id
    selectedId: null,
    clipboard: null, // { id, name, mode: "copy" | "cut" }
    agg: { ops: 0, cmds: 0, wall: 0 },
}

// ---- DOM ------------------------------------------------------------------
const $tree = document.getElementById("tree")
const $log = document.getElementById("log")
const $side = document.getElementById("sidePane")
const $ctx = document.getElementById("ctxMenu")
const $clip = document.getElementById("clipboardInfo")
const $showReads = document.getElementById("showReads")

// ===========================================================================
// API + 控制台日志
// ===========================================================================

/**
 * 调用一个后端 op。
 * @param category "op"=用户主动操作（高亮）  "read"=刷新/读取（淡显）
 */
async function api(op, body = {}, category = "op") {
    const res = await fetch(`/api/${op}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    })
    const json = await res.json()
    logEntry(op, body, json, category)
    if (!json.ok) throw new Error(json.error || "操作失败")
    return json.result
}

function argSummary(op, body) {
    switch (op) {
        case "listNodes":
        case "listAllNodes":
            return `parentId=${body.parentId}`
        case "createNodes":
            return `${body.nodes?.length ?? 0} 个节点 → ${body.parentId}`
        case "moveNodes":
            return `[${(body.nodeIds || []).join(", ")}] → ${body.parentId}`
        case "copyNodes":
            return `[${(body.srcNodeIds || []).join(", ")}] → ${body.parentId}`
        case "deleteNodes":
        case "unDeleteNodes":
            return `[${(body.nodeIds || []).join(", ")}]`
        case "updateNodes":
            return `${JSON.stringify(body.filter)} ${JSON.stringify(body.updateOp)}`
        case "checkNodes":
            return `${body.nodes?.length ?? 0} 个 → ${body.targetId}`
        case "get":
            return `id=${body.id}`
        default:
            return ""
    }
}

function logEntry(op, body, json, category) {
    if (category === "read" && !$showReads.checked) {
        // 即便不显示也要计入累计统计
        bumpAgg(json.stats, category)
        return
    }
    const s = json.stats || {}
    const callsStr = Object.entries(s.calls || {})
        .map(([k, v]) => `${k}×${v}`)
        .join(" ")
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false }) + "." + String(Date.now() % 1000).padStart(3, "0")

    const div = document.createElement("div")
    div.className = "entry" + (category === "read" ? " read" : "")
    const status = json.ok ? `<span class="ok">✓</span>` : `<span class="err">✗ ${escapeHtml(json.error || "")}</span>`
    div.innerHTML =
        `<span class="time">${time}</span> ` +
        `<span class="op">${op}</span>` +
        `<span class="args">(${escapeHtml(argSummary(op, body))})</span> ` +
        status +
        `  <span class="stat">耗时 ${fmtMs(s.wallMs)} · DB ${fmtMs(s.dbTimeMs)} · ${s.totalDbCalls ?? 0} 条命令</span>` +
        (callsStr ? `  <span class="calls">{${escapeHtml(callsStr)}}</span>` : "") +
        `<span class="detail">详情</span>`

    const pre = document.createElement("pre")
    pre.className = "hidden"
    pre.textContent = JSON.stringify(json.ok ? json.result : json, null, 2)
    div.querySelector(".detail").onclick = () => pre.classList.toggle("hidden")
    div.appendChild(pre)

    $log.appendChild(div)
    $log.scrollTop = $log.scrollHeight

    bumpAgg(s, category)
}

function bumpAgg(stats, category) {
    if (category === "op") state.agg.ops += 1
    state.agg.cmds += stats?.totalDbCalls ?? 0
    state.agg.wall += stats?.wallMs ?? 0
    document.getElementById("aggOps").textContent = state.agg.ops
    document.getElementById("aggCmds").textContent = state.agg.cmds
    document.getElementById("aggWall").textContent = Math.round(state.agg.wall * 100) / 100
}

// ===========================================================================
// 数据加载
// ===========================================================================

async function loadChildren(parentId, category = "op") {
    const result = await api("listNodes", { parentId, options: { pageSize: 1000 } }, category)
    const ids = []
    for (const node of result.list) {
        state.nodesById.set(node.id, node)
        ids.push(node.id)
    }
    state.childIds.set(parentId, ids)
    state.loaded.add(parentId)
    return ids
}

/** 重新加载已展开的父节点子列表，并刷新其祖先的统计字段。 */
async function refreshParents(parentIds) {
    const unique = new Set(parentIds)
    for (const pid of unique) {
        if (state.loaded.has(pid)) await loadChildren(pid, "read")
        await refreshAncestors(pid)
    }
    render()
    if (state.selectedId) renderSide(state.nodesById.get(state.selectedId))
}

/** 沿 parentId 链向上逐个 get，刷新祖先节点的统计字段展示。 */
async function refreshAncestors(parentId) {
    let cur = parentId
    while (cur && cur !== ROOT) {
        const node = await api("get", { id: cur }, "read")
        if (!node) break
        state.nodesById.set(node.id, node)
        cur = node.parentId
    }
}

// ===========================================================================
// 渲染
// ===========================================================================

function render() {
    $tree.innerHTML = ""
    renderLevel(ROOT, 0)
}

function renderLevel(parentId, depth) {
    const ids = state.childIds.get(parentId) || []
    for (const id of ids) {
        const node = state.nodesById.get(id)
        if (!node) continue
        $tree.appendChild(renderRow(node, depth))
        if (node.isDir && state.expanded.has(id) && state.loaded.has(id)) {
            renderLevel(id, depth + 1)
        }
    }
}

function renderRow(node, depth) {
    const row = document.createElement("div")
    row.className = "row" + (node.id === state.selectedId ? " selected" : "")
    row.dataset.id = node.id
    row.draggable = true
    row.style.paddingLeft = 8 + depth * 16 + "px"

    const isOpen = state.expanded.has(node.id)
    const caret = node.isDir ? (isOpen ? "▾" : "▸") : ""
    const icon = node.isDir ? (isOpen ? "📂" : "📁") : "📄"

    const badge = node.isDir
        ? `<span class="badge dir">${node.ctotal ?? 0} 项 · ${fmtBytes(node.csize ?? 0)}</span>`
        : `<span class="badge">${fmtBytes(node.size ?? 0)}</span>`

    row.innerHTML =
        `<span class="caret ${node.isDir ? "" : "leaf"}">${caret}</span>` +
        `<span class="icon">${icon}</span>` +
        `<span class="name">${escapeHtml(node.name)}</span>` +
        badge +
        (node.type && node.type !== "dir" ? `<span class="tag">.${escapeHtml(node.type)}</span>` : "")
    return row
}

function renderSide(node) {
    if (!node) {
        $side.innerHTML = `<div class="side-empty">点击左侧节点查看属性与操作</div>`
        return
    }
    const rows = [
        ["id", node.id],
        ["名称", node.name],
        ["类型", node.isDir ? "文件夹" : "文件" + (node.type ? ` (.${node.type})` : "")],
        ["parentId", node.parentId],
        ["size", fmtBytes(node.size ?? 0)],
        ["csize 子级大小", fmtBytes(node.csize ?? 0)],
        ["ctotal 子级数", node.ctotal ?? 0],
        ["cftotal 子级文件数", node.cftotal ?? 0],
        ["index 排序", node.index ?? "—"],
        ["modif 修改标记", node.modif ?? "—"],
    ]
    $side.innerHTML =
        `<div class="side-title">${node.isDir ? "📁" : "📄"} ${escapeHtml(node.name)}</div>` +
        rows.map(([k, v]) => `<div class="kv"><span class="k">${escapeHtml(String(k))}</span><span class="v">${escapeHtml(String(v))}</span></div>`).join("") +
        `<div class="side-actions">
            <button data-sa="rename">重命名</button>
            <button data-sa="size">修改体积</button>
            ${node.isDir ? `<button data-sa="newFile">新建文件</button><button data-sa="newFolder">新建文件夹</button>` : ""}
            <button data-sa="copy">复制</button>
            <button data-sa="cut">剪切</button>
            ${node.isDir && state.clipboard ? `<button data-sa="paste">粘贴到此</button>` : ""}
            <button data-sa="check">检查命名冲突</button>
            ${node.isDir ? `<button data-sa="listAll">列出全部子孙</button>` : ""}
            <button data-sa="delete" class="danger">删除</button>
        </div>`
}

function updateClipboardInfo() {
    if (!state.clipboard) {
        $clip.textContent = ""
        return
    }
    const verb = state.clipboard.mode === "cut" ? "剪切" : "复制"
    $clip.textContent = `剪贴板: [${verb}] ${state.clipboard.name}`
}

// ===========================================================================
// 操作
// ===========================================================================

function select(id) {
    state.selectedId = id
    render()
    renderSide(state.nodesById.get(id))
}

async function toggleExpand(id) {
    if (state.expanded.has(id)) {
        state.expanded.delete(id)
    } else {
        state.expanded.add(id)
        if (!state.loaded.has(id)) await loadChildren(id)
    }
    render()
}

function makeNode(name, isDir, type) {
    return {
        id: crypto.randomUUID(),
        parentId: ROOT, // 会被服务端 createNodes 覆盖
        name,
        isDir,
        size: isDir ? 0 : Math.floor(Math.random() * 4000) + 100,
        modif: Date.now(),
        type: isDir ? "dir" : type || "txt",
    }
}

async function createUnder(parentId, isDir) {
    const name = prompt(isDir ? "新文件夹名称" : "新文件名称（含扩展名）", isDir ? "新建文件夹" : "新文件.txt")
    if (!name) return
    const type = isDir ? "dir" : name.includes(".") ? name.split(".").pop() : "txt"
    await api("createNodes", { nodes: [makeNode(name, isDir, type)], parentId, options: { index: { toEnd: true } } })
    if (parentId !== ROOT) {
        state.expanded.add(parentId)
        if (!state.loaded.has(parentId)) await loadChildren(parentId, "read")
    }
    await refreshParents([parentId])
}

async function renameNode(node) {
    const name = prompt("重命名", node.name)
    if (!name || name === node.name) return
    await api("updateNodes", { filter: { id: node.id }, updateOp: { $set: { name, modif: Date.now() } } })
    await refreshParents([node.parentId])
}

async function editSize(node) {
    const input = prompt(`修改 "${node.name}" 的体积（字节）`, node.size ?? 0)
    if (input == null) return
    const size = Number(input)
    if (!Number.isFinite(size)) return alert("请输入数字")
    // 修改 size 会触发祖先 csize 的增量维护，观察控制台命令数
    await api("updateNodes", { filter: { id: node.id }, updateOp: { $set: { size } } })
    await refreshParents([node.parentId])
}

async function deleteNode(node) {
    if (!confirm(`删除 "${node.name}"${node.isDir ? "（含全部子节点）" : ""}？可在回收站恢复。`)) return
    await api("deleteNodes", { nodeIds: [node.id] })
    if (state.selectedId === node.id) {
        state.selectedId = null
        renderSide(null)
    }
    await refreshParents([node.parentId])
}

async function pasteInto(targetId) {
    const clip = state.clipboard
    if (!clip) return
    const src = state.nodesById.get(clip.id)
    const sourceParent = src ? src.parentId : null
    if (clip.mode === "copy") {
        await api("copyNodes", { srcNodeIds: [clip.id], parentId: targetId, options: { deep: true, renameOnCopy: true } })
    } else {
        await api("moveNodes", { nodeIds: [clip.id], parentId: targetId, options: { overwriteMode: "newName", uniqueBy: "name" } })
        state.clipboard = null
        updateClipboardInfo()
    }
    state.expanded.add(targetId)
    if (!state.loaded.has(targetId)) await loadChildren(targetId, "read")
    await refreshParents([targetId, sourceParent].filter(Boolean))
}

async function checkConflict(node) {
    const result = await api("checkNodes", {
        nodes: [{ name: node.name }],
        targetId: node.parentId,
        options: { uniqueBy: "name" },
    })
    alert(`目标父级 (${node.parentId}) 下命名冲突: ${result.isConflict ? "存在" : "无"}\n已存在节点: ${result.existNodes.length} 个`)
}

async function listAll(node) {
    const result = await api("listAllNodes", { parentId: node.id, options: { pageSize: 1000 } })
    alert(`"${node.name}" 共有 ${result.list.length} 个子孙节点（详见控制台"详情"）`)
}

async function moveTo(nodeId, targetParentId) {
    const node = state.nodesById.get(nodeId)
    if (!node || node.parentId === targetParentId) return
    const sourceParent = node.parentId
    await api("moveNodes", { nodeIds: [nodeId], parentId: targetParentId, options: { overwriteMode: "newName", uniqueBy: "name" } })
    if (targetParentId !== ROOT) {
        state.expanded.add(targetParentId)
        if (!state.loaded.has(targetParentId)) await loadChildren(targetParentId, "read")
    }
    await refreshParents([targetParentId, sourceParent])
}

async function fullRefresh() {
    const wasExpanded = [...state.expanded]
    state.nodesById.clear()
    state.childIds.clear()
    state.loaded.clear()
    await loadChildren(ROOT, "op")
    // 依次恢复之前展开的文件夹
    for (const id of wasExpanded) {
        if (state.nodesById.has(id)) await loadChildren(id, "read")
    }
    render()
}

async function resetDb() {
    if (!confirm("重置数据库：清空全部数据并重新写入种子目录树？")) return
    await api("reset", {})
    state.expanded.clear()
    state.selectedId = null
    renderSide(null)
    await fullRefresh()
}

async function showRecycle() {
    const deleted = await api("listDeleted", {}, "op")
    if (!deleted.length) {
        $side.innerHTML = `<div class="side-title">🗑 回收站</div><div class="side-empty">没有已删除的节点</div>`
        return
    }
    $side.innerHTML =
        `<div class="side-title">🗑 回收站 (${deleted.length})</div>` +
        deleted
            .map(
                (n) =>
                    `<div class="recycle-item"><span class="nm">${n.isDir ? "📁" : "📄"} ${escapeHtml(n.name)}</span>` +
                    `<button data-restore="${n.id}">恢复</button></div>`,
            )
            .join("")
    $side.querySelectorAll("[data-restore]").forEach((btn) => {
        btn.onclick = async () => {
            const node = deleted.find((d) => d.id === btn.dataset.restore)
            await api("unDeleteNodes", { nodeIds: [btn.dataset.restore] })
            await refreshParents([node ? node.parentId : ROOT])
            await showRecycle()
        }
    })
}

// ===========================================================================
// 右键菜单
// ===========================================================================

function showCtxMenu(x, y, node) {
    const items = []
    if (node.isDir) {
        items.push({ label: "📄 在此新建文件", fn: () => createUnder(node.id, false) })
        items.push({ label: "📁 在此新建文件夹", fn: () => createUnder(node.id, true) })
        if (state.clipboard) items.push({ label: "📋 粘贴到此", fn: () => pasteInto(node.id) })
        items.push({ label: "≡ 列出全部子孙", fn: () => listAll(node) })
        items.push({ sep: true })
    }
    items.push({ label: "✎ 重命名", fn: () => renameNode(node) })
    items.push({ label: "⚖ 修改体积", fn: () => editSize(node) })
    items.push({ label: "📑 复制", fn: () => setClipboard(node, "copy") })
    items.push({ label: "✂ 剪切", fn: () => setClipboard(node, "cut") })
    items.push({ label: "🔍 检查命名冲突", fn: () => checkConflict(node) })
    items.push({ label: "ℹ 属性 (get)", fn: () => showProps(node) })
    items.push({ sep: true })
    items.push({ label: "🗑 删除", danger: true, fn: () => deleteNode(node) })

    $ctx.innerHTML = ""
    for (const it of items) {
        if (it.sep) {
            const sep = document.createElement("div")
            sep.className = "sep"
            $ctx.appendChild(sep)
            continue
        }
        const el = document.createElement("div")
        el.className = "item" + (it.danger ? " danger" : "")
        el.textContent = it.label
        el.onclick = () => {
            hideCtxMenu()
            it.fn()
        }
        $ctx.appendChild(el)
    }
    $ctx.style.left = Math.min(x, window.innerWidth - 190) + "px"
    $ctx.style.top = Math.min(y, window.innerHeight - $ctx.offsetHeight - 10) + "px"
    $ctx.classList.remove("hidden")
}
function hideCtxMenu() { $ctx.classList.add("hidden") }

function setClipboard(node, mode) {
    state.clipboard = { id: node.id, name: node.name, mode }
    updateClipboardInfo()
    if (state.selectedId) renderSide(state.nodesById.get(state.selectedId))
}

async function showProps(node) {
    await api("get", { id: node.id })
    alert(`节点 "${node.name}" 的完整文档已打印到控制台（点"详情"展开）`)
}

// ===========================================================================
// 事件绑定
// ===========================================================================

$tree.addEventListener("click", (e) => {
    const row = e.target.closest(".row")
    if (!row) return
    const id = row.dataset.id
    if (e.target.classList.contains("caret")) {
        toggleExpand(id)
        return
    }
    select(id)
})

$tree.addEventListener("dblclick", (e) => {
    const row = e.target.closest(".row")
    if (!row) return
    const node = state.nodesById.get(row.dataset.id)
    if (node && node.isDir) toggleExpand(node.id)
})

$tree.addEventListener("contextmenu", (e) => {
    const row = e.target.closest(".row")
    if (!row) return
    e.preventDefault()
    const node = state.nodesById.get(row.dataset.id)
    select(node.id)
    showCtxMenu(e.clientX, e.clientY, node)
})

// ---- 拖拽 ----------------------------------------------------------------
let dragId = null
let dropTarget = null // sort 模式: { rowId, position: "before"|"after"|"into" }
let dragMode = "move" // "move" | "sort"

function setDragMode(mode) {
    dragMode = mode
    const btn = document.getElementById("dragModeBtn")
    btn.classList.toggle("active", mode === "sort")
    btn.textContent = mode === "sort" ? "⇅ 排序（激活）" : "⇅ 排序模式"
}

function clearDropIndicators() {
    document.querySelectorAll(".row.drop-target,.row.insert-before,.row.insert-after")
        .forEach((r) => r.classList.remove("drop-target", "insert-before", "insert-after"))
    dropTarget = null
}

$tree.addEventListener("dragstart", (e) => {
    const row = e.target.closest(".row")
    if (!row) return
    dragId = row.dataset.id
    e.dataTransfer.effectAllowed = "move"
})

$tree.addEventListener("dragleave", (e) => {
    if (!$tree.contains(e.relatedTarget)) clearDropIndicators()
})

$tree.addEventListener("dragend", () => {
    clearDropIndicators()
    dragId = null
})

$tree.addEventListener("dragover", (e) => {
    const row = e.target.closest(".row")
    clearDropIndicators()

    if (dragMode === "move") {
        if (row) {
            const node = state.nodesById.get(row.dataset.id)
            if (node && node.isDir && node.id !== dragId) {
                e.preventDefault()
                row.classList.add("drop-target")
            }
        } else {
            e.preventDefault() // 空白区域允许落到根目录
        }
        return
    }

    // 排序模式：任意位置都可以放
    e.preventDefault()
    if (!row || row.dataset.id === dragId) return

    const node = state.nodesById.get(row.dataset.id)
    if (!node) return

    const rect = row.getBoundingClientRect()
    const y = e.clientY - rect.top
    const third = rect.height / 3

    if (node.isDir && y > third && y < rect.height - third) {
        // 文件夹中间区域 → 放入文件夹
        row.classList.add("drop-target")
        dropTarget = { rowId: row.dataset.id, position: "into" }
    } else if (y < rect.height / 2) {
        row.classList.add("insert-before")
        dropTarget = { rowId: row.dataset.id, position: "before" }
    } else {
        row.classList.add("insert-after")
        dropTarget = { rowId: row.dataset.id, position: "after" }
    }
})

$tree.addEventListener("drop", async (e) => {
    e.preventDefault()
    const row = e.target.closest(".row")
    const dt = dropTarget
    clearDropIndicators()

    if (!dragId) return
    const id = dragId
    dragId = null

    if (dragMode === "move") {
        if (!row) {
            await moveTo(id, ROOT)
        } else {
            const target = state.nodesById.get(row.dataset.id)
            if (target && target.isDir && target.id !== id) {
                await moveTo(id, target.id)
            }
        }
        return
    }

    // 排序模式
    if (!dt) {
        if (!row) await moveTo(id, ROOT)
        return
    }

    if (dt.position === "into") {
        await moveTo(id, dt.rowId)
        return
    }

    const targetNode = state.nodesById.get(dt.rowId)
    const node = state.nodesById.get(id)
    if (!targetNode || !node) return

    const parentId = targetNode.parentId
    const sourceParent = node.parentId
    const indexOpt = dt.position === "before" ? { nextNodeId: targetNode.id } : { prevNodeId: targetNode.id }

    await api("moveNodes", {
        nodeIds: [id],
        parentId,
        options: { index: indexOpt, overwriteMode: "newName", uniqueBy: "name" },
    })

    if (parentId !== ROOT) {
        state.expanded.add(parentId)
        if (!state.loaded.has(parentId)) await loadChildren(parentId, "read")
    }
    await refreshParents([parentId, sourceParent])
})

// 侧栏按钮
$side.addEventListener("click", (e) => {
    const act = e.target.dataset.sa
    if (!act) return
    const node = state.nodesById.get(state.selectedId)
    if (!node) return
    const map = {
        rename: () => renameNode(node),
        size: () => editSize(node),
        newFile: () => createUnder(node.id, false),
        newFolder: () => createUnder(node.id, true),
        copy: () => setClipboard(node, "copy"),
        cut: () => setClipboard(node, "cut"),
        paste: () => pasteInto(node.id),
        check: () => checkConflict(node),
        listAll: () => listAll(node),
        delete: () => deleteNode(node),
    }
    map[act]?.()
})

// 工具栏
document.querySelector(".toolbar").addEventListener("click", (e) => {
    const act = e.target.dataset.act
    const map = {
        newFolderRoot: () => createUnder(ROOT, true),
        newFileRoot: () => createUnder(ROOT, false),
        refresh: () => fullRefresh(),
        listAllRoot: async () => {
            const r = await api("listAllNodes", { parentId: ROOT, options: { pageSize: 1000 } })
            alert(`整棵树共有 ${r.list.length} 个节点（详见控制台"详情"）`)
        },
        dragMode: () => setDragMode(dragMode === "sort" ? "move" : "sort"),
        recycle: () => showRecycle(),
        reset: () => resetDb(),
    }
    map[act]?.()
})

document.querySelector(".console-head").addEventListener("click", (e) => {
    if (e.target.dataset.act === "clearLog") $log.innerHTML = ""
})

document.addEventListener("click", (e) => {
    if (!$ctx.contains(e.target)) hideCtxMenu()
})
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideCtxMenu()
})

// ===========================================================================
// 工具函数
// ===========================================================================

function fmtBytes(n) {
    if (n < 1024) return n + " B"
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB"
    return (n / 1024 / 1024).toFixed(2) + " MB"
}
function fmtMs(n) {
    return (Math.round((n ?? 0) * 1000) / 1000).toFixed(3) + "ms"
}
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
}

// ===========================================================================
// 启动
// ===========================================================================

;(async function init() {
    await loadChildren(ROOT, "op")
    render()
})()
