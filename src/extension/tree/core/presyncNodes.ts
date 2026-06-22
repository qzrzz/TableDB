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
 *
 * 用客户端保存的 modif / cmodif 与当前数据库中的节点状态做轻量对比，
 * 帮助客户端在写入或拉取前判断哪些节点需要重新同步。
 *
 * 核心流程：
 * 1. 逐个读取当前可见节点；软删除节点在默认读取语义下视为不存在。
 * 2. 找不到节点时放入 deletedNodeIds，表示客户端本地节点已经失效。
 * 3. 如果传入的 modif 或 cmodif 任意一个与线上值不同，放入 syncNodeIds。
 * 4. 未传 modif/cmodif 的已有节点不触发同步，便于调用方只检查自己关心的计数。
 * 5. 保留重复输入对应的重复结果，避免调用方依赖输入顺序时丢失信息。
 */
export async function presyncNodes(
    this: TableTree<ITreeNode>,
    /** 要检查的节点数据列表 */
    nodeModifs: { id: string; modif?: number; cmodif?: number }[],
): Promise<ITreePreSyncNodeResult> {
    const syncNodeIds: string[] = []
    const deletedNodeIds: string[] = []

    for (const item of nodeModifs) {
        // 默认 get 不读取已标记删除节点，因此软删除在预同步语义里等同于线上不存在。
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
