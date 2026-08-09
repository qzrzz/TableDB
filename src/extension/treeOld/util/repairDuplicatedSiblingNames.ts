import type { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"
import { getUniqueFileNames } from "./getUniqueFileNames"
import { refreshTreeMetadata } from "./refreshTreeMetadata"

/** 多用户并发重命名时可能基于同一份旧列表生成相同名称，写入后再兜底收敛为唯一名称。 */
export async function repairDuplicatedSiblingNames<TNode extends ITreeNode>(
    table: TableTree<TNode>,
    parentId: string,
    candidateIds?: string[],
): Promise<void> {
    const siblings = await table.findMany({ parentId }, { sort: { index: 1 } }) as TNode[]
    const candidateIdSet = candidateIds?.length ? new Set(candidateIds) : undefined
    const candidateNames = candidateIdSet
        ? new Set(siblings.filter((node) => candidateIdSet.has(node.id)).map((node) => node.name))
        : undefined
    const repairNodeIds = candidateNames
        ? new Set(siblings.filter((node) => candidateNames.has(node.name)).map((node) => node.id))
        : undefined
    const usedNames = new Set<string>()
    const updates: { id: string; name: string }[] = []

    for (const node of siblings) {
        const shouldRepairNode = !repairNodeIds || repairNodeIds.has(node.id)
        if (!shouldRepairNode) {
            usedNames.add(node.name)
            continue
        }

        if (!usedNames.has(node.name)) {
            usedNames.add(node.name)
            continue
        }

        const [uniqueName] = await getUniqueFileNames([node.name], usedNames)
        usedNames.add(uniqueName)
        updates.push({ id: node.id, name: uniqueName })
    }

    if (updates.length === 0) return

    const modif = Date.now()
    await table.bulkUpdate(
        updates.map((node) => ({
            filter: { id: node.id },
            updateOp: { $set: { name: node.name, modif } as any },
        })),
    )
    await refreshTreeMetadata(table, {
        parentIds: [parentId],
        cmodif: modif,
    })
}
