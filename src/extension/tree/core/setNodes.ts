import type { TableTree } from "../TableTree"
import type { ITreeNode, ITreeOverwriteOptions, ITreeIndexOptions, ITreeChangeResult } from "../tree.types"
import { ITreePreSyncNodeResult } from "./presyncNodes"
import { normalizeWritableNode } from "../util/normalizeWritableNode"
import { refreshTreeMetadata } from "../util/refreshTreeMetadata"
import { resolveTreeIndexes } from "../util/resolveTreeIndex"
import { resolveOverwriteNodes } from "../util/resolveOverwriteNodes"
import { rebalanceTreeIndexes } from "../util/rebalanceTreeIndexes"
import { assertTreeParentExists } from "../util/assertTreeParent"

/** 设置节点选项 */
export type ITreeSetNodesOptions = ITreeOverwriteOptions & {
    /** 是否只更新已存在的节点（不会创建新节点） */
    updateOnly?: boolean

    /** 自动更新排序索引配置 */
    index?: ITreeIndexOptions

    /**
     * 是否进行预同步（pre-sync）检查。
     * 返回
     */
    presync?: boolean
}

/** 设置节点
 *  设置节点数据，已存在的节点会被覆盖，不存在的节点会被创建
 *
 *  如果在 `nodes` 中提供了 `oldModif`, `oldCmodif` 字段，它们会被用来进行预同步检查（pre-sync）而不会被设置到节点上。
 *
 *  流程：
 *  1. 创建本次操作的 newModif
 *  2. 根据 ITreeOverwriteOptions 的配置，找出所有受影响的节点
 *  3. 如果 options.presync 为 true，并且提供了 oldModif/oldCmodif 收集信息
 *  4. 更新数据（使用 Table.setMany() 方法实现）
 *  5. 如果有 index 配置，更新排序索引
 *  6. 进行 metadata 维护
 *
 * 要注意如果修改了节点的 parentId 需要触发相应的 metadata 变更，并且遵守 ITreeOverwriteOptions 覆盖设置和 index 规则
 */
export async function setNodes(
    this: TableTree<ITreeNode>,
    /** 要设置的节点数据列表 */
    nodes: Partial<ITreeNode>[],
    options?: ITreeSetNodesOptions,
): Promise<ITreeChangeResult & Partial<ITreePreSyncNodeResult>> {
    if (nodes.length === 0) return {}

    const modif = Date.now()
    const presyncResult = options?.presync
        ? await this.presyncNodes(
              nodes
                  .filter((node: any) => node.id && (node.oldModif !== undefined || node.oldCmodif !== undefined))
                  .map((node: any) => ({ id: node.id, modif: node.oldModif, cmodif: node.oldCmodif })),
          )
        : undefined

    let writableNodes = nodes.map((node) => {
        const { oldModif, oldCmodif, ...nodeData } = node as any
        return normalizeWritableNode(nodeData, { modif }) as ITreeNode
    })
    const oldParentIds = await collectExistingParentIds.call(this, writableNodes)

    writableNodes = await applySetOverwrite.call(this, writableNodes, options)

    const nodesByParentId = new Map<string, ITreeNode[]>()
    for (const node of writableNodes) {
        const list = nodesByParentId.get(node.parentId) ?? []
        list.push(node)
        nodesByParentId.set(node.parentId, list)
    }
    await assertSetNodeParents.call(this, writableNodes, nodesByParentId)

    await applySetNodeIndexes.call(this, nodesByParentId, options)

    await this.setMany(writableNodes, { updateOnly: options?.updateOnly })
    for (const [parentId, parentNodes] of nodesByParentId) {
        await rebalanceTreeIndexes(this, parentId, parentNodes.map((node) => ({ id: node.id, index: node.index })))
    }
    await refreshTreeMetadata(this, {
        parentIds: [...Array.from(nodesByParentId.keys()), ...oldParentIds],
        nodeIds: writableNodes.map((node) => node.id),
        cmodif: modif,
    })

    return {
        modif,
        cmodif: modif,
        ...presyncResult,
    }
}

async function assertSetNodeParents(
    this: TableTree<ITreeNode>,
    writableNodes: ITreeNode[],
    nodesByParentId: Map<string, ITreeNode[]>,
): Promise<void> {
    const batchNodeIds = new Set(writableNodes.map((node) => node.id))
    for (const parentId of nodesByParentId.keys()) {
        if (parentId === "/" || batchNodeIds.has(parentId)) {
            continue
        }
        await assertTreeParentExists(this, parentId)
    }
}

async function applySetNodeIndexes(
    this: TableTree<ITreeNode>,
    nodesByParentId: Map<string, ITreeNode[]>,
    options?: ITreeSetNodesOptions,
): Promise<void> {
    for (const [parentId, parentNodes] of nodesByParentId) {
        if (options?.index) {
            const indexes = await resolveTreeIndexes(this, parentId, parentNodes.length, options.index)
            for (let i = 0; i < parentNodes.length; i++) {
                parentNodes[i].index = indexes[i]
            }
            continue
        }

        const nodesNeedIndex: ITreeNode[] = []
        for (const node of parentNodes) {
            const oldNode = await this.get(node.id, { ignoreMarkDelete: true })
            if (oldNode && oldNode.parentId === node.parentId) {
                node.index = node.index || oldNode.index || ""
                continue
            }
            if (!node.index) {
                nodesNeedIndex.push(node)
            }
        }

        if (nodesNeedIndex.length > 0) {
            const indexes = await resolveTreeIndexes(this, parentId, nodesNeedIndex.length)
            for (let i = 0; i < nodesNeedIndex.length; i++) {
                nodesNeedIndex[i].index = indexes[i]
            }
        }
    }
}

async function applySetOverwrite(
    this: TableTree<ITreeNode>,
    nodes: ITreeNode[],
    options?: ITreeSetNodesOptions,
): Promise<ITreeNode[]> {
    const nextNodes: ITreeNode[] = []
    let pendingNodes = [...nodes]
    const processedMergeSourceIds = new Set<string>()

    while (pendingNodes.length > 0) {
        const nodesByParentId = groupNodesByParentId(pendingNodes)
        pendingNodes = []

        for (const [parentId, parentNodes] of nodesByParentId) {
            if (processedMergeSourceIds.has(parentId)) {
                continue
            }
            const resolved = await resolveOverwriteNodes(this, parentId, parentNodes, options)
            if (resolved.deleteNodeIds.length > 0) {
                await this.deleteNodes(resolved.deleteNodeIds)
            }

            for (const pair of resolved.mergePairs) {
                if (processedMergeSourceIds.has(pair.sourceNode.id)) {
                    continue
                }
                processedMergeSourceIds.add(pair.sourceNode.id)

                const targetUpdateNode = resolveMergeTargetUpdate(pair.sourceNode, pair.targetNode, options)
                if (targetUpdateNode) {
                    nextNodes.push(targetUpdateNode)
                }

                for (const node of nodes) {
                    if (node.parentId === pair.sourceNode.id) {
                        pendingNodes.push({
                            ...node,
                            parentId: pair.targetNode.id,
                        })
                    }
                }
            }

            nextNodes.push(...resolved.nodes)
        }
    }

    return nextNodes
}

function groupNodesByParentId(nodes: ITreeNode[]): Map<string, ITreeNode[]> {
    const nodesByParentId = new Map<string, ITreeNode[]>()
    for (const node of nodes) {
        const list = nodesByParentId.get(node.parentId) ?? []
        list.push(node)
        nodesByParentId.set(node.parentId, list)
    }
    return nodesByParentId
}

function resolveMergeTargetUpdate(
    sourceNode: ITreeNode,
    targetNode: ITreeNode,
    options?: ITreeSetNodesOptions,
): ITreeNode | undefined {
    if (options?.overwriteMode === "mergeByModif" && targetNode.modif > sourceNode.modif) {
        return undefined
    }

    return {
        ...sourceNode,
        id: targetNode.id,
        parentId: targetNode.parentId,
        index: targetNode.index,
        name: targetNode.name,
    }
}

async function collectExistingParentIds(
    this: TableTree<ITreeNode>,
    nodes: ITreeNode[],
): Promise<string[]> {
    const parentIds = new Set<string>()
    for (const node of nodes) {
        const oldNode = await this.get(node.id, { ignoreMarkDelete: true })
        if (oldNode?.parentId) {
            parentIds.add(oldNode.parentId)
        }
    }
    return Array.from(parentIds)
}
