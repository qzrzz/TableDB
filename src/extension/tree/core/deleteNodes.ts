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
 * 删除指定节点及其全部后代。
 *
 * 核心流程：
 * 1. 去重输入 ID，并读取这些节点连同所有后代，确保目录删除会覆盖整棵子树。
 * 2. 计算“最外层被删除节点”，父子同时删除时只用父节点扣减 metadata，避免后代重复扣减。
 * 3. 根据 TableTree 的标记删除配置选择物理删除或软删除；软删除会写入统一 modif。
 * 4. 用最外层节点对父级的贡献量做负增量，刷新父级及祖先的统计和 childLastIndex。
 *
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
    // 只统计可见树中真正从父级“消失”的入口节点，防止父子混合输入导致重复扣减。
    const topDeletedNodes = collectTopDeletedNodes(nodes)
    const modif = Date.now()

    const shouldRealDelete = options?.realDelete === true || this.options?.enableMarkDelete !== true
    if (shouldRealDelete) {
        // 物理删除要允许读取已标记删除记录，否则 realDelete 无法清理之前软删过的节点。
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
