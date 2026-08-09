import type { TableTree } from "../TableTree"
import type { ITreeNode, ITreeOverwriteOptions, ITreeIndexOptions, ITreeChangeResult } from "../tree.types"
import { resolveTreeIndexes } from "../util/resolveTreeIndex"
import { resolveOverwriteNodes } from "../util/resolveOverwriteNodes"
import { rebalanceTreeIndexes } from "../util/rebalanceTreeIndexes"
import { assertNotMoveIntoSelfOrDescendant, assertTreeParentExists } from "../util/assertTreeParent"
import { refreshTreeMetadata } from "../util/refreshTreeMetadata"
import { collectTopSelectedNodes } from "../util/collectTopSelectedNodes"
import { repairTreeOverwriteConflicts } from "../util/repairTreeOverwriteConflicts"
import { deleteNodes } from "./deleteNodes"

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

/**
 * 移动节点
 *
 * 把节点移动到新的父级下，并按覆盖策略处理目标父级中的冲突节点。
 *
 * 核心流程：
 * 1. 去重输入 ID、校验目标父级，并过滤掉父子混合选择中的后代节点。
 * 2. 先校验不会移动到自身或后代，避免形成父级环。
 * 3. 按覆盖策略解析目标父级冲突：replace 删除冲突目标，skip 跳过来源，merge 递归合并目录。
 * 4. 为仍需移动的节点分配目标父级下的新 index，并在写入前再次校验父级环。
 * 5. 批量更新 parentId/index/modif，写入后再次检测并发造成的环；若发现坏状态立即回滚本次移动。
 * 6. 重排目标父级 index，刷新新旧父级及祖先 metadata，并做并发冲突兜底修复。
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

    // 批量移动父目录和后代时，只移动父目录；后代会随父目录天然保留在子树中。
    const nodes = await collectTopSelectedNodes(this, uniqueNodeIds)
    if (nodes.length === 0) return {}

    await assertNotMoveIntoSelfOrDescendant(this, nodes.map((node) => node.id), parentId)

    const overwriteResult = await applyMoveOverwrite.call(this, nodes, parentId, options)
    const movableNodes = overwriteResult.nodes
    if (movableNodes.length === 0) {
        // 覆盖策略可能只产生了删除或合并副作用；没有副作用时才返回空结果。
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
    await repairTreeOverwriteConflicts(this, parentId, movableNodes.map((node) => node.id), options)

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
        // 写入后再校验一次，覆盖并发交叉移动导致的“校验后状态被别人改坏”的窗口。
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
    // 移动时目标父级下可能已经有同 ID 或同 uniqueBy 节点；来源节点自身不应被当成冲突目标。
    const resolved = await resolveOverwriteNodes(this, parentId, nodes, {
        ...options,
        ignoreNodeIds: nodes.map((node) => node.id),
    })
    let hasChanged = false
    let changedModif: number | undefined
    if (resolved.deleteNodeIds.length > 0) {
        // replace 类策略会先删除目标冲突节点，后续再把来源节点移动过去。
        await deleteNodes.call(this, resolved.deleteNodeIds)
        hasChanged = true
        changedModif = Date.now()
    }
    for (const pair of resolved.mergePairs) {
        // merge 策略保留目标目录，把来源目录的子节点递归迁入目标目录，最后删除来源目录。
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
        // 子节点进入的是新的目标目录，外层移动使用的 prev/next 锚点不属于这个父级，递归时只能追加到末尾。
        const childOptions = options
            ? { ...options, index: { toEnd: true } }
            : undefined
        // 递归调用 moveNodes 复用覆盖策略和 metadata 维护逻辑，避免 merge 自己维护一套规则。
        // 递归合并属于同一个外层移动事务，直接调用核心函数避免重新进入实例队列。
        const result = await moveNodes.call(this, children.map((child) => child.id), targetNode.id, childOptions)
        changedModif = result.cmodif ?? result.modif
    }
    await deleteNodes.call(this, [sourceNode.id])
    const target = await this.get(targetNode.id)
    return target?.cmodif ?? changedModif
}
