
import { get, isEqual as lodashIsEqual, isPlainObject } from "es-toolkit/compat"
import { ITableFilter } from "../../../core/types"

/**
 * 判断文档是否匹配 Filter
 * 用于 SQLite 自定义函数 JsMatch
 * 
 * @param doc 纯 JS 对象（已反序列化）
 * @param filter 查询条件
 */
export function matches(doc: any, filter: ITableFilter): boolean {
    if (isPlainObject(filter) && Object.keys(filter).length === 0) return true

    // 隐式 AND
    for (const key in filter) {
        if (key === "$and") {
            if (!matchAnd(doc, (filter as any).$and)) return false
        } else if (key === "$or") {
            if (!matchOr(doc, (filter as any).$or)) return false
        } else if (key === "$nor") {
            if (!matchNor(doc, (filter as any).$nor)) return false
        } else if (key === "$not") {
            if (!matchNot(doc, (filter as any).$not)) return false
        } else {
            // Field query
            const condition = (filter as any)[key]
            const value = get(doc, key)
            if (!matchValue(value, condition)) return false
        }
    }
    return true
}

function matchAnd(doc: any, conditions: ITableFilter[]): boolean {
    if (!Array.isArray(conditions)) return false
    return conditions.every(c => matches(doc, c))
}

function matchOr(doc: any, conditions: ITableFilter[]): boolean {
    if (!Array.isArray(conditions)) return false
    return conditions.some(c => matches(doc, c))
}

function matchNor(doc: any, conditions: ITableFilter[]): boolean {
    if (!Array.isArray(conditions)) return false
    return !conditions.some(c => matches(doc, c))
}

function matchNot(doc: any, condition: ITableFilter): boolean {
    return !matches(doc, condition)
}

function matchValue(value: any, condition: any): boolean {
    // 1. Exact match (primitive or object equality)
    if (!isPlainObject(condition)) {
        // MongoDB 行为：查询 null 时，同时匹配 null 和缺失字段（undefined）
        if (condition === null || condition === undefined) {
            if (Array.isArray(value)) {
                return value.some(v => v === null || v === undefined)
            }
            return value === null || value === undefined
        }
        // Special handling for array field matching scalar
        if (Array.isArray(value) && !Array.isArray(condition)) {
            return value.some(v => safeIsEqual(v, condition))
        }
        return safeIsEqual(value, condition)
    }

    // 2. Operators
    // Check if it's an operator object (keys start with $)
    const keys = Object.keys(condition)
    const isOperator = keys.length > 0 && keys.every(k => k.startsWith("$"))

    if (!isOperator) {
        // It's a nested object match or exact object match
        return safeIsEqual(value, condition)
    }

    // Evaluate operators
    for (const op of keys) {
        const opVal = condition[op]
        if (!evaluateOp(value, op, opVal)) return false
    }

    return true
}

function evaluateOp(value: any, op: string, opVal: any): boolean {
    switch (op) {
        case "$eq":
            // MongoDB 行为：查询 null 时，同时匹配 null 值和缺失字段（undefined）
            if (opVal === null || opVal === undefined) {
                // 缺失字段（undefined）和 null 都应该匹配
                if (Array.isArray(value) && !Array.isArray(opVal)) {
                    return value.some(v => v === null || v === undefined)
                }
                return value === null || value === undefined
            }
            // 对于其他值的正常相等比较
            if (Array.isArray(value) && !Array.isArray(opVal)) {
                return value.some(v => safeIsEqual(v, opVal))
            }
            return safeIsEqual(value, opVal)
        case "$ne":
            // MongoDB 行为：$ne null 只匹配字段存在且值不为 null 的文档
            if (opVal === null || opVal === undefined) {
                // 只有字段存在且不为 null/undefined 才返回 true
                if (Array.isArray(value) && !Array.isArray(opVal)) {
                    return value.length > 0 && value.some(v => v !== null && v !== undefined)
                }
                return value !== null && value !== undefined
            }
            // 对于其他值的正常不等比较
            if (Array.isArray(value) && !Array.isArray(opVal)) {
                return !value.some(v => safeIsEqual(v, opVal))
            }
            return !safeIsEqual(value, opVal)
        case "$gt":
        case "$gte":
        case "$lt":
        case "$lte":
            // Comparison semantics
            if (Array.isArray(value)) {
                return value.some(v => compareOp(op, v, opVal))
            }
            return compareOp(op, value, opVal)
        case "$in":
            if (!Array.isArray(opVal)) return false
            if (Array.isArray(value)) {
                return value.some(v => opVal.some(ov => safeIsEqual(v, ov)))
            }
            return opVal.some(ov => safeIsEqual(value, ov))
        case "$nin":
            if (!Array.isArray(opVal)) return false
            if (Array.isArray(value)) {
                return !value.some(v => opVal.some(ov => safeIsEqual(v, ov)))
            }
            return !opVal.some(ov => safeIsEqual(value, ov))
        case "$exists":
            // MongoDB 行为：$exists 检查字段是否存在，不考虑值是否为 null
            // 字段存在（即使值为 null）时返回 true，字段不存在时返回 false
            const exists = value !== undefined
            return opVal ? exists : !exists
        case "$regex":
            const re = new RegExp(opVal)
            if (Array.isArray(value)) return value.some(v => typeof v === 'string' && re.test(v))
            return typeof value === 'string' && re.test(value)
        case "$like":
            if (Array.isArray(value)) return value.some(v => typeof v === 'string' && matchLike(v, opVal))
            return typeof value === 'string' && matchLike(value, opVal)
        case "$elemMatch":
            if (!Array.isArray(value)) return false
            // opVal is a Filter logic
            return value.some(v => matches(v, opVal))
        case "$size":
            if (!Array.isArray(value)) return false
            if (typeof opVal === 'number') return value.length === opVal
            return matchValue(value.length, opVal)
        case "$all":
            if (!Array.isArray(value) || !Array.isArray(opVal)) return false
            return opVal.every(req => value.some(v => safeIsEqual(v, req)))
        case "$not":
            // $not performs a logical NOT operation on the specified operator expression
            return !matchValue(value, opVal)
    }
    return false
}

function compareOp(op: string, a: any, b: any): boolean {
    const res = compare(a, b)
    if (op === "$gt") return res > 0
    if (op === "$gte") return res >= 0
    if (op === "$lt") return res < 0
    if (op === "$lte") return res <= 0
    return false
}

function compare(a: any, b: any): number {
    if (a === b) return 0

    // Blob/File handling
    if (a && b && typeof Blob !== "undefined" && a instanceof Blob && b instanceof Blob) {
        const bufA = (a as any)._buffer
        const bufB = (b as any)._buffer
        if (bufA && bufB && Buffer.isBuffer(bufA) && Buffer.isBuffer(bufB)) {
            return bufA.compare(bufB)
        }
    }

    // Date handling
    if (a instanceof Date && b instanceof Date) {
        if (a.getTime() === b.getTime()) return 0
        return a.getTime() > b.getTime() ? 1 : -1
    }
    // Type mismatch handling (simplified)
    const ta = typeof a
    const tb = typeof b
    if (ta !== tb) {
        if (ta < tb) return -1
        return 1
    }

    if (a > b) return 1
    if (a < b) return -1
    return 0
}

function matchLike(text: string, pattern: string): boolean {
    const reStr = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')
    return new RegExp(`^${reStr}$`).test(text)
}

function safeIsEqual(a: any, b: any): boolean {
    // Custom handling for Blob/File equality via _buffer
    if (a && b && typeof Blob !== "undefined") {
        const isABlob = a instanceof Blob
        const isBBlob = b instanceof Blob
        if (isABlob && isBBlob) {
            const bufA = (a as any)._buffer
            const bufB = (b as any)._buffer
            if (bufA && bufB && Buffer.isBuffer(bufA) && Buffer.isBuffer(bufB)) {
                return bufA.equals(bufB)
            }
        }
    }
    return lodashIsEqual(a, b)
}
