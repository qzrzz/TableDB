import { ICursorPagingOptions, ISkipPagingOptions } from "../../../core/list"
import { TableTree } from "../TableTree"

/** 获取一个节点的子节点（基于 skip limit）
 *
 * 基于 Table.listPagingBySkip
 */
export function listNodes(
    this: InstanceType<typeof TableTree>,
    /** 要获取的节点
     *  可以用 '/' 表示根节点 */
    parentId: string,
    options?: ISkipPagingOptions & {
        /** 仅返回指定类型的节点，默认为返回所有类型的节点 */
        onlyTypes?: string[]
        /** 排除指定类型的节点，默认为不排除任何类型的节点
         * 如果 options.onlyTypes 已经指定了要包含的类型，则 options.onlyNotTypes 将被忽略
         */
        onlyNotTypes?: string[]
    },
) {}

/**
 * 获取一个节点的子节点（基于游标分页）
 */
export async function listNodesByCursor(
    this: InstanceType<typeof TableTree>,
    /** 要获取的节点
     *  可以用 '/' 表示根节点 */
    parentId: string,
    options?: ICursorPagingOptions & {
        
    }
) {}


/**
 * 获取一个节点的所有子节点（分页）
 * 
 * 基于 listNodesByCursor，但 Cursor 记录了深度遍历信息，可以从 Cursor 接着遍历
 * 返回的是扁平化的节点列表
 */
export  async function listAllNodes()
