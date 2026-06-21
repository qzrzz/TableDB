import type { TableTree } from "../TableTree"
import type { ITreeNode, ITreeOverwriteOptions, ITreeIndexOptions, ITreeChangeResult } from "../tree.types"
import { resolveTreeIndexes } from "../util/resolveTreeIndex"
import { resolveOverwriteNodes } from "../util/resolveOverwriteNodes"
import { rebalanceTreeIndexes } from "../util/rebalanceTreeIndexes"
import { assertNotMoveIntoSelfOrDescendant, assertTreeParentExists } from "../util/assertTreeParent"
import { refreshTreeMetadata } from "../util/refreshTreeMetadata"
import { repairDuplicatedSiblingNames } from "../util/repairDuplicatedSiblingNames"
import { repairDuplicatedSiblingConflicts } from "../util/repairDuplicatedSiblingConflicts"

/** 移动节点选项 */
export interface ITreeMoveNodesOptions extends ITreeOverwriteOptions {
    /** 自动更新排序索引配置 */
    index?: ITreeIndexOptions
}

interface IApplyMoveOverwriteResult {
    /** 覆盖策略处理后仍需要移动到目标父级的节点。 */
    nodes: ITreeNode[]
    /** merge / replace 删除等覆盖处理是否已经产生真实变更。 */
    hasChanged: boolean
    /** 覆盖处理内部已经产生的变更时间。 */
    modif?: number
}

/** 移动节点
 *
 *  把目标节点移动到新的父节点下，遵循覆盖设置
 */
export async function moveNodes(
    this: TableTree<ITreeNode>,
    /** 要移动的节点 id 列表 */
    nodeIds: string[],
    /** 目标父节点 id ，如果为 "/" 表示根节点 */
    parentId: string,
    options?: ITreeMoveNodesOptions,
): Promise<ITreeChangeResult> {
    const uniqueNodeIds = Array.from(new Set(nodeIds)).filter(Boolean)
    if (uniqueNodeIds.length === 0) return {}
    await assertTreeParentExists(this, parentId)

    const sourceNodes = (await Promise.all(uniqueNodeIds.map((nodeId) => this.get(nodeId)))).filter(
        (node): node is ITreeNode => !!node,
    )
    const nodes = await filterNestedMoveRoots.call(this, sourceNodes)
    if (nodes.length === 0) return {}

    await assertNotMoveIntoSelfOrDescendant(this, nodes.map((node) => node.id), parentId)

    const overwriteResult = await applyMoveOverwrite.call(this, nodes, parentId, options)
    const movableNodes = overwriteResult.nodes
    if (movableNodes.length === 0) {
        if (!overwriteResult.hasChanged) return {}
        const modif = overwriteResult.modif ?? Date.now()
        return {
            modif,
            cmodif: modif,
        }
    }

    const indexes = await resolveTreeIndexes(this, parentId, movableNodes.length, options?.index)
    // 多用户并发移动时，目标父级可能在前置校验后被其他用户移动到来源节点下面。
    // 写入前按当前数据库状态再校验一次，避免形成父级环后才在 metadata 刷新阶段失败。
    await assertNotMoveIntoSelfOrDescendant(this, movableNodes.map((node) => node.id), parentId)
    const modif = Date.now()
    const oldParentIds = Array.from(new Set(movableNodes.map((node) => node.parentId)))
    await this.bulkUpdate(movableNodes.map((node, index) => ({
        filter: { id: node.id },
        updateOp: {
            $set: {
                parentId,
                index: indexes[index],
                name: node.name,
                modif,
            },
        },
    })))
    await rollbackMoveIfCycleCreated.call(this, movableNodes, parentId, modif)
    await rebalanceTreeIndexes(this, parentId, movableNodes.map((node, index) => ({ id: node.id, index: indexes[index] })))
    await refreshTreeMetadata(this, {
        parentIds: [parentId, ...oldParentIds],
        cmodif: modif,
    })
    if (options?.overwriteMode === "newName" && (options.uniqueBy ?? "id") === "name") {
        await repairDuplicatedSiblingNames(this, parentId, movableNodes.map((node) => node.id))
    }
    if (["replace", "skip", "merge", "mergeByModif"].includes(options?.overwriteMode ?? "replace")) {
        await repairDuplicatedSiblingConflicts(
            this,
            parentId,
            options?.uniqueBy ?? "id",
            movableNodes.map((node) => node.id),
            options?.overwriteMode ?? "replace",
        )
    }

    return {
        modif,
        cmodif: modif,
    }
}

async function rollbackMoveIfCycleCreated(
    this: TableTree<ITreeNode>,
    oldNodes: ITreeNode[],
    parentId: string,
    modif: number,
): Promise<void> {
    try {
        await assertNotMoveIntoSelfOrDescendant(this, oldNodes.map((node) => node.id), parentId)
    } catch (error) {
        // 并发交叉移动可能在写入后才形成父级环；必须回滚本次移动，不能把坏状态留给后续 metadata 刷新。
        await this.bulkUpdate(oldNodes.map((node) => ({
            filter: { id: node.id },
            updateOp: {
                $set: {
                    parentId: node.parentId,
                    index: node.index,
                    name: node.name,
                    modif,
                },
            },
        })))
        await refreshTreeMetadata(this, {
            parentIds: [parentId, ...oldNodes.map((node) => node.parentId)],
            cmodif: modif,
        })
        throw error
    }
}

async function applyMoveOverwrite(
    this: TableTree<ITreeNode>,
    nodes: ITreeNode[],
    parentId: string,
    options?: ITreeMoveNodesOptions,
): Promise<IApplyMoveOverwriteResult> {
    const resolved = await resolveOverwriteNodes(this, parentId, nodes, {
        ...options,
        ignoreNodeIds: nodes.map((node) => node.id),
    })
    let hasChanged = false
    let changedModif: number | undefined
    if (resolved.deleteNodeIds.length > 0) {
        await this.deleteNodes(resolved.deleteNodeIds)
        hasChanged = true
        changedModif = Date.now()
    }
    for (const pair of resolved.mergePairs) {
        changedModif = await mergeMoveDir.call(this, pair.sourceNode, pair.targetNode, options) ?? changedModif
        hasChanged = true
    }

    return {
        nodes: resolved.nodes,
        hasChanged,
        modif: changedModif,
    }
}

async function mergeMoveDir(
    this: TableTree<ITreeNode>,
    sourceNode: ITreeNode,
    targetNode: ITreeNode,
    options?: ITreeMoveNodesOptions,
): Promise<number | undefined> {
    let changedModif: number | undefined
    const children = await this.findMany({ parentId: sourceNode.id }, { sort: { index: 1 } })
    if (children.length > 0) {
        const result = await this.moveNodes(children.map((child) => child.id), targetNode.id, options)
        changedModif = result.cmodif ?? result.modif
    }
    await this.deleteNodes([sourceNode.id])
    const target = await this.get(targetNode.id)
    return target?.cmodif ?? changedModif
}

async function filterNestedMoveRoots(
    this: TableTree<ITreeNode>,
    nodes: ITreeNode[],
): Promise<ITreeNode[]> {
    const selectedIds = new Set(nodes.map((node) => node.id))
    const roots: ITreeNode[] = []

    for (const node of nodes) {
        let parentId = node.parentId
        let hasSelectedAncestor = false
        while (parentId && parentId !== "/") {
            if (selectedIds.has(parentId)) {
                hasSelectedAncestor = true
                break
            }
            const parentNode = await this.get(parentId, { ignoreMarkDelete: true })
            parentId = parentNode?.parentId ?? "/"
        }
        // 批量移动时如果父目录已被选中，子节点会随父目录一起移动，不应再被单独平铺移动。
        if (!hasSelectedAncestor) {
            roots.push(node)
        }
    }

    return roots
}
