import type { ITableDBAdapterInstance } from "../../../adapter/adapter"
import type { ITreeNode } from "../tree.types"
import type { TableTree } from "../TableTree"
import { createTreeOperationContext, type ITreeOperationContext } from "../core/context"

/**
 * tree 内部写操作执行器。
 *
 * 事务、同实例串行队列和事务 adapter 绑定都放在这里，TableTree 对外只保留
 * create/set/move/delete/update 等树操作，不暴露数据库事务概念。
 */
const operationTails = new WeakMap<object, Promise<void>>()

export async function runTreeMutation<TNode extends ITreeNode, TResult>(
    tree: TableTree<TNode>,
    callback: (context: ITreeOperationContext<TNode>) => Promise<TResult>,
    transactional = true,
): Promise<TResult> {
    let release!: () => void
    const previous = operationTails.get(tree) ?? Promise.resolve()
    const current = new Promise<void>((resolve) => { release = resolve })
    operationTails.set(tree, current)
    await previous

    try {
        const adapter = tree.adapter
        const run = async (boundAdapter: ITableDBAdapterInstance) => {
            return callback(createTreeOperationContext(tree, boundAdapter))
        }

        if (!transactional || typeof adapter.runTransaction !== "function") {
            return await run(adapter)
        }

        return await adapter.runTransaction(
            // 兼容旧 adapter：事务实现没有回传绑定实例时退回当前 adapter。
            (transaction) => run(transaction ?? adapter),
        )
    } finally {
        release()
        if (operationTails.get(tree) === current) operationTails.delete(tree)
    }
}
