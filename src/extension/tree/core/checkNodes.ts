import { TableTree } from "../TableTree"
import { ITreeNode } from "../tree.types"

/**
 * 检测节点是否存在
 * 相当于进行一次预检 moveNodes 或 setNodes 操作，检查目标位置是否已经存在与要移动/设置的节点冲突的节点
 */
export async function checkNodes(
    this: InstanceType<typeof TableTree>,

    /** 要检查的节点数据列表 */
    nodes: Partial<ITreeNode>[],

    /** 目的地的节点 ID */
    targetId: string,

    options?: {
        /** 以什么方式进行唯一标识，默认按 id  */
        uniqueBy?: "id" | "name" | string

        /** 深度合并子节点
         *  如果存在覆盖目标节点的情况，是否要递归合并子节点
         *  如果深度合并，会把源节点的子节点与目标节点的子节点进行比较，
         *  如果根据 uniqueBy 判断节点相同，就用源节点的子节点覆盖目标节点的子节点
         *  如果 deepMergeByModif 为 true，则会根据 2 个节点的 modif 判断是否要覆盖
         *
         */
        deepMerge?: boolean

        /** 当出现覆盖的情况，如果被覆盖的目标是指定类型，则跳过覆盖
         *  例如：在覆盖节点时，如果目标节点的 type 字段值为 "dir"，则跳过覆盖，保留原有节点
         *  不会中断整个移动操作，而是仅跳过覆盖的节点，继续移动其他节点
         */
        skipOverwriteByType?: string[]

        /**
         *  深度合并子节点时按 modif 更新判断是否应该覆盖
         */
        deepMergeByModif?: boolean

        /**
         * 返回结果的 existNodes 的 projection
         */
        projection?: string[]

        /** 不再收集和返回 existNodes */
        notReturnExistNodes?: boolean
    },
) {}

export interface ICheckNodesResult {
    /** 是否存在冲突 */
    isConflict: boolean
    /** 已存在的节点列表 */
    existNodes: Partial<ITreeNode>[]
}
