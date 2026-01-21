import { ITableDoc } from "../../adapter/adapter"

export interface ITreeNode extends ITableDoc {
    id: string
    /** 父级 */
    parentId: string | null
}
