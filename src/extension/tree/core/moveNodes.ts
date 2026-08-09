import type { ITreeNode, ITreeChangeResult, ITreeIndexOptions, ITreeOverwriteOptions } from "../tree.types"
import type { ITreeOperationContext } from "./context"
import { resolveTreeIndexes } from "../util/resolveTreeIndex"
import { rebalanceTreeIndexes } from "../util/rebalanceTreeIndexes"
import { refreshTreeMetadata } from "../util/refreshTreeMetadata"
import { assertNotMoveIntoSelfOrDescendant, assertTreeParentExists } from "../util/assertTreeParent"
import { collectTopSelectedNodes } from "../util/collectTopSelectedNodes"
import { getNodeValueByPath } from "../util/getNodeValueByPath"
import { getUniqueFileNames } from "../util/getUniqueFileNames"
import { deleteNodesCore } from "./deleteNodes"

export interface ITreeMoveNodesOptions extends ITreeOverwriteOptions {
    index?: ITreeIndexOptions
}

/** 移动 core：只处理已有节点，覆盖冲突和实际移动都在当前上下文内完成。 */
export async function moveNodesCore(
    context: ITreeOperationContext,
    nodeIds: string[],
    parentId: string,
    options?: ITreeMoveNodesOptions,
): Promise<ITreeChangeResult> {
    const ids = Array.from(new Set(nodeIds)).filter(Boolean)
    if (ids.length === 0) return {}
    await assertTreeParentExists(context.view as any, parentId)
    const nodes = await collectTopSelectedNodes(context.view as any, ids) as ITreeNode[]
    if (nodes.length === 0) return {}
    await assertNotMoveIntoSelfOrDescendant(context.view as any, nodes.map((node) => node.id), parentId)

    const movable = await resolveMoveConflicts(context, nodes, parentId, options)
    if (movable.length === 0) return {}
    const indexes = await resolveTreeIndexes(context.view as any, parentId, movable.length, options?.index)
    const modif = Date.now()
    const oldParentIds = Array.from(new Set(movable.map((node) => node.parentId)))

    const result = await context.adapter.bulkUpdate(movable.map((node, index) => ({
        // 旧 parentId 作为 compare-and-set 条件，避免多实例同时移动时静默覆盖彼此结果。
        filter: { id: node.id, parentId: node.parentId } as any,
        updateOp: { $set: { parentId, index: indexes[index], modif } as any },
    })))
    if (result.matchedCount !== undefined && result.matchedCount < movable.length) {
        throw new Error("[TableTree] 移动节点时检测到并发修改，请重试")
    }

    await rebalanceTreeIndexes(context.view as any, parentId, movable.map((node, index) => ({ id: node.id, index: indexes[index] })))
    await refreshTreeMetadata(context.view as any, { parentIds: [parentId, ...oldParentIds], cmodif: modif })
    return { modif, cmodif: modif }
}

async function resolveMoveConflicts(
    context: ITreeOperationContext,
    nodes: ITreeNode[],
    parentId: string,
    options?: ITreeMoveNodesOptions,
): Promise<ITreeNode[]> {
    const uniqueBy = options?.uniqueBy ?? "id"
    const mode = options?.overwriteMode ?? "replace"
    const sourceIds = new Set(nodes.map((node) => node.id))
    const conflicts: ITreeNode[] = []
    for (const node of nodes) {
        const value = getNodeValueByPath(node, uniqueBy)
        if (value === undefined) continue
        const conflict = await context.view.findOne({
            parentId,
            [uniqueBy]: value,
            id: { $nin: [...sourceIds] },
        } as any, { ignoreMarkDelete: false })
        if (conflict) conflicts.push(conflict)
    }

    if (conflicts.length === 0) return nodes
    if (mode === "skip") {
        const conflictValues = new Set(conflicts.map((node) => `${uniqueBy}:${String(getNodeValueByPath(node, uniqueBy))}`))
        return nodes.filter((node) => !conflictValues.has(`${uniqueBy}:${String(getNodeValueByPath(node, uniqueBy))}`))
    }
    if (mode === "newName" && uniqueBy === "name") {
        const siblingNames = new Set((await context.view.findMany({ parentId })).map((node) => node.name))
        const names = await getUniqueFileNames(nodes.map((node) => node.name), siblingNames)
        return nodes.map((node, index) => ({ ...node, name: names[index] }))
    }
    if (mode === "merge" || mode === "mergeByModif") {
        // 目录合并保留目标目录，来源目录的直属子级在同一事务中迁移到目标目录。
        for (const conflict of conflicts) {
            const source = nodes.find((node) => getNodeValueByPath(node, uniqueBy) === getNodeValueByPath(conflict, uniqueBy))
            if (!source || !source.isDir || !conflict.isDir) continue
            const children = await context.view.findMany({ parentId: source.id })
            for (const child of children) await moveNodesCore(context, [child.id], conflict.id, options)
            await deleteNodesCore(context, [source.id])
        }
        return nodes.filter((node) => !conflicts.some((conflict) => getNodeValueByPath(node, uniqueBy) === getNodeValueByPath(conflict, uniqueBy)))
    }

    const replaceIds = conflicts
        .filter((conflict) => options?.enableFileOverwriteDir === true || !(!conflict.isDir && nodes.some((node) => node.isDir)))
        .map((node) => node.id)
    if (replaceIds.length > 0) await deleteNodesCore(context, replaceIds)
    return nodes
}
