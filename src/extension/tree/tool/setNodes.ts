import type { ITreeChangeResult, ITreeNode, ITreeOverwriteOptions } from "../tree.types"
import type { ITreeOperationContext } from "../core/context"
import { createNodesCore } from "../core/createNodes"
import { deleteNodesCore } from "../core/deleteNodes"
import { moveNodesCore } from "../core/moveNodes"
import { updateNodesCore } from "../core/updateNodes"
import { normalizeWritableNode } from "../util/normalizeWritableNode"
import { stripTreeManagedFields } from "../util/stripTreeManagedFields"
import { getNodeValueByPath } from "../util/getNodeValueByPath"
import { getUniqueFileNames } from "../util/getUniqueFileNames"

export type ITreeSetNodesOptions = ITreeOverwriteOptions & {
    /** 只更新已存在且可见的节点。 */
    updateOnly?: boolean
    /** 返回实际被处理的节点 ID。 */
    returnChangedNodesIds?: boolean
}

export interface ITreeSetNodesResult extends ITreeChangeResult {
    changedNodeIds?: string[]
}

/**
 * setNodes 工具：把“设置一批节点”的意图拆成结构化 core 调用。
 *
 * 这里不直接操作数据库。工具只负责读取批次、处理覆盖策略、按父子拓扑排序，
 * 再调用 create/update/move/delete core；外层 TableTree 已经为整个工具建立事务。
 */
export async function setNodesTool(
    context: ITreeOperationContext,
    inputNodes: Partial<ITreeNode>[],
    options?: ITreeSetNodesOptions,
): Promise<ITreeSetNodesResult> {
    if (inputNodes.length === 0) return options?.returnChangedNodesIds ? { changedNodeIds: [] } : {}

    const modif = Date.now()
    assertNoDuplicateInputIds(inputNodes)
    const inputIds = inputNodes.map((node) => node.id).filter((id): id is string => typeof id === "string" && id.length > 0)
    const existingNodes = inputIds.length === 0
        ? []
        : await context.view.findMany({ id: { $in: inputIds } }, { ignoreMarkDelete: true }) as ITreeNode[]
    const existingById = new Map(existingNodes.map((node) => [node.id, node]))

    const normalizedNodes = inputNodes.map((input) => normalizeSetNode(input, existingById.get(input.id as string), modif))
    const updateableNodes = options?.updateOnly
        ? normalizedNodes.filter((node) => existingById.has(node.id) && existingById.get(node.id)?._isDeleted !== true)
        : normalizedNodes
    const resolvedNodes = await resolveSetConflicts(context, updateableNodes, options)
    for (const target of resolvedNodes.existingTargets) existingById.set(target.id, target)
    const changedNodeIds = new Set<string>()
    const deletedConflictIds = resolvedNodes.deletedConflictIds

    if (deletedConflictIds.length > 0) {
        await deleteNodesCore(context, deletedConflictIds)
        for (const id of deletedConflictIds) changedNodeIds.add(id)
    }

    const mergeIdMap = new Map(resolvedNodes.mergeSources.map((pair) => [pair.sourceId, pair.targetId]))
    const preparedNodes = remapMergedNodes(resolvedNodes.nodes, mergeIdMap)
    await moveExistingMergeSubtrees(context, resolvedNodes.mergeSources, existingById, options, changedNodeIds)

    const pendingCreates = preparedNodes.filter((node) => !existingById.has(node.id))
    const existingWrites = preparedNodes.filter((node) => existingById.has(node.id))

    await createInParentOrder(context, pendingCreates, existingById, changedNodeIds)

    // 先移动再更新正文，避免 update core 把 parentId 当作普通字段直接覆盖。
    for (const node of existingWrites) {
        const oldNode = existingById.get(node.id)!
        if (oldNode._isDeleted === true) {
            await restoreAndWriteDeletedNode(context, node, modif)
        }

        const moved = oldNode.parentId !== node.parentId
        if (moved) {
            await moveNodesCore(context, [node.id], node.parentId, {
                uniqueBy: "id",
                overwriteMode: "replace",
                index: node.index ? undefined : { toEnd: true },
            })
        }

        const setData = { ...node } as Record<string, any>
        delete setData.id
        delete setData.parentId
        if (moved && !node.index) delete setData.index
        delete setData._isDeleted
        delete setData._deleteDate
        await updateNodesCore(context, { id: node.id }, { $set: { ...setData, modif } as any })
        changedNodeIds.add(node.id)
    }

    const result: ITreeSetNodesResult = {
        modif,
        cmodif: modif,
    }
    if (options?.returnChangedNodesIds) result.changedNodeIds = [...changedNodeIds]
    return result
}

interface IResolvedSetNodes {
    nodes: ITreeNode[]
    deletedConflictIds: string[]
    mergeSources: Array<{ sourceId: string; targetId: string }>
    existingTargets: ITreeNode[]
}

async function resolveSetConflicts(
    context: ITreeOperationContext,
    nodes: ITreeNode[],
    options?: ITreeSetNodesOptions,
): Promise<IResolvedSetNodes> {
    const uniqueBy = options?.uniqueBy ?? "id"
    const mode = options?.overwriteMode ?? "replace"
    const result: ITreeNode[] = []
    const deletedConflictIds = new Set<string>()
    const mergeSources: Array<{ sourceId: string; targetId: string }> = []
    const existingTargets: ITreeNode[] = []
    const plannedKeys = new Set<string>()

    // 同一父级只读取一次直属子节点，避免大批量同步退化成 N 次 findOne。
    const nodesByParent = new Map<string, ITreeNode[]>()
    for (const node of nodes) {
        const list = nodesByParent.get(node.parentId) ?? []
        list.push(node)
        nodesByParent.set(node.parentId, list)
    }

    for (const [parentId, parentNodes] of nodesByParent) {
        const values = parentNodes.map((node) => getNodeValueByPath(node, uniqueBy))
        const sourceIds = new Set(parentNodes.map((node) => node.id))
        // uniqueBy 为 id 时，同级不可能存在另一个同 id 节点，无需查冲突。
        // 其它 uniqueBy 必须用 $and，避免与 id 排除条件在同一层对象里撞键覆盖。
        let siblings: ITreeNode[] = []
        if (mode === "newName") {
            siblings = (await context.view.findMany({ parentId }, { ignoreMarkDelete: false }) as ITreeNode[])
                .filter((sibling) => !sourceIds.has(sibling.id))
        } else if (uniqueBy !== "id") {
            siblings = (await context.view.findMany({
                $and: [
                    { parentId },
                    { [uniqueBy]: { $in: values } },
                    { id: { $nin: parentNodes.map((node) => node.id) } },
                ],
            } as any, { ignoreMarkDelete: false }) as ITreeNode[])
                .filter((sibling) => !sourceIds.has(sibling.id))
        }
        const siblingByValue = new Map(siblings.map((sibling) => [stableValue(getNodeValueByPath(sibling, uniqueBy)), sibling]))
        const siblingNames = new Set(siblings.map((sibling) => sibling.name))

        for (const node of parentNodes) {
            const value = getNodeValueByPath(node, uniqueBy)
            const plannedKey = `${node.parentId}\u0000${uniqueBy}\u0000${stableValue(value)}`
            if (plannedKeys.has(plannedKey)) {
                throw new Error(`[TableTree] setNodes 批次内存在重复的 ${uniqueBy}：${String(value)}`)
            }

            const conflict = siblingByValue.get(stableValue(value))

            if (!conflict) {
                plannedKeys.add(plannedKey)
                result.push(node)
                continue
            }
            existingTargets.push(conflict)

            if (mode === "skip") continue
            if (mode === "newName" && uniqueBy === "name") {
                const [name] = await getUniqueFileNames([node.name], siblingNames)
                const renamed = { ...node, name }
                siblingNames.add(name)
                plannedKeys.add(`${node.parentId}\u0000name\u0000${stableValue(name)}`)
                result.push(renamed)
                continue
            }

            if ((mode === "merge" || mode === "mergeByModif") && conflict.isDir && node.isDir) {
                // 目录 merge 的目标节点继续沿用输入 ID 会破坏唯一 ID；将输入映射到已有目标，
                // 使后续 update core 更新目标目录，子树迁移由后续独立 setNodes 调用负责。
                result.push({ ...node, id: conflict.id })
                plannedKeys.add(plannedKey)
                mergeSources.push({ sourceId: node.id, targetId: conflict.id })
                continue
            }

            if (mode === "mergeByModif" && (conflict.modif ?? 0) > (node.modif ?? 0)) {
                // 目标节点更新，跳过输入，保留较新数据。
                continue
            }

            if (!options?.enableFileOverwriteDir && conflict.isDir && !node.isDir) {
                // 默认不允许文件替换目录，保持目标目录和其子树不变。
                continue
            }

            deletedConflictIds.add(conflict.id)
            plannedKeys.add(plannedKey)
            result.push(node)
        }
    }

    return { nodes: result, deletedConflictIds: [...deletedConflictIds], mergeSources, existingTargets }
}

/** 将 merge 来源目录及其输入子节点统一改挂到保留的目标目录。 */
function remapMergedNodes(nodes: ITreeNode[], mergeIdMap: Map<string, string>): ITreeNode[] {
    if (mergeIdMap.size === 0) return nodes

    const resolveId = (id: string): string => {
        let current = id
        const visited = new Set<string>()
        while (mergeIdMap.has(current) && !visited.has(current)) {
            visited.add(current)
            current = mergeIdMap.get(current)!
        }
        return current
    }

    const remapped = nodes.map((node) => ({
        ...node,
        id: resolveId(node.id),
        parentId: resolveId(node.parentId),
    }))
    const seenIds = new Set<string>()
    for (const node of remapped) {
        if (seenIds.has(node.id)) throw new Error(`[TableTree] merge 后批次内出现重复节点 ID：${node.id}`)
        seenIds.add(node.id)
    }
    return remapped
}

/** 先迁移数据库中未出现在输入批次里的来源子节点，再删除来源目录本身。 */
async function moveExistingMergeSubtrees(
    context: ITreeOperationContext,
    mergeSources: Array<{ sourceId: string; targetId: string }>,
    existingById: Map<string, ITreeNode>,
    options: ITreeSetNodesOptions | undefined,
    changedNodeIds: Set<string>,
): Promise<void> {
    for (const { sourceId, targetId } of mergeSources) {
        if (!existingById.has(sourceId) || sourceId === targetId) continue
        const children = await context.view.findMany({ parentId: sourceId })
        for (const child of children) {
            await moveNodesCore(context, [child.id], targetId, {
                ...options,
                overwriteMode: options?.overwriteMode === "mergeByModif" ? "mergeByModif" : "merge",
            })
            // 后续 preparedNodes 还会更新这些节点，先同步内存快照，避免再次用旧 parentId 做 CAS。
            existingById.set(child.id, { ...child, parentId: targetId })
        }
        await deleteNodesCore(context, [sourceId])
        changedNodeIds.add(sourceId)
    }
}

async function createInParentOrder(
    context: ITreeOperationContext,
    pendingNodes: ITreeNode[],
    existingById: Map<string, ITreeNode>,
    changedNodeIds: Set<string>,
): Promise<void> {
    let pending = [...pendingNodes]
    while (pending.length > 0) {
        const ready = pending.filter((node) => node.parentId === "/" || existingById.has(node.parentId))
        if (ready.length === 0) {
            throw new Error("[TableTree] setNodes 中存在不存在的父节点，无法创建节点")
        }

        const grouped = new Map<string, ITreeNode[]>()
        for (const node of ready) {
            const list = grouped.get(node.parentId) ?? []
            list.push(node)
            grouped.set(node.parentId, list)
        }
        for (const [parentId, nodes] of grouped) {
            const result = await createNodesCore(context, nodes, parentId, { returnNewNodes: true })
            for (const node of result.newNodes ?? nodes) {
                existingById.set(node.id, node)
                changedNodeIds.add(node.id)
            }
        }
        const readyIds = new Set(ready.map((node) => node.id))
        pending = pending.filter((node) => !readyIds.has(node.id))
    }
}

async function restoreAndWriteDeletedNode(
    context: ITreeOperationContext,
    node: ITreeNode,
    modif: number,
): Promise<void> {
    const setData = { ...node } as Record<string, any>
    delete setData.id
    // 先恢复到旧父级，再由 move core 调整 parentId 和两侧 metadata。
    delete setData.parentId
    delete setData._isDeleted
    delete setData._deleteDate
    await context.adapter.updateOne(
        { id: node.id },
        { $set: { ...setData, modif } as any, $unset: { _isDeleted: true, _deleteDate: true } as any },
    )
}

function normalizeSetNode(input: Partial<ITreeNode>, existing: ITreeNode | undefined, modif: number): ITreeNode {
    const { oldModif: _oldModif, oldCmodif: _oldCmodif, ...inputData } = input as any
    const data = existing ? { ...existing, ...inputData } : inputData
    const parentChangedExplicitly = Boolean(existing && inputData.parentId !== undefined && inputData.parentId !== existing.parentId)
    const explicitIndex = inputData.index !== undefined
    if (parentChangedExplicitly && !explicitIndex) delete (data as any).index
    // setNodes 写入新版本时不应把历史软删除状态重新带回数据库。
    delete (data as any)._isDeleted
    delete (data as any)._deleteDate
    return normalizeWritableNode(stripTreeManagedFields(data as Record<string, any>), { modif }) as ITreeNode
}

function assertNoDuplicateInputIds(nodes: Partial<ITreeNode>[]): void {
    const ids = new Set<string>()
    for (const node of nodes) {
        if (typeof node.id !== "string") continue
        if (ids.has(node.id)) throw new Error(`[TableTree] setNodes 批次内重复节点 ID：${node.id}`)
        ids.add(node.id)
    }
}

function stableValue(value: unknown): string {
    if (value === undefined) return "<undefined>"
    if (value === null) return "<null>"
    if (typeof value === "object") return JSON.stringify(value)
    return String(value)
}
