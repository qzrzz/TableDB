import type { ITreeNode } from "../tree.types"

const TREE_MANAGED_FIELDS = new Set(["csize", "ctotal", "cftotal", "childLastIndex"])

/** 移除由目录树内部维护的统计字段，避免外部写入破坏树结构元数据。 */
export function stripTreeManagedFields<T extends Record<string, any>>(data: T): Partial<T> {
    const cleanData: Record<string, any> = {}
    for (const [key, value] of Object.entries(data)) {
        if (!TREE_MANAGED_FIELDS.has(key)) {
            cleanData[key] = value
        }
    }
    return cleanData as Partial<T>
}

/** 判断字段是否属于目录树内部维护的统计字段。 */
export function isTreeManagedField(field: keyof ITreeNode | string): boolean {
    return TREE_MANAGED_FIELDS.has(String(field))
}
