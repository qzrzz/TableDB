# TableTree Benchmark

- 生成时间：2026-06-21T12:51:34.694Z
- 单项时长：500ms
- 运行 Adapter：SQLite
- SQLite 文件目录：`/Users/yarna/Project/Qzrzz/Code/TableDB/dist/table-tree-benchmark`
- 运行命令：`bun run bench:tree` 或 `bun run bench:tree:all`

## SQLite

| Task name | Latency avg (ns) | Latency med (ns) | Throughput avg (ops/s) | Throughput med (ops/s) | Samples |
| --- | --- | --- | --- | --- | --- |
| [SQLite] 读取性能：listNodes 分页 + total | 573795 ± 0.65% | 560937 ± 22709 | 1757 ± 0.55% | 1783 ± 74 | 872 |
| [SQLite] 读取性能：listNodes 深分页 | 279030 ± 1.06% | 268417 ± 13292 | 3653 ± 0.49% | 3726 ± 186 | 1792 |
| [SQLite] 读取性能：listNodesByCursor 游标分页 | 306083 ± 0.37% | 300312 ± 11124 | 3283 ± 0.32% | 3330 ± 124 | 1634 |
| [SQLite] 读取性能：过滤 + 排序 + 投影 | 244774 ± 0.80% | 233500 ± 11791 | 4164 ± 0.49% | 4283 ± 220 | 2043 |
| [SQLite] 写入性能：createNodes 批量新增 | 13746249 ± 6.07% | 12727375 ± 2534938 | 77 ± 5.62% | 79 ± 16 | 64 |
| [SQLite] 写入性能：setNodes 批量新增 | 23881409 ± 5.38% | 23609333 ± 4053375 | 44 ± 5.68% | 42 ± 6 | 64 |
| [SQLite] 写入性能：setNodes 批量更新 | 18598102 ± 0.59% | 18677291 ± 250625 | 54 ± 0.60% | 54 ± 1 | 64 |
| [SQLite] 写入性能：updateNodes 条件更新 | 19223472 ± 0.98% | 19406000 ± 340312 | 52 ± 1.02% | 52 ± 1 | 64 |
| [SQLite] 树结构变更：moveNodes 单节点移动 | 7568484 ± 3.14% | 7370417 ± 342917 | 134 ± 2.35% | 136 ± 6 | 67 |
| [SQLite] 树结构变更：copyNodes 深度复制 | 8378945 ± 3.63% | 8359145 ± 993895 | 122 ± 3.60% | 120 ± 15 | 64 |
| [SQLite] 覆盖与同步：preOverwriteNodes 预覆盖检测 | 1011547 ± 4.35% | 890375 ± 48333 | 1069 ± 1.54% | 1123 ± 61 | 495 |
| [SQLite] 覆盖与同步：setNodes overwrite replace | 8539222 ± 4.12% | 8316854 ± 322792 | 119 ± 2.63% | 120 ± 5 | 64 |
| [SQLite] 覆盖与同步：setNodes overwrite skip | 3460506 ± 3.55% | 3340958 ± 214749 | 297 ± 2.27% | 299 ± 19 | 145 |
| [SQLite] 覆盖与同步：setNodes overwrite merge | 12693000 ± 1.42% | 12522563 ± 590938 | 79 ± 1.40% | 80 ± 4 | 64 |
| [SQLite] 覆盖与同步：setNodes overwrite newName | 16297030 ± 2.71% | 16223875 ± 592792 | 62 ± 2.12% | 62 ± 2 | 64 |
| [SQLite] 覆盖与同步：presyncNodes | 115700 ± 0.38% | 111792 ± 4375.0 | 8734 ± 0.26% | 8945 ± 357 | 4322 |
| [SQLite] 覆盖与同步：setNodes presync | 2343387 ± 0.95% | 2302917 ± 99792 | 429 ± 0.89% | 434 ± 19 | 214 |
| [SQLite] 删除恢复：deleteNodes 递归标记删除 | 7484993 ± 2.75% | 7444042 ± 752417 | 135 ± 2.80% | 134 ± 12 | 67 |
| [SQLite] 删除恢复：unDeleteNodes 恢复标记删除 | 18526144 ± 2.08% | 18508104 ± 1366167 | 54 ± 2.10% | 54 ± 4 | 64 |
| [SQLite] 删除恢复：deleteNodes realDelete 物理删除 | 12882163 ± 0.68% | 12813479 ± 244917 | 78 ± 0.67% | 78 ± 1 | 64 |

