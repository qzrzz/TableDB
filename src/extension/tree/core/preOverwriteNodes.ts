import type { TableTree } from "../TableTree"
import type { ITreeNode, ITreeOverwriteOptions } from "../tree.types"
import { getNodeValueByPath } from "../util/getNodeValueByPath"
import { collectTopSelectedNodes } from "../util/collectTopSelectedNodes"

/** 检测节点冲突的选项
 *
 * 这里直接复用树覆盖策略选项，保证预检语义与 moveNodes / setNodes 一致。
 */
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

/**
 * 预覆盖检测
 *
 * 在不修改任何数据的前提下，检查一批待写入节点或待移动节点在目标父级下是否会发生唯一键冲突。
 *
 * 核心流程：
 * 1. 根据 uniqueBy 收集待写入 nodes 中的唯一键值。
 * 2. 读取待移动 nodeIds 对应的最外层节点，并收集它们的唯一键值；父子混合移动时后代不参与预检。
 * 3. 如果没有可检测值，直接返回无冲突。
 * 4. 在目标 parentId 的直属子节点里查找这些唯一键值，并排除正在移动的节点自身。
 * 5. 返回冲突节点列表；overwriteMode 不会改变预检结果，因为这里不执行覆盖动作。
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

    // 待 setNodes 的新数据可能还没有落库，只能从传入对象中读取 uniqueBy 值。
    for (const node of nodes) {
        const value = getNodeValueByPath(node, uniqueBy)
        if (value !== undefined) values.add(value)
    }

    // 待 moveNodes 的来源节点需要读取当前库中数据，且保持和 moveNodes 一样的父子混合选择语义。
    const moveRootNodes = await collectTopSelectedNodes(this, nodeIds)
    for (const node of moveRootNodes) {
        const value = getNodeValueByPath(node, uniqueBy)
        if (value !== undefined) values.add(value)
    }

    if (values.size === 0) {
        return { isConflict: false, existNodes: [] }
    }

    const movingNodeIds = new Set(nodeIds)
    // 预检只关注目标父级的直属子节点；移动自身不应被报告为与自己冲突。
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
