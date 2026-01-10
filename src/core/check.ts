import { ITableDoc } from "../adapter/adapter"
import { Table } from "./Table"
import { ITableFilter, ITableUpdateOp } from "./types"
import { UID } from "fzz"

/**
 * 在 fitler 实际使用前，进行检查和修正
 */
export function __check_filter(
    this: Table,
    filter: ITableFilter,
    options?: { ignoreMarkDelete?: boolean; realDelete?: boolean } & Record<string, any>
) {
    if (this.options?.enableMarkDelete && !options?.ignoreMarkDelete && !options?.realDelete) {
        let f = filter as any
        if (
            f._isDeleted == undefined &&
            f.$not?._isDeleted == undefined &&
            f.$and?._isDeleted == undefined &&
            f.$or?._isDeleted == undefined &&
            f.$nor?._isDeleted == undefined
        ) {
            f._isDeleted = { $ne: true }
        }
    }
}

/**
 * 在插入或更新文档前，进行检查和修正
 */
export function __check_input_doc(this: Table, doc: Partial<ITableDoc> | void) {
    if (!doc) return
    // 如果 id 不存在，则自动生成一个唯一 ID
    if (doc.id === undefined) {
        doc.id = UID.new()
    }
}

/**
 * 在插入或更新文档前，进行检查和修正
 */
export function __check_find_options(this: Table, options?: { projection?: any }) {
    if (options?.projection) {
        // 处理预设投影
        if (typeof options.projection === "string") {
            options.projection = this.plv(options.projection as any)
        }
    }
}

/**
 * 在输出文档前，进行检查和修正
 */
export function __check_output_doc(this: Table, doc: Partial<ITableDoc> | void) {
    if (!doc) return
}

/**
 * 在更新操作前，进行检查和修正
 */
export function __check_update_op(this: Table, updateOp: ITableUpdateOp | void) {
    if (!updateOp) return
}
