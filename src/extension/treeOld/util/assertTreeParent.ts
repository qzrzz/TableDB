import type { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"
import { collectDescendantNodes } from "./collectDescendantNodes"

/** 确认父级节点存在，根节点 "/" 视为合法父级。 */
export async function assertTreeParentExists<TNode extends ITreeNode>(
    table: TableTree<TNode>,
    parentId: string,
): Promise<void> {
    assertTreeParentId(parentId)
    if (parentId === "/") return
    if (!(await table.has(parentId))) {
        throw new Error(`[TableTree] 父节点不存在：${parentId}`)
    }
}

/** 校验节点名称不会破坏路径语义。 */
export function assertTreeNodeName(name: unknown): void {
    if (typeof name !== "string") {
        throw new Error("[TableTree] 节点名称必须是字符串")
    }
    if (name.includes("/")) {
        throw new Error(`[TableTree] 节点名称不能包含 "/"：${name}`)
    }
}

/** 校验父级 ID 的运行时类型，避免非法值破坏祖先链。 */
export function assertTreeParentId(parentId: unknown): asserts parentId is string {
    if (typeof parentId !== "string" || parentId.length === 0) {
        throw new Error("[TableTree] 父节点 ID 必须是非空字符串")
    }
}

/** 校验完整树节点的必填字段，避免仅依赖 TypeScript 类型造成脏数据落库。 */
export function assertTreeNodeValues(node: Pick<ITreeNode, "id" | "parentId" | "name" | "isDir" | "size" | "index" | "modif">): void {
    if (typeof node.id !== "string" || node.id.length === 0) {
        throw new Error("[TableTree] 节点 ID 必须是非空字符串")
    }
    assertTreeParentId(node.parentId)
    assertTreeNodeName(node.name)
    if (typeof node.isDir !== "boolean") {
        throw new Error("[TableTree] 节点 isDir 必须是布尔值")
    }
    if (typeof node.size !== "number" || !Number.isFinite(node.size) || node.size < 0) {
        throw new Error("[TableTree] 节点 size 必须是非负有限数字")
    }
    if (typeof node.index !== "string") {
        throw new Error("[TableTree] 节点 index 必须是字符串")
    }
    if (typeof node.modif !== "number" || !Number.isFinite(node.modif)) {
        throw new Error("[TableTree] 节点 modif 必须是有限数字")
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
