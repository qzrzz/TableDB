import type { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"
import type { ITreeSetNodesOptions, ITreeWritableNodePatch } from "./treeCoreTypes"
import { createTreeIndexRange, hasTreeIndexedOrder, normalizeTreeSiblingIndexes, persistTreeParentLastIndex } from "./treeIndex"
import { rebuildTreeAncestorStats, rebuildTreeNodeStats } from "./treeStats"
import { stripManagedTreeStatsFromPatch } from "./treeWriteGuards"
import { deleteNodes } from "./deleteNodes"

/** 设置节点
 *  设置节点数据，已存在的节点会被覆盖，不存在的节点会被创建
 */
export async function setNodes(
    this: TableTree<ITreeNode>,
    /** 要设置的节点数据列表 */
    nodes: ITreeWritableNodePatch<ITreeNode>[],
    options?: ITreeSetNodesOptions,
): Promise<void> {
    if (options?.overwriteMode && !["replace", "newName", "merge", "mergeByModif"].includes(options.overwriteMode)) {
        throw new Error(`[TableTree] setNodes 暂未实现 ${options.overwriteMode} 树覆盖策略`)
    }

    if (options?.overwriteMode === "newName" && options.uniqueBy && options.uniqueBy !== "name") {
        throw new Error("[TableTree] setNodes 的 newName 模式目前只支持按 name 检测冲突")
    }

    if (nodes.length === 0) {
        return
    }

    const normalizedNodes = nodes.map((node) => {
        if (!node.id) {
            throw new Error("[TableTree] setNodes 要求每个节点都提供 id")
        }
        return stripManagedTreeStatsFromPatch<ITreeNode>(node)
    })

    const nodeIds = normalizedNodes.map((node) => node.id!)
    const batchNodeIdSet = new Set(nodeIds.map((id) => String(id)))
    const beforeNodes = await this.findMany(
        { id: { $in: nodeIds } },
        {
            projection: ["id", "parentId", "name", "isDir", "modif", "size"],
        },
    )
    const beforeNodeMap = new Map(beforeNodes.map((node) => [String(node.id), node]))

    for (const node of normalizedNodes) {
        if (node.parentId && node.parentId !== "/") {
            const parentId = String(node.parentId)
            const parentNode = batchNodeIdSet.has(parentId) ? true : await this.get(parentId)
            if (!parentNode) {
                throw new Error(`[TableTree] 父节点不存在: ${node.parentId}`)
            }
        }

        if (!beforeNodeMap.has(String(node.id)) && !node.parentId) {
            throw new Error(`[TableTree] 创建新节点时必须提供 parentId: ${node.id}`)
        }
    }

    const reservedNamesByParent = new Map<string, Set<string>>()
    const mergedNodeIdMap = new Map<string, string>()
    const preparedDirResultMap = new Map<string, PrepareSetNodeConflictResult>()

    for (const node of normalizedNodes) {
        if (!node.isDir) {
            continue
        }

        const beforeNode = beforeNodeMap.get(String(node.id))
        const remappedParentId = node.parentId && mergedNodeIdMap.has(String(node.parentId))
            ? mergedNodeIdMap.get(String(node.parentId))!
            : node.parentId
        const targetParentId = String(remappedParentId ?? beforeNode?.parentId ?? "")
        const nextNode = {
            ...node,
            ...(targetParentId ? { parentId: targetParentId } : undefined),
        } as Partial<ITreeNode>

        const prepareResult = await prepareSetNodeConflict.call(
            this,
            nextNode,
            targetParentId,
            options,
            reservedNamesByParent,
        )

        preparedDirResultMap.set(String(node.id), prepareResult)
        if (prepareResult.action === "merge") {
            mergedNodeIdMap.set(String(node.id), prepareResult.targetNodeId)
        }
    }

    const pendingNodes: Partial<ITreeNode>[] = []
    for (const node of normalizedNodes) {
        const prepareResult = node.isDir
            ? preparedDirResultMap.get(String(node.id))!
            : await prepareSetNodeNodeWithRemappedParent.call(this, node, beforeNodeMap, mergedNodeIdMap, options, reservedNamesByParent)

        if (prepareResult.action === "skip") {
            continue
        }

        if (prepareResult.action === "merge") {
            mergedNodeIdMap.set(String(node.id), prepareResult.targetNodeId)
            if (prepareResult.node) {
                pendingNodes.push(prepareResult.node)
            }
            continue
        }

        pendingNodes.push(prepareResult.node)
    }

    if (pendingNodes.length === 0) {
        return
    }

    const indexedPendingResult = options?.index
        ? await applySetNodeIndexes.call(this, pendingNodes, beforeNodeMap, options.index)
        : await autoAppendSetNodeIndexesWhenNeeded.call(this, pendingNodes, beforeNodeMap)

    const normalizedPendingNodes = indexedPendingResult.nodes

    await this.setMany(normalizedPendingNodes)
    await persistTreeParentLastIndex.call(this, normalizedPendingNodes[0]?.parentId ? String(normalizedPendingNodes[0].parentId) : "", indexedPendingResult.nextParentLastIndex)

    const afterNodes = await this.findMany(
        { id: { $in: normalizedPendingNodes.map((node) => node.id!) } },
        {
            projection: ["id", "parentId"],
        },
    )

    for (const afterNode of afterNodes) {
        await rebuildTreeNodeStats.call(this, String(afterNode.id))
    }

    const rebuildStartIds = new Set<string>()
    for (const beforeNode of beforeNodes) {
        if (beforeNode.parentId && beforeNode.parentId !== "/") {
            rebuildStartIds.add(String(beforeNode.parentId))
        }
    }
    for (const afterNode of afterNodes) {
        if (afterNode.parentId && afterNode.parentId !== "/") {
            rebuildStartIds.add(String(afterNode.parentId))
        }
    }

    for (const startId of rebuildStartIds) {
        await rebuildTreeAncestorStats.call(this, startId, { includeSelf: true })
    }
}

async function autoAppendSetNodeIndexesWhenNeeded(
    this: TableTree<ITreeNode>,
    pendingNodes: Partial<ITreeNode>[],
    beforeNodeMap: Map<string, Partial<ITreeNode>>,
): Promise<{ nodes: Partial<ITreeNode>[]; nextParentLastIndex?: number }> {
    const candidateNodes = pendingNodes.filter((node) => {
        const beforeNode = beforeNodeMap.get(String(node.id))
        const targetParentId = String(node.parentId ?? beforeNode?.parentId ?? "")
        if (!targetParentId || node.index !== undefined) {
            return false
        }
        return !beforeNode || String(beforeNode.parentId) !== targetParentId
    })

    if (candidateNodes.length === 0) {
        return { nodes: pendingNodes }
    }

    const parentIds = Array.from(new Set(candidateNodes.map((node) => String(node.parentId))))
    if (parentIds.length !== 1) {
        return { nodes: pendingNodes }
    }

    const targetParentId = parentIds[0]
    if (!await hasTreeIndexedOrder.call(this, targetParentId)) {
        return { nodes: pendingNodes }
    }

    const candidateNodeIdSet = new Set(candidateNodes.map((node) => String(node.id)))
    const siblings = (await this.findMany(
        { parentId: targetParentId },
        {
            projection: ["id", "index"],
            sort: { index: 1, id: 1 },
        },
    )) as Array<Pick<ITreeNode, "id" | "index">>

    const filteredSiblings = siblings.filter((sibling) => !candidateNodeIdSet.has(String(sibling.id)))
    const orderedSiblingIds = filteredSiblings.map((sibling) => String(sibling.id))
    const normalizedIndexMap = normalizeTreeSiblingIndexes(filteredSiblings)
    const lowerSiblingId = orderedSiblingIds[orderedSiblingIds.length - 1]
    const lowerIndex = lowerSiblingId ? normalizedIndexMap.get(lowerSiblingId) : undefined
    const indexRangeResult = await createTreeIndexRange.call(this, targetParentId, candidateNodes.length, lowerIndex, undefined)
    const assignedIndexMap = new Map(candidateNodes.map((node, index) => [String(node.id), indexRangeResult.indexes[index]]))

    return {
        nodes: pendingNodes.map((node) => assignedIndexMap.has(String(node.id)) ? { ...node, index: assignedIndexMap.get(String(node.id)) } : node),
        nextParentLastIndex: indexRangeResult.nextParentLastIndex,
    }
}

async function applySetNodeIndexes(
    this: TableTree<ITreeNode>,
    pendingNodes: Partial<ITreeNode>[],
    beforeNodeMap: Map<string, Partial<ITreeNode>>,
    indexOptions: NonNullable<ITreeSetNodesOptions["index"]>,
): Promise<{ nodes: Partial<ITreeNode>[]; nextParentLastIndex?: number }> {
    const parentIds = Array.from(
        new Set(
            pendingNodes
                .map((node) => String(node.parentId ?? beforeNodeMap.get(String(node.id))?.parentId ?? ""))
                .filter((parentId) => parentId.length > 0),
        ),
    )

    if (parentIds.length > 1) {
        throw new Error("[TableTree] setNodes 的 index 选项目前只支持同一父节点下的批量写入")
    }

    const targetParentId = parentIds[0]
    if (!targetParentId) {
        return { nodes: pendingNodes }
    }

    const pendingNodeIds = new Set(pendingNodes.map((node) => String(node.id)))
    const siblings = (await this.findMany(
        { parentId: targetParentId },
        {
            projection: ["id", "index"],
            sort: { index: 1, id: 1 },
        },
    )) as Array<Pick<ITreeNode, "id" | "index">>

    const filteredSiblings = siblings.filter((sibling) => !pendingNodeIds.has(String(sibling.id)))
    const orderedSiblingIds = filteredSiblings.map((sibling) => String(sibling.id))
    const normalizedIndexMap = normalizeTreeSiblingIndexes(filteredSiblings)

    const enabledModes = [indexOptions.prevNodeId, indexOptions.nextNodeId, indexOptions.toStart, indexOptions.toEnd].filter(Boolean).length
    if (enabledModes > 1) {
        throw new Error("[TableTree] setNodes 的 index 选项一次只能指定一种插入位置")
    }

    let insertAt = orderedSiblingIds.length
    if (indexOptions.toStart) {
        insertAt = 0
    } else if (indexOptions.nextNodeId) {
        const nextIndex = orderedSiblingIds.indexOf(indexOptions.nextNodeId)
        if (nextIndex < 0) {
            throw new Error(`[TableTree] nextNodeId 不存在于目标父节点下: ${indexOptions.nextNodeId}`)
        }
        insertAt = nextIndex
    } else if (indexOptions.prevNodeId) {
        const prevIndex = orderedSiblingIds.indexOf(indexOptions.prevNodeId)
        if (prevIndex < 0) {
            throw new Error(`[TableTree] prevNodeId 不存在于目标父节点下: ${indexOptions.prevNodeId}`)
        }
        insertAt = prevIndex + 1
    }

    const lowerSiblingId = insertAt > 0 ? orderedSiblingIds[insertAt - 1] : undefined
    const upperSiblingId = insertAt < orderedSiblingIds.length ? orderedSiblingIds[insertAt] : undefined
    const lowerIndex = lowerSiblingId ? normalizedIndexMap.get(lowerSiblingId) : undefined
    const upperIndex = upperSiblingId ? normalizedIndexMap.get(upperSiblingId) : undefined
    const indexRangeResult = await createTreeIndexRange.call(this, targetParentId, pendingNodes.length, lowerIndex, upperIndex)

    return {
        nodes: pendingNodes.map((node, index) => ({
            ...node,
            index: indexRangeResult.indexes[index],
        })),
        nextParentLastIndex: indexRangeResult.nextParentLastIndex,
    }
}

type PrepareSetNodeConflictResult =
    | { action: "set"; node: Partial<ITreeNode> }
    | { action: "skip" }
    | { action: "merge"; targetNodeId: string; node?: Partial<ITreeNode> }

async function prepareSetNodeNodeWithRemappedParent(
    this: TableTree<ITreeNode>,
    node: ITreeWritableNodePatch<ITreeNode>,
    beforeNodeMap: Map<string, Partial<ITreeNode>>,
    mergedNodeIdMap: Map<string, string>,
    options: ITreeSetNodesOptions | undefined,
    reservedNamesByParent: Map<string, Set<string>>,
): Promise<PrepareSetNodeConflictResult> {
    const beforeNode = beforeNodeMap.get(String(node.id))
    const remappedParentId = node.parentId && mergedNodeIdMap.has(String(node.parentId))
        ? mergedNodeIdMap.get(String(node.parentId))!
        : node.parentId
    const targetParentId = String(remappedParentId ?? beforeNode?.parentId ?? "")
    const nextNode = {
        ...node,
        ...(targetParentId ? { parentId: targetParentId } : undefined),
    } as Partial<ITreeNode>

    return prepareSetNodeConflict.call(
        this,
        nextNode,
        targetParentId,
        options,
        reservedNamesByParent,
    )
}

async function prepareSetNodeConflict(
    this: TableTree<ITreeNode>,
    node: Partial<ITreeNode>,
    targetParentId: string,
    options: ITreeSetNodesOptions | undefined,
    reservedNamesByParent: Map<string, Set<string>>,
): Promise<PrepareSetNodeConflictResult> {
    const uniqueBy = options?.uniqueBy ?? (options?.overwriteMode === "newName" ? "name" : undefined)
    if (!uniqueBy || !targetParentId) {
        return { action: "set", node }
    }

    const sourceValue = getSetNodeValueByPath(node as Record<string, any>, uniqueBy)
    if (sourceValue === undefined || sourceValue === null) {
        return { action: "set", node }
    }

    const conflictNodes = (await this.findMany(
        {
            parentId: targetParentId,
            [uniqueBy]: sourceValue,
        },
        {
            projection: ["id", "isDir", "modif"],
        },
    )) as Pick<ITreeNode, "id" | "isDir" | "modif">[]

    const filteredConflictNodes = conflictNodes.filter((item) => String(item.id) !== String(node.id))
    if (filteredConflictNodes.length === 0) {
        return { action: "set", node }
    }

    if (options?.overwriteMode === "newName") {
        const sourceName = typeof node.name === "string" ? node.name : String(node.name ?? node.id ?? "")
        return {
            action: "set",
            node: {
                ...node,
                name: await createSetNodeName.call(this, targetParentId, sourceName, reservedNamesByParent),
            },
        }
    }

    if (["merge", "mergeByModif"].includes(options?.overwriteMode ?? "") && node.isDir) {
        const dirConflictNodes = filteredConflictNodes.filter((item) => item.isDir)
        if (dirConflictNodes.length === 1) {
            const targetNodeId = String(dirConflictNodes[0].id)
            const shouldOverwriteSelf = options?.overwriteMode === "merge"
                || normalizeSetNodeModif(node.modif) > normalizeSetNodeModif(dirConflictNodes[0].modif)

            return {
                action: "merge",
                targetNodeId,
                node: shouldOverwriteSelf
                    ? {
                        ...node,
                        id: targetNodeId,
                        parentId: targetParentId,
                    }
                    : undefined,
            }
        }
    }

    const hasTargetDirConflict = filteredConflictNodes.some((item) => item.isDir)
    if (node.isDir === false && hasTargetDirConflict && options?.enableFileOverwriteDir !== true) {
        return { action: "skip" }
    }

    if (options?.overwriteMode === "mergeByModif") {
        const sourceModif = normalizeSetNodeModif(node.modif)
        const targetMaxModif = Math.max(...filteredConflictNodes.map((item) => normalizeSetNodeModif(item.modif)))
        if (sourceModif <= targetMaxModif) {
            return { action: "skip" }
        }
    }

    await deleteNodes.call(
        this,
        filteredConflictNodes.map((item) => String(item.id)),
    )

    return { action: "set", node }
}

function getSetNodeValueByPath(source: Record<string, any>, path: string): any {
    const pathList = path.split(".")
    let currentValue: any = source

    for (const key of pathList) {
        if (currentValue == null || typeof currentValue !== "object") {
            return undefined
        }
        currentValue = currentValue[key]
    }

    return currentValue
}

async function createSetNodeName(
    this: TableTree<ITreeNode>,
    parentId: string,
    sourceName: string,
    reservedNamesByParent: Map<string, Set<string>>,
): Promise<string> {
    let reservedNames = reservedNamesByParent.get(parentId)
    if (!reservedNames) {
        reservedNames = new Set<string>()
        const siblings = await this.findMany({ parentId }, { projection: ["name"] })
        for (const sibling of siblings) {
            if (typeof sibling.name === "string") {
                reservedNames.add(sibling.name)
            }
        }
        reservedNamesByParent.set(parentId, reservedNames)
    }

    let index = 1
    let nextName = `${sourceName} (${index})`
    while (reservedNames.has(nextName)) {
        index += 1
        nextName = `${sourceName} (${index})`
    }

    reservedNames.add(nextName)
    return nextName
}

function normalizeSetNodeModif(modif: unknown): number {
    return typeof modif === "number" && !Number.isNaN(modif) ? modif : 0
}
