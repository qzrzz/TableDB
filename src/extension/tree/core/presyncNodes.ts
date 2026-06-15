export interface ITreePreSyncNodeResult {
    /** 是否需要同步 */
    needSync: boolean
    /** 需要同步的节点 ID 列表 */
    syncNodeIds: string[]
}

/**
 * 预同步节点
 * 提供一些列节点和其 modif、cmodif 检查它们与数据库内节点是否一致，返回结果
 */
export async function presyncNodes(
    this: TableTree<ITreeNode>,
    /** 要检查的节点数据列表 */
    nodeModifs: { id: string; modif?: number; cmodif?: number }[],
): Promise<ITreePreSyncNodeResult> {}
