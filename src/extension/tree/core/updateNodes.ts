import { ITableFilter, ITableUpdateOp } from "../../../core/types"
import type { TableTree } from "../TableTree"
import type { ITreeChangeResult, ITreeNode } from "../tree.types"
import { collectDescendantNodes } from "../util/collectDescendantNodes"
import { refreshTreeMetadata } from "../util/refreshTreeMetadata"
import { applyTreeMetadataDelta, calcTreeNodeContribution, type ITreeMetadataStatsDelta } from "../util/applyTreeMetadataDelta"
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

interface IUpdateTargetNodes {
    /** 本次真实会被更新的节点，deep 模式下包含后代。 */
    nodes: ITreeNode[]
    /** 去重后的更新节点 ID。 */
    nodeIds: string[]
    /** 更新前受影响的父级，用于后续刷新 metadata。 */
    parentIds: string[]
}

/**
 * 更新节点
 *
 * 更底层的更新接口，可以一次更新多个经 filter 筛选的文档。
 * 可以通过 `options.deep` 参数递归更新子节点。
 *
 * 一次操作更新的所有节点都有相同的 modif, cmodif 值
 *
 * 核心流程：
 * 1. 先判断 updateOp 是否会影响树统计字段，决定读取轻量投影还是统计投影。
 * 2. 根据 filter 收集目标节点；deep 模式会把目标节点的后代也纳入同一次更新。
 * 3. 校验 updateOp 不会破坏树结构：不能改 id，不能移除必填字段，deep 不能同时改 parentId。
 * 4. 清理外部传入的系统维护字段，并补齐本次统一 modif。
 * 5. 执行真实更新；批量移动 parentId 时为每个移动节点分配独立 index。
 * 6. 如果能从旧节点和 $set 直接推导统计变化，就走增量 metadata；否则用 refreshTreeMetadata 全量刷新兜底。
 *
 * 注意：此接口不会执行覆盖检查。调用方直接修改 parentId 时，需要自行确保目标父级下不会出现业务冲突。
 */
export async function updateNodes(
    this: TableTree<ITreeNode>,
    filter: ITableFilter,
    updateOp: ITableUpdateOp<ITreeNode>,
    options?: ITreeUpdateNodesOptions,
): Promise<ITreeChangeResult> {
    // 只有 size/isDir/index 等会影响目录统计的更新，才需要读取完整统计投影。
    const statsChanged = isTreeStatsAffectedUpdateOp(updateOp)
    const canApplyIncrementalMetadata = statsChanged && canApplyIncrementalUpdateMetadata(updateOp)
    const target = await collectUpdateTargetNodes.call(this, filter, options, canApplyIncrementalMetadata)
    if (target.nodes.length === 0) {
        return {}
    }

    const newModif = Number((updateOp.$set as any)?.modif ?? Date.now())
    await assertUpdateOpSafe.call(this, target.nodeIds, updateOp, options)
    // cleanUpdateOp 会过滤 ctotal/csize/childLastIndex 等系统字段，防止外部直接破坏 metadata。
    const cleanUpdateOp = normalizeTreeUpdateOp(updateOp, newModif)

    await applyUpdateNodes.call(this, target.nodes, target.nodeIds, cleanUpdateOp, updateOp)
    const setOp = updateOp.$set as Record<string, any> | undefined
    if (canApplyIncrementalMetadata) {
        // 简单 $set 修改可以直接从旧值和新值计算贡献差，避免扫描所有兄弟节点。
        await applyUpdateMetadataDelta(this, target.nodes, setOp, newModif)
    } else {
        // 复杂算子或 parentId 移动在并发场景下更容易基于过期状态，使用全量刷新保证最终收敛正确。
        await refreshTreeMetadata(this, {
            parentIds: target.parentIds,
            nodeIds: setOp?.parentId !== undefined ? target.nodeIds : undefined,
            cmodif: newModif,
            statsChanged,
        })
    }

    return {
        modif: newModif,
        cmodif: newModif,
    }
}

async function collectUpdateTargetNodes(
    this: TableTree<ITreeNode>,
    filter: ITableFilter,
    options: ITreeUpdateNodesOptions | undefined,
    needStatsProjection: boolean,
): Promise<IUpdateTargetNodes> {
    // projection 只取后续流程需要的字段，普通内容更新无需读取完整节点。
    const targetNodes = await this.findMany(filter, {
        projection: needStatsProjection
            ? ["id", "parentId", "index", "isDir", "size", "ctotal", "cftotal", "csize"]
            : ["id", "parentId"],
    })
    if (targetNodes.length === 0) {
        return { nodes: [], nodeIds: [], parentIds: [] }
    }

    const nodes = [...targetNodes]
    if (options?.deep) {
        // deep 更新只递归当前可见子树；已标记删除的后代不应被普通更新重新影响。
        const childNodes = await collectDescendantNodes(this, targetNodes.map((node) => node.id), {
            ignoreMarkDelete: true,
        })
        nodes.push(...childNodes)
    }

    return {
        nodes,
        nodeIds: Array.from(new Set(nodes.map((node) => node.id))),
        parentIds: Array.from(new Set(nodes.map((node) => node.parentId))),
    }
}

async function applyUpdateMetadataDelta(
    table: TableTree<ITreeNode>,
    oldNodes: ITreeNode[],
    setOp: Record<string, any> | undefined,
    cmodif: number,
): Promise<void> {
    const deltas: ITreeMetadataStatsDelta[] = []
    for (const oldNode of oldNodes) {
        // 用更新前节点和 $set 后节点分别计算对父级的贡献，再取差值作为 metadata 增量。
        const nextNode = resolveUpdatedStatsNode(oldNode, setOp)
        const oldContribution = calcTreeNodeContribution(oldNode)
        const nextContribution = calcTreeNodeContribution(nextNode)
        const parentChanged = oldNode.parentId !== nextNode.parentId
        const indexChanged = setOp && Object.prototype.hasOwnProperty.call(setOp, "index")

        if (parentChanged) {
            // 跨父级移动需要从旧父级扣减，再向新父级增加，并刷新两边 childLastIndex。
            deltas.push({
                parentId: oldNode.parentId,
                ctotal: -oldContribution.ctotal,
                cftotal: -oldContribution.cftotal,
                csize: -oldContribution.csize,
                refreshChildLastIndex: true,
            })
            deltas.push({
                parentId: nextNode.parentId,
                ...nextContribution,
                refreshChildLastIndex: true,
            })
            continue
        }

        const delta = {
            ctotal: nextContribution.ctotal - oldContribution.ctotal,
            cftotal: nextContribution.cftotal - oldContribution.cftotal,
            csize: nextContribution.csize - oldContribution.csize,
        }
        deltas.push({
            parentId: oldNode.parentId,
            ...delta,
            refreshChildLastIndex: Boolean(indexChanged),
        })
    }

    await applyTreeMetadataDelta(table, deltas, cmodif)
}

function resolveUpdatedStatsNode(node: ITreeNode, setOp: Record<string, any> | undefined): ITreeNode {
    if (!setOp) return node

    return {
        ...node,
        parentId: setOp.parentId ?? node.parentId,
        index: setOp.index ?? node.index,
        isDir: setOp.isDir ?? node.isDir,
        size: setOp.size ?? node.size,
    }
}

async function assertUpdateOpSafe(
    this: TableTree<ITreeNode>,
    updateNodeIds: string[],
    updateOp: ITableUpdateOp<ITreeNode>,
    options?: ITreeUpdateNodesOptions,
): Promise<void> {
    const setOp = updateOp.$set as Record<string, any> | undefined
    // 先做算子级安全检查，保证不会通过 $unset/$rename/$min 等绕过树结构保护。
    assertTreeStructureFieldsSafe(updateOp)
    if (!setOp) return

    if (setOp.name !== undefined) {
        assertTreeNodeName(setOp.name)
    }

    if (setOp.parentId !== undefined) {
        if (options?.deep) {
            throw new Error("[TableTree] deep 更新不能同时修改 parentId，避免后代节点被平铺移动")
        }
        // 批量移动不能同时命中父节点和后代，否则会把后代一起改成目标父级，破坏原子树结构。
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

/** 判断本次更新是否会改变目录统计；普通内容字段变化只需要刷新祖先 cmodif。 */
function isTreeStatsAffectedUpdateOp(updateOp: ITableUpdateOp<ITreeNode>): boolean {
    const statsFields = new Set(["parentId", "index", "isDir", "size"])
    const hasStatsField = (op: Record<string, any> | undefined): boolean => {
        return Boolean(op && Object.keys(op).some((key) => statsFields.has(key)))
    }

    if (hasStatsField(updateOp.$set as Record<string, any> | undefined)) return true
    if (hasUnsetStatsField(updateOp.$unset, statsFields)) return true
    if (hasStatsField(updateOp.$inc as Record<string, any> | undefined)) return true
    if (hasStatsField(updateOp.$mul as Record<string, any> | undefined)) return true
    if (hasStatsField(updateOp.$min as Record<string, any> | undefined)) return true
    if (hasStatsField(updateOp.$max as Record<string, any> | undefined)) return true

    const renameOp = updateOp.$rename as Record<string, string> | undefined
    if (renameOp) {
        return Object.entries(renameOp).some(([fromKey, toKey]) => statsFields.has(fromKey) || statsFields.has(toKey))
    }
    return false
}

/** 只有能从旧节点和 $set 直接推导新贡献值的结构更新，才走 O(depth) 增量维护。 */
function canApplyIncrementalUpdateMetadata(updateOp: ITableUpdateOp<ITreeNode>): boolean {
    const statsFields = new Set(["parentId", "index", "isDir", "size"])
    const setOp = updateOp.$set as Record<string, any> | undefined
    const hasStatsField = (op: Record<string, any> | undefined): boolean => {
        return Boolean(op && Object.keys(op).some((key) => statsFields.has(key)))
    }

    if (hasUnsetStatsField(updateOp.$unset, statsFields)) return false
    if (hasStatsField(updateOp.$inc as Record<string, any> | undefined)) return false
    if (hasStatsField(updateOp.$mul as Record<string, any> | undefined)) return false
    if (hasStatsField(updateOp.$min as Record<string, any> | undefined)) return false
    if (hasStatsField(updateOp.$max as Record<string, any> | undefined)) return false

    const renameOp = updateOp.$rename as Record<string, string> | undefined
    if (renameOp && Object.entries(renameOp).some(([fromKey, toKey]) => statsFields.has(fromKey) || statsFields.has(toKey))) {
        return false
    }

    // parentId 移动在多用户并发下可能基于过期父级做重复加减，先保留全量刷新兜底保证收敛正确。
    if (setOp && Object.prototype.hasOwnProperty.call(setOp, "parentId")) {
        return false
    }

    return hasStatsField(setOp)
}

function hasUnsetStatsField(
    unsetOp: ITableUpdateOp<ITreeNode>["$unset"],
    statsFields: Set<string>,
): boolean {
    if (!unsetOp) return false
    const unsetKeys = Array.isArray(unsetOp) ? unsetOp.map(String) : Object.keys(unsetOp)
    return unsetKeys.some((key) => statsFields.has(key))
}

function normalizeTreeUpdateOp(updateOp: ITableUpdateOp<ITreeNode>, modif: number): ITableUpdateOp<ITreeNode> {
    const nextUpdateOp: ITableUpdateOp<ITreeNode> = {}
    const nextSet = stripManagedUpdateFields(updateOp.$set as Record<string, any> | undefined)
    if (nextSet.modif === undefined) {
        nextSet.modif = modif
    }
    nextUpdateOp.$set = nextSet as any
    assignNonEmptyOp(nextUpdateOp, "$setOnInsert", stripManagedUpdateFields(updateOp.$setOnInsert as Record<string, any> | undefined))
    assignNonEmptyOp(nextUpdateOp, "$unset", stripManagedUnsetFields(updateOp.$unset))
    assignNonEmptyOp(nextUpdateOp, "$inc", stripManagedUpdateFields(updateOp.$inc as Record<string, any> | undefined))
    assignNonEmptyOp(nextUpdateOp, "$mul", stripManagedUpdateFields(updateOp.$mul as Record<string, any> | undefined))
    assignNonEmptyOp(nextUpdateOp, "$max", stripManagedUpdateFields(updateOp.$max as Record<string, any> | undefined))
    assignNonEmptyOp(nextUpdateOp, "$min", stripManagedUpdateFields(updateOp.$min as Record<string, any> | undefined))
    assignNonEmptyOp(nextUpdateOp, "$push", stripManagedUpdateFields(updateOp.$push as Record<string, any> | undefined))
    assignNonEmptyOp(nextUpdateOp, "$addToSet", stripManagedUpdateFields(updateOp.$addToSet as Record<string, any> | undefined))
    assignNonEmptyOp(nextUpdateOp, "$pull", stripManagedUpdateFields(updateOp.$pull as Record<string, any> | undefined))
    assignNonEmptyOp(nextUpdateOp, "$pop", stripManagedUpdateFields(updateOp.$pop as Record<string, any> | undefined))
    assignNonEmptyOp(nextUpdateOp, "$rename", stripManagedRenameFields(updateOp.$rename as Record<string, string> | undefined))
    return nextUpdateOp
}

/** 任何外部更新算子都不能直接改写目录树统计字段，这些字段只能由树操作统一维护。 */
function stripManagedUpdateFields(op: Record<string, any> | undefined): Record<string, any> {
    const nextOp: Record<string, any> = {}
    for (const [key, value] of Object.entries(op ?? {})) {
        if (!isTreeManagedField(key)) {
            nextOp[key] = value
        }
    }
    return nextOp
}

/** $unset 支持数组和对象两种写法，这里统一清理后转为对象写法。 */
function stripManagedUnsetFields(unsetOp: ITableUpdateOp<ITreeNode>["$unset"]): Record<string, true | 1> {
    const unsetEntries = Array.isArray(unsetOp)
        ? unsetOp.map((key) => [key, true] as const)
        : Object.entries(unsetOp ?? {})
    const nextUnset: Record<string, true | 1> = {}
    for (const [key, value] of unsetEntries) {
        if (!isTreeManagedField(key)) {
            nextUnset[key] = value as true | 1
        }
    }
    return nextUnset
}

/** rename 的来源或目标只要碰到统计字段，就整条忽略，避免覆盖或搬走系统维护值。 */
function stripManagedRenameFields(renameOp: Record<string, string> | undefined): Record<string, string> {
    const nextRename: Record<string, string> = {}
    for (const [fromKey, toKey] of Object.entries(renameOp ?? {})) {
        if (!isTreeManagedField(fromKey) && !isTreeManagedField(toKey)) {
            nextRename[fromKey] = toKey
        }
    }
    return nextRename
}

function assignNonEmptyOp(
    updateOp: ITableUpdateOp<ITreeNode>,
    key: keyof ITableUpdateOp<ITreeNode>,
    value: Record<string, any>,
): void {
    if (Object.keys(value).length > 0) {
        const writableUpdateOp = updateOp as Record<string, any>
        writableUpdateOp[key] = value
    }
}
