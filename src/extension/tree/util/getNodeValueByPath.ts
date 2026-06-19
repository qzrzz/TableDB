/** 按点路径读取节点上的值，用于覆盖策略的 uniqueBy。 */
export function getNodeValueByPath(data: any, path: string): any {
    if (!path) return undefined
    let current = data
    for (const key of path.split(".")) {
        if (current == null) return undefined
        current = current[key]
    }
    return current
}
