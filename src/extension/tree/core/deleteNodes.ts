import type { ITreeNode } from "../tree.types"
import type { ITreeOperationContext } from "./context"
import { collectDescendantNodes } from "../util/collectDescendantNodes"
import { applyTreeMetadataDelta, calcTreeNodeContribution } from "../util/applyTreeMetadataDelta"

export interface ITreeDeleteNodesOptions {
    /** 强制物理删除；未启用标记删除时也会物理删除。 */
    realDelete?: boolean
}

export interface ITreeDeleteResult {
    hasDeleted: boolean
    hasChildDeleted: boolean
    deletedCount: number
}

/** 删除 core：读取子树、执行删除、刷新父级统计，调用方负责事务边界。 */
export async function deleteNodesCore(
    context: ITreeOperationContext,
    nodeIds: string[],
    options?: ITreeDeleteNodesOptions,
): Promise<ITreeDeleteResult> {
    const uniqueNodeIds = Array.from(new Set(nodeIds)).filter(Boolean)
    if (uniqueNodeIds.length === 0) return emptyDeleteResult()

    const nodes = await collectDescendantNodes(context.view as any, uniqueNodeIds, {
        includeSelf: true,
        ignoreMarkDelete: true,
    }) as ITreeNode[]
    if (nodes.length === 0) return emptyDeleteResult()

    const shouldRealDelete = options?.realDelete === true || context.tree.options?.enableMarkDelete !== true
    const deletableNodes = shouldRealDelete ? nodes : nodes.filter((node) => node._isDeleted !== true)
    if (deletableNodes.length === 0) return emptyDeleteResult()

    const deletedIds = new Set(deletableNodes.map((node) => node.id))
    const topDeletedNodes = deletableNodes.filter((node) => node._isDeleted !== true && !deletedIds.has(node.parentId))
    const modif = Date.now()

    if (shouldRealDelete) {
        await context.adapter.deleteMany({ id: { $in: deletableNodes.map((node) => node.id) } }, { readDelete: true } as any)
    } else {
        await context.adapter.updateMany(
            { id: { $in: deletableNodes.map((node) => node.id) }, _isDeleted: { $ne: true } } as any,
            { $set: { _isDeleted: true, _deleteDate: new Date(), modif } as any },
        )
    }

    await applyTreeMetadataDelta(context.view as any, topDeletedNodes.map((node) => {
        const contribution = calcTreeNodeContribution(node)
        return {
            parentId: node.parentId,
            ctotal: -contribution.ctotal,
            cftotal: -contribution.cftotal,
            csize: -contribution.csize,
            refreshChildLastIndex: true,
        }
    }), modif)

    return {
        hasDeleted: true,
        hasChildDeleted: deletableNodes.some((node) => !uniqueNodeIds.includes(node.id)),
        deletedCount: deletableNodes.length,
    }
}

function emptyDeleteResult(): ITreeDeleteResult {
    return { hasDeleted: false, hasChildDeleted: false, deletedCount: 0 }
}
