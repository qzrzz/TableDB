import { Table } from "../../core/Table"
import { ITreeNode } from "./tree.types"

/**
 * 目录树表
 * 预置了常用的树形结构操作方法，如创建节点、删除节点、更新节点等
 * 每个文档被视为一个节点，必须包含 parentId 字段来表示父子关系
 * 会自动维护节点的层级关系和修改标记
 */

export class TableTree extends Table<ITreeNode> {}
