import type { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"
import { refreshTreeMetadata as refreshTreeMetadataUtil } from "../util/refreshTreeMetadata"

/**
 * 刷新树的元数据
 *
 * @param parentId 要刷新元数据的文件夹 ID，可以指定为 "/" 来刷新整个树的元数据
 */
export async function refreshTreeMetadata(
    table: TableTree<ITreeNode>,
    parentId: string,
): Promise<void> {
    await refreshChildrenFirst(table, parentId)
}

async function refreshChildrenFirst(
    table: TableTree<ITreeNode>,
    parentId: string,
): Promise<void> {
    const children = await table.findMany({ parentId }, { ignoreMarkDelete: true })
    for (const child of children) {
        await refreshChildrenFirst(table, child.id)
    }

    if (parentId !== "/") {
        await refreshTreeMetadataUtil(table, { nodeIds: [parentId] })
    }
}
