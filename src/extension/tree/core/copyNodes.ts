import type { TableTree } from "../TableTree"
import type { ITreeIndexOptions, ITreeNode, ITreeOverwriteOptions } from "../tree.types"
import { getUniqueFileNames } from "../util/getUniqueFileNames"
import { newNodeId } from "../util/newNodeId"
import { normalizeWritableNode } from "../util/normalizeWritableNode"
import { assertTreeParentExists } from "../util/assertTreeParent"
import { resolveTreeIndexes } from "../util/resolveTreeIndex"

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

/** 复制节点
 *
 * 把已经存在的节点复制，会安排新的节点 ID。
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
    await assertTreeParentExists(this, parentId)

    const sourceNodes = (await Promise.all(uniqueNodeIds.map((nodeId) => this.get(nodeId)))).filter(
        (node): node is ITreeNode => !!node,
    )
    const rootNodes = await filterNestedCopyRoots.call(this, sourceNodes)
    if (rootNodes.length === 0) {
        return { createdNodeIds: [] }
    }

    const shouldRenameOnCopy = options?.renameOnCopy === true || (!options?.overwriteMode && options?.renameOnCopy !== false)
    const rootNames = shouldRenameOnCopy
        ? await createCopyNames.call(this, parentId, rootNodes.map((node) => node.name))
        : rootNodes.map((node) => node.name)

    const createdNodeIds: string[] = []
    const copyNodes: ITreeNode[] = []
    for (let i = 0; i < rootNodes.length; i++) {
        const createdId = await buildCopyNodes.call(this, rootNodes[i], parentId, rootNames[i], copyNodes, options)
        createdNodeIds.push(createdId)
    }

    const rootIndexes = await resolveTreeIndexes(this, parentId, createdNodeIds.length, options?.index)
    for (let i = 0; i < createdNodeIds.length; i++) {
        const rootCopyNode = copyNodes.find((node) => node.id === createdNodeIds[i])
        if (rootCopyNode) rootCopyNode.index = rootIndexes[i]
    }

    const { index, ...setOptions } = options ?? {}
    await this.setNodes(copyNodes, setOptions)
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
    options?: ITreeCopyNodesOptions,
): Promise<string> {
    const copiedId = newNodeId()
    const copiedNode = normalizeWritableNode(
        {
            ...sourceNode,
            id: copiedId,
            parentId,
            name,
        },
        { parentId },
    )

    copyNodes.push(copiedNode as ITreeNode)

    if (options?.deep) {
        const children = await this.findMany({ parentId: sourceNode.id }, { sort: { index: 1 } })
        for (const child of children) {
            await buildCopyNodes.call(this, child, copiedId, child.name, copyNodes, options)
        }
    }

    return copiedId
}

async function filterNestedCopyRoots(
    this: TableTree<ITreeNode>,
    nodes: ITreeNode[],
): Promise<ITreeNode[]> {
    const selectedIds = new Set(nodes.map((node) => node.id))
    const roots: ITreeNode[] = []

    for (const node of nodes) {
        let parentId = node.parentId
        let hasSelectedAncestor = false
        while (parentId && parentId !== "/") {
            if (selectedIds.has(parentId)) {
                hasSelectedAncestor = true
                break
            }
            const parentNode = await this.get(parentId, { ignoreMarkDelete: true })
            parentId = parentNode?.parentId ?? "/"
        }
        if (!hasSelectedAncestor) {
            roots.push(node)
        }
    }

    return roots
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
