
/**
 * 规范化投影参数（数组转对象）
 */
export function normalizeProjection(proj?: string[] | Record<string, 1 | -1 | 0>): Record<string, number> | undefined {
    if (!proj) return undefined
    if (Array.isArray(proj)) {
        const projObj: Record<string, 1> = {}
        proj.forEach((p) => (projObj[p] = 1))
        return projObj
    }
    return proj as Record<string, number>
}

/**
 * 投影 (Projection) 处理函数
 * 
 * 类似于 MongoDB 的 project 逻辑：
 * - 如果指定了包含 (inclusion mode): 只返回指定的字段 + _id (除非显式排除了 _id)。
 * - 如果指定了排除 (exclusion mode): 返回所有字段，除了指定的字段。
 * 
 * @param doc 原始文档对象
 * @param projection 投影配置 (e.g. { name: 1, age: 1 } 或 { password: 0 })
 * @returns 投影后的新对象
 */
export function project(doc: any, projection: any): any {
    if (!projection || Object.keys(projection).length === 0) return doc

    const proj: any = {}
    if (Array.isArray(projection)) {
        for (const key of projection) proj[key] = 1
    } else {
        Object.assign(proj, projection)
    }

    const result: any = {}

    let isInclusion = false
    for (const k in proj) {
        if (proj[k] === 1 || proj[k] === true) {
            isInclusion = true
            break
        }
    }

    if (isInclusion) {
        // 包含模式 (Whitelist)

        // 显式处理 id 和 _id，因为它们有时比较特殊
        if (doc.id !== undefined && (proj.id === 1 || proj.id === true)) {
            result.id = doc.id
        }

        if (doc._id !== undefined && (proj._id === 1 || proj._id === true)) {
            result._id = doc._id
        }

        for (const key in proj) {
            if (proj[key] === 1 || proj[key] === true) {
                if (key === "id" || key === "_id") continue // 前面已经处理过
                if (doc[key] !== undefined) result[key] = doc[key]
            }
        }
    } else {
        // 排除模式 (Blacklist)
        Object.assign(result, doc)
        for (const key in proj) {
            if (proj[key] === 0 || proj[key] === false) {
                delete result[key]
            }
        }
    }
    return result
}
