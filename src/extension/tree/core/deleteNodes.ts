import type { TableTree } from "../TableTree"
import { ITreeNode } from "../tree.types"

/** 删除节点
 *  可以通过 `options.deep` 参数递归删除子节点
 */
export async function deleteNodes(
    this: InstanceType<typeof TableTree>,
    /** 要删除的节点 id 列表 */
    nodeIds: string[],
    options?: {
        /** 是否递归删除子节点 */
        deep?: boolean
        /** 是否真正删除节点(在 enableMarkDeleted 为 true 时，也物理删除文档) */
        realDelete?: boolean
    },
) {}
