import { ITableFilter } from "../../../core/types"
import { ITableFindOptions } from "../../adapter"
import { serialize } from "./serializer"
import { getSideTableName, quoteIdentifier, quoteSqlString, sqliteJsonPath } from "./sqlIdentifiers"

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
        if (/^\d+$/.test(value)) return Number(value)
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

export async function mongoToSql(
    filter: ITableFilter,
    options?: ITableFindOptions,
    schemaStats?: Map<string, { hasArray: boolean; hasSpecial: boolean; typeMask?: number }>
): Promise<ISqlQuery> {
    const conditions: string[] = []
    const params: any[] = []

    // 1. Filter
    if (filter) {
        // @ts-ignore
        const indexedFields = options?.indexedFields as Set<string> | undefined
        // @ts-ignore
        const tableName = options?.tableName as string | undefined
        await parseFilterNode(filter, conditions, params, indexedFields, tableName, schemaStats)
    }

    if (conditions.length === 0) conditions.push("1=1")

    // 2. Options
    let sort = ""
    let limit: number | undefined
    let offset: number | undefined

    if (options) {
        if (options.limit !== undefined) {
            if (!Number.isInteger(options.limit) || options.limit < 0) throw new Error("limit 必须是非负整数")
            limit = options.limit
        }
        if (options.offset !== undefined) {
            if (!Number.isInteger(options.offset) || options.offset < 0) throw new Error("offset 必须是非负整数")
            offset = options.offset
        }

        if (options.sort) {
            const sortParts: string[] = []
            const sortObj = normalizeSort(options.sort)

            for (const [key, dir] of Object.entries(sortObj)) {
                if (key === "id") {
                    sortParts.push(`id ${dir === 1 ? "ASC" : "DESC"}`)
                } else if (key === "_id") {
                    sortParts.push(`_id ${dir === 1 ? "ASC" : "DESC"}`)
                } else {
                    sortParts.push(`json_extract(data, ${quoteSqlString(sqliteJsonPath(key))}) ${dir === 1 ? "ASC" : "DESC"}`)
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
    tableName?: string,
    schemaStats?: Map<string, { hasArray: boolean; hasSpecial: boolean; typeMask?: number }>
) {
    for (const key in node) {
        if (key === "$and") {
            const subs = (node as any).$and
            if (Array.isArray(subs)) {
                const group: string[] = []
                for (const sub of subs) {
                    const subConds: string[] = []
                    await parseFilterNode(sub, subConds, params, indexedFields, tableName, schemaStats)
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
                    await parseFilterNode(sub, subConds, params, indexedFields, tableName, schemaStats)
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
            await parseFieldCondition(key, value, conditions, params, indexedFields, tableName, schemaStats)
        }
    }
}

async function parseFieldCondition(
    path: string,
    value: any,
    conditions: string[],
    params: any[],
    indexedFields?: Set<string>,
    tableName?: string,
    schemaStats?: Map<string, { hasArray: boolean; hasSpecial: boolean }>
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
    // 但是，如果 analyzeQueryCompatibility 已经判定它是安全的（即父路径不是数组），
    // 那么这里就应该生成对应的 json_extract 路径。
    // 所以我们不再这里直接排除，而是生成对应的 JSON Path，例如 "$.items.x"。

    // 原来的校验逻辑移除，让下面通用逻辑处理。
    // 但是要确保生成的 JSON Path 是正确的。
    // logic below: "tags.2" -> "$.tags[2]", "items.a" -> "$.items.a"

    // 如果 isNumericIndexPath 是 false，但也包含点号
    // 只要排除 id/_id
    if (path.includes(".") && !isNumericIndexPath && path !== "id" && path !== "_id") {
        // Let it fall through, do NOT push 1=1 and return.
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
        const jsonPath = sqliteJsonPath(path)
        colExpr = `json_extract(data, ${quoteSqlString(jsonPath)})`
    }

    if (!isOperatorObject(value)) {
        // 简单值查询（相当于 $eq）
        if (value === null || value === undefined) {
            // MongoDB 行为：{ field: null } 同时匹配：
            // 1. 字段值为 null
            // 2. 字段不存在
            // 3. 数组字段中包含 null
            // 
            // 使用纯 SQL 实现以获得更好的性能
            if (path === "id" || path === "_id") {
                // id/_id 字段是标量，不可能是数组
                conditions.push(`${colExpr} IS NULL`)
            } else {
                // 将点号路径转换为 JSON 路径
                const jsonPath = sqliteJsonPath(path)
                const jsonPathSql = quoteSqlString(jsonPath)

                // 利用 schemaStats 判断该字段是否曾存储过数组
                // 如果没有，可以跳过数组检查，生成更简单的 SQL
                const stats = schemaStats?.get(path)
                const hasArrayType = stats?.hasArray ?? true  // 默认保守处理，假设可能有数组

                if (hasArrayType) {
                    // 字段可能是数组，需要检查数组包含 null 的情况
                    const nullCondition = `(
                        json_type(data, ${jsonPathSql}) IS NULL
                        OR json_type(data, ${jsonPathSql}) = 'null'
                        OR (json_type(data, ${jsonPathSql}) = 'array' AND EXISTS (
                            SELECT 1 FROM json_each(data, ${jsonPathSql}) WHERE value IS NULL
                        ))
                    )`
                    conditions.push(nullCondition)
                } else {
                    // 字段从未存储过数组，可以使用更简单的 SQL
                    const nullCondition = `(
                        json_type(data, ${jsonPathSql}) IS NULL
                        OR json_type(data, ${jsonPathSql}) = 'null'
                    )`
                    conditions.push(nullCondition)
                }
            }

        } else if (isSafeForEquality(value)) {

            // MongoDB 允许简单值查询匹配数组字段（隐式 $in）
            // 例如 { tags: "red" } 可以匹配 tags: ["red", "blue"]

            // 特殊处理：id 和 _id 字段是标量，必须使用 SQL
            if (path === "id" || path === "_id") {
                await addCondition(colExpr, "=", value, conditions, params, indexedFields, tableName, true)
            } else {
                // 对于普通字段，由于可能存在数组隐式匹配语义，且 SQL 无法直接表达（除非有侧表），
                // 暂时生成 1=1，依赖 isQuerySqlCompatible 返回 false 来启用 JsMatch。
                // *注*：如果字段有索引，`addCondition` 内部会生成 Side Table 查询，这也是安全的。
                // 我们可以尝试让有索引的字段也走 addCondition？
                // 
                // 为了修复 bug，至少 id/_id 必须走 addCondition。
                // 
                // 针对有索引的字段，如果我们确信 Side Table 覆盖了所有情况（包括数组包含），也可以走 addCondition。
                // 目前为了安全，仅对 id/_id 强制生成 SQL。
                // 
                // 优化：如果有侧表索引，我们可以生成 EXISTS 查询，这比 JsMatch 快。
                const isIndexed = tableName && indexedFields &&
                    (path === "id" || path === "_id" || (
                        path.match(/^[a-zA-Z0-9_]+$/) && indexedFields.has(path)
                    ))

                // 优化：如果字段已知不是数组（Clean Field），则可以直接使用 SQL 相等比较
                let isCleanScalar = false
                if (schemaStats) {
                    // Check if path or any prefix is array
                    const parts = path.split('.')
                    let currentPath = ""
                    let safe = true
                    for (let part of parts) {
                        currentPath = currentPath ? `${currentPath}.${part}` : part
                        const s = schemaStats.get(currentPath)
                        if (s && s.hasArray) {
                            safe = false
                            break
                        }
                    }
                    // 兼容性分析器会把没有数组记录的字段判定为纯 SQL 可用；
                    // 即使字段从未出现，也必须生成真实的 JSON 等值条件，不能退化为 1=1。
                    if (safe) isCleanScalar = true
                }

                // console.log(`[mongoToSql] path=${path} isIndexed=${!!isIndexed} isCleanScalar=${isCleanScalar} statsSize=${schemaStats?.size}`)

                if (isIndexed) {
                    await addCondition(colExpr, "=", value, conditions, params, indexedFields, tableName, true)
                } else if (isCleanScalar) {
                    // 对于已知非数组的字段，即使没有索引，也可以生成 json_extract(data, '$.path') = val
                    await addCondition(colExpr, "=", value, conditions, params, indexedFields, tableName, true)
                } else {
                    conditions.push("1=1")
                }
            }
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
                    if (opVal === null || opVal === undefined) {
                        // 将点号路径转换为 JSON 路径
                        const jsonPath = sqliteJsonPath(path)
                        const jsonPathSql = quoteSqlString(jsonPath)

                        // 利用 schemaStats 判断该字段是否曾存储过数组
                        const stats = schemaStats?.get(path)
                        const hasArrayType = stats?.hasArray ?? true

                        if (hasArrayType) {
                            // 字段可能是数组，需要检查数组包含 null 的情况
                            const nullCondition = `(
                                json_type(data, ${jsonPathSql}) IS NULL
                                OR json_type(data, ${jsonPathSql}) = 'null'
                                OR (json_type(data, ${jsonPathSql}) = 'array' AND EXISTS (
                                    SELECT 1 FROM json_each(data, ${jsonPathSql}) WHERE value IS NULL
                                ))
                            )`
                            conditions.push(nullCondition)
                        } else {
                            // 字段从未存储过数组，使用更简单的 SQL
                            const nullCondition = `(
                                json_type(data, ${jsonPathSql}) IS NULL
                                OR json_type(data, ${jsonPathSql}) = 'null'
                            )`
                            conditions.push(nullCondition)
                        }
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
                    if (isSafeForRange(opVal) && isRangeSqlSafe(path, opVal, schemaStats))
                        await addCondition(colExpr, ">", opVal, conditions, params, indexedFields, tableName)
                    else conditions.push("1=1")
                    break
                case "$gte":
                    if (isSafeForRange(opVal) && isRangeSqlSafe(path, opVal, schemaStats))
                        await addCondition(colExpr, ">=", opVal, conditions, params, indexedFields, tableName)
                    else conditions.push("1=1")
                    break
                case "$lt":
                    if (isSafeForRange(opVal) && isRangeSqlSafe(path, opVal, schemaStats))
                        await addCondition(colExpr, "<", opVal, conditions, params, indexedFields, tableName)
                    else conditions.push("1=1")
                    break
                case "$lte":
                    if (isSafeForRange(opVal) && isRangeSqlSafe(path, opVal, schemaStats))
                        await addCondition(colExpr, "<=", opVal, conditions, params, indexedFields, tableName)
                    else conditions.push("1=1")
                    break
                case "$in":
                    if (Array.isArray(opVal) && opVal.length > 0) {
                        // 检查是否包含 null
                        const hasNull = opVal.some((v) => v === null || v === undefined)
                        const nonNullValues = opVal.filter((v) => v !== null && v !== undefined)

                        // id 和 _id 存储在真实列中，不应检查 data JSON 中并不存在的同名字段。
                        if (path === "id" || path === "_id") {
                            if (nonNullValues.length === 0) {
                                conditions.push("1=0")
                                break
                            }
                            const marks = nonNullValues.map(() => "?").join(",")
                            conditions.push(`${colExpr} IN (${marks})`)
                            for (let v of nonNullValues) {
                                if (path === "id" && typeof v === "number") v = String(v)
                                const [sVal] = await prepareValue(v)
                                params.push(sVal)
                            }
                            break
                        }

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
                                const sqlTypes = getSqliteTypesForValues(nonNullValues)
                                const typeSql = `json_type(data, ${quoteSqlString(sqliteJsonPath(path))}) IN (${sqlTypes.map(quoteSqlString).join(", ")})`

                                // 智能优化：倒排索引 (Side Table) 检查
                                let optimized = false
                                if (tableName && indexedFields) {
                                    const match = colExpr.match(/^json_extract\(data, '(\$\..+)'\)$/)
                                    if (match) {
                                        const path = match[1]
                                        const fieldName = path.replace(/^\$\./, "")
                                        if (indexedFields.has(fieldName)) {
                                            const sideTableName = getSideTableName(tableName!, fieldName)
                                            inConditions.push(
                                                `EXISTS (SELECT 1 FROM ${quoteIdentifier(sideTableName)} WHERE id = ${quoteIdentifier(tableName!)}.id AND val IN (${marks})) AND (json_type(data, ${quoteSqlString(path)}) = 'array' OR ${typeSql})`
                                            )
                                            optimized = true
                                        }
                                    }
                                }

                                if (!optimized) {
                                    // 对于非索引数组字段，需要使用 json_each 展开数组检查元素
                                    // 因为 json_extract 返回整个数组 JSON，而非单个元素
                                    // 左侧 IN 匹配标量值，右侧 EXISTS 匹配数组元素
                                    //
                                    // 注意：必须先用两参数形式的 json_type(data, path) 判断字段确实是数组，
                                    // 再调用 json_each。否则当字段是标量字符串时（如 name="src"），
                                    // json_each(json_extract(...)) 会把 "src" 当作 JSON 解析而抛出 "malformed JSON"。
                                    const jsonPath = sqliteJsonPath(path)
                                    const jsonPathSql = quoteSqlString(jsonPath)
                                    inConditions.push(
                                        `((${colExpr} IN (${marks}) AND ${typeSql}) OR (json_type(data, ${jsonPathSql}) = 'array' AND EXISTS (SELECT 1 FROM json_each(data, ${jsonPathSql}) WHERE type IN (${sqlTypes.map(quoteSqlString).join(", ")} ) AND value IN (${marks}))))`
                                    )
                                }

                                // 准备参数值
                                const preparedValues: any[] = []
                                for (let v of nonNullValues) {
                                    if (colExpr === "id" && typeof v === "number") v = String(v)
                                    const [sVal] = await prepareValue(v)
                                    preparedValues.push(sVal)
                                }

                                // 如果使用了 json_each 回退，需要 push 两次参数（左右两个 IN）
                                if (!optimized) {
                                    params.push(...preparedValues, ...preparedValues)
                                } else {
                                    params.push(...preparedValues)
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
                                ninConditions.push(
                                    hasNull
                                        ? `${colExpr} NOT IN (${marks})`
                                        : `(${colExpr} NOT IN (${marks}) OR ${colExpr} IS NULL)`,
                                )
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
    tableName?: string,
    isCleanScalar: boolean = false
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

                // 生成类型检查条件
                // 注意：NaN 和 Infinity 虽然 typeof 是 "number"，但序列化后是对象 { $t: "nan" } 等
                let typeCheck: string
                const pathSql = quoteSqlString(path.replace(/''/g, "'"))
                if (typeof val === "boolean") {
                    typeCheck = `json_type(data, ${pathSql}) = '${val ? "true" : "false"}'`
                } else if (typeof val === "number") {
                    if (Number.isNaN(val) || !Number.isFinite(val)) {
                        // NaN/Infinity 序列化为对象 { $t: "nan" } 等
                        typeCheck = `json_type(data, ${pathSql}) = 'object'`
                    } else {
                        // 普通数值
                        typeCheck = `json_type(data, ${pathSql}) IN ('integer', 'real')`
                    }
                } else {
                    typeCheck = "1=1"
                }


                // 智能优化：Inverted Index (Side Table)
                const fieldName = path.replace(/^\$\./, "")
                const isIndexed = indexedFields?.has(fieldName) && tableName

                if (isIndexed) {
                    const sideTableName = getSideTableName(tableName!, fieldName)

                    // EXISTS (SELECT 1 FROM "_idx_table_tags" WHERE id = "table".id AND val = ?)
                    // 侧表保存的是数组元素；标量混合时用字段类型约束，数组字段则由侧表精确命中元素。
                    subQuery = `EXISTS (SELECT 1 FROM ${quoteIdentifier(sideTableName)} WHERE id = ${quoteIdentifier(tableName!)}.id AND val = ?) AND (json_type(data, ${pathSql}) = 'array' OR (${typeCheck}))`
                    conditions.push(subQuery)
                    params.push(sVal)
                } else {
                    // 强制对序列化为对象 (Map, Set) 的复杂类型进行 JSON 比较
                    // 以避免简单字符串比较中的空格/格式不匹配
                    if (val instanceof Map || val instanceof Set) {
                        subQuery = `((${col} = json(?) AND ${typeCheck}))`
                        params.push(sVal)
                    } else if (isCleanScalar) {
                        // 优化：如果是 Clean Scalar，直接使用简单比较，不需要 OR 数组逻辑
                        subQuery = `(${col} = ? AND ${typeCheck})`
                        params.push(sVal)
                    } else {
                        subQuery = `((${col} = ? AND ${typeCheck}) OR (json_type(data, ${pathSql}) = 'array' AND EXISTS (SELECT 1 FROM json_each(data, ${pathSql}) WHERE value = ?)))`
                        params.push(sVal)
                        // 仅为数组检查分支再次 push sVal
                        if (!(val instanceof Map) && !(val instanceof Set)) {
                            params.push(sVal)
                        }
                    }
                    conditions.push(subQuery)
                }
                return
            }
        }
    }

    // 范围比较必须约束 JSON 原始类型，防止 SQLite 将字符串隐式转换成数字。
    if ([">", ">=", "<", "<="].includes(op) && col.startsWith("json_extract(data,")) {
        const match = col.match(/^json_extract\(data, '((?:''|[^'])+)'\)$/)
        if (match) {
            const jsonPath = match[1].replace(/''/g, "'")
            const typeCheck =
                typeof val === "number"
                    ? `json_type(data, ${quoteSqlString(jsonPath)}) IN ('integer', 'real')`
                    : typeof val === "string"
                      ? `json_type(data, ${quoteSqlString(jsonPath)}) = 'text'`
                      : typeof val === "boolean"
                        ? `json_type(data, ${quoteSqlString(jsonPath)}) IN ('true', 'false')`
                        : "0"
            conditions.push(`(${typeCheck} AND ${col} ${op} ?)`)
            params.push(sVal)
            return
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

function getSqliteTypesForValues(values: any[]): string[] {
    const types = new Set<string>()
    for (const value of values) {
        if (typeof value === "number") {
            types.add("integer")
            types.add("real")
        } else if (typeof value === "string") {
            types.add("text")
        } else if (typeof value === "boolean") {
            types.add(value ? "true" : "false")
        } else if (value instanceof Date) {
            types.add("object")
        }
    }
    return [...types]
}

function isRangeSqlSafe(
    path: string,
    value: any,
    schemaStats?: Map<string, { hasArray: boolean; hasSpecial: boolean; typeMask?: number }>,
): boolean {
    if (path === "id" || path === "_id") return isSafeForRange(value)
    const stats = schemaStats?.get(path)
    if (!stats || stats.hasArray || stats.hasSpecial) return false
    const expected =
        typeof value === "number"
            ? 4
            : typeof value === "string"
              ? 2
              : typeof value === "boolean"
                ? 8
                : undefined
    return expected !== undefined && stats.typeMask === expected
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
