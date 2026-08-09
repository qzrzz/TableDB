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
        // name 一并写入，保证 newName 改名结果真正落库。
        filter: { id: node.id, parentId: node.parentId } as any,
        updateOp: { $set: { parentId, index: indexes[index], modif, name: node.name } as any },
    })))
    if (result.matchedCount !== undefined && result.matchedCount < movable.length) {
        throw new Error("[TableTree] 移动节点时检测到并发修改，请重试")
    }

    await rebalanceTreeIndexes(context.view as any, parentId, movable.map((node, index) => ({ id: node.id, index: indexes[index] })))
    await refreshTreeMetadata(context.view as any, { parentIds: [parentId, ...oldParentIds], cmodif: modif })
    return { modif, cmodif: modif }
}

/**
 * 解析移动到目标父级时的同级冲突。
 *
 * 注意：不能把 `id: { $nin: ... }` 和 `[uniqueBy]: value` 写在同一层对象里；
 * 当 uniqueBy 为 `"id"` 时后者会被前者覆盖，导致误把任意兄弟当成冲突并删除。
 */
async function resolveMoveConflicts(
    context: ITreeOperationContext,
    nodes: ITreeNode[],
    parentId: string,
    options?: ITreeMoveNodesOptions,
): Promise<ITreeNode[]> {
    const uniqueBy = options?.uniqueBy ?? "id"
    const mode = options?.overwriteMode ?? "replace"
    const sourceIds = new Set(nodes.map((node) => node.id))

    // 默认按 id 判定时，目标父级下不存在“另一个同 id 节点”，无需覆盖解析。
    if (uniqueBy === "id") {
        return nodes
    }

    if (mode === "newName" && uniqueBy === "name") {
        const siblings = await context.view.findMany({ parentId }) as ITreeNode[]
        const existsNames = siblings
            .filter((node) => !sourceIds.has(node.id))
            .map((node) => node.name)
            .filter((name): name is string => typeof name === "string")
        const names = await getUniqueFileNames(nodes.map((node) => node.name), existsNames)
        return nodes.map((node, index) => ({ ...node, name: names[index] }))
    }

    const movable: ITreeNode[] = []
    const deleteIds: string[] = []

    for (const node of nodes) {
        const value = getNodeValueByPath(node, uniqueBy)
        if (value === undefined) {
            movable.push(node)
            continue
        }

        // 用 $and 组合条件，避免 uniqueBy 字段与 id 排除条件撞键。
        const conflict = await context.view.findOne({
            $and: [
                { parentId },
                { [uniqueBy]: value },
                { id: { $nin: [...sourceIds] } },
            ],
        } as any, { ignoreMarkDelete: false }) as ITreeNode | void

        if (!conflict) {
            movable.push(node)
            continue
        }

        if (mode === "skip") {
            continue
        }

        if (mode === "merge" || mode === "mergeByModif") {
            if (node.isDir && conflict.isDir) {
                // 目录合并：保留目标目录，递归迁移来源直属子级后删除来源目录。
                const children = await context.view.findMany({ parentId: node.id }) as ITreeNode[]
                for (const child of children) {
                    await moveNodesCore(context, [child.id], conflict.id, options)
                }
                await deleteNodesCore(context, [node.id])
                continue
            }
            if (mode === "mergeByModif" && (conflict.modif ?? 0) > (node.modif ?? 0)) {
                // 目标更新，跳过本次移动。
                continue
            }
            // 非目录冲突（或来源更新）按 replace 处理。
        }

        // 默认禁止文件覆盖目录，避免误删整棵子树。
        if (!options?.enableFileOverwriteDir && node.isDir === false && conflict.isDir === true) {
            continue
        }

        deleteIds.push(conflict.id)
        movable.push(node)
    }

    if (deleteIds.length > 0) {
        await deleteNodesCore(context, Array.from(new Set(deleteIds)))
    }
    return movable
}
