---
sort: 10
icon: ri-node-tree
---

# 目录树 | Tree

目录树（Tree）是 TableDB 的一个扩展功能，提供了树形结构的数据管理能力。通过目录树扩展，你可以得到一个功能完善的树形数据结构，支持节点的创建、查询、更新、删除、移动、复制等操作，它会自动维护目录树功能的元数据。

## 概念

### 节点修改计数 `modif`

目录树中的每个节点都有一个 `modif` 字段，表示该节点的修改计数。每当节点被修改时，`modif` 值会自动递增。通过 `modif` 字段，你可以简单地判断一个节点是否被修改过。

与 Table 自动维护的 `_updateDate` 不同，`modif` 是可控的，可以根据业务逻辑选择性地修改。

`modif` 包含了系统修改和用户修改，因此它不适合作为给用户看的「更新时间」，例如不能直接拿它表达排序更新时间。

### 可控排序 `index`

目录树中的每个节点都有一个 `index` 字段，表示该节点在同级节点中的排序位置，它通常用在给用户手动拖拽排序。

当前实现使用数值型分数索引：在两侧节点之间插入时，会给新节点分配一个落在上下界之间的数值，因此通常只需要修改当前节点自己的 `index`。

为了避免不需要排序时引入额外写入，`index` 默认只会在两种情况下写入：

- 显式使用插入定位能力
- 目标父节点已经进入索引模式，此时新的追加写入会自动分配末尾 `index`，以保持顺序稳定

在 Mongodb 和 SQLite 中，空字符串排在 `A` 之前。

## 当前能力

当前 `TableTree` 已经提供以下树操作：

- `createNodes(nodes, parentId, options)`：在指定父节点下创建节点
- `listNodes(parentId, options)`：分页获取直属子节点
- `listNodesByCursor(parentId, options)`：游标分页获取直属子节点
- `listAllNodes(parentId, options)`：按深度优先顺序扁平获取全部子孙节点
- `checkNodes(nodes, targetId, options)`：预检目标位置按当前覆盖策略实际会影响到的目标节点
- `setNodes(nodes, options)`：批量设置节点，支持覆盖策略和批量排序定位
- `copyNodes(srcNodeIds, parentId, options)`：复制节点，支持深拷贝、根节点自动重命名和根节点插入定位
- `moveNodes(nodeIds, parentId, options)`：移动节点，支持覆盖策略和同级重排
- `deleteNodes(nodeIds, options)`：递归删除节点，支持标记删除
- `unDeleteNodes(nodeIds)`：恢复标记删除的节点子树
- `updateNodes(filter, updateOp, options)`：更新节点，支持递归更新整棵子树

这些能力由 [src/extension/tree/TableTree.ts](src/extension/tree/TableTree.ts) 暴露，对应的核心实现位于：

- [src/extension/tree/core/createNodes.ts](src/extension/tree/core/createNodes.ts)
- [src/extension/tree/core/listNodes.ts](src/extension/tree/core/listNodes.ts)
- [src/extension/tree/core/checkNodes.ts](src/extension/tree/core/checkNodes.ts)
- [src/extension/tree/core/setNodes.ts](src/extension/tree/core/setNodes.ts)
- [src/extension/tree/core/copyNodes.ts](src/extension/tree/core/copyNodes.ts)
- [src/extension/tree/core/moveNodes.ts](src/extension/tree/core/moveNodes.ts)
- [src/extension/tree/core/deleteNodes.ts](src/extension/tree/core/deleteNodes.ts)
- [src/extension/tree/core/unDeleteNodes.ts](src/extension/tree/core/unDeleteNodes.ts)
- [src/extension/tree/core/updateNodes.ts](src/extension/tree/core/updateNodes.ts)

## 自动维护字段

目录树会自动维护下面这些内部字段：

- `csize`：全部后代节点的总大小，不含当前节点自身 `size`
- `ctotal`：全部后代节点总数，包含目录和文件
- `cftotal`：全部后代文件总数
- `clidLastIndex`：当前目录节点已分配给直属子节点的最后一个追加索引

这些字段都只允许内部维护，外部写入会被忽略或拒绝。其中 `csize` / `ctotal` / `cftotal` 的维护逻辑集中在 [src/extension/tree/core/treeStats.ts](src/extension/tree/core/treeStats.ts)，`clidLastIndex` 则由排序写路径在追加子节点时自动推进。

## 排序与插入定位

当前目录树已经支持一套统一的 `index` 定位语义：

- `toStart`：插入到同级开头
- `toEnd`：插入到同级末尾
- `prevNodeId`：插入到指定节点之后
- `nextNodeId`：插入到指定节点之前

目前这些能力分别覆盖到：

- `createNodes()`：支持以上 4 种定位方式
- `moveNodes()`：支持跨父节点插入和同父节点内重排
- `copyNodes()`：当前支持根节点级别的 `prevNodeId` 定位
- `setNodes()`：当前支持同一父节点下的批量写入和重排

当某个父节点已经进入索引模式后，后续没有显式传入 `index` 选项的新建、复制、跨父节点移动、写入新节点，也会默认按末尾追加分配 `index`，避免无索引新节点打乱既有顺序。

另外，目录节点上的 `clidLastIndex` 现在已经作为内部状态启用：当子节点被追加到末尾时，目录树会自动推进这个值，作为后续 append 场景的最后分配索引记录，避免每次都从头推断末尾位置。

读取行为也已经和 `index` 联动：

- 当某个父节点下已经存在有效 `index` 时，`listNodes()` 和 `listAllNodes()` 会按 `index` 再按 `id` 返回
- 当该父节点下没有任何有效 `index` 时，会保留原来的自然顺序，不强制切换到排序模式

## 覆盖策略

### `moveNodes()`

当前 `moveNodes()` 已支持以下覆盖行为：

- `replace`：删除目标父节点下的冲突节点，再移动源节点
- `newName`：当目标下存在同名节点时，自动重命名为 `名称 (1)`、`名称 (2)` 这类形式后再移动
- `merge`：当源节点和目标冲突节点都是目录时，递归把源目录子节点并入目标目录
- `mergeByModif`：目录仍然递归合并；如果遇到非目录冲突，则只有源节点 `modif` 更大时才覆盖，否则跳过

当前行为特点：

- 冲突检测默认只看目标父节点下的直属节点
- `newName` 目前只支持按 `name` 检测冲突
- 当文件要覆盖目录时，默认会跳过，除非显式开启 `enableFileOverwriteDir`
- 如果同时传入 `index` 选项，会先完成冲突处理，再给最终真的要落到目标父节点下的根节点分配新顺序

### `setNodes()`

当前 `setNodes()` 已支持以下覆盖行为：

- `replace`：删除目标父节点下的冲突节点，再执行写入
- `newName`：当目标下存在同名节点时，自动改名后写入
- `merge`：如果写入目录与目标目录冲突，会折叠到目标目录，并把子节点改挂到目标目录下
- `mergeByModif`：与 `merge` 类似，但只有源目录 `modif` 更大时才覆盖目标目录元数据；子节点冲突仍按 `modif` 决定覆盖或跳过

当前行为特点：

- 同批次写入允许子节点引用本批次中的父节点
- 目录合并时，内部会先建立目录映射，再处理子节点写入
- `newName` 同样只支持按 `name` 检测冲突
- `index` 目前只支持“最终落到同一父节点下”的批量写入；如果一批节点会落到多个父节点，会直接报错

### `checkNodes()`

当前 `checkNodes()` 会直接复用 `moveNodes()` / `setNodes()` 的覆盖选项：

- `replace`：返回实际会被替换的目标节点
- `newName`：返回空数组，因为实际执行时不会覆盖目标节点，而是改名后写入
- `merge`：如果命中目录对目录冲突，会返回将被合并的目标目录；如果源节点里包含子树，还会继续递归返回深层会受影响的目标节点
- `mergeByModif`：与 `merge` 类似，但会跳过 `modif` 更大或相等的目标节点，因此返回结果只包含真正会被覆盖或合并的节点

当前行为特点：

- 它返回的是“按当前覆盖策略实际会影响到的目标节点”，而不是“所有重名节点”
- 当源节点是目录并且发生目录合并时，会继续递归预检深层子节点冲突
- 如果直接传入一批待写入节点，会优先按这批节点自身的父子关系递归预检
- 如果某个目录节点在本批输入里没有带出子节点，当前会继续读取它在表里的现有子树做递归预检，因此混合批次场景也能继续下钻
- 当文件将覆盖目录且没有开启 `enableFileOverwriteDir` 时，会视为“实际不会覆盖”，因此不会出现在返回结果里

### `copyNodes()`

当前 `copyNodes()` 已支持以下行为：

- 支持根节点复制时自动重命名
- 支持递归复制整棵子树
- 支持通过 `prevNodeId` 把复制出来的根节点插入到目标父节点下的指定位置
- 当复制结果追加到非根父节点末尾时，会同步推进目标目录的 `clidLastIndex`

当前行为特点：

- `prevNodeId` 只作用于根节点层级
- 如果一次复制多个根节点，后续根节点会顺次接在前一个新副本之后
- 子节点仍然按复制出的新父节点继续创建，不会继承根节点的插入定位参数

### `updateNodes()`

当前 `updateNodes()` 已支持以下行为：

- 默认只更新直接命中的节点
- `deep: true`：先把直接命中的节点扩展成整棵子树，再统一执行递归更新
- 如果更新内容会影响 `size` / `isDir` 这类统计贡献，祖先节点的 `csize` / `ctotal` / `cftotal` 会自动刷新

当前行为特点：

- 不允许通过 `updateNodes()` 修改 `parentId`，需要改用 `moveNodes()`
- 不允许外部修改 `csize` / `ctotal` / `cftotal`

## 当前限制

以下能力目前仍然是后续可继续增强的方向：

- 当前仍然主要依赖数值型 `index` 作为第一版排序方案，`clidLastIndex` 只用于记录末尾追加时的最后分配索引，还没有扩展成完整的排序元数据体系

因此目前目录树已经可以作为“结构正确、统计正确、覆盖策略和排序策略都可用”的树形文档模型来使用；如果你的场景依赖更细粒度的排序元数据维护，下一步可以继续扩展 `clidLastIndex` 之类的能力。
