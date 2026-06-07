import { TableTree } from "../TableTree"
import { ITreeIndexOptions, ITreeOverwriteOptions } from "../tree.types"

/** 移动节点
 *  把目标节点移动到新的父节点下·
 */
export function moveNodes(
    this: InstanceType<typeof TableTree>,
    /** 要移动的节点 id 列表 */
    nodeIds: string[],
    /** 目标父节点 id ，如果为 "/" 表示根节点 */
    parentId: string,
    options?: ITreeOverwriteOptions & {
        /** 自动更新排序索引配置
         *  如果没有，不会更新排序索引
         */
        index?: ITreeIndexOptions
    },
) {}
