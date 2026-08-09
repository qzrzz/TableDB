import type { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"
import { refreshTreeMetadata as refreshTreeMetadataUtil } from "../util/refreshTreeMetadata"

/**
 * 递归刷新树的元数据
 * 从一个文件夹向下递归刷新 metadata 属性，保证 `ctotal`,`cftotal`,`csize` 正确
 */
export async function refreshTreeMetadata(
    table: TableTree<ITreeNode>,
    /** 要刷新元数据的文件夹 ID，可以指定为 "/" 来刷新整个树的元数据 */
    parentId: string,
): Promise<void> {
    // 递归刷新期间需要与树写操作串行化，避免父级统计读到子级的中间状态。
    await table.runTreeTransaction(() => refreshChildrenFirst(table, parentId))
}

async function refreshChildrenFirst(table: TableTree<ITreeNode>, parentId: string): Promise<void> {
    const children = await table.findMany({ parentId }, { ignoreMarkDelete: true })
    for (const child of children) {
        await refreshChildrenFirst(table, child.id)
    }

    if (parentId !== "/") {
        await refreshTreeMetadataUtil(table, { nodeIds: [parentId] })
    }
}
