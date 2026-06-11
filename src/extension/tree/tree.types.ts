import { ITableDoc } from "../../adapter/adapter"

export interface ITreeNode extends ITableDoc {
    id: string
    /** 父级的 id ，如果为 "/" 表示根节点 */
    parentId: string
    /** 节点名称 */
    name: string
    /** 修改标记 */
    modif: number
    /** 节点类型 */
    type?: string
    /** 是否是文件夹节点
     *  无论是否是文件夹节点，任何节点都可以有子节点
     */
    isDir: boolean
    /** 排序索引 */
    index?: number
    /** 子级排序序号（子级最后一个节点的序号） */
    clidLastIndex?: number
    /** 尺寸 */
    size: number
    // 树结构数据 ---------------------
    /** 子级大小 （所有子级节点，不包括自身节点的大小） */
    csize: number
    /** 子级数量 （所有子级节点的数量，包括文件夹和文件 ） */
    ctotal: number
    /** 子级文件数量 （所有子级节点的数量，仅包含文件） */
    cftotal: number
}

/**
 * 树结构节点排序索引选项
 */
export interface ITreeIndexOptions {
    /**
     * 指定一个父节点下已存在的子节点  ID
     * 新创建的节点将被插入到该节点之后
     */
    prevNodeId?: string

    /**
     * 指定一个父节点下已存在的子节点  ID
     * 新创建的节点将被插入到该节点之前
     */
    nextNodeId?: string

    /** 新创建的节点将被插入到子节点列表的开头 */
    toStart?: boolean

    /** 新创建的节点将被插入到子节点列表的末尾 */
    toEnd?: boolean
}

/** 树结构覆盖节点选项 */
export interface ITreeOverwriteOptions {
    /** 以什么方式进行唯一标识，默认按 id
     *  也可以是任意键，例如 "name"，"meta.hash_md5" 等等
     */
    uniqueBy?: "id" | "name" | string

    /** 当出现文件覆盖文件夹的情况时
     *  是否要允许 file 覆盖 dir，默认不允许
     *  如果不允许，则会跳过覆盖，保留原有文件夹节点
     */
    enableFileOverwriteDir?: boolean

    /** 当出现覆盖的情况，要执行的逻辑
     *
     * - `replace`：直接替换目标节点（默认）
     *              如果目标是文件夹，会被删除（遵守 Table 的删除逻辑，可能是标记删除）
     *
     * - `merge`：  如果源节点和目标节点都是目录节点，则用合并它们的子节点
     *
     * - `mergeByModif`: 同 merge，但只有当源节点的 modif 大于目标节点的 modif 时才覆盖，相当于按新旧合并
     *
     * - `newName`：不覆盖目标节点，而是为新节点生成一个新的名称（例如在原有名称后添加 " (1)"）
     *
     * merge：如果源节点和目标节点都是目录节点，则合并它们的子节点，否则替换目标节点
     * mergeByModif：同 merge，但只有当源节点的 modif 大于目标节点的 modif 时才覆盖
     * newName：不覆盖目标节点，而是为新节点生成一个新的名称（例如在原有名称后添加 " (1)"）
     */
    overwriteMode?: "replace" | "merge" | "mergeByModif" | "newName"
}
