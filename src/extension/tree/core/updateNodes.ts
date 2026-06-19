import { ITableFilter, ITableUpdateOp } from "../../../core/types"
import type { TableTree } from "../TableTree"
import type { ITreeChangeResult, ITreeNode } from "../tree.types"
import { collectDescendantNodes } from "../util/collectDescendantNodes"
import { refreshTreeMetadata } from "../util/refreshTreeMetadata"
import { isTreeManagedField } from "../util/stripTreeManagedFields"
import { assertNotMoveIntoSelfOrDescendant, assertTreeNodeName, assertTreeParentExists } from "../util/assertTreeParent"

/** 更新节点选项 */
export interface ITreeUpdateNodesOptions {
    /** 是否递归更新子节点 */
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
    const targetNodes = await this.findMany(filter, { ignoreMarkDelete: true })
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
    await assertUpdateOpSafe.call(this, updateNodeIds, updateOp)
    const cleanUpdateOp = normalizeTreeUpdateOp(updateOp, newModif)

    await this.updateMany({ id: { $in: updateNodeIds } }, cleanUpdateOp)
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
): Promise<void> {
    const setOp = updateOp.$set as Record<string, any> | undefined
    if (!setOp) return

    if (setOp.name !== undefined) {
        assertTreeNodeName(setOp.name)
    }

    if (setOp.parentId !== undefined) {
        await assertTreeParentExists(this, setOp.parentId)
        await assertNotMoveIntoSelfOrDescendant(this, updateNodeIds, setOp.parentId)
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
