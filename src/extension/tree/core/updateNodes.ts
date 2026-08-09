import type { ITableFilter, ITableUpdateOp } from "../../../core/types"
import type { ITreeNode, ITreeChangeResult } from "../tree.types"
import type { ITreeOperationContext } from "./context"
import { refreshTreeMetadata } from "../util/refreshTreeMetadata"
import { assertTreeNodeName } from "../util/assertTreeParent"
import { collectDescendantNodes } from "../util/collectDescendantNodes"

export interface ITreeUpdateNodesOptions {
    /**
     * 是否把更新扩展到所有后代。
     * `parentId` 会被忽略，不能通过 updateNodes 移动节点；需要移动时使用 moveNodes / setNodes。
     */
    deep?: boolean
}

/**
 * 更新 core：只处理内容与业务字段，不负责节点移动。
 *
 * - `parentId` 会被静默忽略，避免误写造成环或破坏树结构；
 * - 受管理的统计字段（ctotal 等）会被剥离；
 * - tree 的默认策略是不强制事务化更新；需要和结构操作同批次时由 setNodes tool 统一编排。
 */
export async function updateNodesCore(
    context: ITreeOperationContext,
    filter: ITableFilter,
    updateOp: ITableUpdateOp<ITreeNode>,
    options?: ITreeUpdateNodesOptions,
): Promise<ITreeChangeResult> {
    const targets = await context.view.findMany(filter) as ITreeNode[]
    if (targets.length === 0) return {}

    const targetNodes = [...targets]
    if (options?.deep) {
        targetNodes.push(...await collectDescendantNodes(context.view as any, targets.map((node) => node.id), {
            includeSelf: false,
            ignoreMarkDelete: false,
        }) as ITreeNode[])
    }

    validateUpdateOp(updateOp)
    const cleanUpdateOp = normalizeTreeUpdateOp(updateOp)
    const setOp = cleanUpdateOp.$set as Record<string, any> | undefined
    const modif = Number(setOp?.modif ?? Date.now())
    if (setOp) setOp.modif = modif

    const ids = Array.from(new Set(targetNodes.map((node) => node.id)))
    await context.adapter.updateMany({ id: { $in: ids } }, cleanUpdateOp)

    // parentId 已被忽略，统计变化只可能来自 index / isDir / size。
    const statsChanged = Boolean(setOp && ["index", "isDir", "size"].some((key) => key in setOp))
    await refreshTreeMetadata(context.view as any, {
        parentIds: Array.from(new Set(targetNodes.map((node) => node.parentId))),
        cmodif: modif,
        statsChanged,
    })
    return { modif, cmodif: modif }
}

function validateUpdateOp(updateOp: ITableUpdateOp<ITreeNode>): void {
    const setOp = updateOp.$set as Record<string, any> | undefined
    if (setOp?.id !== undefined) throw new Error("[TableTree] updateNodes 不能修改节点 id")
    if (setOp?.name !== undefined) assertTreeNodeName(setOp.name)
    if (setOp?.isDir !== undefined && typeof setOp.isDir !== "boolean") throw new Error("[TableTree] isDir 必须是布尔值")
    if (setOp?.size !== undefined && (typeof setOp.size !== "number" || !Number.isFinite(setOp.size) || setOp.size < 0)) {
        throw new Error("[TableTree] size 必须是非负有限数字")
    }
}

/** 剥离受管理字段和 parentId，并准备可安全写入的 updateOp。 */
function normalizeTreeUpdateOp(updateOp: ITableUpdateOp<ITreeNode>): ITableUpdateOp<ITreeNode> {
    const setOp = { ...((updateOp.$set as Record<string, any> | undefined) ?? {}) }
    // 结构位置只能由 moveNodes / setNodes 改变；这里忽略 parentId，避免半成功写入环。
    delete setOp.parentId
    delete setOp.ctotal
    delete setOp.cftotal
    delete setOp.csize
    delete setOp.childLastIndex
    return { ...updateOp, $set: setOp as any }
}
