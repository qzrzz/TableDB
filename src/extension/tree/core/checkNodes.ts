import type { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"
import type { ICheckNodesResult, ITreeCheckNodesOptions, ITreeWritableNodePatch } from "./treeCore.types"
import { stripManagedTreeStatsFromPatch } from "./treeWriteGuards"

/**
 * 检测节点是否存在
 * 相当于进行一次预检 moveNodes 或 setNodes 操作，检查目标位置是否已经存在与要移动/设置的节点冲突的节点
 */
export async function checkNodes(
    this: TableTree<ITreeNode>,

    /** 要检查的节点数据列表 */
    nodes: ITreeWritableNodePatch<ITreeNode>[],

    /** 目的地的节点 ID */
    targetId: string,

    options?: ITreeCheckNodesOptions,
): Promise<ICheckNodesResult<ITreeNode>> {
    const uniqueBy = options?.uniqueBy ?? "id"

    if (targetId !== "/") {
        const targetNode = await this.get(targetId)
        if (!targetNode) {
            throw new Error(`[TableTree] 目标父节点不存在: ${targetId}`)
        }
    }

    if (nodes.length === 0) {
        return {
            isConflict: false,
            existNodes: [],
        }
    }

    const sanitizedNodes = nodes.map((node) => stripManagedTreeStatsFromPatch<ITreeNode>(node as Record<string, any>))
    const candidateValues = Array.from(
        new Set(
            sanitizedNodes
                .map((node) => getValueByPath(node, uniqueBy))
                .filter((value) => value !== undefined && value !== null),
        ),
    )

    if (candidateValues.length === 0) {
        return {
            isConflict: false,
            existNodes: [],
        }
    }

    const sourceRootNodes = collectSourceRootNodes(sanitizedNodes)
    const affectedNodes = await collectAffectedConflictNodes.call(
        this,
        sourceRootNodes,
        targetId,
        {
            uniqueBy,
            options,
            batchChildrenMap: buildBatchChildrenMap(sanitizedNodes),
            conflictNodeCache: new Map<string, Partial<ITreeNode>[]>(),
            sourceChildrenCache: new Map<string, ITreeWritableNodePatch<ITreeNode>[]>(),
        },
    )

    return {
        isConflict: affectedNodes.length > 0,
        existNodes: affectedNodes,
    }
}

interface ICheckNodesTraversalContext {
    uniqueBy: string
    options?: ITreeCheckNodesOptions
    batchChildrenMap: Map<string, ITreeWritableNodePatch<ITreeNode>[]>
    conflictNodeCache: Map<string, Partial<ITreeNode>[]>
    sourceChildrenCache: Map<string, ITreeWritableNodePatch<ITreeNode>[]>
}

function buildConflictFilter(targetId: string, uniqueBy: string, values: any[]) {
    return {
        parentId: targetId,
        [uniqueBy]: { $in: values },
    }
}

function buildConflictProjection(uniqueBy: string): string[] {
    return Array.from(new Set(["id", "parentId", "name", "type", "isDir", "modif", uniqueBy]))
}

async function collectAffectedConflictNodes(
    this: TableTree<ITreeNode>,
    sourceNodes: ITreeWritableNodePatch<ITreeNode>[],
    targetParentId: string,
    context: ICheckNodesTraversalContext,
): Promise<Partial<ITreeNode>[]> {
    const affectedNodes: Partial<ITreeNode>[] = []
    const seenIds = new Set<string>()

    for (const sourceNode of sourceNodes) {
        const matchedExistNodes = await findConflictNodesForSourceNode.call(this, sourceNode, targetParentId, context)
        const nextAffectedNodes = filterAffectedNodesByOverwriteMode(sourceNode, matchedExistNodes, context.options)

        for (const affectedNode of nextAffectedNodes) {
            const nodeId = String(affectedNode.id)
            if (seenIds.has(nodeId)) {
                continue
            }
            seenIds.add(nodeId)
            affectedNodes.push(affectedNode)
        }

        const mergeTargetNode = resolveMergeTargetNode(sourceNode, matchedExistNodes, context.options)
        if (!mergeTargetNode) {
            continue
        }

        const childNodes = await loadSourceChildNodes.call(this, sourceNode, context)
        if (childNodes.length === 0) {
            continue
        }

        const descendantAffectedNodes = await collectAffectedConflictNodes.call(
            this,
            childNodes,
            String(mergeTargetNode.id),
            context,
        )

        for (const affectedNode of descendantAffectedNodes) {
            const nodeId = String(affectedNode.id)
            if (seenIds.has(nodeId)) {
                continue
            }
            seenIds.add(nodeId)
            affectedNodes.push(affectedNode)
        }
    }

    return affectedNodes
}

function collectSourceRootNodes(sourceNodes: ITreeWritableNodePatch<ITreeNode>[]): ITreeWritableNodePatch<ITreeNode>[] {
    const sourceNodeIds = new Set(
        sourceNodes
            .map((node) => node.id)
            .filter((nodeId): nodeId is string => typeof nodeId === "string" && nodeId.length > 0),
    )
    const rootNodes = sourceNodes.filter((node) => typeof node.parentId !== "string" || !sourceNodeIds.has(node.parentId))
    return rootNodes.length > 0 ? rootNodes : sourceNodes
}

function buildBatchChildrenMap(sourceNodes: ITreeWritableNodePatch<ITreeNode>[]): Map<string, ITreeWritableNodePatch<ITreeNode>[]> {
    const batchChildrenMap = new Map<string, ITreeWritableNodePatch<ITreeNode>[]>()

    for (const sourceNode of sourceNodes) {
        if (typeof sourceNode.parentId !== "string" || sourceNode.parentId.length === 0) {
            continue
        }

        const nextChildren = batchChildrenMap.get(sourceNode.parentId) ?? []
        nextChildren.push(sourceNode)
        batchChildrenMap.set(sourceNode.parentId, nextChildren)
    }

    return batchChildrenMap
}

async function findConflictNodesForSourceNode(
    this: TableTree<ITreeNode>,
    sourceNode: ITreeWritableNodePatch<ITreeNode>,
    targetParentId: string,
    context: ICheckNodesTraversalContext,
): Promise<Partial<ITreeNode>[]> {
    const sourceValue = getValueByPath(sourceNode as Record<string, any>, context.uniqueBy)
    if (sourceValue === undefined || sourceValue === null) {
        return []
    }

    const cacheKey = `${targetParentId}\n${context.uniqueBy}\n${JSON.stringify(sourceValue)}`
    const cachedNodes = context.conflictNodeCache.get(cacheKey)
    if (cachedNodes) {
        return cachedNodes
    }

    const conflictNodes = (await this.findMany(
        buildConflictFilter(targetParentId, context.uniqueBy, [sourceValue]),
        {
            projection: buildConflictProjection(context.uniqueBy),
        } as any,
    )) as Partial<ITreeNode>[]

    context.conflictNodeCache.set(cacheKey, conflictNodes)
    return conflictNodes
}

function resolveMergeTargetNode(
    sourceNode: ITreeWritableNodePatch<ITreeNode>,
    existNodes: Partial<ITreeNode>[],
    options?: ITreeCheckNodesOptions,
): Partial<ITreeNode> | undefined {
    if (!sourceNode.isDir || !["merge", "mergeByModif"].includes(options?.overwriteMode ?? "")) {
        return undefined
    }

    const dirExistNodes = existNodes.filter((node) => node.isDir)
    return dirExistNodes.length === 1 ? dirExistNodes[0] : undefined
}

async function loadSourceChildNodes(
    this: TableTree<ITreeNode>,
    sourceNode: ITreeWritableNodePatch<ITreeNode>,
    context: ICheckNodesTraversalContext,
): Promise<ITreeWritableNodePatch<ITreeNode>[]> {
    if (typeof sourceNode.id !== "string" || sourceNode.id.length === 0) {
        return []
    }

    const batchChildren = context.batchChildrenMap.get(sourceNode.id)
    if (batchChildren && batchChildren.length > 0) {
        return batchChildren
    }

    const cachedChildren = context.sourceChildrenCache.get(sourceNode.id)
    if (cachedChildren) {
        return cachedChildren
    }

    const sourceChildren = (await this.findMany(
        { parentId: sourceNode.id },
        {
            projection: buildConflictProjection(context.uniqueBy),
        } as any,
    )) as ITreeWritableNodePatch<ITreeNode>[]

    context.sourceChildrenCache.set(sourceNode.id, sourceChildren)
    return sourceChildren
}

function filterAffectedNodesByOverwriteMode(
    sourceNode: ITreeWritableNodePatch<ITreeNode>,
    existNodes: Partial<ITreeNode>[],
    options?: ITreeCheckNodesOptions,
): Partial<ITreeNode>[] {
    if (existNodes.length === 0) {
        return []
    }

    if (options?.overwriteMode === "newName") {
        return []
    }

    if (["merge", "mergeByModif"].includes(options?.overwriteMode ?? "") && sourceNode.isDir) {
        const dirExistNodes = existNodes.filter((node) => node.isDir)
        if (dirExistNodes.length === 1) {
            return dirExistNodes
        }
    }

    const hasTargetDirConflict = existNodes.some((node) => node.isDir)
    if (sourceNode.isDir === false && hasTargetDirConflict && options?.enableFileOverwriteDir !== true) {
        return []
    }

    if (options?.overwriteMode === "mergeByModif") {
        const sourceModif = normalizeNodeModif(sourceNode.modif)
        const targetMaxModif = Math.max(...existNodes.map((node) => normalizeNodeModif(node.modif)))
        if (sourceModif <= targetMaxModif) {
            return []
        }
    }

    return existNodes
}

function normalizeNodeModif(modif: unknown): number {
    return typeof modif === "number" && !Number.isNaN(modif) ? modif : 0
}

function getValueByPath(source: Record<string, any>, path: string): any {
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
