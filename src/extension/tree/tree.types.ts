import { ITableDoc } from "../../adapter/adapter"

export interface ITreeNode extends ITableDoc {
    /** 节点 ID */
    id: string
    /** 父级的 ID
     *  如果为 "/" 表示父级为根节点 */
    parentId: string
    /** 节点名称
     *  用于显示和识别节点
     *  内部限制不能允许包含 "/" 字符，如果有会抛出错误，以避免和路径混淆
     */
    name: string
    /** 节点类型 */
    type?: string
    /** 修改计数 */
    modif: number
    /** 子级修改计数 */
    cmodif?: number
    /** 是否是文件夹节点
     *
     * 标记是否是文件夹节点（之所以需要标记是因为无论是否是文件夹节点，任何节点都可以有子节点）
     */
    isDir: boolean
    /** 排序索引 (indexless 分数索引) */
    index?: string
    /** 子级排序序号（子级最后一个节点的序号） */
    childLastIndex?: string
    // 树结构数据 ---------------------
    /** 子级大小 （所有子级节点，不包括自身节点的大小） */
    csize: number
    /** 子级数量 （所有子级节点的数量，包括文件夹和文件 ） */
    ctotal: number
    /** 子级文件数量 （所有子级节点的数量，仅包含文件） */
    cftotal: number
    /** 节点尺寸（byte） */
    size: number
}

/** 树结构元数据字段
 *
 * 这些字段会被系统管理，用户无法自行修改。
 */
export interface ITreeNodeMetadataKeys {
    /** 子级总大小，不包含当前节点自身 size */
    csize: number
    /** 子级总数量，包含文件夹和文件 */
    ctotal: number
    /** 子级文件总数量，仅统计文件节点 */
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

/** 节点覆盖选项 */
export type ITreeOverwriteOptions = {
    /** 以什么方式进行唯一标识，默认按 id
     *  也可以是任意键，例如 "name"，"meta.hash_md5" 等等
     */
    uniqueBy?: "id" | "name" | string

    /** 当出现文件覆盖文件夹的情况时
     *  是否要允许 file 覆盖 dir，默认不允许
     *  如果不允许，则会跳过单个文件的覆盖，保留原有文件夹节点
     */
    enableFileOverwriteDir?: boolean

    /** 当出现覆盖的情况，要执行的逻辑
     *
     * - `replace`：直接替换目标节点（默认）
     *             （遵守 Table 的删除逻辑，可能是标记删除，要注意如果是文件夹会递归删除）
     *
     * - `skip`：跳过已存在的冲突节点，不写入新节点。
     *
     * - `merge`：删除已存在的冲突节点，再写入新节点；
     *            但如果冲突节点和新节点都是文件夹节点，
     *            则不删除冲突节点，而是把它们的子节点进行合并
     *           （如果子节点也有冲突则继续按 merge 规则进行处理）。
     *            相当于目录的递归合并。
     *
     * - `mergeByModif`: 类似 `merge`，处理冲突节点时不是用新节点
     *                   直接覆盖已存在节点，而是判断节点 `modif` 的大小，
     *                   保留 `modif` 较大的节点。
     *
     * - `newName`：不覆盖目标节点，而是为新节点生成一个新的名称（例如在原有名称后添加 " (1)"）
     *
     */
    overwriteMode?: "replace" | "skip" | "merge" | "mergeByModif" | "newName"
}

/** 树变更结果
 *  更新、创建等树操作的返回值，便于客户端同步
 */
export interface ITreeChangeResult {
    /** 此次操作的 modif 值
     *  每个改变的节点都会被设置为这个 modif 值 */
    modif?: number

    /** 此次操作的 cmodif 值
     *  每个改变的节点的子级都会被设置为这个 cmodif 值 */
    cmodif?: number
}
