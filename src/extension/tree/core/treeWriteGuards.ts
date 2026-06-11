import type { ITableUpdateOp } from "../../../core/types"
import type { ITreeManagedField, ITreeManagedStatsField, ITreeWritableNodePatch } from "./treeCoreTypes"
import type { ITreeNode } from "../tree.types"

const TREE_MANAGED_STATS_FIELDS = new Set<ITreeManagedStatsField>(["csize", "ctotal", "cftotal"])
const TREE_MANAGED_FIELDS = new Set<ITreeManagedField>(["csize", "ctotal", "cftotal", "clidLastIndex"])

/**
 * 移除外部补丁里可能混入的树统计字段。
 *
 * create/set 这类直接接收文档对象的入口，应该统一通过这里兜底，
 * 避免调用方借助 any 等方式把内部字段带进来。
 */
export function stripManagedTreeStatsFromPatch<TNode extends ITreeNode>(patch: Record<string, any>): ITreeWritableNodePatch<TNode> {
    const nextPatch = { ...patch }
    for (const field of TREE_MANAGED_FIELDS) {
        delete nextPatch[field]
    }
    return nextPatch as ITreeWritableNodePatch<TNode>
}

/**
 * 断言 updateOp 没有试图写入树统计字段。
 *
 * 树统计字段只能由内部维护，因此所有公开更新入口都应先做这层检查。
 */
export function assertTreeManagedStatsNotModified(updateOp: ITableUpdateOp<any>): void {
    for (const [operator, value] of Object.entries(updateOp)) {
        if (!value || typeof value !== "object") {
            continue
        }

        if (operator === "$unset" && Array.isArray(value)) {
            for (const fieldPath of value) {
                assertTreeManagedFieldPathAllowed(fieldPath)
            }
            continue
        }

        for (const fieldPath of Object.keys(value)) {
            assertTreeManagedFieldPathAllowed(fieldPath)

            if (operator === "$rename") {
                const targetFieldPath = (value as Record<string, string>)[fieldPath]
                assertTreeManagedFieldPathAllowed(targetFieldPath)
            }
        }
    }
}

/** 判断 updateOp 是否会影响祖先统计 */
export function hasTreeStatAffectingFieldUpdate(updateOp: ITableUpdateOp<any>): boolean {
    return hasFieldUpdate(updateOp, ["size", "isDir"])
}

/** 判断 updateOp 是否触及指定字段 */
export function hasFieldUpdate(updateOp: ITableUpdateOp<any>, fieldNames: string[]): boolean {
    const fieldSet = new Set(fieldNames)

    for (const [operator, value] of Object.entries(updateOp)) {
        if (!value || typeof value !== "object") {
            continue
        }

        if (operator === "$unset" && Array.isArray(value)) {
            if (value.some((fieldPath) => fieldSet.has(getRootFieldName(fieldPath)))) {
                return true
            }
            continue
        }

        for (const fieldPath of Object.keys(value)) {
            if (fieldSet.has(getRootFieldName(fieldPath))) {
                return true
            }

            if (operator === "$rename") {
                const targetFieldPath = (value as Record<string, string>)[fieldPath]
                if (fieldSet.has(getRootFieldName(targetFieldPath))) {
                    return true
                }
            }
        }
    }

    return false
}

function assertTreeManagedFieldPathAllowed(fieldPath: string): void {
    if (TREE_MANAGED_FIELDS.has(getRootFieldName(fieldPath) as ITreeManagedField)) {
        throw new Error(`[TableTree] 不允许外部修改树内部维护字段: ${fieldPath}`)
    }
}

function getRootFieldName(fieldPath: string): string {
    return fieldPath.split(".")[0]
}