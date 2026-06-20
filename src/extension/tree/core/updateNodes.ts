import { ITableFilter, ITableUpdateOp } from "../../../core/types"
import type { TableTree } from "../TableTree"
import type { ITreeChangeResult, ITreeNode } from "../tree.types"
import { collectDescendantNodes } from "../util/collectDescendantNodes"
import { refreshTreeMetadata } from "../util/refreshTreeMetadata"
import { isTreeManagedField } from "../util/stripTreeManagedFields"
import { assertNotMoveIntoSelfOrDescendant, assertTreeNodeName, assertTreeParentExists } from "../util/assertTreeParent"
import { resolveTreeIndexes } from "../util/resolveTreeIndex"

/** 更新节点选项 */
export interface ITreeUpdateNodesOptions {
    /** 是否递归更新子节点
     *  如果使用递归，并且更新 parentId 时要注意，不要把后代节点的 parentId 也一并改写为目标父级，应该抛出错误
     */
    deep?: boolean
}

/** 更新节点
 *
 * 更底层的更新接口，可以一次更新多个经 filter 筛选的文档。
 * 可以通过 `options.deep` 参数递归更新子节点。
 *
 * 一次操作更新的所有节点都有相同的 modif, cmodif 值
 *
 * 要注意如果修改了节点的  需要触发相应的 metadata 变更，通过此接口修改 parentId 不能进行覆盖检查所以要注意
 */
export async function updateNodes(
    this: TableTree<ITreeNode>,
    filter: ITableFilter,
    updateOp: ITableUpdateOp<ITreeNode>,
    options?: ITreeUpdateNodesOptions,
): Promise<ITreeChangeResult> {
    const targetNodes = await this.findMany(filter)
    if (targetNodes.length === 0) {
        return {}
    }

    const allNodes = [...targetNodes]
    if (options?.deep) {
        const childNodes = await collectDescendantNodes(this, targetNodes.map((node) => node.id), {
            ignoreMarkDelete: true,
        })
        allNodes.push(...childNodes)
    }

    const updateNodeIds = Array.from(new Set(allNodes.map((node) => node.id)))
    const parentIds = Array.from(new Set(allNodes.map((node) => node.parentId)))
    const newModif = Number((updateOp.$set as any)?.modif ?? Date.now())
    await assertUpdateOpSafe.call(this, updateNodeIds, updateOp, options)
    const cleanUpdateOp = normalizeTreeUpdateOp(updateOp, newModif)

    await applyUpdateNodes.call(this, allNodes, updateNodeIds, cleanUpdateOp, updateOp)
    await refreshTreeMetadata(this, {
        parentIds,
        nodeIds: updateNodeIds,
        cmodif: newModif,
    })

    return {
        modif: newModif,
        cmodif: newModif,
    }
}

async function assertUpdateOpSafe(
    this: TableTree<ITreeNode>,
    updateNodeIds: string[],
    updateOp: ITableUpdateOp<ITreeNode>,
    options?: ITreeUpdateNodesOptions,
): Promise<void> {
    const setOp = updateOp.$set as Record<string, any> | undefined
    assertTreeStructureFieldsSafe(updateOp)
    if (!setOp) return

    if (setOp.name !== undefined) {
        assertTreeNodeName(setOp.name)
    }

    if (setOp.parentId !== undefined) {
        if (options?.deep) {
            throw new Error("[TableTree] deep 更新不能同时修改 parentId，避免后代节点被平铺移动")
        }
        await assertNoSelectedAncestorAndDescendant.call(this, updateNodeIds)
        await assertTreeParentExists(this, setOp.parentId)
        await assertNotMoveIntoSelfOrDescendant(this, updateNodeIds, setOp.parentId)
    }
}

/** updateNodes 不能改写节点身份，也不能移除树节点必需字段，否则会产生不可遍历的孤儿节点。 */
function assertTreeStructureFieldsSafe(updateOp: ITableUpdateOp<ITreeNode>): void {
    const setOp = updateOp.$set as Record<string, any> | undefined
    if (setOp && Object.prototype.hasOwnProperty.call(setOp, "id")) {
        throw new Error("[TableTree] updateNodes 不能修改树结构字段 id")
    }
    assertRequiredSetFieldValues(setOp)

    const unsetKeys = collectUnsetKeys(updateOp.$unset)
    const requiredFields = new Set(["id", "parentId", "name", "isDir", "size"])
    for (const key of unsetKeys) {
        if (requiredFields.has(key)) {
            throw new Error(`[TableTree] updateNodes 不能移除树结构字段 ${key}`)
        }
    }

    const renameOp = updateOp.$rename as Record<string, string> | undefined
    if (renameOp) {
        for (const [fromKey, toKey] of Object.entries(renameOp)) {
            if (requiredFields.has(fromKey) || requiredFields.has(toKey)) {
                throw new Error(`[TableTree] updateNodes 不能通过 rename 改写树结构字段 ${fromKey}`)
            }
        }
    }

    assertCompareStructureFieldsSafe(updateOp.$min as Record<string, any> | undefined, "$min")
    assertCompareStructureFieldsSafe(updateOp.$max as Record<string, any> | undefined, "$max")
}

function assertRequiredSetFieldValues(setOp?: Record<string, any>): void {
    if (!setOp) return

    if (Object.prototype.hasOwnProperty.call(setOp, "parentId") && typeof setOp.parentId !== "string") {
        throw new Error("[TableTree] updateNodes 不能把树结构字段 parentId 更新为空值")
    }
    if (Object.prototype.hasOwnProperty.call(setOp, "name") && typeof setOp.name !== "string") {
        throw new Error("[TableTree] updateNodes 不能把树结构字段 name 更新为空值")
    }
    if (Object.prototype.hasOwnProperty.call(setOp, "isDir") && typeof setOp.isDir !== "boolean") {
        throw new Error("[TableTree] updateNodes 不能把树结构字段 isDir 更新为空值")
    }
    if (Object.prototype.hasOwnProperty.call(setOp, "size") && typeof setOp.size !== "number") {
        throw new Error("[TableTree] updateNodes 不能把树结构字段 size 更新为空值")
    }
}

function assertCompareStructureFieldsSafe(compareOp: Record<string, any> | undefined, operator: "$min" | "$max"): void {
    if (!compareOp) return

    const immutableFields = new Set(["id", "parentId", "name", "isDir"])
    for (const [key, value] of Object.entries(compareOp)) {
        if (immutableFields.has(key)) {
            throw new Error(`[TableTree] updateNodes 不能通过 ${operator} 改写树结构字段 ${key}`)
        }
        if (key === "size" && typeof value !== "number") {
            throw new Error(`[TableTree] updateNodes 不能通过 ${operator} 把树结构字段 size 更新为空值`)
        }
    }
}

function collectUnsetKeys(unsetOp: ITableUpdateOp<ITreeNode>["$unset"]): string[] {
    if (!unsetOp) return []
    if (Array.isArray(unsetOp)) {
        return unsetOp.map(String)
    }
    return Object.keys(unsetOp)
}

/** 批量修改 parentId 时，如果命中集合内同时包含父子节点，会把后代平铺到目标父级，必须提前拒绝。 */
async function assertNoSelectedAncestorAndDescendant(
    this: TableTree<ITreeNode>,
    updateNodeIds: string[],
): Promise<void> {
    const selectedIds = new Set(updateNodeIds)
    for (const nodeId of selectedIds) {
        const node = await this.get(nodeId, { ignoreMarkDelete: true })
        let parentId = node?.parentId
        while (parentId && parentId !== "/") {
            if (selectedIds.has(parentId)) {
                throw new Error("[TableTree] 批量更新 parentId 不能同时命中父节点和后代节点")
            }
            const parentNode = await this.get(parentId, { ignoreMarkDelete: true })
            parentId = parentNode?.parentId
        }
    }
}

/** 执行真实更新；批量跨父级移动时需要为每个移动节点分配独立 index。 */
async function applyUpdateNodes(
    this: TableTree<ITreeNode>,
    nodes: ITreeNode[],
    updateNodeIds: string[],
    cleanUpdateOp: ITableUpdateOp<ITreeNode>,
    originalUpdateOp: ITableUpdateOp<ITreeNode>,
): Promise<void> {
    const setOp = originalUpdateOp.$set as Record<string, any> | undefined
    if (setOp?.parentId === undefined || setOp.index !== undefined) {
        await this.updateMany({ id: { $in: updateNodeIds } }, cleanUpdateOp)
        return
    }

    const nextParentId = setOp.parentId
    const movingNodes = nodes.filter((node) => node.parentId !== nextParentId)
    if (movingNodes.length === 0) {
        await this.updateMany({ id: { $in: updateNodeIds } }, cleanUpdateOp)
        return
    }

    const indexes = await resolveTreeIndexes(this, nextParentId, movingNodes.length)
    const indexByNodeId = new Map<string, string>()
    for (let i = 0; i < movingNodes.length; i++) {
        indexByNodeId.set(movingNodes[i].id, indexes[i])
    }

    await this.bulkUpdate(
        nodes.map((node) => {
            const updateOp = cloneUpdateOp(cleanUpdateOp)
            const nextIndex = indexByNodeId.get(node.id)
            if (nextIndex !== undefined) {
                updateOp.$set = {
                    ...((updateOp.$set as Record<string, any> | undefined) ?? {}),
                    index: nextIndex,
                } as any
            }
            return {
                filter: { id: node.id },
                updateOp,
            }
        }),
    )
}

function cloneUpdateOp(updateOp: ITableUpdateOp<ITreeNode>): ITableUpdateOp<ITreeNode> {
    return {
        ...updateOp,
        $set: updateOp.$set ? { ...(updateOp.$set as any) } : undefined,
        $unset: Array.isArray(updateOp.$unset) ? [...updateOp.$unset] as any : updateOp.$unset ? { ...(updateOp.$unset as any) } : undefined,
    }
}

function normalizeTreeUpdateOp(updateOp: ITableUpdateOp<ITreeNode>, modif: number): ITableUpdateOp<ITreeNode> {
    const nextUpdateOp: ITableUpdateOp<ITreeNode> = { ...updateOp }
    if (nextUpdateOp.$set) {
        const nextSet: Record<string, any> = {}
        for (const [key, value] of Object.entries(nextUpdateOp.$set)) {
            if (!isTreeManagedField(key)) {
                nextSet[key] = value
            }
        }
        if (nextSet.modif === undefined) {
            nextSet.modif = modif
        }
        nextUpdateOp.$set = nextSet as any
    } else {
        nextUpdateOp.$set = { modif } as any
    }

    if (nextUpdateOp.$unset) {
        const unsetEntries = Array.isArray(nextUpdateOp.$unset)
            ? nextUpdateOp.$unset.map((key) => [key, true] as const)
            : Object.entries(nextUpdateOp.$unset)
        const nextUnset: Record<string, true | 1> = {}
        for (const [key, value] of unsetEntries) {
            if (!isTreeManagedField(key)) {
                nextUnset[key] = value as true | 1
            }
        }
        nextUpdateOp.$unset = nextUnset
    }

    return nextUpdateOp
}
