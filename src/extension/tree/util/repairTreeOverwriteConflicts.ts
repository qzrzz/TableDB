import type { TableTree } from "../TableTree"
import type { ITreeNode, ITreeOverwriteOptions } from "../tree.types"
import { repairDuplicatedSiblingConflicts } from "./repairDuplicatedSiblingConflicts"
import { repairDuplicatedSiblingNames } from "./repairDuplicatedSiblingNames"

/**
 * 覆盖写入后做并发兜底收敛，避免同级残留重复名称或重复唯一键。
 *
 * 预先解析覆盖策略只能基于当时读到的同级节点；多用户同时写入同一父级时，
 * 仍可能在写入后产生重复 name 或 uniqueBy。这个函数统一放在 core 操作末尾，
 * 按实际落库结果再做一次修复，让最终状态符合覆盖模式。
 */
export async function repairTreeOverwriteConflicts<TNode extends ITreeNode>(
    table: TableTree<TNode>,
    parentId: string,
    candidateIds: string[],
    options?: ITreeOverwriteOptions,
): Promise<void> {
    const overwriteMode = options?.overwriteMode ?? "replace"
    const uniqueBy = options?.uniqueBy ?? "id"

    if (overwriteMode === "newName" && uniqueBy === "name") {
        await repairDuplicatedSiblingNames(table, parentId, candidateIds)
        return
    }

    if (["replace", "skip", "merge", "mergeByModif"].includes(overwriteMode)) {
        await repairDuplicatedSiblingConflicts(table, parentId, uniqueBy, candidateIds, overwriteMode)
    }
}
