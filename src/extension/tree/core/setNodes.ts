import type { TableTree } from "../TableTree"
import { ITreeNode, ITreeOverwriteOptions } from "../tree.types"

/** 设置节点
 *  设置节点数据，已存在的节点会被覆盖，不存在的节点会被创建
 */
export function setNodes(
    this: InstanceType<typeof TableTree>,
    /** 要设置的节点数据列表 */
    nodes: Partial<ITreeNode>[],
    options?: ITreeOverwriteOptions & {},
) {}
