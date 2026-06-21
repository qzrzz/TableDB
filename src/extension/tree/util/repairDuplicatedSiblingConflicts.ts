import type { TableTree } from "../TableTree"
import type { ITreeNode, ITreeOverwriteOptions } from "../tree.types"
import { getNodeValueByPath } from "./getNodeValueByPath"

/** 多用户并发覆盖时可能同时写入同一唯一键，这里兜底只保留同一父级下最新的冲突节点。 */
export async function repairDuplicatedSiblingConflicts<TNode extends ITreeNode>(
    table: TableTree<TNode>,
    parentId: string,
    uniqueBy: string,
    candidateIds: string[],
    overwriteMode: ITreeOverwriteOptions["overwriteMode"] = "replace",
): Promise<void> {
    if (uniqueBy === "id" || candidateIds.length === 0) return

    const candidateIdSet = new Set(candidateIds)
    const siblings = await table.findMany({ parentId }) as TNode[]
    const candidateValues = new Set(
        siblings
            .filter((node) => candidateIdSet.has(node.id))
            .map((node) => getNodeValueByPath(node, uniqueBy))
            .filter((value) => value !== undefined),
    )
    if (candidateValues.size === 0) return

    const groups = new Map<any, TNode[]>()
    for (const node of siblings) {
        const value = getNodeValueByPath(node, uniqueBy)
        if (value === undefined || !candidateValues.has(value)) continue
        const nodes = groups.get(value) ?? []
        nodes.push(node)
        groups.set(value, nodes)
    }

    const deleteNodeIds: string[] = []
    for (const nodes of groups.values()) {
        if (nodes.length <= 1) continue
        const orderedNodes = [...nodes].sort((left, right) => {
            const byModif = (right.modif ?? 0) - (left.modif ?? 0)
            if (byModif !== 0) return byModif
            return String(right.id).localeCompare(String(left.id))
        })
        const [keptNode, ...duplicatedNodes] = orderedNodes
        const mergeableDirNodes = isMergeMode(overwriteMode) && keptNode.isDir
            ? duplicatedNodes.filter((node) => node.isDir)
            : []
        for (const node of mergeableDirNodes) {
            await mergeDuplicatedDirChildren(table, node, keptNode, uniqueBy, overwriteMode)
        }
        deleteNodeIds.push(...duplicatedNodes.map((node) => node.id))
    }

    if (deleteNodeIds.length > 0) {
        await table.deleteNodes(deleteNodeIds)
    }
}

function isMergeMode(overwriteMode: ITreeOverwriteOptions["overwriteMode"]): boolean {
    return overwriteMode === "merge" || overwriteMode === "mergeByModif"
}

/** 并发 merge 可能先产生多个同名目录，删除 loser 前必须先把子节点合并到保留目录，避免丢失无冲突子树。 */
async function mergeDuplicatedDirChildren<TNode extends ITreeNode>(
    table: TableTree<TNode>,
    sourceNode: TNode,
    targetNode: TNode,
    uniqueBy: string,
    overwriteMode: ITreeOverwriteOptions["overwriteMode"],
): Promise<void> {
    const children = await table.findMany({ parentId: sourceNode.id }, { sort: { index: 1 } }) as TNode[]
    if (children.length === 0) return

    await table.moveNodes(children.map((child) => child.id), targetNode.id, {
        uniqueBy,
        overwriteMode,
        index: { toEnd: true },
    })
}
