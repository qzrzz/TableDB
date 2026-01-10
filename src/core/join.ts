import { Table } from "./Table"

export interface ITableJoinOp {
    /** 目标表 */
    table: Table
    /** 本地键的字段名 */
    localKey: string
    /** 目标键的字段名 */
    targetKey: string
    /** 新本地键字段名
     * 默认与 localKey 相同，会覆盖 localKey 字段。\
     * 设置了新本地键字段名后，会新增该字段，保留原 localKey 字段。
     */
    newLocalKey?: string
    /** 目标表的投影字段列表 */
    projection?: string[] | Record<string, 1 | -1>
}

/** 连接多个 Table 的文档
 *
 * 根据文档中的 localKey 字段值，去目标表中查找对应的文档，并将目标文档添加到本地文档中。\
 * 支持一对一和一对多（数组）的连接关系。
 *
 */
export async function joinListWithTable(list: any[], joinOps: ITableJoinOp[]) {
    if (!list.length || !joinOps.length) {
        return list
    }

    // 并行执行所有连接操作
    await Promise.all(
        joinOps.map(async (joinOp) => {
            const { table, localKey, targetKey, newLocalKey, projection } = joinOp

            // 收集所有需要查询的目标键值
            const targetKeyValues = new Set<any>()
            
            for (const doc of list) {
                const keyValue = doc[localKey]
                
                if (keyValue === undefined || keyValue === null) {
                    continue
                }
                
                // 处理数组类型的键值
                if (Array.isArray(keyValue)) {
                    keyValue.forEach((val) => {
                        if (val !== undefined && val !== null) {
                            targetKeyValues.add(val)
                        }
                    })
                } else {
                    targetKeyValues.add(keyValue)
                }
            }

            // 如果没有有效的键值，跳过此连接操作
            if (targetKeyValues.size === 0) {
                return
            }

            // 批量查询目标表
            const filter = { [targetKey]: { $in: Array.from(targetKeyValues) } }
            const findOptions = projection ? { projection } : undefined

            const targetDocs = await table.findMany(filter, findOptions)

            // 创建目标文档的映射表，便于快速查找
            const targetDocMap = new Map<any, any>()
            for (const targetDoc of targetDocs) {
                const key = (targetDoc as any)[targetKey]
                targetDocMap.set(key, targetDoc)
            }

            // 将目标文档连接到原始文档中
            const fieldName = newLocalKey || localKey
            
            for (const doc of list) {
                const keyValue = doc[localKey]

                if (keyValue === undefined || keyValue === null) {
                    continue
                }

                // 处理数组类型的键值
                if (Array.isArray(keyValue)) {
                    const joinedDocs = keyValue
                        .map((val) => targetDocMap.get(val))
                        .filter((doc) => doc !== undefined)
                    
                    doc[fieldName] = joinedDocs
                } else {
                    const targetDoc = targetDocMap.get(keyValue)
                    if (targetDoc) {
                        doc[fieldName] = targetDoc
                    }
                }
            }
        })
    )

    return list
}
