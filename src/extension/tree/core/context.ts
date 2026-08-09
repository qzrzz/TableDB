import type {
    ITableDBAdapterInstance,
    ITableFindOptions,
    ITableSetOptions,
    ITableDeletedResult,
    ITableInsertResult,
    ITableUpdateOptions,
    ITableUpdateResult,
} from "../../../adapter/adapter"
import type { ITableFilter } from "../../../core/types"
import type { ITableUpdateOp } from "../../../core/types"
import type { ITreeNode } from "../tree.types"
import type { TableTree } from "../TableTree"

/**
 * tree 的一次写操作上下文。
 * adapter 是事务绑定实例；core 不直接使用 Table.adapter，避免 MongoDB session 丢失。
 */
export interface ITreeOperationContext<TNode extends ITreeNode = ITreeNode> {
    tree: TableTree<TNode>
    adapter: ITableDBAdapterInstance
    view: TreeOperationView<TNode>
}

/**
 * 将 adapter 包装成 tree 工具需要的最小 Table 视图。
 * 所有读取和写入都从这里经过，因此事务上下文可以被完整传递到旧的纯工具函数。
 */
export class TreeOperationView<TNode extends ITreeNode = ITreeNode> {
    constructor(
        private readonly tree: TableTree<TNode>,
        private readonly adapter: ITableDBAdapterInstance,
    ) {}

    async get(id: any, options?: { ignoreMarkDelete?: boolean }): Promise<TNode | void> {
        const doc = await this.adapter.get(id)
        if (!doc) return undefined
        if (this.isHidden(doc, options?.ignoreMarkDelete)) return undefined
        return doc as TNode
    }

    async has(id: any, options?: { ignoreMarkDelete?: boolean }): Promise<boolean> {
        return Boolean(await this.get(id, options))
    }

    async findMany(filter: ITableFilter, options?: ITableFindOptions): Promise<TNode[]> {
        const { ignoreMarkDelete, ...adapterOptions } = options ?? {}
        const query = this.withVisibilityFilter(filter, ignoreMarkDelete)
        return await this.adapter.findMany(query, adapterOptions) as TNode[]
    }

    async findOne(filter: ITableFilter, options?: ITableFindOptions): Promise<TNode | void> {
        const { ignoreMarkDelete, ...adapterOptions } = options ?? {}
        const query = this.withVisibilityFilter(filter, ignoreMarkDelete)
        return await this.adapter.findOne(query, adapterOptions) as TNode | void
    }

    async updateMany(
        filter: ITableFilter,
        updateOp: ITableUpdateOp<TNode>,
        options?: ITableUpdateOptions,
    ): Promise<ITableUpdateResult> {
        return this.adapter.updateMany(filter, updateOp, options)
    }

    async bulkUpdate(
        updates: Parameters<ITableDBAdapterInstance["bulkUpdate"]>[0],
    ): Promise<ITableUpdateResult> {
        return this.adapter.bulkUpdate(updates)
    }

    async insertMany(docs: Partial<TNode>[]): Promise<ITableInsertResult> {
        return this.adapter.insertMany(docs)
    }

    async setMany(docs: Partial<TNode>[], options?: ITableSetOptions) {
        return this.adapter.setMany(docs, options)
    }

    async deleteMany(filter: ITableFilter, options?: any): Promise<ITableDeletedResult> {
        return this.adapter.deleteMany(filter, options)
    }

    private isHidden(doc: any, ignoreMarkDelete?: boolean): boolean {
        return this.tree.options?.enableMarkDelete === true && ignoreMarkDelete !== true && doc._isDeleted === true
    }

    private withVisibilityFilter(filter: ITableFilter, ignoreMarkDelete?: boolean): ITableFilter {
        if (this.tree.options?.enableMarkDelete !== true || ignoreMarkDelete === true) return filter
        return {
            $and: [filter, { _isDeleted: { $ne: true } }],
        } as ITableFilter
    }
}

export function createTreeOperationContext<TNode extends ITreeNode>(
    tree: TableTree<TNode>,
    adapter: ITableDBAdapterInstance,
): ITreeOperationContext<TNode> {
    return {
        tree,
        adapter,
        view: new TreeOperationView(tree, adapter),
    }
}
