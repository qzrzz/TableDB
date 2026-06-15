import type { TableTree } from "../TableTree"
import type { ITreeNode, ITreeIndexOptions } from "../tree.types"

/** 创建节点选项 */
export interface ITreeCreateNodesOptions {
    /** 是否自动计算并写入排序索引 */
    index?: ITreeIndexOptions

    /** 是否在创建后返回新节点的数据，默认为 false */
    returnNewNodes?: boolean
}

export interface ITreeCreateResult {
    /** 创建的节点 id 列表 */
    createdNodeIds: string[]

    /** 创建的节点数据列表，仅在 options.returnNewNodes 为 true 时返回 */
    newNodes?: ITreeNode[]
}

/** 创建节点
 *
 * 只能在指定的父节点下创建节点，
 * 所有创建的节点都会强制设置 parentId
 *
 */
export async function createNodes(
    this: TableTree<ITreeNode>,
    /** 要创建的节点文档 */
    nodes: Partial<ITreeNode>[],
    /** 父级节点 id ，如果为 "/" 表示根节点 */
    parentId: string,
    options?: ITreeCreateNodesOptions,
): Promise<ITreeCreateResult> {}