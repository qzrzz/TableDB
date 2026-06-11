import { Table } from "../../core/Table"
import { checkNodes } from "./core/checkNodes"
import { copyNodes } from "./core/copyNodes"
import { createNodes } from "./core/createNodes"
import { deleteNodes } from "./core/deleteNodes"
import { listAllNodes, listNodes, listNodesByCursor } from "./core/listNodes"
import { moveNodes } from "./core/moveNodes"
import { setNodes } from "./core/setNodes"
import { unDeleteNodes } from "./core/unDeleteNodes"
import { updateNodes } from "./core/updateNodes"
import type {
	ICheckNodesResult,
	ITreeCheckNodesOptions,
	ITreeCopyNodesOptions,
	ITreeCreateNodesOptions,
	ITreeDeleteNodesOptions,
	ITreeDeleteResult,
	ITreeListAllNodesOptions,
	ITreeListAllNodesResult,
	ITreeListNodesByCursorOptions,
	ITreeListNodesByCursorResult,
	ITreeListNodesOptions,
	ITreeListNodesResult,
	ITreeMoveNodesOptions,
	ITreeSetNodesOptions,
	ITreeUpdateFilter,
	ITreeUpdateNodesOptions,
	ITreeUpdateOp,
	ITreeWritableNode,
	ITreeWritableNodePatch,
} from "./core/treeCoreTypes"
import { ITreeNode } from "./tree.types"

/**
 * 目录树表
 * 预置了常用的树形结构操作方法，如创建节点、删除节点、更新节点等
 * 每个文档被视为一个节点，必须包含 parentId 字段来表示父子关系
 * 会自动维护节点的层级关系和修改标记
 *
 */
export class TableTree<TNode extends ITreeNode = ITreeNode> extends Table<TNode> {
	/** 创建节点 */
	createNodes(nodes: ITreeWritableNode<TNode>[], parentId: string, options?: ITreeCreateNodesOptions): Promise<void> {
		return createNodes.call(this, nodes, parentId, options)
	}

	/** 获取直属子节点（skip/limit） */
	listNodes(parentId: string, options?: ITreeListNodesOptions): Promise<ITreeListNodesResult<TNode>> {
		return listNodes.call(this, parentId, options) as Promise<ITreeListNodesResult<TNode>>
	}

	/** 获取直属子节点（cursor） */
	listNodesByCursor(
		parentId: string,
		options?: ITreeListNodesByCursorOptions,
	): Promise<ITreeListNodesByCursorResult<TNode>> {
		return listNodesByCursor.call(this, parentId, options) as Promise<ITreeListNodesByCursorResult<TNode>>
	}

	/** 获取全部子孙节点（扁平分页） */
	listAllNodes(parentId: string, options?: ITreeListAllNodesOptions): Promise<ITreeListAllNodesResult<TNode>> {
		return listAllNodes.call(this, parentId, options) as Promise<ITreeListAllNodesResult<TNode>>
	}

	/** 检查目标位置是否存在冲突节点 */
	checkNodes(
		nodes: ITreeWritableNodePatch<TNode>[],
		targetId: string,
		options?: ITreeCheckNodesOptions,
	): Promise<ICheckNodesResult<TNode>> {
		return checkNodes.call(this, nodes, targetId, options) as Promise<ICheckNodesResult<TNode>>
	}

	/** 设置节点数据 */
	setNodes(nodes: ITreeWritableNodePatch<TNode>[], options?: ITreeSetNodesOptions): Promise<void> {
		return setNodes.call(this, nodes, options)
	}

	/** 复制节点 */
	copyNodes(srcNodeIds: string[], parentId: string, options?: ITreeCopyNodesOptions): Promise<void> {
		return copyNodes.call(this, srcNodeIds, parentId, options)
	}

	/** 移动节点 */
	moveNodes(nodeIds: string[], parentId: string, options?: ITreeMoveNodesOptions): Promise<void> {
		return moveNodes.call(this, nodeIds, parentId, options)
	}

	/** 删除节点 */
	deleteNodes(nodeIds: string[], options?: ITreeDeleteNodesOptions): Promise<ITreeDeleteResult> {
		return deleteNodes.call(this, nodeIds, options)
	}

	/** 恢复节点 */
	unDeleteNodes(nodeIds: string[]): Promise<void> {
		return unDeleteNodes.call(this, nodeIds)
	}

	/** 更新节点 */
	updateNodes(filter: ITreeUpdateFilter, updateOp: ITreeUpdateOp<TNode>, options?: ITreeUpdateNodesOptions): Promise<void> {
		return updateNodes.call(this, filter, updateOp, options)
	}
}
