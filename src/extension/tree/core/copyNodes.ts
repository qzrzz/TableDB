import type { TableTree } from "../TableTree"
import type { ITreeIndexOptions, ITreeNode, ITreeOverwriteOptions } from "../tree.types"
import { getUniqueFileNames } from "../util/getUniqueFileNames"
import { newNodeId } from "../util/newNodeId"
import { normalizeWritableNode } from "../util/normalizeWritableNode"
import { assertTreeParentExists } from "../util/assertTreeParent"
import { resolveTreeIndexes } from "../util/resolveTreeIndex"
import { repairDuplicatedSiblingNames } from "../util/repairDuplicatedSiblingNames"
import { collectTopSelectedNodes } from "../util/collectTopSelectedNodes"

/** 复制节点选项 */
export type ITreeCopyNodesOptions = ITreeOverwriteOptions & {
    /** 是否自动计算并写入排序索引 */
    index?: ITreeIndexOptions
    /** 是否递归复制子节点 */
    deep?: boolean
    /** 复制后的节点是否自动重命名
     *  使用 getUniqueFileNames() 获得独特名字
     */
    renameOnCopy?: boolean
}

export interface ITreeCopyResult {
    /** 创建的节点 id 列表（如果有递归，不算子文件，只有 `srcNodeIds` 对应复制的节点） */
    createdNodeIds: string[]
}

/**
 * 复制节点
 *
 * 将已存在节点复制到目标父级，并为复制出的每个节点生成新的 ID。
 *
 * 核心流程：
 * 1. 去重并读取源节点，父子混合选择时只保留最外层源节点，避免子节点被重复复制。
 * 2. 按 renameOnCopy 规则为顶层副本预生成名称；默认复制到同级时自动避让重名。
 * 3. 递归构造待写入节点列表，deep 模式下复制整棵子树，所有副本共享本次复制的 modif。
 * 4. 只给顶层副本计算目标父级下的 index，子节点在各自新父级下保持构造顺序。
 * 5. 交给 setNodes 统一处理覆盖策略、metadata、标记删除恢复和最终写入。
 * 6. 返回仍然可见的顶层副本 ID；如果覆盖策略跳过了某些副本，它们不会出现在结果里。
 *
 */
export async function copyNodes(
    this: TableTree<ITreeNode>,
    /** 待复制的源节点 ID 列表 */
    srcNodeIds: string[],
    /** 目标父节点 ID，如果为 "/" 表示根节点 */
    parentId: string,
    options?: ITreeCopyNodesOptions,
): Promise<ITreeCopyResult> {
    const uniqueNodeIds = Array.from(new Set(srcNodeIds)).filter(Boolean)
    if (uniqueNodeIds.length === 0) {
        return { createdNodeIds: [] }
    }

    // 复制的目标位置必须已经存在；复制过程中产生的新子节点会挂到新副本父级下。
    await assertTreeParentExists(this, parentId)

    // 父目录和子节点同时被选中时，复制父目录已经包含子节点，不再单独复制子节点。
    const rootNodes = await collectTopSelectedNodes(this, uniqueNodeIds)
    if (rootNodes.length === 0) {
        return { createdNodeIds: [] }
    }

    // 默认复制行为倾向于“生成副本”而不是覆盖原节点，因此未指定覆盖策略时自动重命名。
    const shouldRenameOnCopy = options?.renameOnCopy === true || (!options?.overwriteMode && options?.renameOnCopy !== false)
    const rootNames = shouldRenameOnCopy
        ? await createCopyNames.call(this, parentId, rootNodes.map((node) => node.name))
        : rootNodes.map((node) => node.name)

    const createdNodeIds: string[] = []
    const copyNodes: ITreeNode[] = []
    const modif = Date.now()
    for (let i = 0; i < rootNodes.length; i++) {
        const createdId = await buildCopyNodes.call(this, rootNodes[i], parentId, rootNames[i], copyNodes, modif, options)
        createdNodeIds.push(createdId)
    }

    const rootIndexes = await resolveTreeIndexes(this, parentId, createdNodeIds.length, options?.index)
    for (let i = 0; i < createdNodeIds.length; i++) {
        const rootCopyNode = copyNodes.find((node) => node.id === createdNodeIds[i])
        if (rootCopyNode) rootCopyNode.index = rootIndexes[i]
    }

    const { index, ...setOptions } = options ?? {}
    await this.setNodes(copyNodes, setOptions)
    if (shouldRenameOnCopy) {
        // 多用户同时复制时，预先生成的名称仍可能冲突，写入后再做一次兜底修复。
        await repairDuplicatedSiblingNames(this, parentId, createdNodeIds)
    }
    const existingRootIds: string[] = []
    for (const nodeId of createdNodeIds) {
        if (await this.has(nodeId)) {
            existingRootIds.push(nodeId)
        }
    }
    return { createdNodeIds: existingRootIds }
}

async function buildCopyNodes(
    this: TableTree<ITreeNode>,
    sourceNode: ITreeNode,
    parentId: string,
    name: string,
    copyNodes: ITreeNode[],
    modif: number,
    options?: ITreeCopyNodesOptions,
): Promise<string> {
    const copiedId = newNodeId()
    const copiedNode = normalizeWritableNode(
        {
            ...sourceNode,
            id: copiedId,
            parentId,
            name,
            modif,
        },
        { parentId },
    )

    copyNodes.push(copiedNode as ITreeNode)

    if (options?.deep) {
        const children = await this.findMany({ parentId: sourceNode.id }, { sort: { index: 1 } })
        for (const child of children) {
            await buildCopyNodes.call(this, child, copiedId, child.name, copyNodes, modif, options)
        }
    }

    return copiedId
}

async function createCopyNames(
    this: TableTree<ITreeNode>,
    parentId: string,
    names: string[],
): Promise<string[]> {
    const siblings = await this.findMany({ parentId }, { projection: ["name"] })
    const existsNames = siblings.map((node) => node.name).filter((name): name is string => typeof name === "string")
    return getUniqueFileNames(names, existsNames)
}
