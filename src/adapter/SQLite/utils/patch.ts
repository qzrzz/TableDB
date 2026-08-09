
import { get, set, unset, has, cloneDeep, isEqual } from "es-toolkit/compat"
import { ITableUpdateOp, ITableValue } from "../../../core/types"

/**
 * 在内存中对文档应用 MongoDB 风格的更新操作
 * 直接修改传入的 doc 对象
 * @returns 是否发生了修改
 */
export function applyUpdate(doc: any, op: ITableUpdateOp): boolean {
    let modified = false

    // $set
    if (op.$set) {
        for (const [path, value] of Object.entries(op.$set)) {
            if (!isEqual(get(doc, path), value)) {
                set(doc, path, value)
                modified = true
            }
        }
    }

    // $unset
    if (op.$unset) {
        const paths = Array.isArray(op.$unset) ? op.$unset : Object.keys(op.$unset)
        for (const path of paths) {
            if (has(doc, path)) {
                unset(doc, path)
                modified = true
            }
        }
    }

    // $inc
    if (op.$inc) {
        for (const [path, value] of Object.entries(op.$inc)) {
            const current = get(doc, path)
            if (typeof current === "number" && typeof value === "number") {
                set(doc, path, current + value)
                modified = true
            } else if (typeof current === "bigint") {
                set(doc, path, current + BigInt(value))
                modified = true
            } else if (current === undefined) {
                // 如果不存在，初始化为 value
                set(doc, path, value)
                modified = true
            }
        }
    }

    // $mul
    if (op.$mul) {
        for (const [path, value] of Object.entries(op.$mul)) {
            const current = get(doc, path)
            if (typeof current === "number" && typeof value === "number") {
                set(doc, path, current * value)
                modified = true
            } else if (typeof current === "bigint") {
                set(doc, path, current * BigInt(value))
                modified = true
            } else if (current === undefined) {
                set(doc, path, 0) // MongoDB behavior: $mul on missing field sets to 0
                modified = true
            }
        }
    }

    // $min
    if (op.$min) {
        for (const [path, value] of Object.entries(op.$min)) {
            const current = get(doc, path)
            if (current === undefined || value < current) { // JS comparison works for primitives & Date
                set(doc, path, value)
                modified = true
            }
        }
    }

    // $max
    if (op.$max) {
        for (const [path, value] of Object.entries(op.$max)) {
            const current = get(doc, path)
            if (current === undefined || value > current) {
                set(doc, path, value)
                modified = true
            }
        }
    }

    // $rename
    if (op.$rename) {
        for (const [oldPath, newPath] of Object.entries(op.$rename)) {
            if (has(doc, oldPath)) {
                const val = get(doc, oldPath)
                unset(doc, oldPath)
                set(doc, newPath, val)
                modified = true
            }
        }
    }

    // Arrays: $push, $addToSet, $pop, $pull
    // 这里简化处理，完全模拟需要较多代码

    if (op.$push) {
        for (const [path, val] of Object.entries(op.$push)) {
            let arr = get(doc, path)
            if (arr === undefined) {
                arr = []
                set(doc, path, arr)
            }
            if (Array.isArray(arr)) {
                // 处理简化版 $push: { field: value } 和 完整版 $push: { field: { $each: [...] } }
                // types.ts 定义: $push: { [field]: ITableArrayAddOp }
                // ITableArrayAddOp can be value or { $each... }

                const addOp = val as any
                if (isPlainObject(addOp) && addOp.$each) {
                    // complex push
                    const each = Array.isArray(addOp.$each) ? addOp.$each : [addOp.$each]
                    const position = addOp.$position
                    const slice = addOp.$slice

                    if (each.length === 0) continue
                    if (typeof position === 'number') {
                        arr.splice(position, 0, ...each)
                    } else {
                        arr.push(...each)
                    }

                    if (typeof slice === 'number') {
                        // slice logic (negative: keep last N, positive: keep first N?, MongoDB is tricky)
                        // MongoDB: $slice: -5 (keep last 5)
                        // This uses Array.prototype.slice semantics? No, MongoDB specific.
                        // MongoDB: 0 (empty), negative (last n), positive (first n)
                        if (slice === 0) arr.length = 0
                        else if (slice > 0) arr.splice(slice)
                        else if (slice < 0) {
                            const keep = arr.slice(slice)
                            arr.length = 0
                            arr.push(...keep)
                        }
                    }
                } else {
                    // simple push
                    arr.push(val)
                }
                modified = true
            }
        }
    }

    if (op.$addToSet) {
        for (const [path, val] of Object.entries(op.$addToSet)) {
            let arr = get(doc, path)
            if (arr === undefined) {
                arr = []
                set(doc, path, arr)
            }
            if (Array.isArray(arr)) {
                const addOp = val as any
                const itemsToAdd = (isPlainObject(addOp) && addOp.$each) ? addOp.$each : [val]

                for (const item of itemsToAdd) {
                    // Deep compare for uniqueness
                    if (!arr.some(existing => isEqual(existing, item))) {
                        arr.push(item)
                        modified = true
                    }
                }
            }
        }
    }

    if (op.$pop) {
        for (const [path, val] of Object.entries(op.$pop)) {
            const arr = get(doc, path)
            if (Array.isArray(arr) && arr.length > 0) {
                if (val === 1) arr.pop()
                else if (val === -1) arr.shift()
                modified = true
            }
        }
    }

    if (op.$pull) {
        for (const [path, condition] of Object.entries(op.$pull)) {
            const arr = get(doc, path)
            if (Array.isArray(arr)) {
                const originalLen = arr.length
                // simplified pull: check if element matches condition
                // condition can be Value or Filter
                const newArr = arr.filter(item => !matchPull(item, condition))
                if (newArr.length !== originalLen) {
                    set(doc, path, newArr)
                    modified = true
                }
            }
        }
    }

    return modified
}

export function isPlainObject(v: any) {
    return v && typeof v === 'object' && !Array.isArray(v) && v.constructor === Object
}

function matchPull(item: any, condition: any): boolean {
    // 简化的匹配逻辑
    if (isEqual(item, condition)) return true
    if (isPlainObject(condition)) {
        if (condition.$in && Array.isArray(condition.$in)) {
            if (condition.$in.some((c: any) => isEqual(c, item))) return true
        }
        // TODO: more operators
    }
    return false
}

export function flattenObject(obj: any, prefix = "", result: any = {}): any {
    for (const key in obj) {
        let value = obj[key]
        const newKey = prefix ? `${prefix}.${key}` : key

        if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) && !((value as any)._bloId)) {
            if (value.__overwrite__) {
                value = { ...value }
                delete value.__overwrite__
                result[newKey] = value
            } else {
                flattenObject(value, newKey, result)
            }
        } else {
            result[newKey] = value
        }
    }
    return result
}

export function deepMergeWithArrayUnion(target: any, source: any) {
    for (const key in source) {
        const sourceVal = source[key]
        const targetVal = target[key]

        if (sourceVal === undefined) continue

        if (isPlainObject(sourceVal) && !sourceVal.__overwrite__ && isPlainObject(targetVal)) {
            deepMergeWithArrayUnion(targetVal, sourceVal)
        } else if (Array.isArray(sourceVal) && Array.isArray(targetVal)) {
            for (const item of sourceVal) {
                if (!targetVal.some((t: any) => isEqual(t, item))) {
                    targetVal.push(item)
                }
            }
        } else {
            if (isPlainObject(sourceVal) && sourceVal.__overwrite__) {
                const { __overwrite__, ...clean } = sourceVal
                target[key] = clean
            } else {
                target[key] = sourceVal
            }
        }
    }
    return target
}
