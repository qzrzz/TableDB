import type { TableTree } from "../TableTree"
import type { ITreeNode, ITreeOverwriteOptions } from "../tree.types"
import { getNodeValueByPath } from "../util/getNodeValueByPath"

/** 检测节点冲突的选项
 *
 * 这里直接复用树覆盖策略选项，保证 checkNodes 的预检语义与 moveNodes / setNodes 一致。
 */ /** 移动节点选项 */
export interface ITreePreOverwriteOptions extends ITreeOverwriteOptions {
    /** existNodes 返回的投影字段
     *
     *  可以是字符串数组，表示包含的字段列表\
     *  也可以是字段映射对象，1 表示包含该字段，-1 表示排除该字段\
     *  不能同时包含和排除字段
     */
    projection?: string[] | Record<string, 1 | -1>
}

/** 检测节点冲突的结果 */
export interface ITreePreOverwriteResult<TNode extends ITreeNode = ITreeNode> {
    /** 是否存在冲突 */
    isConflict: boolean
    /** 已存在的节点列表 */
    existNodes: Partial<TNode>[]
}

/** 预覆盖检测
 * 相当于进行一次预检 setNodes 的覆盖操作，检查目标位置是否已经存在与要移动/设置的节点冲突的节点
 */
export async function preOverwriteNodes(
    this: TableTree<ITreeNode>,
    /** 要检查的节点数据列表 */
    nodes: Partial<ITreeNode>[],
    /** 要移动的节点 id 列表 */
    nodeIds: string[],
    /** 目标父节点 id ，如果为 "/" 表示根节点 */
    parentId: string,
    options?: ITreePreOverwriteOptions,
): Promise<ITreePreOverwriteResult<ITreeNode>> {
    const uniqueBy = options?.uniqueBy ?? "id"
    const values = new Set<any>()

    for (const node of nodes) {
        const value = getNodeValueByPath(node, uniqueBy)
        if (value !== undefined) values.add(value)
    }

    const moveRootNodes = await collectMoveRootNodes.call(this, nodeIds)
    for (const node of moveRootNodes) {
        const value = getNodeValueByPath(node, uniqueBy)
        if (value !== undefined) values.add(value)
    }

    if (values.size === 0) {
        return { isConflict: false, existNodes: [] }
    }

    const movingNodeIds = new Set(nodeIds)
    const existNodes = (await this.findMany(
        {
            parentId,
            [uniqueBy]: { $in: Array.from(values) },
        },
        {
            projection: options?.projection,
        },
    )).filter((node) => !movingNodeIds.has(node.id))

    return {
        isConflict: existNodes.length > 0,
        existNodes,
    }
}

/** 预检移动节点时需要和 moveNodes 一样忽略已选中父节点下面的后代，避免报告不会发生的平铺冲突。 */
async function collectMoveRootNodes(this: TableTree<ITreeNode>, nodeIds: string[]): Promise<ITreeNode[]> {
    const uniqueNodeIds = Array.from(new Set(nodeIds)).filter(Boolean)
    const nodes = (await Promise.all(uniqueNodeIds.map((nodeId) => this.get(nodeId)))).filter(
        (node): node is ITreeNode => !!node,
    )
    const selectedIds = new Set(nodes.map((node) => node.id))
    const roots: ITreeNode[] = []

    for (const node of nodes) {
        let parentId = node.parentId
        let hasSelectedAncestor = false
        while (parentId && parentId !== "/") {
            if (selectedIds.has(parentId)) {
                hasSelectedAncestor = true
                break
            }
            const parentNode = await this.get(parentId, { ignoreMarkDelete: true })
            parentId = parentNode?.parentId ?? "/"
        }
        if (!hasSelectedAncestor) {
            roots.push(node)
        }
    }

    return roots
}
