import { ITreeNode } from "../tree.types"

export function newEmptyNode(nodeData: any): ITreeNode {
    return Object.assign(
        {
            id: "",
            parentId: "",
            name: "",
            index: "",
            modif: 0,
            isDir: false,
            size: 0,
        },
        nodeData,
    ) as ITreeNode
}
