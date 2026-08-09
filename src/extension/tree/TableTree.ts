import { Table, type ITableOptions } from "../../core/Table"
import { defineTable, type UseTableFunction } from "../../core/defineTable"
import type { ITreeNode } from "./tree.types"
import { runTreeMutation } from "./internal/runTreeMutation"
import { createNodesCore, type ITreeCreateNodesOptions, type ITreeCreateResult } from "./core/createNodes"
import { updateNodesCore, type ITreeUpdateNodesOptions } from "./core/updateNodes"
import { deleteNodesCore, type ITreeDeleteNodesOptions, type ITreeDeleteResult } from "./core/deleteNodes"
import { moveNodesCore, type ITreeMoveNodesOptions } from "./core/moveNodes"
import { setNodesTool, type ITreeSetNodesOptions, type ITreeSetNodesResult } from "./tool/setNodes"
import { listNodes as listNodesCore, type ITreeListNodesOptions, type ITreeListNodesResult } from "./core/listNodes"

/**
 * 目录树表的配置。
 *
 * 目录树没有额外的连接配置，直接复用 `Table` 的配置项，例如：
 * - `name`：底层表名；
 * - `adapter`：SQLite、MongoDB 或其他 TableDB 适配器；
 * - `enableMarkDelete`：是否使用标记删除；
 * - `indexes`、`autoMetadata` 等 Table 通用配置。
 *
 * 节点类型通过泛型传入后，业务自定义字段会在 `TableTree` 的读写接口中保留类型信息。
 */
export interface ITableTreeOptions<TNode extends ITreeNode = ITreeNode> extends ITableOptions<TNode> {}

/**
 * 基于 `Table` 的目录树实现。
 *
 * `TableTree` 负责把目录树的公开方法连接到对应的 core 或 tool：
 * - `createNodes` 只处理新节点创建；
 * - `updateNodes` 处理已有节点更新；
 * - `deleteNodes` 处理节点及其子树删除；
 * - `moveNodes` 处理节点移动、排序和覆盖冲突；
 * - `setNodes` 是面向调用方的编排工具，会按输入意图拆解为多个 core 操作；
 * - `listNodes` 只负责固定父节点范围并复用 Table 的分页查询能力。
 *
 * ## 事务和并发边界
 *
 * `TableTree` 不向外暴露事务对象，也不要求调用方理解 MongoDB session 或 SQLite
 * transaction。每个结构性写操作内部都会经过 `runTreeMutation`：
 *
 * 1. 同一个 `TableTree` 实例上的写操作会排队执行，避免本实例内多个异步调用同时
 *    读取旧的父级统计或排序索引；
 * 2. 如果适配器提供 `runTransaction`，创建、删除、移动和 set 操作会使用同一个
 *    事务绑定 adapter 完成全部读写；
 * 3. 如果适配器不支持事务，仍会保持本实例串行，但无法提供跨步骤原子回滚；
 * 4. core 只使用操作上下文，不直接访问 `TableTree.adapter`，因此 MongoDB 事务中的
 *    读写不会意外落到事务外的 session 上。
 *
 * `updateNodes` 有意使用非事务路径。更新文件大小、名称以外的扩展字段通常不需要
 * 跨多个文档的结构原子性；如果一次调用同时改变目录关系、覆盖策略和子树，应使用
 * `setNodes`，让工具在一个结构事务内编排 create/update/move/delete core。
 *
 * ## 节点和元数据
 *
 * 节点必须满足 `ITreeNode` 的基本结构。目录树会自动维护 `modif`、`cmodif`、
 * `ctotal`、`cftotal`、`csize` 和排序相关字段；调用方不应直接依赖或覆盖这些受管理字段。
 * 目录树允许文件节点拥有子节点，`isDir` 只表示业务类型，不是数据库层面的父子约束。
 * 根节点使用特殊父级 ID `/` 表示。
 *
 * 事务细节隐藏在内部执行器中，调用方只需要调用本类的普通方法并等待 Promise 完成。
 */
export class TableTree<TNode extends ITreeNode = ITreeNode> extends Table<TNode> {
    /**
     * 创建目录树表实例。
     *
     * 构造函数只负责把配置交给父类 `Table`。数据库连接、表结构和索引的初始化仍由
     * `Table` 的 `inited` Promise 管理，因此直接使用 `new TableTree()` 时应先等待
     * `table.inited`；使用 `defineTableTree()` 时，返回的 use 函数会等待初始化完成。
     */
    constructor(tableOptions: ITableTreeOptions<TNode>) {
        super(tableOptions)
    }

    /**
     * 在指定父节点下创建一批新节点。
     *
     * 该方法只接受“新建”语义，不负责根据 ID 判断节点应该更新还是移动；需要同时
     * 处理新建、更新、移动和覆盖时，应使用 `setNodes`。`parentId` 为 `/` 时表示
     * 创建在根层级，否则父节点必须已经存在。
     *
     * 创建过程会自动完成节点归一化、排序 index 分配、实际插入节点筛选以及父级和
     * 祖先统计刷新。适配器支持事务时，插入和 metadata 更新会在同一事务内完成。
     */
    createNodes = async (
        nodes: Partial<TNode>[],
        parentId: string,
        options?: ITreeCreateNodesOptions,
    ): Promise<ITreeCreateResult> => {
        // core 只接收事务绑定的操作上下文；这里的类型断言是把 TableTree 的业务泛型
        // 接到当前目录树 core 的通用节点接口，不改变运行时的事务边界。
        return runTreeMutation(this, (context) => createNodesCore(context as any, nodes as any, parentId, options))
    }

    /**
     * 更新符合过滤条件的已有节点。
     *
     * `filter` 和 `updateOp` 沿用 TableDB 的查询与更新操作符。方法会校验目录树相关
     * 字段，自动写入本次 `modif`，并在 `size`、`isDir`、`parentId` 或 `index` 变化时
     * 刷新受影响的父级统计。
     *
     * 此方法默认不启动数据库事务，这是目录树“更新不要求多实例结构安全”的约定。
     * 它仍会在同一实例内排队执行；需要跨多个 core 操作保持原子性时，应改用 `setNodes`。
     */
    updateNodes = async (
        filter: Parameters<typeof updateNodesCore>[1],
        updateOp: Parameters<typeof updateNodesCore>[2],
        options?: ITreeUpdateNodesOptions,
    ) => {
        // false 表示不启动适配器事务，但仍由 runTreeMutation 负责本实例内的执行排队。
        return runTreeMutation(this, (context) => updateNodesCore(context as any, filter, updateOp, options), false)
    }

    /**
     * 设置一批节点，使输入节点最终出现在指定的 ID、父级和覆盖策略状态。
     *
     * `setNodes` 是对外的高层工具，不是 core。它会先读取现状并解析冲突，再按父子
     * 拓扑调用 `createNodesCore`，并根据需要调用 `updateNodesCore`、`moveNodesCore`
     * 和 `deleteNodesCore`。因此同一批输入可以同时包含目录、目录子节点、已有节点和
     * 需要覆盖的节点。
     *
     * 创建、移动、删除和更新编排会共享同一个操作上下文；适配器支持事务时，批次中任意
     * 一步失败都会回滚此前已经完成的结构写入。`updateOnly`、`uniqueBy`、`overwriteMode`
     * 等行为由 `ITreeSetNodesOptions` 控制。
     */
    setNodes = async (
        nodes: Partial<TNode>[],
        options?: ITreeSetNodesOptions,
    ): Promise<ITreeSetNodesResult> => {
        // 工具在当前 context 内直接调用 core，避免每个子操作重新开启事务或重新排队。
        return runTreeMutation(this, (context) => setNodesTool(context as any, nodes as any, options), true)
    }

    /**
     * 删除指定节点及其全部后代。
     *
     * 启用 `enableMarkDelete` 时默认只写入标记删除字段，并从普通查询和父级统计中隐藏；
     * 传入 `realDelete: true` 时会物理删除节点。删除目录时会一次性处理整棵子树，且会
     * 按最外层节点计算父级统计，避免父子节点同时出现在输入中导致重复扣减。
     */
    deleteNodes = async (
        nodeIds: string[],
        options?: ITreeDeleteNodesOptions,
    ): Promise<ITreeDeleteResult> => {
        // 删除涉及节点状态、子树和父级 metadata，默认使用结构事务保证步骤原子性。
        return runTreeMutation(this, (context) => deleteNodesCore(context as any, nodeIds, options))
    }

    /**
     * 将已有节点移动到新的父节点下。
     *
     * 移动会校验目标父级存在、禁止把节点移动到自身或后代，并重新计算目标位置的
     * `index`。如果指定唯一键和覆盖模式，还会处理同级冲突以及目录合并。旧父级和新
     * 父级的 `ctotal`、`cftotal`、`csize`、`childLastIndex` 等统计会一起刷新。
     *
     * 移动使用 compare-and-set 形式检查旧 `parentId`，配合 MongoDB 事务重试可以避免
     * 多实例同时移动时静默覆盖另一实例的结果。
     */
    moveNodes = async (
        nodeIds: string[],
        parentId: string,
        options?: ITreeMoveNodesOptions,
    ) => {
        // 移动同时改变节点关系和两侧父级统计，属于必须保持原子性的结构操作。
        return runTreeMutation(this, (context) => moveNodesCore(context as any, nodeIds, parentId, options))
    }

    /**
     * 列出指定父节点的直属子节点。
     *
     * 该方法不会递归展开子树，默认按 `index` 升序返回；分页、排序、投影、类型过滤
     * 和标记删除可见性沿用 `Table.listPaging` 的选项。即使调用方在 `options.filter`
     * 中传入其他 `parentId`，实现仍会以方法参数为准，避免查询越过当前父级范围。
     *
     * 这是只读操作，不需要进入结构事务。
     */
    listNodes(
        parentId: string,
        options?: ITreeListNodesOptions,
    ): Promise<ITreeListNodesResult> {
        return listNodesCore.call(this as any, parentId, options)
    }
}

/**
 * 定义一个可复用的目录树表工厂。
 *
 * 该函数与 `defineTable` 保持一致：调用时只声明表配置，返回的函数在第一次使用时
 * 创建或复用 `TableTree` 实例，并等待底层表初始化完成。适合在应用启动阶段定义：
 *
 * ```ts
 * const useFileTree = defineTableTree<IFileNode>({
 *     name: "files",
 *     adapter: SQLiteAdapter({ filename: "files.db" }),
 * })
 *
 * const tree = await useFileTree()
 * await tree.createNodes([{ id: "readme", name: "README.md", isDir: false }], "/")
 * ```
 *
 * 工厂不会把事务对象暴露给调用方；事务选择和操作上下文绑定仍由 `TableTree` 内部完成。
 */
export function defineTableTree<TNode extends ITreeNode = ITreeNode>(
    tableOptions: ITableTreeOptions<TNode>,
): UseTableFunction<TNode, TableTree<TNode>> {
    return defineTable(tableOptions, TableTree as any)
}
