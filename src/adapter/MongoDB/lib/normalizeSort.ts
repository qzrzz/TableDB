import type { Sort } from "mongodb"

/** 规范化排序参数 */
export function normalizeSort(sort?: string[] | Record<string, 1 | -1>): Sort | undefined {
    if (!sort) return undefined
    if (Array.isArray(sort)) {
        const sortObj: Record<string, 1 | -1> = {}
        sort.forEach((s) => {
            if (s.startsWith("-")) {
                sortObj[s.substring(1)] = -1
            } else {
                sortObj[s] = 1
            }
        })
        return sortObj
    }
    return sort
}
