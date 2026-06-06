import { ITableDoc } from "../../adapter/adapter"

export interface ITreeNode extends ITableDoc {
    id: string
    /** 父级的 id ，如果为 "/" 表示根节点 */
    parentId: string
    /** 修改标记 */
    modif: number
    /** 节点类型 */
    type: string
}
