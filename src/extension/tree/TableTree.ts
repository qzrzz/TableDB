import { Table, ITableOptions } from "../../core/Table"
import { ITreeNode } from "./tree.types"
import { createNodes } from "./core/createNodes"
import { updateNodes } from "./core/updateNodes"
import { setNodes } from "./core/setNodes"
import { deleteNodes } from "./core/deleteNodes"
import { unDeleteNodes } from "./core/unDeleteNodes"
import { moveNodes } from "./core/moveNodes"
import { copyNodes } from "./core/copyNodes"
import { listNodes } from "./core/listNodes"
import { listNodesByCursor } from "./core/listNodesByCursor"
import { preOverwriteNodes } from "./core/preOverwriteNodes"
import { presyncNodes } from "./core/presyncNodes"
import { defineTable, UseTableFunction } from "../../core/defineTable"

/**
 * 目录树表
 * 预置了常用的树形结构操作方法，如创建节点、删除节点、更新节点等
 * 每个文档被视为一个节点，必须包含 parentId 字段来表示父子关系
 * 会自动维护节点的层级关系和修改标记
 *
 */
export class TableTree<TNode extends ITreeNode = ITreeNode> extends Table<TNode> {
    createNodes: typeof createNodes = createNodes as any
    updateNodes: typeof updateNodes = updateNodes as any
    setNodes: typeof setNodes = setNodes as any
    deleteNodes: typeof deleteNodes = deleteNodes as any
    unDeleteNodes: typeof unDeleteNodes = unDeleteNodes as any
    moveNodes: typeof moveNodes = moveNodes as any
    copyNodes: typeof copyNodes = copyNodes as any
    listNodes: typeof listNodes = listNodes as any
    listNodesByCursor: typeof listNodesByCursor = listNodesByCursor as any
    preOverwriteNodes: typeof preOverwriteNodes = preOverwriteNodes as any
    presyncNodes: typeof presyncNodes = presyncNodes as any
}

/**
 * 定义目录树表，返回一个 useTableTree 函数
 *
 * @param tableOptions TableTree 的配置选项
 * @returns 返回一个异步获取 TableTree 实例的函数
 *
 * @example
 * ```ts
 * const useFileTree = defineTableTree<ZFile>({
 *     name: "file-tree",
 * })
 * const fileTree = await useFileTree()
 * ```
 */
export function defineTableTree<TNode extends ITreeNode = ITreeNode>(
    tableOptions: ITableOptions<TNode>
): UseTableFunction<TNode, TableTree<TNode>> {
    return defineTable(tableOptions, TableTree as any)
}