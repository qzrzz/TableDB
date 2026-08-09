
import { ITableFilter } from "../../../core/types"
import { serialize } from "./serializer"

export interface CompatibilityResult {
    compatible: boolean
    reasons: Array<{ path: string; reason: string; value?: any }>
}

/** 脏字段统计中使用的值类型位标记。 */
export const SQLITE_VALUE_TYPE = {
    ARRAY: 1,
    STRING: 2,
    NUMBER: 4,
    BOOLEAN: 8,
    DATE: 16,
    SPECIAL: 32,
    OTHER: 64,
} as const

export type QuerySchemaStats = {
    hasArray: boolean
    hasSpecial: boolean
    typeMask?: number
}

/**
 * 判断值是否可以直接在 SQL 中安全比较
 * 
 * 目前支持：
 * - string, boolean (直接 SQL 映射)
 * - number (需要排除 NaN, Infinity)
 * - Date (作为时间戳或 ISO 字符串比较，通常视具体序列化实现而定，这里假设 adapter 处理了)
 * 
 * 不支持：
 * - object, array (需要 JSON 解析)
 * - null, undefined (SQL NULL 语义复杂，保守起见可能需要特殊处理)
 * - bigint (可能超出 SQL INTEGER 范围或需要特殊转换)
 */
export function isCompatibleValue(val: any): boolean {
    if (val === null || val === undefined) return false
    const t = typeof val
    if (t === 'number') {
        if (!Number.isFinite(val)) return false
        return true
    }
    if (t === 'string' || t === 'boolean') return true
    if (t === 'bigint') return false
    // Date 对象在许多 ORM/查询构建器中会被转换为数字或字符串，视具体情况。
    // 在这里我们假设它可以通过 parameter binding 传递给 SQLite。
    if (val instanceof Date) return true
    return false
}

/**
 * 分析查询兼容性 (Query Compatibility Analysis)
 * 
 * 目的：
 * 判断一个 MongoDB 风格的 filter 是否可以完全、等价地转换为一族 SQL WHERE 子句。
 * 
 * 策略选择：
 * - 如果 Compatible=true: 使用纯 SQL 查询 (高性能)。
 * - 如果 Compatible=false: 使用混合查询 (Hybrid Mode)，即 "SQL 粗筛 + JS 精确匹配"。
 * 
 * 不兼容情况 (Incompatible Scenarios):
 * 1. 特殊操作符: $where, $nor (SQL 难以直接表达其短路或逻辑).
 * 2. 数组/对象全量匹配: { tags: ["A", "B"] } (需要严格顺序和内容匹配).
 * 3. 隐式数组包含: { tags: "A" } 且 tags 是数组 (MongoDB 语义是 distinct contains, SQL 默认是 equality).
 * 4. 特殊数值: NaN, Infinity (SQL 标准浮点数处理可能不一致).
 * 5. 深层点号路径: "a.b.c" 涉及中间路径可能是数组的情况 (需要 unwind).
 * 
 * @param filter 用户查询对象
 * @param schemaStats 字段统计信息，用于判断某个路径是否曾经存储过数组 (Schema Dirty Tracking).
 */
export function analyzeQueryCompatibility(
    filter: ITableFilter,
    schemaStats?: Map<string, QuerySchemaStats>
): CompatibilityResult {
    const reasons: Array<{ path: string; reason: string; value?: any }> = []
    if (!filter) return { compatible: true, reasons }

    function check(node: any, prefix = ""): boolean {
        let isCompatible = true
        for (const key in node) {
            // 1. 逻辑操作符递归检查
            if (key === "$and" || key === "$or") {
                const subs = node[key]
                if (Array.isArray(subs)) {
                    for (const sub of subs) {
                        if (!check(sub, prefix)) isCompatible = false
                    }
                }
                continue
            }

            const path = prefix ? `${prefix}.${key}` : key
            const stats = schemaStats?.get(path)

            // 2. 不支持的操作符
            if (key === "$nor" || key === "$not" || key === "$where") {
                reasons.push({ path, reason: `Unsupported operator: ${key}` })
                isCompatible = false
                continue
            }

            // 3. 点号路径检查 (Dot Notation)
            // 如果路径中涉及数组遍历 (例如 users.0.name 或 posts.comments.author)，SQL json_extract 难以完美模拟 Mongo 的 unwind 语义。
            // 除非我们要确认中间路径绝对不是数组。
            if (key.includes('.')) {
                if (schemaStats) {
                    const parts = key.split('.')
                    let currentPath = prefix ? prefix : ""
                    let isPathSafe = true

                    for (let i = 0; i < parts.length - 1; i++) {
                        currentPath = currentPath ? `${currentPath}.${parts[i]}` : parts[i]
                        const pathStats = schemaStats.get(currentPath)
                        // 如果中间节点是数组，那么 SQL 路径提取可能会失效或语义不符
                        if (pathStats && pathStats.hasArray) {
                            isPathSafe = false
                            break
                        }
                    }

                    if (!isPathSafe) {
                        reasons.push({ path, reason: "Dot notation path traverse through array, requires JsMatch" })
                        isCompatible = false
                    }
                } else {
                    // 无 Schema 信息时，保守认为点号路径不安全 (可能涉及数组)
                    reasons.push({ path, reason: "Dot notation path implies complex logic (array/object traversal)" })
                    isCompatible = false
                }
            }

            // 4. 值检查
            const val = node[key]

            // 4.1 对象值 (可能是子查询对象 { $gt: 1 } 或对象匹配 { a: 1 })
            if (val && typeof val === "object") {
                if (val instanceof Date) {
                    // Date 特殊处理：虽然是对象，但作为标量值比较
                    // 如果该字段可能是数组，隐式包含查询 { dates: new Date() } 仍需回退
                    if (!stats || !stats.hasArray) {
                        continue
                    }
                    reasons.push({ path, reason: "Implicit array containment check requires JsMatch", value: val })
                    isCompatible = false
                    continue
                }

                if (!Array.isArray(val)) {
                    // 检查是否为操作符对象 (Query Operator Object)
                    const keys = Object.keys(val)
                    const isOperator = keys.length > 0 && keys.every(k => k.startsWith("$"))

                    if (isOperator) {
                        for (const op in val) {
                            // id/_id 是数据库中的固定标量列，不依赖 JSON 字段统计信息。
                            if (path === "id" || path === "_id") {
                                const opValue = val[op]
                                const valid =
                                    ["$gt", "$gte", "$lt", "$lte", "$eq", "$ne"].includes(op)
                                        ? isCompatibleValue(opValue)
                                        : ["$in", "$nin"].includes(op) &&
                                          Array.isArray(opValue) &&
                                          opValue.every(isCompatibleValue)
                                if (!valid) {
                                    reasons.push({ path, reason: `ID operator ${op} is not SQL-compatible`, value: opValue })
                                    isCompatible = false
                                }
                                continue
                            }

                            if (["$gt", "$gte", "$lt", "$lte"].includes(op)) {
                                if (!isCompatibleValue(val[op])) {
                                    reasons.push({ path, reason: `Value type unsafe for SQL comparison in ${op}`, value: val[op] })
                                    isCompatible = false
                                } else {
                                    const expectedType = getRangeTypeMask(val[op])
                                    if (
                                        !stats ||
                                        stats.hasArray ||
                                        stats.hasSpecial ||
                                        expectedType === undefined ||
                                        stats.typeMask !== expectedType
                                    ) {
                                        // 只有字段类型已知且完全单一时，范围 SQL 才能保证不把数组或其他类型混入比较。
                                        reasons.push({ path, reason: `Range operator ${op} requires a homogeneous scalar field`, value: val[op] })
                                        isCompatible = false
                                    }
                                }
                            } else if (op === "$eq") {
                                if (!isCompatibleValue(val[op])) {
                                    reasons.push({ path, reason: `Value type unsafe for SQL equality in ${op}`, value: val[op] })
                                    isCompatible = false
                                }
                            } else if (op === "$in") {
                                if (!Array.isArray(val[op]) || !val[op].every(isCompatibleValue)) {
                                    reasons.push({ path, reason: "$in values must be SQL-compatible scalar values", value: val[op] })
                                    isCompatible = false
                                }
                            } else if (op === "$ne" || op === "$nin") {
                                const values = op === "$nin" ? val[op] : [val[op]]
                                if (
                                    !values.every(isCompatibleValue) ||
                                    !stats ||
                                    stats.hasArray ||
                                    stats.hasSpecial ||
                                    (stats.typeMask !== undefined && (stats.typeMask & (stats.typeMask - 1)) !== 0)
                                ) {
                                    reasons.push({ path, reason: `${op} requires a known homogeneous scalar field`, value: val[op] })
                                    isCompatible = false
                                }
                            } else {
                                // 其他操作符 ($elemMatch, $size, $regex, $all 等) 统统回退
                                reasons.push({ path, reason: `Unsupported operator: ${op}` })
                                isCompatible = false
                            }
                        }
                    } else {
                        // 普通对象匹配 { field: { a: 1 } } -> 需要完整 JSON 匹配
                        reasons.push({ path, reason: "Object equality check requires JsMatch", value: val })
                        isCompatible = false
                    }
                } else {
                    // 数组精确匹配 { field: [1, 2] } -> 需要顺序完全一致
                    reasons.push({ path, reason: "Array equality check requires JsMatch", value: val })
                    isCompatible = false
                }
            } else {
                // 4.2 标量值 (Scalar Value)
                if (key === "id" || key === "_id") {
                    if (!isCompatibleValue(val)) {
                        reasons.push({ path, reason: "ID value type unsafe for SQL", value: val })
                        isCompatible = false
                    }
                } else {
                    // 隐式相等匹配 { field: value }
                    // null/undefined 查询现在可以用纯 SQL 实现
                    // 参见 mongoToSql.ts 中的实现
                    if (val === null || val === undefined) {
                        continue
                    }


                    if (!isCompatibleValue(val)) {
                        reasons.push({ path, reason: "Value type unsafe for implicit equality", value: val })
                        isCompatible = false
                        continue
                    }

                    if (!stats || !stats.hasArray) {
                        // 安全：字段不是数组，标量匹配可用 SQL
                        continue
                    }
                    // 不安全：字段是数组，{ field: "A" } 意为 contains("A")，需要回退
                    reasons.push({ path, reason: "Implicit array containment check requires JsMatch", value: val })
                    isCompatible = false
                }
            }
        }
        return isCompatible
    }

    check(filter)
    return { compatible: reasons.length === 0, reasons }
}

/**
 * 简化的兼容性判断入口
 */
export function isQuerySqlCompatible(
    filter: ITableFilter,
    schemaStats?: Map<string, QuerySchemaStats>
): boolean {
    return analyzeQueryCompatibility(filter, schemaStats).compatible
}

function getRangeTypeMask(value: any): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return SQLITE_VALUE_TYPE.NUMBER
    if (typeof value === "string") return SQLITE_VALUE_TYPE.STRING
    if (typeof value === "boolean") return SQLITE_VALUE_TYPE.BOOLEAN
    return undefined
}
