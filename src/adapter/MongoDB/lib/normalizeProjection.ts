import type { Document } from "mongodb"

/** 规范化投影参数（仅转换格式，不处理 _id） */
export function normalizeProjection(proj?: string[] | Record<string, 1 | -1>): Document | undefined {
    if (!proj) return undefined
    if (Array.isArray(proj)) {
        const projObj: Record<string, 1> = {}
        proj.forEach((p) => (projObj[p] = 1))
        return projObj
    }
    return proj
}

/**
 * 构建最终的 MongoDB projection 选项
 * 
 * 规则：
 * - 无 projection：默认排除 _id
 * - 只有 { _id: 1 }：返回全部字段（包括 _id）
 * - 指定字段但无 _id：排除 _id
 * - 指定字段且有 _id：按用户设置
 */
export function buildProjection(userProjection?: string[] | Record<string, 1 | -1>): Document | undefined {
    const proj = normalizeProjection(userProjection)
    
    // 无 projection：默认排除 _id
    if (!proj) {
        return { _id: 0 }
    }

    const keys = Object.keys(proj)
    
    // 只有 { _id: 1 }：用户想要全部字段 + _id，不设置 projection（MongoDB 默认行为）
    if (keys.length === 1 && keys[0] === "_id" && proj["_id"] === 1) {
        return undefined
    }

    // 用户明确指定了 _id：按用户设置
    if ("_id" in proj) {
        return proj
    }

    // 用户没有指定 _id：默认排除 _id
    return { _id: 0, ...proj }
}
