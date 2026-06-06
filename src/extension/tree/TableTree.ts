import { table } from "console"
import { ITableDoc } from "../../adapter/adapter"
import { Table } from "../../core/Table"
import { createNodes } from "./core/createNodes"
import { ITreeNode } from "./tree.types"
import { defineClass } from "fzz"

/**
 * 目录树表格
 * 预置了常用的树形结构操作方法，如创建节点、删除节点、更新节点等
 * 每个文档被视为一个节点，必须包含 parentId 字段来表示父子关系
 * 会自动维护节点的层级关系和修改标记
 */
export const TableTree = defineClass(
    class TableTree {
        constructor(public table: Table) {}
    },
    { createNodes },
)
