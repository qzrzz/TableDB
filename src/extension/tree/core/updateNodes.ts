import type { ITableFilter, ITableUpdateOp } from "../../../core/types"
import type { ITreeNode, ITreeChangeResult } from "../tree.types"
import type { ITreeOperationContext } from "./context"
import { refreshTreeMetadata } from "../util/refreshTreeMetadata"
import { assertTreeNodeName, assertTreeParentExists, assertTreeParentId } from "../util/assertTreeParent"
import { collectDescendantNodes } from "../util/collectDescendantNodes"

export interface ITreeUpdateNodesOptions {
    /** 是否把更新扩展到所有后代；deep 与 parentId 更新不能同时使用。 */
    deep?: boolean
}

/**
 * 更新 core：更新内容字段为轻量路径，结构字段只做必要校验。
 * tree 的默认策略是不强制事务化更新；需要和结构操作同批次时由 setNodes tool 统一编排。
 */
export async function updateNodesCore(
    context: ITreeOperationContext,
    filter: ITableFilter,
    updateOp: ITableUpdateOp<ITreeNode>,
    options?: ITreeUpdateNodesOptions,
): Promise<ITreeChangeResult> {
    const targets = await context.view.findMany(filter) as ITreeNode[]
    if (targets.length === 0) return {}
    if (options?.deep && updateOp.$set && Object.prototype.hasOwnProperty.call(updateOp.$set, "parentId")) {
        throw new Error("[TableTree] deep 更新不能同时修改 parentId")
    }

    const targetNodes = [...targets]
    if (options?.deep) {
        targetNodes.push(...await collectDescendantNodes(context.view as any, targets.map((node) => node.id), {
            includeSelf: false,
            ignoreMarkDelete: false,
        }) as ITreeNode[])
    }

    validateUpdateOp(updateOp)
    const setOp = updateOp.$set as Record<string, any> | undefined
    if (setOp?.parentId !== undefined) {
        await assertTreeParentExists(context.view as any, setOp.parentId)
    }
    const modif = Number((updateOp.$set as any)?.modif ?? Date.now())
    const cleanUpdateOp = normalizeTreeUpdateOp(updateOp, modif)
    const ids = Array.from(new Set(targetNodes.map((node) => node.id)))
    await context.adapter.updateMany({ id: { $in: ids } }, cleanUpdateOp)

    const statsChanged = Boolean(setOp && ["parentId", "index", "isDir", "size"].some((key) => key in setOp))
    await refreshTreeMetadata(context.view as any, {
        parentIds: Array.from(new Set(targetNodes.map((node) => node.parentId))),
        nodeIds: setOp?.parentId !== undefined ? ids : undefined,
        cmodif: modif,
        statsChanged,
    })
    return { modif, cmodif: modif }
}

function validateUpdateOp(updateOp: ITableUpdateOp<ITreeNode>): void {
    const setOp = updateOp.$set as Record<string, any> | undefined
    if (setOp?.id !== undefined) throw new Error("[TableTree] updateNodes 不能修改节点 id")
    if (setOp?.parentId !== undefined) assertTreeParentId(setOp.parentId)
    if (setOp?.name !== undefined) assertTreeNodeName(setOp.name)
    if (setOp?.isDir !== undefined && typeof setOp.isDir !== "boolean") throw new Error("[TableTree] isDir 必须是布尔值")
    if (setOp?.size !== undefined && (typeof setOp.size !== "number" || !Number.isFinite(setOp.size) || setOp.size < 0)) {
        throw new Error("[TableTree] size 必须是非负有限数字")
    }
    if (setOp?.parentId === "") throw new Error("[TableTree] parentId 不能为空")
}

function normalizeTreeUpdateOp(updateOp: ITableUpdateOp<ITreeNode>, modif: number): ITableUpdateOp<ITreeNode> {
    const setOp = { ...((updateOp.$set as Record<string, any> | undefined) ?? {}) }
    delete setOp.ctotal
    delete setOp.cftotal
    delete setOp.csize
    delete setOp.childLastIndex
    setOp.modif = modif
    return { ...updateOp, $set: setOp as any }
}
