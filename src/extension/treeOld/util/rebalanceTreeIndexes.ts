import { getIndexesBetween, smartRebalance } from "indexless"
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

    const duplicatedIndexesRebalanced = await rebalanceDuplicatedSiblingIndexes(table, parentId)

    if (result.rebalanced || duplicatedIndexesRebalanced) {
        await refreshTreeMetadata(table, { parentIds: [parentId], cmodif: Date.now() })
    }
}

/** 多用户并发写入时可能基于同一个旧 childLastIndex 生成相同 index，这里兜底恢复同级排序唯一性。 */
async function rebalanceDuplicatedSiblingIndexes<TNode extends ITreeNode>(
    table: TableTree<TNode>,
    parentId: string,
): Promise<boolean> {
    const siblings = (await table.findMany(
        { parentId },
        { sort: { index: 1 }, projection: ["id", "index", "modif"] },
    ) as Pick<TNode, "id" | "index" | "modif">[]).filter((node) => Boolean(node.index))
    const indexes = siblings.map((node) => node.index).filter((index): index is string => Boolean(index))
    if (new Set(indexes).size === indexes.length) {
        return false
    }

    const orderedSiblings = [...siblings].sort((left, right) => {
        const byIndex = compareIndex(left.index ?? "", right.index ?? "")
        if (byIndex !== 0) return byIndex
        const byModif = (left.modif ?? 0) - (right.modif ?? 0)
        if (byModif !== 0) return byModif
        return compareIndex(String(left.id), String(right.id))
    })
    const nextIndexes = getIndexesBetween(null, null, orderedSiblings.length)
    const modif = Date.now()
    await table.bulkUpdate(
        orderedSiblings.map((node, index) => ({
            filter: { id: node.id },
            updateOp: { $set: { index: nextIndexes[index], modif } as any },
        })),
    )

    return true
}

function compareIndex(left: string, right: string): number {
    if (left < right) return -1
    if (left > right) return 1
    return 0
}
