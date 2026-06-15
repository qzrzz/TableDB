import type { TableTree } from "../TableTree"
import type { ITreeNode, ITreeOverwriteOptions, ITreeIndexOptions, ITreeChangeResult } from "../tree.types"
import { ITreePreSyncNodeResult } from "./presyncNodes"

/** 设置节点选项 */
export type ITreeSetNodesOptions = ITreeOverwriteOptions & {
    /** 是否只更新已存在的节点（不会创建新节点） */
    updateOnly?: boolean

    /** 自动更新排序索引配置 */
    index?: ITreeIndexOptions

    /**
     * 是否进行预同步（pre-sync）检查。
     * 返回
     */
    presync?: boolean
}

/** 设置节点
 *  设置节点数据，已存在的节点会被覆盖，不存在的节点会被创建
 *
 *  如果在 `nodes` 中提供了 `oldModif`, `oldCmodif` 字段，它们会被用来进行预同步检查（pre-sync）而不会被设置到节点上。
 *
 *  流程：
 *  1. 创建本次操作的 newModif
 *  2. 根据 ITreeOverwriteOptions 的配置，找出所有受影响的节点
 *  3. 如果 options.presync 为 true，并且提供了 oldModif/oldCmodif 收集信息
 *  4. 更新数据（使用 Table.setMany() 方法实现）
 *  5. 如果有 index 配置，更新排序索引
 *  6. 进行 metadata 维护
 *
 * 要注意如果修改了节点的 parentId 需要触发相应的 metadata 变更，并且遵守 ITreeOverwriteOptions 覆盖设置
 */
export async function setNodes(
    this: TableTree<ITreeNode>,
    /** 要设置的节点数据列表 */
    nodes: Partial<ITreeNode>[],
    options?: ITreeSetNodesOptions,
): Promise<ITreeChangeResult & Partial<ITreePreSyncNodeResult>> {}
