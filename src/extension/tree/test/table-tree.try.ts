import { SQLiteAdapter } from "../../../adapter/SQLite"
import { defineTableTree, TableTree } from "../TableTree"
import { ITreeNode } from "../tree.types"

type ZFile = ITreeNode & {
    name: string
    meta: any
}

const __dirname = import.meta.dirname

let useTableTree = defineTableTree<ZFile>({
    name: "fs-test",
    adapter: SQLiteAdapter({ filename: `${__dirname}/dist/fs-test.sqlite` }),
})

let treeTable = await useTableTree()

let re = await treeTable.createNodes(
    [
        {
            name: "123",
        },
    ],
    "/",
    
)
console.log("re", re)
