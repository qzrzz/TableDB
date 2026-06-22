import type { TableTree } from "../TableTree"
import type { ITreeNode, ITreeOverwriteOptions, ITreeIndexOptions, ITreeChangeResult } from "../tree.types"
import type { ITreePreSyncNodeResult } from "./presyncNodes"
import { normalizeWritableNode } from "../util/normalizeWritableNode"
import { refreshTreeMetadata } from "../util/refreshTreeMetadata"
import { resolveTreeIndexes } from "../util/resolveTreeIndex"
import { resolveOverwriteNodes, type IResolveOverwriteNodesResult } from "../util/resolveOverwriteNodes"
import { rebalanceTreeIndexes } from "../util/rebalanceTreeIndexes"
import { assertTreeParentExists } from "../util/assertTreeParent"
import { collectDescendantNodes } from "../util/collectDescendantNodes"
import { collectExistingParentIds } from "../util/collectExistingParentIds"
import { groupNodesByParentId } from "../util/groupNodesByParentId"
import { repairTreeOverwriteConflicts } from "../util/repairTreeOverwriteConflicts"

/** 设置节点选项 */
export type ITreeSetNodesOptions = ITreeOverwriteOptions & {
    /** 是否只更新已存在的节点（不会创建新节点） */
    updateOnly?: boolean

    /** 自动更新排序索引配置 */
    index?: ITreeIndexOptions

    /**
     * 是否进行预同步（pre-sync）检查。
     * 开启后会根据传入节点里的 oldModif/oldCmodif 返回过期、缺失等同步状态。
     */
    presync?: boolean

    /**
     * 是否返回被更新的节点 id
     */
    returnChangedNodesIds?: boolean

    /**
     * 赋值模式，同 setMany() 的赋值模式。
     * 默认 "default" 相当于 `Object.assign(oldDoc, newDoc)`。
     */
    setMode?: "default" | "overwrite" | "merge"
}

export interface ITreeSetNodesResult extends ITreeChangeResult, Partial<ITreePreSyncNodeResult> {
    /** 被更新的节点 id 列表 */
    changedNodeIds?: string[]
}

interface IApplySetOverwriteResult {
    /** 经过覆盖策略处理后需要写入的节点。 */
    nodes: ITreeNode[]
    /** 覆盖策略中已经被删除的冲突节点 ID。 */
    deletedNodeIds: string[]
    /** merge 后需要清理的来源目录 ID。 */
    mergedSourceNodeIds: string[]
}

/**
 * 设置节点
 *
 * 设置节点数据，已存在的节点会被覆盖，不存在的节点会被创建。
 *
 *  如果在 `nodes` 中提供了 `oldModif`, `oldCmodif` 字段，它们会被用来进行预同步检查（pre-sync）而不会被设置到节点上。
 *
 * 流程：
 * 1. 生成本次写入统一使用的 modif。
 * 2. 按需执行 presync，并剥离只用于同步检查的 oldModif/oldCmodif。
 * 3. updateOnly 模式先过滤不可见或不存在的节点，避免把缺失节点误创建回来。
 * 4. 根据覆盖策略解析最终要写入的节点、要删除的冲突节点，以及 merge 后要清理的来源目录。
 * 5. 在任何真实写入前完成父级存在、批次重复 ID、最终父级环和排序锚点校验，尽量保证失败时不留下半写入。
 * 6. 写入前记录旧父级，写入后重排受影响父级 index，并刷新新旧父级及祖先 metadata。
 * 7. 最后执行并发冲突兜底修复，让多用户同时写入同一父级时最终仍收敛到覆盖策略要求的状态。
 *
 * 要注意如果修改了节点的 parentId 需要触发相应的 metadata 变更，并且遵守 ITreeOverwriteOptions 覆盖设置和 index 规则
 */
export async function setNodes(
    this: TableTree<ITreeNode>,
    /** 要设置的节点数据列表 */
    nodes: Partial<ITreeNode>[],
    options?: ITreeSetNodesOptions,
): Promise<ITreeSetNodesResult> {
    if (nodes.length === 0) {
        return options?.returnChangedNodesIds ? { changedNodeIds: [] } : {}
    }

    const modif = Date.now()
    // presync 只用于把客户端旧版本状态带回给调用方，不影响本次写入是否继续执行。
    const presyncResult = await collectSetPresyncResult.call(this, nodes, options)
    const writableNodes = prepareWritableNodes(nodes, modif)
    const visibleWritableNodes = await filterUpdateOnlyVisibleNodes.call(this, writableNodes, options)
    assertNoBatchDuplicateNodeConflicts(visibleWritableNodes)

    // 先记录原父级，用于 parentId 被修改后刷新旧父级和旧祖先链的统计字段。
    const oldParentIds = await collectExistingParentIds(this, visibleWritableNodes)

    // 覆盖策略可能把来源节点映射为目标 ID，或跳过/合并部分子树；后续所有校验都基于解析后的最终写入计划。
    const overwriteResult = await applySetOverwrite.call(this, visibleWritableNodes, options)
    const resolvedNodes = overwriteResult.nodes
    assertNoBatchDuplicateNodeConflicts(resolvedNodes)
    if (isNoSetWrite(resolvedNodes, overwriteResult)) {
        return buildNoSetWriteResult(presyncResult, options)
    }
    const nodesByParentId = groupNodesByParentId(resolvedNodes)

    // 父级、父级环和 index 锚点都必须在删除冲突目标之前校验，避免后续失败时破坏已有树。
    await assertSetNodeParents.call(this, resolvedNodes, nodesByParentId)
    await assertSetNodeParentMoves.call(this, resolvedNodes)

    await applySetNodeIndexes.call(this, nodesByParentId, options)

    const writableChangedNodeIds = options?.returnChangedNodesIds
        ? await collectWritableChangedNodeIds.call(this, resolvedNodes, options)
        : []

    if (overwriteResult.deletedNodeIds.length > 0) {
        // 覆盖策略确认要删除的目标节点，此时所有前置校验已通过，可以安全产生副作用。
        await this.deleteNodes(overwriteResult.deletedNodeIds)
    }
    await this.setMany(resolvedNodes, resolveSetManyOptions(options))
    await restoreWrittenNodesVisibility.call(this, resolvedNodes)
    for (const [parentId, parentNodes] of nodesByParentId) {
        await rebalanceTreeIndexes(
            this,
            parentId,
            parentNodes.map((node) => ({ id: node.id, index: node.index })),
        )
    }
    if (overwriteResult.mergedSourceNodeIds.length > 0) {
        // merge 保留目标目录并迁移来源子树，写入完成后来源目录本身需要被删除。
        await this.deleteNodes(overwriteResult.mergedSourceNodeIds)
    }
    await refreshTreeMetadata(this, {
        parentIds: [...Array.from(nodesByParentId.keys()), ...oldParentIds],
        statIds: resolvedNodes.filter((node) => node.isDir).map((node) => node.id),
        cmodif: modif,
    })
    for (const [parentId, parentNodes] of nodesByParentId) {
        // 多用户并发写入可能同时生成相同名称或唯一键，最后按覆盖策略再收敛一次。
        await repairTreeOverwriteConflicts(this, parentId, parentNodes.map((node) => node.id), options)
    }

    const result: ITreeSetNodesResult = {
        modif,
        cmodif: modif,
        ...presyncResult,
    }
    if (options?.returnChangedNodesIds) {
        result.changedNodeIds = Array.from(new Set([
            ...writableChangedNodeIds,
            ...overwriteResult.deletedNodeIds,
            ...overwriteResult.mergedSourceNodeIds,
        ]))
    }
    return result
}

/** 没有可写节点且覆盖处理也没有副作用时，本次 setNodes 不应伪造变更时间。 */
function isNoSetWrite(resolvedNodes: ITreeNode[], overwriteResult: IApplySetOverwriteResult): boolean {
    return (
        resolvedNodes.length === 0 &&
        overwriteResult.deletedNodeIds.length === 0 &&
        overwriteResult.mergedSourceNodeIds.length === 0
    )
}

/** 构建无实际写入时的返回值，保留 presync 信息和调用方显式要求的 changedNodeIds。 */
function buildNoSetWriteResult(
    presyncResult: ITreePreSyncNodeResult | undefined,
    options?: ITreeSetNodesOptions,
): ITreeSetNodesResult {
    const result: ITreeSetNodesResult = {
        ...presyncResult,
    }
    if (options?.returnChangedNodesIds) {
        result.changedNodeIds = []
    }
    return result
}

/** setNodes 表示写入一份当前有效节点，同 ID 命中已标记删除记录时需要恢复可见性。 */
async function restoreWrittenNodesVisibility(this: TableTree<ITreeNode>, nodes: ITreeNode[]): Promise<void> {
    const nodeIds = Array.from(new Set(nodes.map((node) => node.id))).filter(Boolean)
    if (nodeIds.length === 0) return

    await this.updateMany(
        { id: { $in: nodeIds }, _isDeleted: true } as any,
        { $unset: { _isDeleted: true, _deleteDate: true } as any },
    )
}

/** updateOnly 遵循可见节点语义，已标记删除节点按不存在处理。 */
async function filterUpdateOnlyVisibleNodes(
    this: TableTree<ITreeNode>,
    nodes: ITreeNode[],
    options?: ITreeSetNodesOptions,
): Promise<ITreeNode[]> {
    if (!options?.updateOnly) return nodes

    const visibleNodes: ITreeNode[] = []
    for (const node of nodes) {
        if (await this.has(node.id)) {
            visibleNodes.push(node)
        }
    }
    return visibleNodes
}

/** 收集 setNodes 需要返回的预同步结果，避免把 oldModif/oldCmodif 写入真实节点数据。 */
async function collectSetPresyncResult(
    this: TableTree<ITreeNode>,
    nodes: Partial<ITreeNode>[],
    options?: ITreeSetNodesOptions,
): Promise<ITreePreSyncNodeResult | undefined> {
    if (!options?.presync) {
        return undefined
    }

    // oldModif/oldCmodif 是客户端同步检查字段，只参与 presync，不应写入节点正文。
    const presyncNodes = nodes
        .filter((node: any) => node.id && (node.oldModif !== undefined || node.oldCmodif !== undefined))
        .map((node: any) => ({ id: node.id, modif: node.oldModif, cmodif: node.oldCmodif }))

    return this.presyncNodes(presyncNodes)
}

/** 将外部传入的节点补齐为可写入节点，并统一写入本次操作的 modif。 */
function prepareWritableNodes(nodes: Partial<ITreeNode>[], modif: number): ITreeNode[] {
    return nodes.map((node) => {
        const { oldModif, oldCmodif, ...nodeData } = node as any
        return normalizeWritableNode(nodeData, { modif }) as ITreeNode
    })
}

/** 同一批次内同一个节点 ID 只能出现一次，否则输入无法表达唯一的目录树节点。 */
function assertNoBatchDuplicateNodeConflicts(nodes: ITreeNode[]): void {
    const nodeIds = new Set<string>()
    for (const node of nodes) {
        if (nodeIds.has(node.id)) {
            throw new Error(`[TableTree] 重复节点 ID：${node.id}`)
        }
        nodeIds.add(node.id)
    }
}

/**
 * 校验本次写入涉及的父节点是否存在。
 *
 * 同一批次内新建父子节点时，父节点可能尚未落库，因此允许 parentId 指向本批次内的节点。
 */
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

/** setNodes 可以移动已有节点，写入前必须按最终父级链拒绝会形成环的批量移动。 */
async function assertSetNodeParentMoves(this: TableTree<ITreeNode>, writableNodes: ITreeNode[]): Promise<void> {
    assertNoBatchParentCycles(writableNodes)

    const finalParentIdByNodeId = new Map(writableNodes.map((node) => [node.id, node.parentId]))
    const oldParentIdCache = new Map<string, string | undefined>()
    const getFinalParentId = async (nodeId: string): Promise<string | undefined> => {
        const batchParentId = finalParentIdByNodeId.get(nodeId)
        if (batchParentId !== undefined) return batchParentId
        if (oldParentIdCache.has(nodeId)) return oldParentIdCache.get(nodeId)

        const oldNode = await this.get(nodeId, { ignoreMarkDelete: true })
        oldParentIdCache.set(nodeId, oldNode?.parentId)
        return oldNode?.parentId
    }

    for (const node of writableNodes) {
        const oldNode = await this.get(node.id, { ignoreMarkDelete: true })
        if (!oldNode || oldNode.parentId === node.parentId) {
            continue
        }
        await assertNoFinalMoveCycle(node.id, node.parentId, getFinalParentId)
    }
}

/** 按批量写入后的最终父级链校验移动结果，允许同批次先把后代移出再重排祖先。 */
async function assertNoFinalMoveCycle(
    nodeId: string,
    parentId: string,
    getFinalParentId: (nodeId: string) => Promise<string | undefined>,
): Promise<void> {
    if (parentId === "/") return
    if (parentId === nodeId) {
        throw new Error("[TableTree] 不能把节点移动到自己下面")
    }

    const visited = new Set<string>()
    let currentParentId: string | undefined = parentId
    while (currentParentId && currentParentId !== "/") {
        if (currentParentId === nodeId) {
            throw new Error("[TableTree] 不能把节点移动到自己的后代节点中")
        }
        if (visited.has(currentParentId)) {
            throw new Error(`[TableTree] 检测到循环父级引用：${currentParentId}`)
        }
        visited.add(currentParentId)
        currentParentId = await getFinalParentId(currentParentId)
    }
}

/** 同一批次允许先写父再写子，但不能让批次内父级引用组成环。 */
function assertNoBatchParentCycles(writableNodes: ITreeNode[]): void {
    const parentIdByNodeId = new Map<string, string>()
    for (const node of writableNodes) {
        parentIdByNodeId.set(node.id, node.parentId)
    }

    for (const node of writableNodes) {
        const visited = new Set<string>()
        let parentId = node.parentId
        while (parentId && parentId !== "/" && parentIdByNodeId.has(parentId)) {
            if (parentId === node.id || visited.has(parentId)) {
                throw new Error(`[TableTree] 检测到循环父级引用：${parentId}`)
            }
            visited.add(parentId)
            parentId = parentIdByNodeId.get(parentId) ?? "/"
        }
    }
}

/**
 * 为待写入节点确定排序索引。
 *
 * 普通更新会尽量保留原 index；新建、跨父级写入或显式指定 index 选项时才重新分配。
 */
async function applySetNodeIndexes(
    this: TableTree<ITreeNode>,
    nodesByParentId: Map<string, ITreeNode[]>,
    options?: ITreeSetNodesOptions,
): Promise<void> {
    for (const [parentId, parentNodes] of nodesByParentId) {
        if (options?.index) {
            // 显式传入 index 选项时，整批节点按同一个插入位置重新分配排序值。
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
                // 同父级更新时尽量保留原排序，避免普通字段更新改变节点位置。
                node.index = node.index || oldNode.index || ""
                continue
            }
            if (!node.index) {
                nodesNeedIndex.push(node)
            }
        }

        if (nodesNeedIndex.length > 0) {
            // 新节点或跨父级移动的节点如果没有 index，则追加到当前父级的末尾。
            const indexes = await resolveTreeIndexes(this, parentId, nodesNeedIndex.length)
            for (let i = 0; i < nodesNeedIndex.length; i++) {
                nodesNeedIndex[i].index = indexes[i]
            }
        }
    }
}

/**
 * 应用覆盖策略，解析最终需要写入的节点和已经删除的冲突节点。
 *
 * merge/mergeByModif 会把来源目录的子节点重新挂到目标目录下，并逐层继续解析子级冲突。
 */
async function applySetOverwrite(
    this: TableTree<ITreeNode>,
    nodes: ITreeNode[],
    options?: ITreeSetNodesOptions,
): Promise<IApplySetOverwriteResult> {
    // 这个循环按父级逐层解析覆盖策略。merge 会把来源目录的子节点改挂到目标目录，
    // 因此可能产生新的待处理节点，直到所有层级的冲突都被解析完。
    const nextNodes: ITreeNode[] = []
    const deletedNodeIds: string[] = []
    const mergedSourceNodeIds: string[] = []
    const replacedSourceIdByTargetId = new Map<string, string>()
    const replacePairsForCleanup: IResolveOverwriteNodesResult<ITreeNode>["replacePairs"] = []
    let pendingNodes = [...nodes]
    const processedMergeSourceIds = new Set<string>()
    const discardedBatchNodeIds = new Set<string>()

    while (pendingNodes.length > 0) {
        const nodesByParentId = groupNodesByParentId(pendingNodes)
        pendingNodes = []

        for (const [parentId, parentNodes] of nodesByParentId) {
            if (processedMergeSourceIds.has(parentId)) {
                // 来源目录已经被 merge 到目标目录，旧父级路径下的子节点不再继续写入。
                continue
            }
            if (discardedBatchNodeIds.has(parentId)) {
                // 父节点已被 skip/replace 丢弃，它的批次子树也必须一起丢弃，避免写入孤儿节点。
                for (const node of parentNodes) {
                    discardedBatchNodeIds.add(node.id)
                }
                continue
            }
            const resolved = await resolveOverwriteNodes(this, parentId, await hydrateMergeSourceNodes.call(this, parentNodes, options), options)
            collectDiscardedBatchNodeIds(parentNodes, resolved, discardedBatchNodeIds)
            const targetSetResult = resolveTargetSetNodes(resolved)
            replacePairsForCleanup.push(...resolved.replacePairs)
            deletedNodeIds.push(...targetSetResult.deleteNodeIds)

            for (const pair of resolved.replacePairs) {
                if (pair.sourceNode.id !== pair.targetNode.id) {
                    // replace 复用目标 ID 后，本批次来源目录的子节点也要跟着挂到目标 ID 下。
                    replacedSourceIdByTargetId.set(pair.sourceNode.id, pair.targetNode.id)
                }
                if (pair.sourceNode.isDir && discardedBatchNodeIds.has(pair.sourceNode.id)) {
                    // 来源目录来自 merge 改挂后的旧路径时，原路径子树已被跳过，需要按复用的目标 ID 重新排队。
                    const sourceChildren = await collectMergeSourceChildren.call(this, pair.sourceNode.id, nodes)
                    for (const node of sourceChildren) {
                        pendingNodes.push({
                            ...node,
                            parentId: pair.targetNode.id,
                        })
                    }
                }
            }

            for (const pair of resolved.mergePairs) {
                if (processedMergeSourceIds.has(pair.sourceNode.id)) {
                    continue
                }
                processedMergeSourceIds.add(pair.sourceNode.id)
                mergedSourceNodeIds.push(pair.sourceNode.id)

                // merge 模式保留目标目录 ID，把来源目录的可写字段合并到目标目录上。
                const targetUpdateNode = resolveMergeTargetUpdate(pair.sourceNode, pair.targetNode, options)
                if (targetUpdateNode) {
                    nextNodes.push(targetUpdateNode)
                }

                // 来源目录的直接子节点需要转移到目标目录下，下一轮继续处理子级冲突。
                const sourceChildren = await collectMergeSourceChildren.call(this, pair.sourceNode.id, nodes)
                for (const node of sourceChildren) {
                    // 旧来源路径下的后代会在改挂后的新路径继续处理，原路径上的同批次后代必须跳过。
                    discardedBatchNodeIds.add(node.id)
                    pendingNodes.push({
                        ...node,
                        parentId: pair.targetNode.id,
                    })
                }
            }

            nextNodes.push(...targetSetResult.nodes)
        }
    }

    reparentReplacedSourceChildren(nextNodes, replacedSourceIdByTargetId)
    const replacedDescendantIds = await collectReplacedTargetDescendantIds.call(this, replacePairsForCleanup, nextNodes)
    deletedNodeIds.push(...replacedDescendantIds)

    return {
        nodes: nextNodes,
        deletedNodeIds: Array.from(new Set(deletedNodeIds)),
        mergedSourceNodeIds: Array.from(new Set(mergedSourceNodeIds)),
    }
}

/** replace 复用目录 ID 后，本批次来源目录下的子节点也要跟着改挂到目标目录 ID 下。 */
function reparentReplacedSourceChildren(nodes: ITreeNode[], replacedSourceIdByTargetId: Map<string, string>): void {
    if (replacedSourceIdByTargetId.size === 0) return

    let changed = true
    while (changed) {
        changed = false
        for (const node of nodes) {
            const nextParentId = replacedSourceIdByTargetId.get(node.parentId)
            if (nextParentId && node.parentId !== nextParentId) {
                node.parentId = nextParentId
                changed = true
            }
        }
    }
}

/** replace 复用目标节点 ID 时，需要清理目标目录原有子树，避免旧子节点残留在新节点下面。 */
async function collectReplacedTargetDescendantIds(
    this: TableTree<ITreeNode>,
    replacePairs: IResolveOverwriteNodesResult<ITreeNode>["replacePairs"],
    nextNodes: ITreeNode[],
): Promise<string[]> {
    const reusableTargetIds = new Set<string>()
    for (const pair of replacePairs) {
        reusableTargetIds.add(pair.targetNode.id)
    }

    const nextNodeIds = new Set(nextNodes.map((node) => node.id))
    const deletedIds: string[] = []
    for (const targetId of reusableTargetIds) {
        const descendants = await collectDescendantNodes(this, [targetId], {
            ignoreMarkDelete: true,
        })
        const descendantIds = descendants
            .map((node) => node.id)
            .filter((nodeId) => !nextNodeIds.has(nodeId))
        if (descendantIds.length > 0) {
            deletedIds.push(...descendantIds)
        }
    }
    return deletedIds
}

/** 批次内冲突被跳过或替换掉的节点，其本批次子树也应跳过，避免写入失去父级的后代。 */
function collectDiscardedBatchNodeIds(
    inputNodes: ITreeNode[],
    resolved: IResolveOverwriteNodesResult<ITreeNode>,
    discardedNodeIds: Set<string>,
): void {
    const keptNodeIds = new Set<string>()
    for (const node of resolved.nodes) {
        keptNodeIds.add(node.id)
    }
    for (const pair of resolved.mergePairs) {
        keptNodeIds.add(pair.sourceNode.id)
    }

    for (const node of inputNodes) {
        if (!keptNodeIds.has(node.id)) {
            discardedNodeIds.add(node.id)
        }
    }
}

/** merge/mergeByModif 使用局部节点时，先用库中已有节点补齐目录类型等树语义字段。 */
async function hydrateMergeSourceNodes(
    this: TableTree<ITreeNode>,
    nodes: ITreeNode[],
    options?: ITreeSetNodesOptions,
): Promise<ITreeNode[]> {
    if (options?.overwriteMode !== "merge" && options?.overwriteMode !== "mergeByModif") {
        return nodes
    }

    const nextNodes: ITreeNode[] = []
    for (const node of nodes) {
        const oldNode = await this.get(node.id, { ignoreMarkDelete: true })
        nextNodes.push(oldNode ? { ...oldNode, ...node, isDir: oldNode.isDir } : node)
    }
    return nextNodes
}

/** 收集合并来源目录的直接子节点，包含本次待写入列表以及数据库里已经存在的子节点。 */
async function collectMergeSourceChildren(
    this: TableTree<ITreeNode>,
    sourceNodeId: string,
    nodes: ITreeNode[],
): Promise<ITreeNode[]> {
    const childrenById = new Map<string, ITreeNode>()
    const dbChildren = await this.findMany({ parentId: sourceNodeId }, { sort: { index: 1 } }) as ITreeNode[]
    for (const child of dbChildren) {
        childrenById.set(child.id, child)
    }
    for (const node of nodes) {
        if (node.parentId === sourceNodeId) {
            // 本次传入的子节点优先级更高，用于保留调用方提供的新字段。
            childrenById.set(node.id, { ...(childrenById.get(node.id) ?? {} as ITreeNode), ...node })
        }
    }
    return Array.from(childrenById.values())
}

/** 计算需要返回给调用方的变更节点 ID，updateOnly 模式下只返回实际已存在并会被更新的节点。 */
async function collectWritableChangedNodeIds(
    this: TableTree<ITreeNode>,
    writableNodes: ITreeNode[],
    options?: ITreeSetNodesOptions,
): Promise<string[]> {
    if (!options?.updateOnly) {
        return writableNodes.map((node) => node.id)
    }

    const changedNodeIds: string[] = []
    for (const node of writableNodes) {
        const exists = await this.has(node.id)
        if (exists) {
            changedNodeIds.push(node.id)
        }
    }
    return changedNodeIds
}

/** 将树节点的 setMode 选项转换为底层 Table.setMany() 可识别的写入选项。 */
function resolveSetManyOptions(options?: ITreeSetNodesOptions) {
    return {
        updateOnly: options?.updateOnly,
        overwrite: options?.setMode === "overwrite" ? true : undefined,
        merge: options?.setMode === "merge" ? true : undefined,
    }
}

/**
 * 将 replace 覆盖冲突转换为实际写入计划。
 *
 * 为了让覆盖后的节点继续使用目标节点 ID，会把来源节点内容映射到第一个冲突目标上。
 */
function resolveTargetSetNodes(
    resolved: IResolveOverwriteNodesResult<ITreeNode>,
): { nodes: ITreeNode[]; deleteNodeIds: string[] } {
    if (resolved.replacePairs.length === 0) {
        return {
            nodes: resolved.nodes,
            deleteNodeIds: resolved.deleteNodeIds,
        }
    }

    const nextNodes: ITreeNode[] = []
    const deleteNodeIds = new Set(resolved.deleteNodeIds)
    const consumedSourceIds = new Set<string>()
    const pairsBySourceId = new Map<string, typeof resolved.replacePairs>()
    for (const pair of resolved.replacePairs) {
        const pairs = pairsBySourceId.get(pair.sourceNode.id) ?? []
        pairs.push(pair)
        pairsBySourceId.set(pair.sourceNode.id, pairs)
    }

    for (const pairs of pairsBySourceId.values()) {
        const [firstPair, ...extraPairs] = pairs
        consumedSourceIds.add(firstPair.sourceNode.id)
        deleteNodeIds.delete(firstPair.targetNode.id)
        // 一个来源节点命中多个目标冲突时，只复用第一个目标 ID，其余目标仍然需要删除。
        for (const pair of extraPairs) {
            deleteNodeIds.add(pair.targetNode.id)
        }
        nextNodes.push(resolveConflictTargetUpdate(firstPair.sourceNode, firstPair.targetNode))
    }

    for (const node of resolved.nodes) {
        if (!consumedSourceIds.has(node.id)) {
            nextNodes.push(node)
        }
    }

    return {
        nodes: nextNodes,
        deleteNodeIds: Array.from(deleteNodeIds),
    }
}

/** 生成 replace 冲突场景下的目标节点更新数据，保留目标节点的身份和树位置。 */
function resolveConflictTargetUpdate(sourceNode: ITreeNode, targetNode: ITreeNode): ITreeNode {
    return {
        ...sourceNode,
        id: targetNode.id,
        parentId: targetNode.parentId,
        index: targetNode.index,
        name: targetNode.name,
    }
}

/** 生成 merge 冲突场景下的目标目录更新数据，mergeByModif 会保留更新的目标目录字段。 */
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
