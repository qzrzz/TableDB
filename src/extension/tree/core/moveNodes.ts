import type { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"
import type { ITreeMoveNodesOptions } from "./treeCore.types"
import { createTreeIndexRange, hasTreeIndexedOrder, normalizeTreeSiblingIndexes, persistTreeParentLastIndex } from "./treeIndex"
import { applyTreeStatsDeltaToAncestors, collectTreeAncestorIds, getTreeNodeStatsContribution } from "./treeStats"
import { deleteNodes } from "./deleteNodes"

/** 移动节点
 *  把目标节点移动到新的父节点下·
 */
export async function moveNodes(
    this: TableTree<ITreeNode>,
    /** 要移动的节点 id 列表 */
    nodeIds: string[],
    /** 目标父节点 id ，如果为 "/" 表示根节点 */
    parentId: string,
    options?: ITreeMoveNodesOptions,
): Promise<void> {
    if (options?.overwriteMode && !["replace", "newName", "merge", "mergeByModif"].includes(options.overwriteMode)) {
        throw new Error(`[TableTree] moveNodes 暂未实现 ${options.overwriteMode} 覆盖模式`)
    }

    if (options?.overwriteMode === "newName" && options.uniqueBy && options.uniqueBy !== "name") {
        throw new Error("[TableTree] moveNodes 的 newName 模式目前只支持按 name 检测冲突")
    }

    const uniqueNodeIds = Array.from(new Set(nodeIds))
    if (uniqueNodeIds.length === 0) {
        return
    }

    if (parentId !== "/") {
        const targetParentNode = await this.get(parentId)
        if (!targetParentNode) {
            throw new Error(`[TableTree] 目标父节点不存在: ${parentId}`)
        }
    }

    const existingNodes: ITreeNode[] = []
    for (const nodeId of uniqueNodeIds) {
        const node = await this.get(nodeId)
        if (node) {
            existingNodes.push(node)
        }
    }

    if (existingNodes.length === 0) {
        return
    }

    const selectedNodeIdSet = new Set(existingNodes.map((node) => node.id))
    const rootNodes: ITreeNode[] = []

    for (const node of existingNodes) {
        const ancestorIds = await collectTreeAncestorIds.call(this, node.parentId)
        const hasSelectedAncestor = ancestorIds.some((ancestorId) => selectedNodeIdSet.has(ancestorId))
        if (!hasSelectedAncestor) {
            rootNodes.push(node)
        }
    }

    for (const rootNode of rootNodes) {
        if (rootNode.id === parentId) {
            throw new Error(`[TableTree] 不能把节点移动到自身下: ${rootNode.id}`)
        }

        const subtreeNodeIds = await collectSubtreeNodeIds.call(this, rootNode.id)
        if (subtreeNodeIds.includes(parentId)) {
            throw new Error(`[TableTree] 不能把节点移动到其子孙节点下: ${rootNode.id} -> ${parentId}`)
        }
    }

    const reservedNamesByParent = new Map<string, Set<string>>()
    const moveTasks: Array<{ rootNode: ITreeNode; patch: Partial<ITreeNode> }> = []

    for (const rootNode of rootNodes) {
        const moveConflictResult = await resolveMoveConflict.call(this, rootNode, parentId, options, reservedNamesByParent)
        if (moveConflictResult.action === "skip") {
            continue
        }

        if (moveConflictResult.action === "merge") {
            await mergeTreeNode.call(this, rootNode, moveConflictResult.targetNodeId, options)
            continue
        }

        moveTasks.push({
            rootNode,
            patch: moveConflictResult.patch,
        })
    }

    const shouldAutoAppendToIndexedParent = !options?.index
        && moveTasks.some((task) => task.rootNode.parentId !== parentId)
        && await hasTreeIndexedOrder.call(this, parentId)

    const indexResult = options?.index
        ? await createMoveIndexPatchMap.call(
            this,
            parentId,
            moveTasks.map((task) => task.rootNode),
            options.index,
        )
        : shouldAutoAppendToIndexedParent
            ? await createMoveIndexPatchMap.call(
                this,
                parentId,
                moveTasks.filter((task) => task.rootNode.parentId !== parentId).map((task) => task.rootNode),
                { toEnd: true },
            )
        : { patchMap: new Map<string, number>() }

    for (const task of moveTasks) {
        const { rootNode } = task
        const movePatch = {
            ...task.patch,
            ...(indexResult.patchMap.has(rootNode.id) ? { index: indexResult.patchMap.get(rootNode.id)! } : undefined),
        }

        if (rootNode.parentId === parentId && Object.keys(movePatch).length === 0) {
            continue
        }

        const isParentChanged = rootNode.parentId !== parentId
        if (isParentChanged) {
            const contribution = getTreeNodeStatsContribution(rootNode)
            await applyTreeStatsDeltaToAncestors.call(this, rootNode.parentId, {
                csize: -contribution.csize,
                ctotal: -contribution.ctotal,
                cftotal: -contribution.cftotal,
            })

            await this.updateOne(
                { id: rootNode.id },
                {
                    $set: {
                        parentId,
                        ...movePatch,
                    } as Partial<ITreeNode>,
                },
            )

            await applyTreeStatsDeltaToAncestors.call(this, parentId, contribution)
            continue
        }

        await this.updateOne(
            { id: rootNode.id },
            {
                $set: movePatch,
            },
        )
    }

    await persistTreeParentLastIndex.call(this, parentId, indexResult.nextParentLastIndex)
}

async function createMoveIndexPatchMap(
    this: TableTree<ITreeNode>,
    parentId: string,
    movingRootNodes: ITreeNode[],
    indexOptions: NonNullable<ITreeMoveNodesOptions["index"]>,
): Promise<{ patchMap: Map<string, number>; nextParentLastIndex?: number }> {
    const enabledModes = [indexOptions.prevNodeId, indexOptions.nextNodeId, indexOptions.toStart, indexOptions.toEnd].filter(Boolean).length
    if (enabledModes > 1) {
        throw new Error("[TableTree] moveNodes 的 index 选项一次只能指定一种插入位置")
    }

    const movingNodeIdSet = new Set(movingRootNodes.map((node) => node.id))
    const siblings = (await this.findMany(
        { parentId },
        {
            projection: ["id", "index"],
            sort: { index: 1, id: 1 },
        },
    )) as Array<Pick<ITreeNode, "id" | "index">>

    const filteredSiblings = siblings.filter((sibling) => !movingNodeIdSet.has(String(sibling.id)))
    const orderedSiblingIds = filteredSiblings.map((sibling) => String(sibling.id))
    const normalizedIndexMap = normalizeTreeSiblingIndexes(filteredSiblings)

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
    const indexRangeResult = await createTreeIndexRange.call(this, parentId, movingRootNodes.length, lowerIndex, upperIndex)

    return {
        patchMap: new Map(movingRootNodes.map((node, index) => [node.id, indexRangeResult.indexes[index]])),
        nextParentLastIndex: indexRangeResult.nextParentLastIndex,
    }
}

async function resolveMoveConflict(
    this: TableTree<ITreeNode>,
    rootNode: ITreeNode,
    targetParentId: string,
    options?: ITreeMoveNodesOptions,
    reservedNamesByParent?: Map<string, Set<string>>,
): Promise<
    | { action: "move"; patch: Partial<ITreeNode> }
    | { action: "skip" }
    | { action: "merge"; targetNodeId: string }
> {
    const uniqueBy = options?.uniqueBy ?? (options?.overwriteMode === "newName" ? "name" : undefined)
    if (!uniqueBy) {
        return { action: "move", patch: {} }
    }

    const sourceValue = getMoveNodeValueByPath(rootNode as Record<string, any>, uniqueBy)
    if (sourceValue === undefined || sourceValue === null) {
        return { action: "move", patch: {} }
    }

    const conflictNodes = (await this.findMany(
        {
            parentId: targetParentId,
            [uniqueBy]: sourceValue,
        },
        {
            projection: ["id", "isDir", "type", "modif"],
        },
    )) as Pick<ITreeNode, "id" | "isDir" | "modif">[]

    const filteredConflictNodes = conflictNodes.filter((node) => String(node.id) !== rootNode.id)
    if (filteredConflictNodes.length === 0) {
        return { action: "move", patch: {} }
    }

    if (options?.overwriteMode === "newName") {
        const sourceName = typeof rootNode.name === "string" ? rootNode.name : String(rootNode.name ?? rootNode.id)
        const nextName = await createMoveName.call(this, targetParentId, sourceName, reservedNamesByParent ?? new Map())
        return { action: "move", patch: { name: nextName } }
    }

    if (["merge", "mergeByModif"].includes(options?.overwriteMode ?? "") && rootNode.isDir) {
        const dirConflictNodes = filteredConflictNodes.filter((node) => node.isDir)
        if (dirConflictNodes.length === 1) {
            return {
                action: "merge",
                targetNodeId: String(dirConflictNodes[0].id),
            }
        }
    }

    const hasTargetDirConflict = filteredConflictNodes.some((node) => node.isDir)
    if (!rootNode.isDir && hasTargetDirConflict && options?.enableFileOverwriteDir !== true) {
        return { action: "skip" }
    }

    if (options?.overwriteMode === "mergeByModif") {
        const sourceModif = normalizeTreeNodeModif(rootNode.modif)
        const targetMaxModif = Math.max(...filteredConflictNodes.map((node) => normalizeTreeNodeModif(node.modif)))
        if (sourceModif <= targetMaxModif) {
            return { action: "skip" }
        }
    }

    await deleteNodes.call(
        this,
        filteredConflictNodes.map((node) => String(node.id)),
    )

    return { action: "move", patch: {} }
}

function getMoveNodeValueByPath(source: Record<string, any>, path: string): any {
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

async function mergeTreeNode(
    this: TableTree<ITreeNode>,
    sourceNode: ITreeNode,
    targetNodeId: string,
    options?: ITreeMoveNodesOptions,
): Promise<void> {
    const children = await this.findMany(
        { parentId: sourceNode.id },
        {
            projection: ["id"],
        },
    )

    const childNodeIds = children.map((child) => String(child.id))
    if (childNodeIds.length > 0) {
        await moveNodes.call(this, childNodeIds, targetNodeId, options)
    }

    await deleteNodes.call(this, [sourceNode.id])
}

function normalizeTreeNodeModif(modif: unknown): number {
    return typeof modif === "number" && !Number.isNaN(modif) ? modif : 0
}

async function createMoveName(
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

/**
 * 收集一棵子树内的全部节点 id，包含根节点自身。
 *
 * moveNodes 需要用它判断是否把节点移动到了自己的子孙节点下。
 */
async function collectSubtreeNodeIds(
    this: TableTree<ITreeNode>,
    rootNodeId: string,
): Promise<string[]> {
    const visitedIds = new Set<string>()
    const queue = [rootNodeId]

    while (queue.length > 0) {
        const currentNodeId = queue.shift()!
        if (visitedIds.has(currentNodeId)) {
            continue
        }

        visitedIds.add(currentNodeId)

        const children = await this.findMany(
            { parentId: currentNodeId },
            {
                projection: ["id"],
            },
        )

        for (const child of children) {
            if (!visitedIds.has(child.id)) {
                queue.push(child.id)
            }
        }
    }

    return Array.from(visitedIds)
}
