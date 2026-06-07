import type { TableTree } from "../TableTree"
import { ITreeNode } from "../tree.types"

/** 复制节点
 */
export async function copyNodes(
    this: InstanceType<typeof TableTree>,
    /** 待复制的源节点 ID 列表 */
    srcNodeIds: string[],
    /** 目标父节点 ID，如果为 "/" 表示根节点 */
    parentId: string,
    options?: {
        /**
         * 指定一个已存在的子节点 id
         * 表示新创建的节点将被插入到该节点之后
         * 此节点必须在 parentId 节点的子节点列表中，否则会被忽略，默认插入到子节点列表末尾
         */
        prevNodeId?: string

        /** 是否递归复制子节点 */
        deep?: boolean
        
        /** 复制后的节点是否重命名，默认为 true */
        renameOnCopy?: boolean
    },
) {}
