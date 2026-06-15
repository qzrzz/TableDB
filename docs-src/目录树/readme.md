---
sort: 10
icon: ri-node-tree
---

# 目录树 | Tree

目录树（Tree）是 TableDB 的一个扩展功能，提供了树形结构的数据管理能力。通过目录树扩展，你可以得到一个功能完善的树形数据结构，支持节点的创建、查询、更新、删除、移动、复制等操作，它会自动维护目录树功能的元数据。

## 概念

### 节点属性

@import "../../src/extension/tree/tree.types.ts" @only=ITreeNode

### 修改计数 `modif`、`cmodif`

目录树里的每个节点都有 `modif` 和 `cmodif` 两个字段，通常是用节点修改时间的毫秒数。
`modif` 记录节点本身的修改；`cmodif` 记录当前节点的后代节点的修改计数。

在客户端通过与线上数据对比 `modif`，能非常轻松地判断一个节点到底有没有变过，是否需要更新。通过 `cmodif` 可以判断文件夹子级是否有变更。

每一个 tree API 方法都只有一个新 `modif` 值，也就是说像 `setNodes()` 这样的方法，每次执行改变的多个节点，其 `modif` 都相同。

它们由系统自动维护，也可以手动修改，具体见 [自动维护树结构属性](#自动维护树结构属性)。

#### 为什么要用 `modif`？

> [!NOTE] 注意事项
>
> - **与更新时间的区别**：它和数据库那种死板的“最后修改时间 (`_updateDate`)”不太一样，`modif` 是完全受控的，你可以根据业务逻辑，灵活决定在什么情况下才增加这个计数。

### 可控排序 `index`

目录树中的每个节点都有一个 `index` 字段，表示该节点在同级节点中的排序位置，它通常用在给用户手动拖拽排序。

`index` 是一个使用 [indexless](https://www.npmjs.com/package/indexless) 库实现的分数索引（Fractional Indexing），使用字符串类型存储，依靠字符串特性进行排序。

使用分数索引的好处是每次拖拽排序、插入元素时，都只需要修改当前节点的 `index` 字段即可，不用修改前后节点的 `index`。同时可以直接用字符串顺序来进行排序，在各个数据库或者编程语言中都能非常轻松的进行排序。

但是分数索引也有代价，在一个位置不断的进行排序会导致 `index` 长度不断增加。为了限制 `index` 长度，实际上系统会在后台进行[智能重排 (smartRebalance)](https://www.npmjs.com/package/indexless?activeTab=readme#%E9%87%8D%E5%88%86%E5%B8%83) 。每一次进行 `index` 涉及的更新，都会同时进行智能重排。

#### 排序操作

- **新建、移动节点位置** 用户可以指定插入位置（插入到开头/末尾/某个节点的后面/某个节点的前面），如果用户没有指定，会依照父节点是否有 `lastChildIndex` 属性，如果有意味着父节点已经有排序需求，则会默认追加到末尾，如果没有则会把 `index` 设置为空字符串

- **更新 `index`** 如果任何更新涉及到修改目标节点位置的情况，会触发[智能重排 (smartRebalance)](https://www.npmjs.com/package/indexless?activeTab=readme#%E9%87%8D%E5%88%86%E5%B8%83)，并且根据情况修改父节点 `lastChildIndex` 的值

- **手动拖拽排序** 通常由客户端进行手动排序的实现，对于后端来说只用简单的修改目标节点的`index` 即可。

> [!NOTE] 注意事项
> 在 Mongodb 和 SQLite 中，空字符串排在 `A` 之前。

#### `index` 更新选项

@import "../../src/extension/tree/tree.types.ts" @only=ITreeIndexOptions @full

在创建、移动、更新操作中使用 `options.index` 参数可以控制如何更新节点的 `index` 值。`prevNodeId`、`nextNodeId` 用来把节点插入到已有节点的前后位置。`toStart`、`toEnd` 用来把节点插入到同级节点列表的开头或末尾。

### 自动维护树结构属性

为了实现方便的目录树功能，TableTree 会自动维护下面这些内部字段：

- `modif`：节点更新计数
- `cmodif`：子节点更新计数
- `ctotal`：全部后代节点的总数，包含文件夹(`isDir:true`) 和文件节点
- `cftotal`：全部后代节点仅包含文件的总数（不包含文件夹）
- `csize`：全部后代节点的大小（`size`）总和（不包含当前节点自身 `size` 字段的值）
- `clidLastIndex`：子节点中 `index` 值最大的一个值。当新建、插入操作时可以使用此属性快速的设置子节点的 `index`。

这些字段通常都只允许内部维护，外部写入会被忽略（`modif`、`cmodif` 允许修改）。

#### 维护策略

节点更新、删除、新建操作时会记录被更新的节点的 `id`, `parentId`、`size` 变化量、删除数等信息，提供给单独的 `treeMetadataRefresh()` 方法进行统一的树结构属性刷新。这个方法会沿着被更新节点的祖先链路，逐层更新 `cmodif`、`ctotal`、`cftotal`、`csize` 和 `clidLastIndex` 等字段。

> [!NOTE] 值得注意的逻辑
>
> - 如果一个节点的 `cmodif` 被更新了，那么它的父节点的 `cmodif` 也会被更新
> - `cmodif`,`clidLastIndex` 被更新不会直接导致 `modif` 的更新，只有当节点本身被修改了才会更新 `modif`。
> - 当节点的 `ctotal` 和 `csize` 的更新会导致 `modif` 的更新。

### 节点覆盖选项

覆盖选项主要用于 `checkNodes()`、`setNodes()`、`moveNodes()` 这类会把节点写入到目标父节点下的操作。它会在目标父节点的直属子节点中按 `uniqueBy` 查找冲突节点，再按 `overwriteMode` 决定覆盖、合并、跳过或改名。

@import "../../src/extension/tree/tree.types.ts" @only=ITreeOverwriteOptions @full

#### 冲突唯一键 `uniqueBy`

`uniqueBy` 用来定义“什么算冲突”。默认按节点 `id`，常用的是 `name`，也可以点路径指定节点任意键如 `meta.hash_md5`

#### 覆盖模式 `overwriteMode`

`overwriteMode` 控制命中冲突节点后的处理方式：

- `replace`： 删除已存在的冲突节点，再写入新节点，这是默认模式。

- `skip`：跳过已存在的冲突节点，不写入新节点。

- `merge`：删除已存在的冲突节点，再写入新节点；但如果冲突节点和新节点都是文件夹节点，则不删除冲突节点，而是把它们的子节点进行合并（如果子节点也有冲突则继续按 merge 规则进行处理）。相当于目录的递归合并。

- `mergeByModif`：类似 `merge`，处理冲突节点时不是用新节点直接覆盖已存在节点，而是判断节点 `modif` 的大小，保留 `modif` 较大的节点。

- `newName`：不覆盖目标节点，而是为源节点生成新名称，例如 `文件.txt (1)`、`文件.txt (2)`，然后继续写入或移动。

> [!NOTE] 注意事项
>
> - 如果是 `replace` 模式，且已存在的冲突节点是文件夹节点，则会删除整个文件夹（遵守 Table 的删除逻辑，可能是标记删除），请谨慎使用。

#### 同名冲突添加后缀规则

如果遇到同名冲突，并且覆盖模式是 `newName`，则会在新节点名称后添加 ` (1)`、` (2)` 等后缀来生成新的名称，直到没有同名冲突为止。

要注意的是如果文件名是 `文件(2).txt`，会识别出已有的 `(2)` 后缀，并在数字基础上继续递增，例如 `文件(2).txt` -> `文件(3).txt`，而不是 `文件(2) (1).txt`。

#### 文件覆盖文件夹

当源节点是文件（`isDir: false`），目标冲突节点是目录（`isDir: true`）时，默认不会让文件覆盖目录，单个源文件会被跳过。如果需要允许文件覆盖目录，可以在选项里开启 `enableFileOverwriteDir`，此时会直接删除目标目录（及其子树）再写入源文件。

---

## 核心接口

TreeTable 可以除了可以使用基本的[增删改查](/units/docs-src-u589eu5220u6539u67e5)接口外，还有一些列专属接口：

### 创建节点 `createNodes()`

@import "../../src/extension/tree/core/createNodes.ts" @doc=createNodes

### 更新节点 `updateNodes()`

@import "../../src/extension/tree/core/updateNodes.ts" @doc=updateNodes

相比于 `setNodes()` , `updateNodes()` 是一个更底层的接口，提供了更灵活的更新能力。它接受一个过滤器参数 `filter` 来指定要更新哪些节点，以及一个更新操作参数 `updateOp` 来定义如何更新这些节点。这意味着 `updateNodes()` 的资源消耗是不确定的，通常来说不会公开给客户端直接调用。

### 设置节点数据 `setNodes()`

@import "../../src/extension/tree/core/setNodes.ts" @doc=setNodes

`setNodes()` 提供了简单的方式来创建或更新节点数据。它接受一个节点数据数组 `nodes`，可以根据数据更新或者创建节点。它的资源消耗是确定可控的，就是每个节点对应一次更新或创建操作。

可以通过 `options.onlyUpdate` 选项来控制 `setNodes()` 只能更新已有节点而不创建新节点，避免更新已删除除节点时误创建新节点。

在 `setNodes()` 中可以使用覆盖选项来控制当目标位置有冲突节点时的处理方式，覆盖选项包括 `uniqueBy` 和 `overwriteMode`，具体见 [节点覆盖选项](#节点覆盖选项)。

#### 预同步

当进行 `setNodes()` 操作时会对节点进行修改，此时客户端上的节点可能已经过时了，为了让客户端可以知道此次操作前数据是否已经过时，就可以用 `presync` 选项来进行预同步。

客户端提供 `oldModif` 或 `oldCmodif` 两个值，服务端会把它们和当前数据的 `modif` 和 `cmodif` 进行对比，把结果在 `setNodes()` 结果中返回。

### 删除节点 `deleteNodes()`

@import "../../src/extension/tree/core/deleteNodes.ts" @doc=deleteNodes

### 恢复删除的节点 `unDeleteNodes()`

@import "../../src/extension/tree/core/unDeleteNodes.ts" @doc=unDeleteNodes

如何开启 `enableMarkDelete` 选项：

```ts
let useTree = new TableTree<ITreeNode>(table, {
    enableMarkDelete: true,
})
```

### 移动节点 `moveNodes()`

@import "../../src/extension/tree/core/moveNodes.ts" @doc=moveNodes

### 列出子节点 `listNodes()`

@import "../../src/extension/tree/core/listNodes.ts" @doc=listNodes

### 列出子节点（游标） `listNodesByCursor()`

@import "../../src/extension/tree/core/listNodesByCursor.ts" @doc=listNodesByCursor

### 预覆盖节点 `preOverwriteNodes()`

@import "../../src/extension/tree/core/preOverwriteNodes.ts" @doc=preOverwriteNodes
