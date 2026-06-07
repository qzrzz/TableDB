import { TableTree } from "../TableTree"

/** 删除节点
 *  可以通过 `options.deep` 参数递归删除子节点
 */
export async function deleteNodes(
    this: InstanceType<typeof TableTree>,
    /** 要恢复的节点 id 列表 */
    nodeIds: string[],
    options?: {},
) {}
