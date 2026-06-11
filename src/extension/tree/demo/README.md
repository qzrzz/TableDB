# TableTree 目录树演示

一个基于 **SQLite 存储** 的网页 Demo，用于演示 [`TableTree.ts`](../TableTree.ts) 的全部功能。
界面是一棵可交互的文件/目录树，底部带一个 **操作控制台**：每个操作都会记录
执行了多少条底层数据库命令、各自的耗时，以及累计统计。

## 运行

```bash
# 在仓库根目录执行（需要 Bun）
bun run src/extension/tree/demo/server.ts

# 自定义端口
PORT=5000 bun run src/extension/tree/demo/server.ts
```

启动后打开 http://localhost:4812 。

> 使用 Bun 运行的原因：本仓库源码使用无扩展名的 TS 相对导入，Bun 可直接执行；
> 同时内置 `bun:sqlite` 免依赖。TableTree 的查询均为纯 SQL 兼容查询，因此无需自定义函数。

数据库文件位于 `src/extension/tree/demo/data/tree-demo.sqlite`（首次启动自动创建并写入种子数据）。

## 功能映射

界面操作 → `TableTree` 方法：

| 界面操作 | 方法 |
| --- | --- |
| 展开文件夹 / 刷新 | `listNodes` |
| “列出全部节点 / 子孙” | `listAllNodes` |
| 新建文件 / 文件夹 | `createNodes` |
| 重命名 / 修改体积 | `updateNodes` |
| 拖拽 / 剪切粘贴 | `moveNodes` |
| 复制粘贴 | `copyNodes` |
| 删除（标记删除） | `deleteNodes` |
| 回收站恢复 | `unDeleteNodes` |
| 检查命名冲突 | `checkNodes` |
| 属性面板 | `get` |
| 重置数据库 | `clearAll` + 重新种子 |

`setNodes` 也已在服务端 API 中暴露（`/api/setNodes`）。

## 控制台与耗时分析

- 每次 API 调用都会在控制台输出：**整体耗时 / 纯数据库耗时 / 底层命令条数 / 各方法调用次数**。
- 顶栏聚合显示累计的「操作数 / DB 命令数 / 累计耗时」。
- 点击每条日志的「详情」可展开该次操作的完整返回 JSON。
- 「显示刷新读取」开关控制是否在日志里显示刷新类读取（仍会计入累计统计）。

命令计数的实现见 [`instrument.ts`](./instrument.ts)：用 `Proxy` 包裹 adapter 实例，
统计每个底层方法（`get` / `findMany` / `insertMany` / `updateOne` / `updateMany` /
`deleteMany` …）的调用次数与耗时。这能直观看到 —— 比如一次 `moveNodes` 或带统计维护的
`createNodes`，背后其实触发了多次数据库命令。

## 文件结构

```
demo/
├── server.ts        # Bun HTTP 服务：API 调度 + 静态资源
├── instrument.ts    # 统计底层 DB 命令数/耗时的 adapter 包装
├── seed.ts          # 种子目录树数据
├── data/            # SQLite 数据库文件（自动生成）
└── public/
    ├── index.html
    ├── style.css
    └── app.js       # 前端逻辑：树渲染 + 控制台
```
