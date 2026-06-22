import type { TableTree } from "../TableTree"
import type { ITreeNode, ITreeIndexOptions } from "../tree.types"
import { normalizeWritableNode } from "../util/normalizeWritableNode"
import { resolveTreeIndexes } from "../util/resolveTreeIndex"
import { rebalanceTreeIndexes } from "../util/rebalanceTreeIndexes"
import { assertTreeParentExists } from "../util/assertTreeParent"
import { applyTreeMetadataDelta, calcTreeNodeContribution } from "../util/applyTreeMetadataDelta"

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

/**
 * 创建节点
 *
 * 在指定父级下批量插入新节点，并维护目录树需要的排序和统计字段。
 *
 * 核心流程：
 * 1. 先校验父级是否存在，避免写入孤儿节点。
 * 2. 将外部传入的 Partial 节点归一化为完整可写节点，并统一本次操作的 modif。
 * 3. 根据显式 index 选项或父级当前排序状态，为缺少 index 的节点补齐排序值。
 * 4. 调用底层 insertMany 写入；如果遇到重复 ID，底层会跳过，所以后续只处理实际插入成功的节点。
 * 5. 用实际插入节点的贡献量增量刷新父级及祖先 metadata，并按需触发 index 智能重排。
 *
 */
export async function createNodes(
    this: TableTree<ITreeNode>,
    /** 要创建的节点文档 */
    nodes: Partial<ITreeNode>[],
    /** 父级节点 id ，如果为 "/" 表示根节点 */
    parentId: string,
    options?: ITreeCreateNodesOptions,
): Promise<ITreeCreateResult> {
    if (nodes.length === 0) {
        return { createdNodeIds: [], newNodes: options?.returnNewNodes ? [] : undefined }
    }

    // 创建操作只能挂到已存在父级或根节点下；批量 setNodes 才支持同批次创建父子节点。
    await assertTreeParentExists(this, parentId)

    const modif = Date.now()
    const newNodes = nodes.map((node) => {
        return normalizeWritableNode(node, {
            parentId,
            modif,
        }) as ITreeNode
    })

    if (options?.index) {
        // 调用方显式指定插入位置时，整批新节点按该位置连续生成 index。
        const indexes = await resolveTreeIndexes(this, parentId, newNodes.length, options.index)
        for (let i = 0; i < newNodes.length; i++) {
            newNodes[i].index = indexes[i]
        }
    } else {
        // 未显式指定时保留调用方已有 index，只给缺失 index 的节点补默认排序值。
        const nodesNeedIndex = newNodes.filter((node) => !node.index)
        if (nodesNeedIndex.length > 0) {
            const indexes = await resolveTreeIndexes(this, parentId, nodesNeedIndex.length)
            for (let i = 0; i < nodesNeedIndex.length; i++) {
                nodesNeedIndex[i].index = indexes[i]
            }
        }
    }

    const result = await this.insertMany(newNodes)
    const insertedNodeSet = new Set(result.insertedIds)
    const insertedNodes = collectInsertedNodes(newNodes, insertedNodeSet)

    // 只用实际插入成功的节点刷新 metadata，避免重复 ID 被跳过后仍错误增加父级统计。
    await applyTreeMetadataDelta(this, insertedNodes.map((node) => ({
        parentId,
        ...calcTreeNodeContribution(node),
        childLastIndexCandidate: node.index,
    })), modif)
    await rebalanceTreeIndexes(this, parentId, insertedNodes.map((node) => ({ id: node.id, index: node.index })))

    return {
        createdNodeIds: result.insertedIds,
        newNodes: options?.returnNewNodes ? insertedNodes : undefined,
    }
}

/** insertMany 会跳过重复 ID，这里只保留每个实际插入 ID 对应的第一份节点数据。 */
function collectInsertedNodes(nodes: ITreeNode[], insertedNodeSet: Set<string>): ITreeNode[] {
    const seenIds = new Set<string>()
    const insertedNodes: ITreeNode[] = []
    for (const node of nodes) {
        if (!insertedNodeSet.has(node.id) || seenIds.has(node.id)) {
            continue
        }
        seenIds.add(node.id)
        insertedNodes.push(node)
    }
    return insertedNodes
}
