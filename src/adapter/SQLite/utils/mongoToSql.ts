
import { ITableFilter } from "../../../core/types"
import { ITableFindOptions } from "../../adapter"
import { serialize } from "./serializer"

/**
 * 确保 _id 值为整数类型
 * 处理字符串、数字、以及包含 $in/$eq 等操作符的对象
 */
function ensureIntegerId(value: any): any {
    if (value === null || value === undefined) return value

    // 已经是整数
    if (typeof value === "number" && Number.isInteger(value)) return value

    // 字符串形式的整数
    if (typeof value === "string") {
        const num = parseInt(value, 10)
        if (!isNaN(num)) return num
        return value // 无法转换则原样返回
    }

    // 处理查询操作符，如 { $in: [...] }, { $eq: ... }, { $ne: ... } 等
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const result: any = {}
        for (const key of Object.keys(value)) {
            if (key.startsWith("$")) {
                // 操作符的值需要递归处理
                if (Array.isArray(value[key])) {
                    // $in, $nin 等数组操作符
                    result[key] = value[key].map((v: any) => ensureIntegerId(v))
                } else {
                    // $eq, $ne, $gt, $lt 等单值操作符
                    result[key] = ensureIntegerId(value[key])
                }
            } else {
                result[key] = value[key]
            }
        }
        return result
    }

    // 其他类型原样返回
    return value
}

export interface ISqlQuery {
    where: string
    params: any[]
    sort?: string
    limit?: number
    offset?: number
}

export async function mongoToSql(filter: ITableFilter, options?: ITableFindOptions): Promise<ISqlQuery> {
    const conditions: string[] = []
    const params: any[] = []

    // 1. Filter
    if (filter) {
        await parseFilterNode(filter, conditions, params)
    }

    if (conditions.length === 0) conditions.push("1=1")

    // 2. Options
    let sort = ""
    let limit: number | undefined
    let offset: number | undefined

    if (options) {
        if (options.limit !== undefined) limit = options.limit
        if (options.offset !== undefined) offset = options.offset

        if (options.sort) {
            const sortParts: string[] = []
            const sortObj = normalizeSort(options.sort)

            for (const [key, dir] of Object.entries(sortObj)) {
                if (key === "id") {
                    sortParts.push(`id ${dir === 1 ? "ASC" : "DESC"}`)
                } else if (key === "_id") {
                    sortParts.push(`_id ${dir === 1 ? "ASC" : "DESC"}`)
                } else {
                    sortParts.push(`json_extract(data, '$.${key}') ${dir === 1 ? "ASC" : "DESC"}`)
                }
            }
            if (sortParts.length > 0) sort = sortParts.join(", ")
        }
    }


    // ... helper logic ...

    return {
        where: conditions.join(" AND "),
        params,
        sort,
        limit,
        offset,
    }
}

async function parseFilterNode(node: ITableFilter, conditions: string[], params: any[]) {
    for (const key in node) {
        if (key === "$and") {
            const subs = (node as any).$and
            if (Array.isArray(subs)) {
                const group: string[] = []
                for (const sub of subs) {
                    const subConds: string[] = []
                    await parseFilterNode(sub, subConds, params)
                    if (subConds.length > 0) group.push(`(${subConds.join(" AND ")})`)
                }
                if (group.length > 0) conditions.push(`(${group.join(" AND ")})`)
            }
        } else if (key === "$or") {
            const subs = (node as any).$or
            if (Array.isArray(subs)) {
                const group: string[] = []
                for (const sub of subs) {
                    const subConds: string[] = []
                    await parseFilterNode(sub, subConds, params)
                    if (subConds.length > 0) group.push(`(${subConds.join(" AND ")})`)
                }
                if (group.length > 0) conditions.push(`(${group.join(" OR ")})`)
            }
        } else if (key === "$nor") {
            // Ignore (Handled by JsMatch)
        } else if (key === "$not") {
            // Ignore (Handled by JsMatch)
        } else {
            const value = (node as any)[key]
            await parseFieldCondition(key, value, conditions, params)
        }
    }
}

async function parseFieldCondition(path: string, value: any, conditions: string[], params: any[]) {
    let colExpr = ""
    if (path === "id") {
        colExpr = "id"
    } else if (path === "_id") {
        colExpr = "_id"
        // _id 是整数主键，确保值为整数类型
        value = ensureIntegerId(value)
    } else {
        colExpr = `json_extract(data, '$.${path}')`
    }

    if (!isOperatorObject(value)) {
        // 简单值查询（相当于 $eq）
        if (value === null || value === undefined) {
            // MongoDB 行为：{ field: null } 同时匹配 null 和缺失字段
            conditions.push(`(${colExpr} IS NULL OR ${colExpr} = json('null'))`)
        } else if (isSafeForEquality(value)) {
            await addCondition(colExpr, "=", value, conditions, params)
        }
    } else {
        for (const op in value) {
            const opVal = value[op]
            switch (op) {
                case "$eq":
                    // MongoDB 行为：$eq null 匹配 null 和缺失字段
                    if (opVal === null || opVal === undefined) {
                        // 使用 IS NULL 来匹配 null 值和缺失字段
                        conditions.push(`(${colExpr} IS NULL OR ${colExpr} = json('null'))`)
                    } else if (isSafeForEquality(opVal)) {
                        await addCondition(colExpr, "=", opVal, conditions, params)
                    }
                    break
                case "$ne":
                    // MongoDB 行为：$ne null 只匹配字段存在且值不为 null 的文档
                    if (opVal === null || opVal === undefined) {
                        // 需要字段存在且不为 null
                        conditions.push(`(${colExpr} IS NOT NULL AND ${colExpr} != json('null'))`)
                    } else if (isSafeForEquality(opVal)) {
                        await addCondition(colExpr, "!=", opVal, conditions, params)
                    }
                    break
                case "$gt":
                    if (isSafeForRange(opVal))
                        await addCondition(colExpr, ">", opVal, conditions, params)
                    break
                case "$gte":
                    if (isSafeForRange(opVal))
                        await addCondition(colExpr, ">=", opVal, conditions, params)
                    break
                case "$lt":
                    if (isSafeForRange(opVal))
                        await addCondition(colExpr, "<", opVal, conditions, params)
                    break
                case "$lte":
                    if (isSafeForRange(opVal))
                        await addCondition(colExpr, "<=", opVal, conditions, params)
                    break
                case "$in":
                    if (Array.isArray(opVal) && opVal.length > 0) {
                        // All elements must be safe for equality to use SQL IN
                        if (opVal.every(isSafeForEquality)) {
                            const marks = opVal.map(() => "?").join(",")
                            conditions.push(`${colExpr} IN (${marks})`)
                            for (let v of opVal) {
                                if (colExpr === "id" && typeof v === "number") v = String(v)
                                const [sVal] = await prepareValue(v)
                                params.push(sVal)
                            }
                        } else {
                            // If unsafe, we can't use SQL IN efficiently or correctly?
                            // Equality for BigInt/Buffer is safe, so this mostly skipping Objects
                            // If skipped, JsMatch handles it.
                        }
                    } else {
                        conditions.push("1=0")
                    }
                    break
                case "$nin":
                    if (Array.isArray(opVal) && opVal.length > 0) {
                        if (opVal.every(isSafeForEquality)) {
                            const marks = opVal.map(() => "?").join(",")
                            const cond = `(${colExpr} NOT IN (${marks}) OR ${colExpr} IS NULL)`
                            conditions.push(cond)
                            for (let v of opVal) {
                                if (colExpr === "id" && typeof v === "number") v = String(v)
                                const [sVal] = await prepareValue(v)
                                params.push(sVal)
                            }
                        }
                    }
                    break
            }
        }
    }
}

async function addCondition(col: string, op: string, val: any, conditions: string[], params: any[]) {
    // If column is 'id', force validation as string (SQLite comparison strictness)
    // prepareValue handles serialization, but we want to ensure input is String if it's a direct ID comparison
    // Only if val is primitive number.
    if (col === "id" && typeof val === "number") {
        val = String(val)
    }
    
    // _id 是整数主键，确保值为整数类型
    if (col === "_id") {
        val = ensureIntegerId(val)
    }

    const [sVal] = await prepareValue(val)

    if (op === "=") {
        let subQuery = ""
        if (col === "id") {
            conditions.push(`${col} = ?`)
            params.push(sVal)
            return
        } else {
            const match = col.match(/^json_extract\(data, '(\$\..+)'\)$/)
            if (match) {
                const path = match[1]
                subQuery = `((${col} = ?) OR (json_type(data, '${path}') = 'array' AND EXISTS (SELECT 1 FROM json_each(data, '${path}') WHERE value = ?)))`
                conditions.push(subQuery)
                params.push(sVal)
                params.push(sVal)
                return
            }
        }
    }

    // For "Not Equal" logic ($ne), matches if different OR missing/null.
    if (op === "!=") {
        conditions.push(`(${col} != ? OR ${col} IS NULL)`)
        params.push(sVal)
        return
    }

    conditions.push(`${col} ${op} ?`)
    params.push(sVal)
}

function isSafeForRange(val: any): boolean {
    if (val === null || val === undefined) return true
    const t = typeof val
    if (t === 'number' || t === 'string' || t === 'boolean') return true
    if (val instanceof Date) return true
    return false
}

function isSafeForEquality(val: any): boolean {
    if (val === null || val === undefined) return true
    const t = typeof val
    if (t === 'number' || t === 'string' || t === 'boolean') return true
    if (t === 'bigint') return true
    if (val instanceof Date) return true

    // Arrays have stable serialization order [1,2] -> "[1,2]"
    if (Array.isArray(val)) return true

    // Buffers have stable wrapped structure
    if ((typeof Buffer !== 'undefined' && Buffer.isBuffer(val)) ||
        val instanceof ArrayBuffer ||
        (ArrayBuffer.isView(val) && !(val instanceof DataView))) {
        return true
    }

    // Plain objects are unsafe due to key ordering
    if (t === 'object') return false

    return false
}


/**
 * 准备参数值
 * 返回 [serializedValue, isSpecialType]
 */
async function prepareValue(val: any): Promise<[any, boolean]> {
    const s = await serialize(val)
    if (s !== null && typeof s === "object") {
        return [JSON.stringify(s), true]
    }
    if (typeof s === "boolean") {
        return [s ? 1 : 0, false]
    }
    return [s, false]
}

function isOperatorObject(v: any) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
        return Object.keys(v).some((k) => k.startsWith("$"))
    }
    return false
}

function normalizeSort(sort: string[] | Record<string, 1 | -1>): Record<string, 1 | -1> {
    const re: Record<string, 1 | -1> = {}
    if (Array.isArray(sort)) {
        for (const s of sort) {
            if (s.startsWith("-")) {
                re[s.substring(1)] = -1
            } else {
                re[s] = 1
            }
        }
    } else {
        return sort
    }
    return re
}
