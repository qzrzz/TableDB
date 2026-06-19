import type { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"
import { collectDescendantNodes } from "./collectDescendantNodes"

/** 确认父级节点存在，根节点 "/" 视为合法父级。 */
export async function assertTreeParentExists<TNode extends ITreeNode>(
    table: TableTree<TNode>,
    parentId: string,
): Promise<void> {
    if (parentId === "/") return
    if (!(await table.has(parentId))) {
        throw new Error(`[TableTree] 父节点不存在：${parentId}`)
    }
}

/** 校验节点名称不会破坏路径语义。 */
export function assertTreeNodeName(name: unknown): void {
    if (typeof name === "string" && name.includes("/")) {
        throw new Error(`[TableTree] 节点名称不能包含 "/"：${name}`)
    }
}

/** 确认移动目标不会落入节点自身或后代中。 */
export async function assertNotMoveIntoSelfOrDescendant<TNode extends ITreeNode>(
    table: TableTree<TNode>,
    nodeIds: string[],
    parentId: string,
): Promise<void> {
    if (parentId === "/") return
    const uniqueNodeIds = Array.from(new Set(nodeIds)).filter(Boolean)
    if (uniqueNodeIds.includes(parentId)) {
        throw new Error("[TableTree] 不能把节点移动到自己下面")
    }
    const descendantNodes = await collectDescendantNodes(table, uniqueNodeIds)
    if (descendantNodes.some((node) => node.id === parentId)) {
        throw new Error("[TableTree] 不能把节点移动到自己的后代节点中")
    }
}
