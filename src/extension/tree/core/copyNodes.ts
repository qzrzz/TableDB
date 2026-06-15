import type { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"
import { stripManagedTreeStatsFromPatch } from "./treeWriteGuards"

/** 复制节点选项 */
export interface ITreeCopyNodesOptions {
    /** 新节点插入到该节点之后 */
    prevNodeId?: string
    /** 是否递归复制子节点 */
    deep?: boolean
    /** 复制后的节点是否自动重命名 */
    renameOnCopy?: boolean
}

/** 复制节点
 */
export async function copyNodes(
    this: TableTree<ITreeNode>,
    /** 待复制的源节点 ID 列表 */
    srcNodeIds: string[],
    /** 目标父节点 ID，如果为 "/" 表示根节点 */
    parentId: string,
    options?: ITreeCopyNodesOptions,
): Promise<void> {
    const uniqueNodeIds = Array.from(new Set(srcNodeIds))
    if (uniqueNodeIds.length === 0) {
        return
    }

    if (parentId !== "/") {
        const targetParentNode = await this.get(parentId)
        if (!targetParentNode) {
            throw new Error(`[TableTree] 目标父节点不存在: ${parentId}`)
        }
    }

    const existingNodes: ITreeNode[] = []
    for (const nodeId of uniqueNodeIds) {
        const node = await this.get(nodeId)
        if (node) {
            existingNodes.push(node)
        }
    }

    if (existingNodes.length === 0) {
        return
    }

    const selectedIdSet = new Set(existingNodes.map((node) => node.id))
    const rootNodes: ITreeNode[] = []

    for (const node of existingNodes) {
        let currentParentId = node.parentId
        let hasSelectedAncestor = false

        while (currentParentId && currentParentId !== "/") {
            if (selectedIdSet.has(currentParentId)) {
                hasSelectedAncestor = true
                break
            }
            const parentNode = await this.get(currentParentId)
            currentParentId = parentNode?.parentId ?? "/"
        }

        if (!hasSelectedAncestor) {
            rootNodes.push(node)
        }
    }

    const reservedNamesByParent = new Map<string, Set<string>>()
    let currentPrevNodeId = options?.prevNodeId
    for (const rootNode of rootNodes) {
        const copiedRootId = await copyTreeNode.call(this, rootNode, parentId, true, options, reservedNamesByParent, currentPrevNodeId)
        currentPrevNodeId = copiedRootId
    }
}

async function copyTreeNode(
    this: TableTree<ITreeNode>,
    sourceNode: ITreeNode,
    targetParentId: string,
    isRootCopy: boolean,
    options: ITreeCopyNodesOptions | undefined,
    reservedNamesByParent: Map<string, Set<string>>,
    rootPrevNodeId?: string,
): Promise<string> {
    const writableNode = stripManagedTreeStatsFromPatch<ITreeNode>(sourceNode as Record<string, any>) as Omit<ITreeNode, "csize" | "ctotal" | "cftotal">
    const copiedId = createTreeCopyId()
    const sourceName = typeof writableNode.name === "string" ? writableNode.name : String(writableNode.name ?? copiedId)
    const copiedName = isRootCopy && options?.renameOnCopy !== false
        ? await createCopyName.call(this, targetParentId, sourceName, reservedNamesByParent)
        : sourceName

    await this.createNodes(
        [
            {
                ...writableNode,
                id: copiedId,
                name: copiedName,
            },
        ],
        targetParentId,
        isRootCopy && rootPrevNodeId
            ? { index: { prevNodeId: rootPrevNodeId } }
            : undefined,
    )

    if (options?.deep) {
        const children = await this.findMany({ parentId: sourceNode.id })
        for (const child of children) {
            await copyTreeNode.call(this, child as ITreeNode, copiedId, false, options, reservedNamesByParent)
        }
    }

    return copiedId
}

async function createCopyName(
    this: TableTree<ITreeNode>,
    parentId: string,
    sourceName: string,
    reservedNamesByParent: Map<string, Set<string>>,
): Promise<string> {
    let reservedNames = reservedNamesByParent.get(parentId)
    if (!reservedNames) {
        reservedNames = new Set<string>()
        const siblings = await this.findMany({ parentId }, { projection: ["name"] })
        for (const sibling of siblings) {
            if (typeof sibling.name === "string") {
                reservedNames.add(sibling.name)
            }
        }
        reservedNamesByParent.set(parentId, reservedNames)
    }

    let index = 1
    let nextName = `${sourceName} (${index})`
    while (reservedNames.has(nextName)) {
        index += 1
        nextName = `${sourceName} (${index})`
    }

    reservedNames.add(nextName)
    return nextName
}

function createTreeCopyId(): string {
    return crypto.randomUUID()
}
