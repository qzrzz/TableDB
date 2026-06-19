import type { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"

export interface ITreePreSyncNodeResult {
    /** 是否需要同步 */
    needSync: boolean
    /** 需要同步的节点 ID 列表 */
    syncNodeIds: string[]
    /** 线上不存在的 ID 列表 */
    deletedNodeIds: string[]
}

/**
 * 预同步节点
 * 提供一些列节点和其 modif、cmodif 检查它们与数据库内节点是否一致，返回结果
 * 如果提供节点在线上不存在，放入 deletedNodeIds
 */
export async function presyncNodes(
    this: TableTree<ITreeNode>,
    /** 要检查的节点数据列表 */
    nodeModifs: { id: string; modif?: number; cmodif?: number }[],
): Promise<ITreePreSyncNodeResult> {
    const syncNodeIds: string[] = []
    const deletedNodeIds: string[] = []

    for (const item of nodeModifs) {
        const node = await this.get(item.id)
        if (!node) {
            deletedNodeIds.push(item.id)
            continue
        }
        if (
            (item.modif !== undefined && node.modif !== item.modif) ||
            (item.cmodif !== undefined && node.cmodif !== item.cmodif)
        ) {
            syncNodeIds.push(item.id)
        }
    }

    return {
        needSync: syncNodeIds.length > 0 || deletedNodeIds.length > 0,
        syncNodeIds,
        deletedNodeIds,
    }
}
