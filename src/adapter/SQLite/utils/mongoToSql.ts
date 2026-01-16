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
        // @ts-ignore
        const indexedFields = options?.indexedFields as Set<string> | undefined
        // @ts-ignore
        const tableName = options?.tableName as string | undefined
        await parseFilterNode(filter, conditions, params, indexedFields, tableName)
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

async function parseFilterNode(
    node: ITableFilter,
    conditions: string[],
    params: any[],
    indexedFields?: Set<string>,
    tableName?: string
) {
    for (const key in node) {
        if (key === "$and") {
            const subs = (node as any).$and
            if (Array.isArray(subs)) {
                const group: string[] = []
                for (const sub of subs) {
                    const subConds: string[] = []
                    await parseFilterNode(sub, subConds, params, indexedFields, tableName)
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
                    await parseFilterNode(sub, subConds, params, indexedFields, tableName)
                    if (subConds.length > 0) group.push(`(${subConds.join(" AND ")})`)
                }
                if (group.length > 0) conditions.push(`(${group.join(" OR ")})`)
                else conditions.push("1=0")
            }
        } else if (key === "$nor") {
            // Ignore (Handled by JsMatch)
        } else if (key === "$not") {
            // Ignore (Handled by JsMatch)
        } else {
            const value = (node as any)[key]
            await parseFieldCondition(key, value, conditions, params, indexedFields, tableName)
        }
    }
}

async function parseFieldCondition(
    path: string,
    value: any,
    conditions: string[],
    params: any[],
    indexedFields?: Set<string>,
    tableName?: string
) {
    // 检查是否是纯数字索引路径（如 "tags.2" 或 "items.0.name"）
    // 这种路径 SQLite 可以正确处理
    const pathParts = path.split(".")
    const isNumericIndexPath = pathParts.every((part, idx) => {
        // 第一部分是字段名，后续部分可以是数字索引或属性名
        if (idx === 0) return true
        // 后续部分如果是数字，则是数组索引
        return /^\d+$/.test(part)
    })

    // 包含点号的路径，但不是纯数字索引路径，可能涉及数组展开
    // 例如 "items.x" 查询数组元素属性，SQLite 的 json_extract 不支持
    // 使用 1=1 让 JsMatch 处理
    if (path.includes(".") && !isNumericIndexPath && path !== "id" && path !== "_id") {
        conditions.push("1=1")
        return
    }

    let colExpr = ""
    if (path === "id") {
        colExpr = "id"
    } else if (path === "_id") {
        colExpr = "_id"
        // _id 是整数主键，确保值为整数类型
        value = ensureIntegerId(value)
    } else {
        // 将点号路径转换为 SQLite JSON 路径格式
        // 例如 "tags.2" -> "$.tags[2]", "items.0.name" -> "$.items[0].name"
        const jsonPath = pathParts
            .map((part, idx) => {
                if (idx === 0) return `$.${part}`
                if (/^\d+$/.test(part)) return `[${part}]`
                return `.${part}`
            })
            .join("")
        colExpr = `json_extract(data, '${jsonPath}')`
    }

    if (!isOperatorObject(value)) {
        // 简单值查询（相当于 $eq）
        if (value === null || value === undefined) {
            // MongoDB 行为：{ field: null } 同时匹配：

            // 1. 字段值为 null
            // 2. 字段不存在
            // 3. 数组字段中包含 null
            // SQL 无法处理第 3 种情况，使用 1=1 让 JsMatch 处理
            conditions.push("1=1")
        } else if (isSafeForEquality(value)) {
            // MongoDB 允许简单值查询匹配数组字段（隐式 $in）
            // 例如 { tags: "red" } 可以匹配 tags: ["red", "blue"]
            // 由于 SQL 无法精确表达这种语义，使用 1=1 让 JsMatch 处理
            conditions.push("1=1")
        } else {
            // SQL 比较的不安全类型（如普通对象），使用 1=1 让 JsMatch 处理
            conditions.push("1=1")
        }
    } else {
        for (const op in value) {
            const opVal = value[op]
            switch (op) {
                case "$eq":
                    // MongoDB 行为：$eq null 匹配 null、缺失字段和数组包含 null
                    // SQL 无法处理数组包含 null 的情况，使用 1=1 让 JsMatch 处理
                    if (opVal === null || opVal === undefined) {
                        conditions.push("1=1")
                    } else if (isSafeForEquality(opVal)) {
                        await addCondition(colExpr, "=", opVal, conditions, params, indexedFields, tableName)
                    }
                    break
                case "$ne":
                    // MongoDB 行为：$ne null 只匹配字段存在且值不为 null 的文档
                    if (opVal === null || opVal === undefined) {
                        // 需要字段存在且不为 null
                        conditions.push(`(${colExpr} IS NOT NULL AND ${colExpr} != json('null'))`)
                    } else if (isSafeForEquality(opVal)) {
                        await addCondition(colExpr, "!=", opVal, conditions, params, indexedFields, tableName)
                    }
                    break
                case "$gt":
                    if (isSafeForRange(opVal))
                        await addCondition(colExpr, ">", opVal, conditions, params, indexedFields, tableName)
                    break
                case "$gte":
                    if (isSafeForRange(opVal))
                        await addCondition(colExpr, ">=", opVal, conditions, params, indexedFields, tableName)
                    break
                case "$lt":
                    if (isSafeForRange(opVal))
                        await addCondition(colExpr, "<", opVal, conditions, params, indexedFields, tableName)
                    break
                case "$lte":
                    if (isSafeForRange(opVal))
                        await addCondition(colExpr, "<=", opVal, conditions, params, indexedFields, tableName)
                    break
                case "$in":
                    if (Array.isArray(opVal) && opVal.length > 0) {
                        // 检查是否包含 null
                        const hasNull = opVal.some((v) => v === null || v === undefined)
                        const nonNullValues = opVal.filter((v) => v !== null && v !== undefined)

                        // 必须所有非 null 元素都支持安全相等性检查才能使用 SQL IN
                        if (nonNullValues.every(isSafeForEquality)) {
                            const inConditions: string[] = []

                            // 处理 null 值 - MongoDB 行为：$in [null] 匹配 null 和缺失字段
                            if (hasNull) {
                                inConditions.push(`(${colExpr} IS NULL OR ${colExpr} = json('null'))`)
                            }

                            // 处理非 null 值
                            if (nonNullValues.length > 0) {
                                const marks = nonNullValues.map(() => "?").join(",")

                                // 智能优化：倒排索引 (Side Table) 检查
                                let optimized = false
                                if (tableName && indexedFields) {
                                    const match = colExpr.match(/^json_extract\(data, '(\$\..+)'\)$/)
                                    if (match) {
                                        const path = match[1]
                                        const fieldName = path.replace(/^\$\./, "")
                                        if (indexedFields.has(fieldName)) {
                                            const safeField = fieldName.replace(/[^a-zA-Z0-9_]/g, "_")
                                            const sideTableName = `_idx_${tableName}_${safeField}`
                                            inConditions.push(
                                                `EXISTS (SELECT 1 FROM "${sideTableName}" WHERE id = "${tableName}".id AND val IN (${marks}))`
                                            )
                                            optimized = true
                                        }
                                    }
                                }

                                if (!optimized) {
                                    inConditions.push(`${colExpr} IN (${marks})`)
                                }

                                for (let v of nonNullValues) {
                                    if (colExpr === "id" && typeof v === "number") v = String(v)
                                    const [sVal] = await prepareValue(v)
                                    params.push(sVal)
                                }
                            }

                            // 组合所有条件
                            if (inConditions.length > 0) {
                                conditions.push(`(${inConditions.join(" OR ")})`)
                            }
                        } else {
                            // 如果不安全，则无法高效或正确地使用 SQL IN
                            // BigInt/Buffer 的相等性是安全的，所以这里主要跳过对象
                            // 如果跳过，由 JsMatch 处理。
                            conditions.push("1=1")
                        }
                    } else {
                        conditions.push("1=0")
                    }
                    break
                case "$nin":
                    if (Array.isArray(opVal) && opVal.length > 0) {
                        // 检查是否包含 null
                        const hasNull = opVal.some((v) => v === null || v === undefined)
                        const nonNullValues = opVal.filter((v) => v !== null && v !== undefined)

                        if (nonNullValues.every(isSafeForEquality)) {
                            const ninConditions: string[] = []

                            // MongoDB 行为：$nin [null] 排除 null 和缺失字段
                            if (hasNull) {
                                // 字段必须存在且不为 null
                                ninConditions.push(`(${colExpr} IS NOT NULL AND ${colExpr} != json('null'))`)
                            }

                            // 处理非 null 值
                            if (nonNullValues.length > 0) {
                                const marks = nonNullValues.map(() => "?").join(",")
                                ninConditions.push(`${colExpr} NOT IN (${marks})`)
                                for (let v of nonNullValues) {
                                    if (colExpr === "id" && typeof v === "number") v = String(v)
                                    const [sVal] = await prepareValue(v)
                                    params.push(sVal)
                                }
                            }

                            // 组合条件：所有条件都必须满足（AND）
                            if (ninConditions.length > 0) {
                                conditions.push(`(${ninConditions.join(" AND ")})`)
                            }
                        } else {
                            // 不安全类型，由 JsMatch 处理
                            conditions.push("1=1")
                        }
                    }
                    // $nin: [] 匹配所有 - 不添加任何条件
                    break
            }
        }
    }
}

async function addCondition(
    col: string,
    op: string,
    val: any,
    conditions: string[],
    params: any[],
    indexedFields?: Set<string>,
    tableName?: string
) {
    // 如果列是 'id'，强制作为字符串验证 (SQLite 比较的严格性)
    // prepareValue 处理序列化，但如果是直接 ID 比较，我们要确保输入是字符串
    // 仅当 val 是原始数字时。
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
                const typeCheck =
                    typeof val === "boolean"
                        ? `json_type(data, '${path}') = '${val ? "true" : "false"}'`
                        : typeof val === "number"
                        ? `json_type(data, '${path}') IN ('integer', 'real')`
                        : "1=1"

                // 智能优化：Inverted Index (Side Table)
                const fieldName = path.replace(/^\$\./, "")
                const isIndexed = indexedFields?.has(fieldName) && tableName

                if (isIndexed) {
                    const safeField = fieldName.replace(/[^a-zA-Z0-9_]/g, "_")
                    const sideTableName = `_idx_${tableName}_${safeField}`

                    // EXISTS (SELECT 1 FROM "_idx_table_tags" WHERE id = "table".id AND val = ?)
                    subQuery = `EXISTS (SELECT 1 FROM "${sideTableName}" WHERE id = "${tableName}".id AND val = ?)`
                    conditions.push(subQuery)
                    params.push(sVal)
                } else {
                    // 强制对序列化为对象 (Map, Set) 的复杂类型进行 JSON 比较
                    // 以避免简单字符串比较中的空格/格式不匹配
                    if (val instanceof Map || val instanceof Set) {
                        subQuery = `((${col} = json(?) AND ${typeCheck}))`
                    } else {
                        subQuery = `((${col} = ? AND ${typeCheck}) OR (json_type(data, '${path}') = 'array' AND EXISTS (SELECT 1 FROM json_each(data, '${path}') WHERE value = ?)))`
                    }
                    conditions.push(subQuery)
                    params.push(sVal)
                    // 仅为数组检查分支再次 push sVal
                    if (!(val instanceof Map) && !(val instanceof Set)) {
                        params.push(sVal)
                    }
                }
                return
            }
        }
    }

    // 对于 "不等于" 逻辑 ($ne)，如果不同或缺失/null 则匹配。
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
    if (t === "number") {
        // 特殊数值 Infinity、-Infinity、NaN 会被序列化为对象格式，无法直接用 SQL 比较
        if (!Number.isFinite(val)) return false
        return true
    }
    if (t === "string" || t === "boolean") return true
    if (val instanceof Date) return true
    return false
}

function isSafeForEquality(val: any): boolean {
    if (val === null || val === undefined) return true
    const t = typeof val
    if (t === "number" || t === "string" || t === "boolean") return true
    if (t === "bigint") return true
    if (val instanceof Date) return true

    // 数组具有稳定的序列化顺序 [1,2] -> "[1,2]"
    if (Array.isArray(val)) return true

    // Buffer 具有稳定的包装结构
    if (
        (typeof Buffer !== "undefined" && Buffer.isBuffer(val)) ||
        val instanceof ArrayBuffer ||
        (ArrayBuffer.isView(val) && !(val instanceof DataView))
    ) {
        return true
    }

    // 普通对象因键顺序而不安全
    // 但 Map 和 Set 具有稳定的序列化 (如果检查相同插入顺序的精确匹配)
    if (val instanceof Map || val instanceof Set) return true

    if (t === "object") return false

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
