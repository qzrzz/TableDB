import { SQLiteAdapter } from "../../../../adapter/SQLite"
import type { ITreeNode } from "../../tree.types"
import { TableTree } from "../../TableTree"

export interface IGrokTreeNode extends ITreeNode {
    note?: string
    meta?: { hash?: string; tag?: string }
}

let tableIndex = 0

/** 创建隔离的内存目录树，默认开启标记删除。 */
export async function createGrokTree(
    name: string,
    options?: { enableMarkDelete?: boolean },
): Promise<TableTree<IGrokTreeNode>> {
    const table = new TableTree<IGrokTreeNode>({
        name: `grok-${tableIndex++}-${name}`,
        adapter: SQLiteAdapter({ filename: ":memory:", driver: "better-sqlite3" }),
        enableMarkDelete: options?.enableMarkDelete ?? true,
    })
    await table.inited
    return table
}

export function dir(id: string, parentId = "/", name = id): Partial<IGrokTreeNode> {
    return { id, parentId, name, isDir: true }
}

export function file(
    id: string,
    parentId = "/",
    name = id,
    size = 1,
): Partial<IGrokTreeNode> {
    return { id, parentId, name, isDir: false, size }
}

/** 读取节点上的关键统计，缺省按 0 处理便于断言。 */
export async function statsOf(
    table: TableTree<IGrokTreeNode>,
    id: string,
): Promise<{ ctotal: number; cftotal: number; csize: number; childLastIndex?: string }> {
    const node = await table.get(id, { ignoreMarkDelete: true })
    return {
        ctotal: node?.ctotal ?? 0,
        cftotal: node?.cftotal ?? 0,
        csize: node?.csize ?? 0,
        childLastIndex: node?.childLastIndex,
    }
}

/** 返回指定父级下可见子节点 id 列表（按 listNodes 默认 index 序）。 */
export async function childIds(
    table: TableTree<IGrokTreeNode>,
    parentId: string,
): Promise<string[]> {
    const result = await table.listNodes(parentId, { pageSize: 1000 })
    return result.list.map((node) => node.id)
}

/** 自底向上从直属子节点重算期望统计，用于对照实现是否维护正确。 */
export async function expectedStatsFromChildren(
    table: TableTree<IGrokTreeNode>,
    parentId: string,
): Promise<{ ctotal: number; cftotal: number; csize: number }> {
    const children = (await table.listNodes(parentId, {
        pageSize: 1000,
        ignoreMarkDelete: false,
    })).list

    let ctotal = 0
    let cftotal = 0
    let csize = 0
    for (const child of children) {
        ctotal += 1 + (child.ctotal ?? 0)
        cftotal += (child.isDir ? 0 : 1) + (child.cftotal ?? 0)
        csize += (child.size ?? 0) + (child.csize ?? 0)
    }
    return { ctotal, cftotal, csize }
}

/** 断言目录统计与其子树实际贡献一致。 */
export async function expectStatsMatchChildren(
    table: TableTree<IGrokTreeNode>,
    parentId: string,
): Promise<void> {
    if (parentId === "/") return
    const actual = await statsOf(table, parentId)
    const expected = await expectedStatsFromChildren(table, parentId)
    expect(actual.ctotal).toBe(expected.ctotal)
    expect(actual.cftotal).toBe(expected.cftotal)
    expect(actual.csize).toBe(expected.csize)
}
