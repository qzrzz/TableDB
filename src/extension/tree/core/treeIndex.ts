import type { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"

export const TREE_INDEX_STEP = 1024

export interface ITreeIndexRangeResult {
    indexes: number[]
    nextParentLastIndex?: number
}

/** 判断某个父节点当前是否已经进入索引排序模式。 */
export async function hasTreeIndexedOrder(
    this: TableTree<ITreeNode>,
    parentId: string,
): Promise<boolean> {
    if (parentId !== "/") {
        const parentNode = await this.get(parentId)
        if (typeof parentNode?.clidLastIndex === "number" && !Number.isNaN(parentNode.clidLastIndex)) {
            return true
        }
    }

    const indexedChild = await this.findOne(
        {
            parentId,
            index: { $ne: null },
        },
        {
            projection: ["id"],
        },
    )

    return Boolean(indexedChild)
}

/**
 * 归一化同级节点已有的 index。
 *
 * 旧数据可能没有 index，或者 index 已经稀疏不连续，
 * 这里统一转换成稳定递增的数值，便于后续继续分配新区间。
 */
export function normalizeTreeSiblingIndexes(siblings: Array<Pick<ITreeNode, "id" | "index">>): Map<string, number> {
    const normalizedIndexMap = new Map<string, number>()
    let currentIndex = 0

    for (const sibling of siblings) {
        const rawIndex = typeof sibling.index === "number" && !Number.isNaN(sibling.index) ? sibling.index : undefined
        currentIndex = rawIndex !== undefined && rawIndex > currentIndex ? rawIndex : currentIndex + TREE_INDEX_STEP
        normalizedIndexMap.set(String(sibling.id), currentIndex)
    }

    return normalizedIndexMap
}

/**
 * 生成一段新的 index 序列。
 *
 * 当序列落在末尾时，会优先复用父节点记录的 clidLastIndex，
 * 让后续 append 场景可以持续单调递增，而不是每次都重新扫描整段区间。
 */
export async function createTreeIndexRange(
    this: TableTree<ITreeNode>,
    parentId: string,
    count: number,
    lowerIndex?: number,
    upperIndex?: number,
): Promise<ITreeIndexRangeResult> {
    if (count <= 0) {
        return { indexes: [] }
    }

    const parentLastIndex = await getTreeParentLastIndex.call(this, parentId)

    if (lowerIndex === undefined && upperIndex === undefined) {
        if (parentLastIndex !== undefined) {
            const indexes = Array.from({ length: count }, (_, index) => parentLastIndex + index + 1)
            return {
                indexes,
                nextParentLastIndex: indexes[indexes.length - 1],
            }
        }

        const indexes = Array.from({ length: count }, (_, index) => (index + 1) * TREE_INDEX_STEP)
        return {
            indexes,
            nextParentLastIndex: indexes[indexes.length - 1],
        }
    }

    if (lowerIndex === undefined) {
        const step = 1 / (count + 1)
        return {
            indexes: Array.from({ length: count }, (_, index) => upperIndex! - step * (count - index)),
        }
    }

    if (upperIndex === undefined) {
        const baseIndex = Math.max(parentLastIndex ?? lowerIndex, lowerIndex)
        const indexes = Array.from({ length: count }, (_, index) => baseIndex + index + 1)
        return {
            indexes,
            nextParentLastIndex: indexes[indexes.length - 1],
        }
    }

    const step = (upperIndex - lowerIndex) / (count + 1)
    if (step <= 0) {
        throw new Error("[TableTree] 无法在目标位置生成有效的 index 序列")
    }

    return {
        indexes: Array.from({ length: count }, (_, index) => lowerIndex + step * (index + 1)),
    }
}

/**
 * 持久化父节点当前已分配的最后一个子级 index。
 */
export async function persistTreeParentLastIndex(
    this: TableTree<ITreeNode>,
    parentId: string,
    nextParentLastIndex?: number,
): Promise<void> {
    if (parentId === "/" || nextParentLastIndex === undefined) {
        return
    }

    const parentNode = await this.get(parentId)
    if (!parentNode) {
        return
    }

    const currentLastIndex = typeof parentNode.clidLastIndex === "number" && !Number.isNaN(parentNode.clidLastIndex)
        ? parentNode.clidLastIndex
        : undefined

    if (currentLastIndex !== undefined && currentLastIndex >= nextParentLastIndex) {
        return
    }

    await this.updateOne(
        { id: parentId },
        {
            $set: {
                clidLastIndex: nextParentLastIndex,
            },
        },
    )
}

async function getTreeParentLastIndex(
    this: TableTree<ITreeNode>,
    parentId: string,
): Promise<number | undefined> {
    if (parentId === "/") {
        return undefined
    }

    const parentNode = await this.get(parentId)
    const parentLastIndex = parentNode?.clidLastIndex
    return typeof parentLastIndex === "number" && !Number.isNaN(parentLastIndex) ? parentLastIndex : undefined
}