---
sort: 10
icon: ri-node-tree
---

# 目录树 | Tree

`TableTree` 是 TableDB 的目录树扩展。它在普通 `Table` 的增删改查能力之上，增加了父子关系、同级排序、子树统计、软删除和覆盖策略，并自动维护目录树所需的 metadata。

当前正式实现位于 `src/extension/tree`。旧版实现和旧接口仅保留在 `src/extension/treeOld` 中用于归档对照，不属于正式导出。

## 快速开始

推荐使用 `defineTableTree` 创建可复用的表工厂：

```ts
import { SQLiteAdapter, defineTableTree } from "tbdb"
import type { ITreeNode } from "tbdb"

interface IFileNode extends ITreeNode {
    mimeType?: string
}

const useFileTree = defineTableTree<IFileNode>({
    name: "files",
    adapter: SQLiteAdapter({ filename: "files.db" }),
    enableMarkDelete: true,
})

const tree = await useFileTree()

await tree.createNodes([
    { id: "docs", name: "文档", isDir: true },
], "/")

await tree.createNodes([
    { id: "readme", name: "README.md", isDir: false, size: 1024, mimeType: "text/markdown" },
], "docs")

const result = await tree.listNodes("docs", { pageSize: 50 })
console.log(result.list)
```

如果直接使用 `new TableTree(options)`，需要先等待 `table.inited`；`defineTableTree` 返回的工厂会等待底层表初始化完成。

## 数据模型

### 节点字段

@import "../../src/extension/tree/tree.types.ts" @only=ITreeNode

### 父子关系

- 根层级使用特殊父级 ID `/`，根本身不是一条需要创建的节点记录。
- `parentId` 指向直属父节点的 `id`。
- `isDir` 只表示业务上的“目录/文件”类型，不是数据库层面的父子约束；文件节点也可以拥有子节点。
- 节点名称不能包含 `/`，避免与路径语义混淆。
- 新节点缺少 `id` 时会自动生成；缺少 `isDir`、`size`、`index` 等可归一化字段时会使用默认值。

### 受管理字段

以下统计字段由 `TableTree` 自动重算，不应通过普通更新直接写入：

| 字段 | 含义 |
| --- | --- |
| `modif` | 节点自身最近一次修改的计数/时间值 |
| `cmodif` | 后代节点最近一次结构或内容变化的计数/时间值 |
| `ctotal` | 全部后代节点数量，包含目录和文件 |
| `cftotal` | 全部后代文件数量，不包含目录 |
| `csize` | 全部后代文件大小之和，不包含当前节点自身的 `size` |
| `childLastIndex` | 直属子节点中最大的排序 `index` |

`modif` 和 `cmodif` 通常也由操作自动生成；如果业务需要使用外部同步版本号，可以在写入节点时显式提供，未提供时由系统生成。不要把 `ctotal`、`cftotal`、`csize` 或 `childLastIndex` 当作业务输入，它们会被系统过滤并重新计算。

标记删除节点默认不会出现在普通查询中，也不会计入父级统计；使用 `ignoreMarkDelete: true` 可以读取这些记录。

## 修改计数与元数据

`modif` 和 `cmodif` 适合客户端做增量同步：

- 比较节点的 `modif`，可以判断节点自身是否发生变化；
- 比较目录的 `cmodif`，可以判断目录子树是否可能发生变化；
- 同一个高层操作通常会复用同一个修改值，但客户端不应依赖不同 core 调用之间的精确数值相等关系。

正常的 `createNodes`、`updateNodes`、`deleteNodes`、`moveNodes` 和 `setNodes` 会自动刷新受影响父级及祖先的统计字段。

如果数据曾经通过底层 adapter 直接写入、外部脚本批量修改，或者历史操作中途异常退出，可以调用：

```ts
// 刷新整棵可达树
await tree.refreshTreeMetadata("/")

// 只刷新指定节点及其子树
await tree.refreshTreeMetadata("docs")
```

刷新过程按“先子节点、后父节点”的顺序执行，适合修复 `ctotal`、`cftotal`、`csize` 和 `childLastIndex`。正常业务写入不需要每次调用它。

## 同级排序

节点的 `index` 使用 [indexless](https://www.npmjs.com/package/indexless) 分数索引。插入或移动节点时通常只需要修改当前节点的 `index`，不需要改写所有兄弟节点。

### 排序选项

@import "../../src/extension/tree/tree.types.ts" @only=ITreeIndexOptions @full

排序选项可用于 `createNodes` 和 `moveNodes`：

- `toStart`：插入同级列表开头；
- `toEnd`：插入同级列表末尾；
- `prevNodeId`：插入指定兄弟节点之后；
- `nextNodeId`：插入指定兄弟节点之前；
- 同时指定 `prevNodeId` 和 `nextNodeId` 时，插入两个节点之间。

没有显式排序选项时：

1. 如果父级有 `childLastIndex`，新节点会追加到末尾；
2. 否则新节点使用空字符串 `index`。

频繁在同一位置插入会使分数索引变长，系统会在相关写入后尝试执行智能重排。

## 覆盖与冲突处理

覆盖选项用于 `setNodes` 和 `moveNodes`，用于定义同一父级下什么算冲突，以及冲突发生后的处理方式。

@import "../../src/extension/tree/tree.types.ts" @only=ITreeOverwriteOptions @full

常用配置示例：

```ts
await tree.setNodes(nodes, {
    uniqueBy: "name",
    overwriteMode: "replace",
})
```

### `uniqueBy`

默认按 `id` 判断冲突。文件同步场景通常使用 `name`，也可以使用点路径，例如 `meta.hash_md5`。

### `overwriteMode`

- `replace`：删除冲突节点后写入新节点；目录冲突可能递归删除整棵子树。
- `skip`：保留原节点，跳过冲突输入。
- `merge`：目录与目录冲突时保留目标目录，并将来源子树合并过去；其他冲突按替换处理。
- `mergeByModif`：目录合并时结合 `modif` 判断保留较新的数据。
- `newName`：不删除原节点，为输入节点生成不冲突的名称，例如 `文件 (1).txt`。

如果名称已经带有数字后缀，例如 `文件 (2).txt`，再次冲突时会递增为 `文件 (3).txt`，不会继续叠加新的后缀。

文件覆盖目录默认被禁止。设置 `enableFileOverwriteDir: true` 后，文件可以删除目标目录及其子树再写入。

## 公共接口

下面的接口是 `TableTree` 对外提供的高层方法。事务、MongoDB session 和 core 上下文不需要由调用方管理。

### `createNodes`

在指定父级下创建一批新节点：

```ts
await tree.createNodes(nodes, parentId, options?)
```

@import "../../src/extension/tree/core/createNodes.ts" @only=ITreeCreateNodesOptions @full

`createNodes` 只处理新建语义，不会根据已有 ID 自动转为更新或移动。父级必须存在，根层级使用 `/`。

### `updateNodes`

使用 TableDB 的 filter 和 update operator 更新已有节点：

```ts
await tree.updateNodes(filter, updateOp, options?)
```

@import "../../src/extension/tree/core/updateNodes.ts" @only=ITreeUpdateNodesOptions @full

它适合更新文件内容、名称、大小或业务扩展字段。`deep: true` 时会把更新扩展到后代节点。`parentId` 会被静默忽略，移动节点请使用 `moveNodes` 或 `setNodes`。

`updateNodes` 默认不启动数据库事务，这是设计上的轻量路径：更新操作不要求跨实例结构安全。如果一次操作同时包含创建、覆盖、移动、删除等结构变化，应使用 `setNodes`。

### `setNodes`

`setNodes` 是最适合文件同步和批量导入的高层接口：

```ts
await tree.setNodes(nodes, options?)
```

@import "../../src/extension/tree/tool/setNodes.ts" @only=ITreeSetNodesOptions @full

它会根据节点 ID 和覆盖选项自动拆解为：

1. 父子拓扑排序；
2. 冲突解析；
3. `createNodesCore`、`updateNodesCore`、`moveNodesCore`、`deleteNodesCore` 调用；
4. 父级和祖先 metadata 刷新。

适用场景包括：初始化目录、同步远端文件列表、恢复标记删除节点和目录合并。

### `deleteNodes`

删除节点及其全部后代：

```ts
await tree.deleteNodes(nodeIds, options?)
```

@import "../../src/extension/tree/core/deleteNodes.ts" @only=ITreeDeleteNodesOptions @full

启用 `enableMarkDelete` 时默认执行标记删除；`realDelete: true` 会执行物理删除，也可以清理已经标记删除的节点。

### `moveNodes`

将已有节点移动到新的父级：

```ts
await tree.moveNodes(nodeIds, parentId, options?)
```

@import "../../src/extension/tree/core/moveNodes.ts" @only=ITreeMoveNodesOptions @full

移动会校验目标父级、禁止移动到自身或后代，并更新旧父级和新父级的统计。它也支持排序选项和覆盖策略。

### `listNodes`

列出指定父级的直属子节点，不会递归展开子树：

```ts
const result = await tree.listNodes(parentId, options?)
```

@import "../../src/extension/tree/core/listNodes.ts" @only=ITreeListNodesOptions @full

支持分页、排序、投影、`onlyTypes`、`onlyNotTypes`、额外过滤条件和 `ignoreMarkDelete`。即使 `options.filter` 中传入其他 `parentId`，方法仍以参数 `parentId` 为准，避免查询越过当前父级范围。

### `refreshTreeMetadata`

修复指定节点及其子树的统计字段：

```ts
await tree.refreshTreeMetadata(parentId)
```

传入 `/` 刷新整棵可达树。该方法是修复工具，不是日常写入流程的一部分。

## 事务与多实例安全

### 结构操作

`createNodes`、`deleteNodes`、`moveNodes` 和 `setNodes` 属于结构操作：

- 同一个 `TableTree` 实例内会串行执行，避免并发读取旧的父级统计或排序信息；
- 如果 adapter 提供 `runTransaction`，这些操作会在同一个数据库事务中完成；
- MongoDB 事务中的所有读写都会使用事务绑定的 session；
- MongoDB adapter 默认会为逻辑主键 `id` 创建唯一索引，事务不能替代唯一约束；
- 如果 adapter 不支持事务，只能保证本实例串行，不能提供跨步骤原子回滚。

### 更新操作

`updateNodes` 默认不走事务，适合内容或业务字段更新。它不会被包装成对外可见的事务 API，也不应被当作多实例结构锁使用。

### MongoDB 使用前提

目录树结构操作会调用 adapter 的 `runTransaction`。MongoDB 部署必须支持事务，通常使用副本集或分片集群；单机 standalone MongoDB 不支持多文档事务。

建议保留 `MongoDBAdapter` 默认的 `ensureIdIndex: true`，让逻辑主键 `id` 具备数据库级唯一约束。如果已有等价的唯一索引，也可以关闭自动建索引，但不能只依赖事务防止重复节点。

事务中的读写由 `TableTree` 自动绑定到同一个 MongoDB session。业务代码不应在一次树操作中绕过 `TableTree`，直接使用外层 MongoDB collection 或未绑定 session 的 adapter。

### 调用建议

- 文件同步、目录导入：优先使用 `setNodes`；
- 用户拖拽移动：使用 `moveNodes`；
- 删除目录：使用 `deleteNodes`；
- 只改文件大小或扩展字段：使用 `updateNodes`；
- 发现统计不一致：调用 `refreshTreeMetadata` 修复。

## 旧接口说明

以下旧版接口不属于当前 `TableTree` 公共 API：复制节点、预同步、预覆盖、游标分页和独立的 `unDeleteNodes`。相关实现与测试仍保留在 `src/extension/treeOld`，只用于历史参考。
