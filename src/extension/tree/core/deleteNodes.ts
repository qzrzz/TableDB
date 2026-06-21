import type { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"
import { collectDescendantNodes } from "../util/collectDescendantNodes"
import { applyTreeMetadataDelta, calcTreeNodeContribution } from "../util/applyTreeMetadataDelta"

/** 删除节点选项 */
export interface ITreeDeleteNodesOptions {
    /** 是否强制物理删除 */
    realDelete?: boolean
}

/** 删除节点结果 */
export interface ITreeDeleteResult {
    /** 是否有节点被删除 */
    hasDeleted: boolean
    /** 是否有子节点被删除 */
    hasChildDeleted: boolean
    /** 被删除的节点数量 */
    deletedCount: number
}

/**
 * 删除节点
 *
 * 子节点也会被递归删除
 * 要注意递归删除可能会导致性能问题，尤其是当删除的节点有大量子孙节点时。
 * 
 */
export async function deleteNodes(
    this: TableTree<ITreeNode>,
    /** 要删除的节点 id 列表 */
    nodeIds: string[],
    options?: ITreeDeleteNodesOptions,
): Promise<ITreeDeleteResult> {
    const uniqueNodeIds = Array.from(new Set(nodeIds)).filter(Boolean)
    if (uniqueNodeIds.length === 0) {
        return { hasDeleted: false, hasChildDeleted: false, deletedCount: 0 }
    }

    const nodes = await collectDescendantNodes(this, uniqueNodeIds, {
        includeSelf: true,
        ignoreMarkDelete: true,
    })
    if (nodes.length === 0) {
        return { hasDeleted: false, hasChildDeleted: false, deletedCount: 0 }
    }

    const deleteIds = nodes.map((node) => node.id)
    const topDeletedNodes = collectTopDeletedNodes(nodes)
    const modif = Date.now()

    const shouldRealDelete = options?.realDelete === true || this.options?.enableMarkDelete !== true
    if (shouldRealDelete) {
        await this.deleteMany({ id: { $in: deleteIds } }, { realDelete: true, readDelete: true } as any)
    } else {
        await this.updateMany(
            { id: { $in: deleteIds } },
            {
                $set: {
                    _isDeleted: true,
                    _deleteDate: new Date(),
                    modif,
                } as any,
            },
        )
    }

    await applyTreeMetadataDelta(this, topDeletedNodes.map((node) => {
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
        hasChildDeleted: nodes.some((node) => !uniqueNodeIds.includes(node.id)),
        deletedCount: nodes.length,
    }
}

/** 删除父子混合输入时，只用最外层被删除节点计算对可见树的贡献变化，避免后代重复扣减。 */
function collectTopDeletedNodes(nodes: ITreeNode[]): ITreeNode[] {
    const deletedNodeIds = new Set(nodes.map((node) => node.id))
    return nodes.filter((node) => node._isDeleted !== true && !deletedNodeIds.has(node.parentId))
}
