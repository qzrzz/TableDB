/**
 * 将动态名称安全地转换为 SQLite 标识符。
 * 表名、索引名和触发器名不能使用参数绑定，因此必须单独转义双引号。
 */
export function quoteIdentifier(value: string): string {
    return `"${String(value).replace(/"/g, '""')}"`
}

/** 将字符串安全地放入 SQLite SQL 字符串字面量中。 */
export function quoteSqlString(value: string): string {
    return `'${value.replace(/'/g, "''")}'`
}

/**
 * 将点号路径转换为 SQLite JSON1 路径。
 * 数字段表示数组下标，其余段保留原有 Mongo 风格的嵌套语义。
 */
export function sqliteJsonPath(path: string): string {
    return path
        .split(".")
        .map((part, index) => {
            if (index === 0) return `$.${part}`
            if (/^\d+$/.test(part)) return `[${part}]`
            return `.${part}`
        })
        .join("")
}

/**
 * 为侧表生成稳定且不碰撞的名称。
 * 普通字段保持旧名称，包含点号或特殊字符的字段增加哈希后缀，避免 a.b 与 a_b 冲突。
 */
export function getSideTableName(tableName: string, field: string): string {
    const safeField = field.replace(/[^a-zA-Z0-9_]/g, "_")
    if (safeField === field) return `_idx_${tableName}_${safeField}`

    let hash = 2166136261
    for (let i = 0; i < field.length; i++) {
        hash ^= field.charCodeAt(i)
        hash = Math.imul(hash, 16777619)
    }
    return `_idx_${tableName}_${safeField}_${(hash >>> 0).toString(36)}`
}
