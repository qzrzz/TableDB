import { smartRebalance } from "indexless"
import type { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"
import { refreshTreeMetadata } from "./refreshTreeMetadata"

export interface IRebalanceTreeIndexesOptions {
    /** 触发重排的 index 最大长度。 */
    maxIndexLength?: number
}

/** 对单个父级下刚写入的 index 区间执行智能重排。 */
export async function rebalanceTreeIndexes<TNode extends ITreeNode>(
    table: TableTree<TNode>,
    parentId: string,
    items: { id: string; index?: string }[],
    options?: IRebalanceTreeIndexesOptions,
): Promise<void> {
    const indexedItems = items.filter((item): item is { id: string; index: string } => Boolean(item.index))
    if (indexedItems.length === 0) return

    const result = await smartRebalance(
        { items: indexedItems },
        {
            maxIndexLength: options?.maxIndexLength,
            getPrevIndexes: async (index, count = 5) => {
                return table.findMany(
                    { parentId, index: { $lt: index } },
                    { sort: { index: -1 }, limit: count, projection: ["id", "index"] },
                ) as any
            },
            getNextIndexes: async (index, count = 5) => {
                return table.findMany(
                    { parentId, index: { $gt: index } },
                    { sort: { index: 1 }, limit: count, projection: ["id", "index"] },
                ) as any
            },
            setIndexes: async (reqs) => {
                const modif = Date.now()
                await table.bulkUpdate(
                    reqs.map((req) => ({
                        filter: "id" in req ? { id: req.id } : { parentId, index: req.index },
                        // index 重排会改变节点排序状态，需要同步更新节点自身的修改计数。
                        updateOp: { $set: { index: req.newIndex, modif } as any },
                    })),
                )
            },
        },
    )

    if (result.rebalanced) {
        await refreshTreeMetadata(table, { parentIds: [parentId], cmodif: Date.now() })
    }
}
