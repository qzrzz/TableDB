import { ITableDoc } from "../../adapter/adapter"
import { Table } from "../../core/Table"
import { ITreeNode } from "./tree.types"

export class TableTree<TSchema extends ITreeNode = ITreeNode> {
    constructor(private table: Table<TSchema>) {}

    /** 创建节点 */
    createNodes() {}
}
