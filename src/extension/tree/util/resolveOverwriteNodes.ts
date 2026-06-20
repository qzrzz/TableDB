import type { TableTree } from "../TableTree"
import type { ITreeNode, ITreeOverwriteOptions } from "../tree.types"
import { getNodeValueByPath } from "./getNodeValueByPath"
import { getUniqueFileNames } from "./getUniqueFileNames"

export interface IResolveOverwriteNodesOptions extends ITreeOverwriteOptions {
    /** move 模式下忽略当前正在移动的节点自身冲突。 */
    ignoreNodeIds?: string[]
}

export interface IResolveOverwriteNodesResult<TNode extends ITreeNode = ITreeNode> {
    /** 可以继续写入或移动的节点。 */
    nodes: TNode[]
    /** 被跳过的节点。 */
    skippedNodes: TNode[]
    /** 需要先删除的冲突节点 ID。 */
    deleteNodeIds: string[]
    /** replace 类覆盖中，来源节点和被覆盖目标节点的对应关系。 */
    replacePairs: { sourceNode: TNode; targetNode: TNode }[]
    /** 需要递归合并的目录节点对。 */
    mergePairs: { sourceNode: TNode; targetNode: TNode }[]
}

/** 解析覆盖策略，返回后续写入、跳过、删除和合并计划。 */
export async function resolveOverwriteNodes<TNode extends ITreeNode>(
    table: TableTree<TNode>,
    parentId: string,
    nodes: TNode[],
    options?: IResolveOverwriteNodesOptions,
): Promise<IResolveOverwriteNodesResult<TNode>> {
    const mode = options?.overwriteMode ?? "replace"
    const uniqueBy = options?.uniqueBy ?? "id"
    const ignoreNodeIds = new Set(options?.ignoreNodeIds ?? [])
    const result: IResolveOverwriteNodesResult<TNode> = {
        nodes: [],
        skippedNodes: [],
        deleteNodeIds: [],
        replacePairs: [],
        mergePairs: [],
    }

    if (nodes.length === 0) return result
    const resolvedNodes = mode === "replace"
        ? resolveReplaceBatchConflicts(nodes, uniqueBy)
        : nodes

    const conflictValues = resolvedNodes
        .map((node) => getNodeValueByPath(node, uniqueBy))
        .filter((value) => value !== undefined)
    const conflictNodes = conflictValues.length
        ? ((await table.findMany({ parentId, [uniqueBy]: { $in: conflictValues } })) as TNode[])
        : []

    if (mode === "newName" && uniqueBy === "name") {
        // newName 需要基于同级下所有已占用名称计算，避免只检查精确冲突时生成已有的后缀名。
        const siblingNodes = await table.findMany({ parentId }) as TNode[]
        const existsNames = siblingNodes
            .filter((node) => !ignoreNodeIds.has(node.id))
            .map((node) => node.name)
            .filter((name): name is string => typeof name === "string")
        const nextNames = await getUniqueFileNames(resolvedNodes.map((node) => node.name), existsNames)
        result.nodes = resolvedNodes.map((node, index) => ({ ...node, name: nextNames[index] }))
        return result
    }

    for (const node of resolvedNodes) {
        const value = getNodeValueByPath(node, uniqueBy)
        const conflicts = conflictNodes.filter((item) => {
            return !ignoreNodeIds.has(item.id) && item.id !== node.id && getNodeValueByPath(item, uniqueBy) === value
        })

        if (conflicts.length === 0) {
            result.nodes.push(node)
            continue
        }

        if (mode === "skip") {
            result.skippedNodes.push(node)
            continue
        }

        if (mode === "merge" || mode === "mergeByModif") {
            const firstConflict = conflicts[0]
            if (node.isDir && firstConflict.isDir) {
                result.mergePairs.push({ sourceNode: node, targetNode: firstConflict })
                continue
            }
            if (mode === "mergeByModif" && firstConflict.modif > node.modif) {
                result.skippedNodes.push(node)
                continue
            }
        }

        const deletableIds = conflicts
            .filter((item) => options?.enableFileOverwriteDir || !(node.isDir === false && item.isDir === true))
            .map((item) => item.id)
        if (deletableIds.length !== conflicts.length) {
            result.skippedNodes.push(node)
            continue
        }

        result.deleteNodeIds.push(...deletableIds)
        result.replacePairs.push(...conflicts.map((targetNode) => ({ sourceNode: node, targetNode })))
        result.nodes.push(node)
    }

    result.deleteNodeIds = Array.from(new Set(result.deleteNodeIds))
    return result
}

/** replace 模式下批次内同级同名节点互相覆盖，保留最后一个写入意图。 */
function resolveReplaceBatchConflicts<TNode extends ITreeNode>(nodes: TNode[], uniqueBy: string): TNode[] {
    const nodeByConflictKey = new Map<any, TNode>()
    const nodesWithoutConflictKey: TNode[] = []
    for (const node of nodes) {
        const value = getNodeValueByPath(node, uniqueBy)
        if (value === undefined) {
            nodesWithoutConflictKey.push(node)
            continue
        }
        nodeByConflictKey.set(value, node)
    }
    return [...nodesWithoutConflictKey, ...nodeByConflictKey.values()]
}
