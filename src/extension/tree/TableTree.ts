import { table } from "console"
import { ITableDoc } from "../../adapter/adapter"
import { Table } from "../../core/Table"
import { createNodes } from "./core/createNodes"
import { ITreeNode } from "./tree.types"
import { defineClass } from "fzz"



export const TableTree = defineClass(class TableTree {
    constructor(public table: Table) { }

}, { createNodes })


let tree = new TableTree({} as any)
tree.createNodes([])





