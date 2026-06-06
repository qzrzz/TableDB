import type { TableTree } from "../TableTree"
import { ITreeNode } from "../tree.types"

/** 创建节点
 *
 * 只能在指定的父节点下创建节点，所有创建的节点都会设置 parentId 字段为 parentId 参数的值
 */
export async function createNodes(
    this: InstanceType<typeof TableTree>,
    /** 父级节点 id ，如果为 "/" 表示根节点 */
    parentId: string,
    /** 要创建的节点文档 */
    nodes: ITreeNode[],

) {}
