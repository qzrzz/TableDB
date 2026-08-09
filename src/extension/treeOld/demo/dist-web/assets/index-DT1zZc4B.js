(function(){const t=document.createElement("link").relList;if(t&&t.supports&&t.supports("modulepreload"))return;for(const a of document.querySelectorAll('link[rel="modulepreload"]'))n(a);new MutationObserver(a=>{for(const o of a)if(o.type==="childList")for(const d of o.addedNodes)d.tagName==="LINK"&&d.rel==="modulepreload"&&n(d)}).observe(document,{childList:!0,subtree:!0});function r(a){const o={};return a.integrity&&(o.integrity=a.integrity),a.referrerPolicy&&(o.referrerPolicy=a.referrerPolicy),a.crossOrigin==="use-credentials"?o.credentials="include":a.crossOrigin==="anonymous"?o.credentials="omit":o.credentials="same-origin",o}function n(a){if(a.ep)return;a.ep=!0;const o=r(a);fetch(a.href,o)}})();const D="http://127.0.0.1:5173",E=document.querySelector("#app"),c=[];let v="正在连接后端...",S="",T=0,l,h="拖到节点上半部/下半部可排序；拖到文件夹中间可移动进去。";x("用户 A");x("用户 B");w();Promise.all(c.map(e=>p(e,"/")));function f(){E.innerHTML=`
        <section class="topbar">
            <div>
                <h1>TableTree 多用户目录树 Demo</h1>
                <p>${v}</p>
            </div>
            <div class="top-actions">
                <input id="db-path" value="${m(S)}" placeholder="SQLite DB 文件路径，例如 dist/test.db" />
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
            ${c.map(O).join("")}
        </section>
    `,C();for(const e of c)q(e)}function O(e){return`
        <article class="window" data-window-id="${e.id}">
            <header class="window-head">
                <input class="user-name" value="${m(e.name)}" aria-label="用户名" />
                <div class="window-actions">
                    <button data-action="batch">自动批量操作</button>
                    <button data-action="refresh">刷新</button>
                    <button data-action="close">关闭</button>
                </div>
            </header>
            <div class="create-row">
                <button data-action="new-dir">新建文件夹</button>
                <button data-action="new-file">新建文件</button>
                <span>${e.error?`<b class="error">${m(e.error)}</b>`:`${T.toLocaleString("zh-CN")} 个节点 · ${m(h)}`}</span>
            </div>
            <div class="tree">
                ${P(e,"/",0)}
            </div>
        </article>
    `}function P(e,t,r){const n=e.children.get(t);return n?n.length===0?`<div class="empty" style="--depth:${r}">空目录</div>`:n.map(a=>B(e,a,r)).join(""):r===0?'<button class="load-root" data-action="refresh">载入根目录</button>':""}function B(e,t,r){const n=e.expanded.has(t.id),a=e.selectedId===t.id?" selected":"",o=t.isDir?`<span class="count">${t.ctotal??0}</span>`:`<span class="size">${N(t.size)}</span>`,d=t.index||"-";return`
        <div class="node${a}" style="--depth:${r}" draggable="true" data-node-id="${t.id}" data-parent-id="${t.parentId}">
            <button class="twisty" data-action="toggle" ${t.isDir?"":"disabled"}>${t.isDir?n?"▾":"▸":"·"}</button>
            <span class="icon">${t.isDir?"📁":"📄"}</span>
            <span class="name" title="${m(t.name)}">${m(t.name)}</span>
            <code class="index" title="index: ${m(d)}">${m(A(d))}</code>
            ${o}
            <button data-action="rename">改名</button>
            <button data-action="delete">删除</button>
        </div>
        ${t.isDir&&n?`<div class="children">${P(e,t.id,r+1)}</div>`:""}
    `}function C(){g("#open-db")?.addEventListener("click",async()=>{const e=(g("#db-path")?.value??"").trim();e&&(await u("/api/open",{method:"POST",body:{dbPath:e}}),L())}),g("#upload-db")?.addEventListener("change",async e=>{const t=e.target.files?.[0];t&&(await fetch(`${D}/api/upload-db`,{method:"POST",headers:{"x-db-name":t.name},body:await t.arrayBuffer()}),L())}),g("#reset-tree")?.addEventListener("click",async()=>{v="正在生成 10 万级默认目录树，页面会在后端写完后刷新...",f(),await u("/api/reset",{method:"POST",body:{count:1e5}}),L()}),g("#add-window")?.addEventListener("click",()=>{x(`用户 ${String.fromCharCode(65+c.length)}`),f(),p(c[c.length-1],"/")})}function q(e){const t=E.querySelector(`[data-window-id="${e.id}"]`);t&&(t.querySelector(".user-name")?.addEventListener("input",r=>{e.name=r.target.value||e.name}),t.addEventListener("click",async r=>{const n=r.target,a=n.dataset.action;if(!a)return;const d=n.closest("[data-node-id]")?.dataset.nodeId;if(a==="close"){c.splice(c.indexOf(e),1),f();return}if(a==="refresh"){await I(e);return}if(a==="batch"){await u("/api/batch",{method:"POST",body:{userId:e.name}}),await I(e);return}if(a==="new-dir"||a==="new-file"){const i=e.selectedId&&b(e,e.selectedId)?.isDir?e.selectedId:"/",s=a==="new-dir",y=prompt(s?"文件夹名称":"文件名称",s?"新建文件夹":"新建文件.txt");if(!y)return;await u("/api/nodes",{method:"POST",body:{parentId:i,name:y,isDir:s,userId:e.name}}),e.expanded.add(i),await p(e,i,!0);return}if(d){if(e.selectedId=d,a==="toggle"){if(!b(e,d)?.isDir)return;e.expanded.has(d)?e.expanded.delete(d):(e.expanded.add(d),await p(e,d)),f();return}if(a==="rename"){const i=b(e,d),s=prompt("新名称",i?.name??"");if(!s)return;await u(`/api/nodes/${encodeURIComponent(d)}`,{method:"PATCH",body:{name:s,owner:e.name}}),await p(e,i?.parentId??"/",!0);return}if(a==="delete"){const i=b(e,d);if(!confirm(`确定删除 ${i?.name??d} 及其子节点吗？`))return;await u(`/api/nodes/${encodeURIComponent(d)}`,{method:"DELETE"}),await p(e,i?.parentId??"/",!0)}}}),t.addEventListener("dragstart",r=>{const n=r.target.closest("[data-node-id]");n&&(l={id:n.dataset.nodeId,parentId:n.dataset.parentId},n.classList.add("dragging"),h="拖动中：上半部=排到目标前面，下半部=排到目标后面，文件夹中间=移动进去。",r.dataTransfer?.setData("text/plain",l.id),r.dataTransfer?.setDragImage(n,16,16),f())}),t.addEventListener("dragover",r=>{const n=r.target.closest("[data-node-id]");!n||!l||(r.preventDefault(),M(e,n,r.clientY))}),t.addEventListener("drop",async r=>{r.preventDefault();const n=r.target.closest("[data-node-id]");if(!n||!l||l.id===n.dataset.nodeId)return;const a=b(e,n.dataset.nodeId);if(!a)return;const o=n.getBoundingClientRect(),d=r.clientY-o.top,i=o.height*.35,s=a.isDir&&d>i&&d<o.height-i,y=s?{nodeIds:[l.id],parentId:a.id,index:{toEnd:!0}}:{nodeIds:[l.id],parentId:a.parentId,index:d<=i?{nextNodeId:a.id}:{prevNodeId:a.id}};await u("/api/move",{method:"POST",body:y}),s&&e.expanded.add(a.id),h=s?`已移动到「${a.name}」目录。`:`已按 index 重新排序到「${a.name}」${d<=i?"之前":"之后"}。`,$(t),await I(e),l=void 0}),t.addEventListener("dragleave",r=>{t.contains(r.relatedTarget)||$(t)}),t.addEventListener("dragend",()=>{l=void 0,h="拖到节点上半部/下半部可排序；拖到文件夹中间可移动进去。",$(t),f()}))}async function I(e){const t=new Set(["/",...Array.from(e.expanded)]);for(const r of t)await p(e,r,!0);await w()}async function L(){await w();for(const e of c)e.expanded.clear(),e.children.clear(),await p(e,"/",!0);f()}async function p(e,t,r=!1){if(!(!r&&e.children.has(t))){e.loading=!0,e.error=void 0;try{const n=await u(`/api/nodes?parentId=${encodeURIComponent(t)}&limit=300`);e.children.set(t,n.list)}catch(n){e.error=n instanceof Error?n.message:String(n)}finally{e.loading=!1,f()}}}async function w(){try{const e=await u("/api/status");S=e.dbPath,T=e.total,v=`当前 DB：${e.dbPath}`}catch(e){v=`后端未连接：${e instanceof Error?e.message:String(e)}`}f()}async function u(e,t){const r=await fetch(`${D}${e}`,{method:t?.method??"GET",headers:t?.body?{"content-type":"application/json"}:void 0,body:t?.body?JSON.stringify(t.body):void 0}),n=await r.json();if(!r.ok)throw new Error(n.error??"请求失败");return n}function x(e){c.push({id:crypto.randomUUID(),name:e,expanded:new Set,loading:!1,children:new Map})}function b(e,t){for(const r of e.children.values()){const n=r.find(a=>a.id===t);if(n)return n}}function N(e){return e>1024*1024?`${(e/1024/1024).toFixed(1)} MB`:e>1024?`${(e/1024).toFixed(1)} KB`:`${e} B`}function A(e){return e.length<=12?e:`${e.slice(0,5)}…${e.slice(-5)}`}function M(e,t,r){const n=t.closest(".window");if(!n)return;$(n);const a=b(e,t.dataset.nodeId),o=t.getBoundingClientRect(),d=r-o.top,i=o.height*.35;a?.isDir&&d>i&&d<o.height-i?(t.classList.add("drop-into"),h=`松手：移动到「${a.name}」目录内部`):d<=i?(t.classList.add("drop-before"),h=`松手：排序到「${a?.name??"目标"}」之前`):(t.classList.add("drop-after"),h=`松手：排序到「${a?.name??"目标"}」之后`)}function $(e){e.querySelectorAll(".drop-before, .drop-after, .drop-into, .dragging").forEach(t=>{t.classList.remove("drop-before","drop-after","drop-into","dragging")})}function g(e){return document.querySelector(e)}function m(e){return e.replace(/[&<>"']/g,t=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[t])}
