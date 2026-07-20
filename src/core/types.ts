import { ITableDoc } from "../adapter/adapter"

/** Table 的基本类型
 *  这格式可以直接存入 Table 后取出时，类型不会变化，Table 会保持其原始类型
 */
export type ITablePrimitive =
    | string
    | number
    | boolean
    | null
    | undefined
    | Date
    | RegExp
    | Map<any, any>
    | Set<any>
    | bigint
    | Blob
    | File
    | ArrayBuffer
    // 二级制操作数据类型
    | DataView
    | Int8Array
    | Int16Array
    | Int32Array
    | Uint8Array
    | Uint8ClampedArray
    | Uint16Array
    | Uint32Array
    | Float32Array
    | Float64Array
    | BigInt64Array
    | BigUint64Array
    // Error 类型
    | Error

/**
 * Table 的数据类型，可以是基本类型、对象或数组
 *
 *  对象会在存储前进行 Key 排序，以确保 MongoDB, sqlite 匹配对象更容易
 *  也就是说对象 keys 顺序会丢失
 */
export type ITableValue = ITablePrimitive | { [field: string]: ITableValue } | ITableValue[]

/**
 * Table 查询过滤器定义，
 * 过滤器用来描述查询文档时的条件
 *
 */
export type ITableFilter =
    | {
          [field: string]: ITableQuery
      }
    | { $and?: { [field: string]: ITableQuery }[] }
    | { $or?: { [field: string]: ITableQuery }[] }
    | { $nor?: { [field: string]: ITableQuery }[] }

export type ITableQuery = ITableValue | ITableMatchOp | ITableMatchLogic

/**
 * Table 逻辑操作定义
 */
export interface ITableMatchLogic {
    /** 多个条件同时成立 */
    $and?: ITableMatchOp[]
    /** 多个条件中至少一个成立 */
    $or?: (ITableMatchOp | ITableValue)[]
    /** 多个条件都不成立 */
    $nor?: (ITableMatchOp | ITableValue)[]
    /** 条件不成立 */
    $not?: ITableMatchOp | ITableValue | Omit<ITableMatchLogic, "$not">
}

/**
 * Table 匹配操作定义
 */
export interface ITableMatchOp {
    /**
     *  等于
     *
     *  相当于 field === value\
     *  对于对象类型，会要求字段和值完全匹配（包括嵌套对象），顺序无关\
     *  如果目标字段是数组，查询是非数组，则表示数组中包含该值（相当于 arr.includes(value)）\
     *  如果目标字段是数组，查询也是数组，则表示数组要完全匹配（包括顺序）
     *
     */
    $eq?: ITableValue

    /** 不等于
     *
     * 相当于 field !== value\
     * 对于对象类型，会要求字段和值完全匹配（包括嵌套对象），顺序无关
     * 如果目标字段是数组，查询是非数组，则表示数组中不包含该值（相当于 !arr.includes(value)）\
     * 如果目标字段是数组，查询也是数组，则表示数组不完全匹配（包括顺序）
     */
    $ne?: any

    /**
     * 大于
     *
     * 相当于 field > value\
     * Date 类型会比较时间戳\
     * 二进制数据会进行 Byte-by-byte 比较\
     * 如果目标字段是数组，只要有一个元素满足条件即匹配成功（相当于 arr.some(el => el > value)）
     */
    $gt?: any

    /** 大于等于
     *
     * 相当于 field >= value\
     * Date 类型会比较时间戳
     * 二进制数据会进行 Byte-by-byte 比较\
     * 如果目标字段是数组，只要有一个元素满足条件即匹配成功（相当于 arr.some(el => el >= value)）
     */
    $gte?: any

    /** 小于
     *
     * 相当于 field < value\
     * Date 类型会比较时间戳\
     * 二进制数据会进行 Byte-by-byte 比较\
     * 如果目标字段是数组，只要有一个元素满足条件即匹配成功（相当于 arr.some(el => el < value)）
     */
    $lt?: any

    /** 小于等于
     *
     * 相当于 field <= value\
     * Date 类型会比较时间戳\
     * 二进制数据会进行 Byte-by-byte 比较\
     * 如果目标字段是数组，只要有一个元素满足条件即匹配成功（相当于 arr.some(el => el <= value)）
     */
    $lte?: any

    /** 包含于
     *
     * 相当于 valueArray.includes(field)
     */
    $in?: any[]

    /** 不包含于
     * 相当于 !valueArray.includes(field)
     */
    $nin?: any[]

    /** 模糊匹配（仅适用于字符串字段）
     *
     * 支持 `%` 通配符，表示任意字符序列\
     * 例如：`'foo%'` 可以匹配 `'foo'`、`'foobar'`、`'foo123'` 等
     */
    $like?: string

    /** 正则表达式匹配（仅适用于字符串字段）
     *
     * 使用 JavaScript 正则表达式语法\
     * 例如：`'^foo.*bar$'` 可以匹配以 `'foo'` 开头、以 `'bar'` 结尾的字符串
     */
    $regex?: string

    /** 字段是否存在
     *
     * true 表示字段必须存在且不为 null\
     * false 表示字段不存在或值为 null
     */
    $exists?: boolean

    /**
     * 对数组元素进行匹配
     *
     * 对数组字段使用，表示数组中至少有一个元素满足子条件
     */
    $elemMatch?: { [elField: string]: ITableQuery } | ITableQuery

    /** 包含所有
     *
     * 相当于 valueArray.every(v => field.includes(v))
     * 用于数组字段，表示数组中必须包含所有指定元素
     */
    $all?: any[]

    /**
     *  数组长度匹配
     *
     *  用于数组字段，表示数组长度等于指定值
     */
    $size?: number | { $eq?: number; $ne?: number; $gt?: number; $gte?: number; $lt?: number; $lte?: number }
}

/**
 * Table 更新操作定义
 */
export interface ITableUpdateOp<TSchema extends ITableDoc = ITableDoc> {
    /** 设置指定字段的值
     *
     * 可以使用`.`来处理嵌套对象 */
    $set?: MatchKeysAndValues<TSchema>

    /** 在创建/插入新文档时设置指定字段的值
     *
     * 仅在创建/插入新文档时生效，可以用来设置默认值、创建时间等\
     * 可以使用`.`来处理嵌套对象 */
    $setOnInsert?: MatchKeysAndValues<TSchema>

    /** 删除指定字段
     *
     * 可以使用`.`来处理嵌套对象 */
    $unset?: { [field: string]: true | 1 } | string[]

    /** 对指定字段进行加法操作
     *
     *  相当于 field = field + value\
     *  可以使用`.`来处理嵌套对象 */
    $inc?: { [field: string]: number | bigint }

    /** 对指定字段进行乘法操作
     *
     *  相当于 field = field * value\
     *  可以使用`.`来处理嵌套对象 */
    $mul?: { [field: string]: number | bigint }

    /** 对指定字段进行最大值更新
     *
     *  相当于 field = max(field, value)\
     *  可以使用`.`来处理嵌套对象 */
    $max?: { [field: string]: number | Date | bigint }

    /** 对指定字段进行最小值更新
     *
     *  相当于 field = min(field, value)\
     *  可以使用`.`来处理嵌套对象
     *  */
    $min?: { [field: string]: number | Date | bigint }

    // ---------------------------------------------
    // 数组操作

    /**
     * 添加元素到数组字段
     *
     * 默认添加到数组末尾，使用 $position 可以指定位置\
     * 如果目标字段不是数组类型，操作会失败
     *
     * 子算子：{ $each: [value1,value2,...] } 可以一次添加多个元素\
     * 子算子：{ $position: number } 指定添加位置，0 为数组开头（负数不支持）\
     * 子算子：{ $slice: number } 限制添加操作后，字段数组最大长度
     *
     */
    $push?: ITableArrayUpdate<TSchema>

    /**
     * 添加元素到字段并保持唯一
     *
     * 与 $push 不同，如果目标数组中元素已存在则不会重复添加
     *
     * 子算子：{ $each: [value1,value2,...] } 可以一次添加多个元素\
     * 子算子：{ $position: number } 指定添加位置，0 为数组开头（负数不支持）\
     * 子算子：{ $slice: number } 限制添加操作后，字段数组最大长度
     * 注意元素顺序不影响对象的对比
     */
    $addToSet?: ITableArrayUpdate<TSchema>

    /**
     * 从数组字段中移除匹配的元素
     *
     * @example
     * // 移除数组中指定值
     * { tags: { $in: [3,'name1'] } }
     * // 移除数组中所有值大于 5 的元素
     * { scores: { $gt: 5 } }
     */
    $pull?: { [field: string]: ITableValue | ITableMatchOp | ITableMatchLogic }

    /** 移除数组字段最后一个元素或者第一个元素
     *
     * 1 表示移除最后一个元素\
     * -1 表示移除第一个元素
     */
    $pop?: { [field: string]: 1 | -1 } // 1 移除末尾元素，-1 移除开头元素

    // ---------------------------------------------
    // 对象操作

    /** 重命名字段
     *
     * key为旧字段名，value为新字段名\
     * 可以使用`.`来处理嵌套对象，新名字也要是嵌套名\
     * { $rename: { "name.first": "name.fname" } }
     *
     * 如果新字段名已存在，则会覆盖原有字段（原字段数据就删除了）
     * 如果旧字段名不存在，则操作无效
     */
    $rename?: { [oldField: string]: string }
}

/** 排除可空类型，便于识别可选数组字段。 */
type ITableNonNullish<T> = Exclude<T, null | undefined>

/** 获取数组字段的元素类型。 */
type ITableArrayElement<T> = ITableNonNullish<T> extends readonly (infer TElement)[] ? TElement : never

/**
 * 递归获取 Schema 中所有数组字段路径。
 *
 * 除了顶层数组字段，也支持 `profile.loginRecords` 形式的嵌套路径。
 * Table 原生值类型被视为叶子节点，避免递归进入 Date、Map 等对象内部。
 * 路径深度限制为 8 层，避免循环引用的 Schema 造成类型无限递归。
 */
type ITableArrayFieldPath<T, TDepth extends unknown[] = []> = TDepth["length"] extends 8
    ? never
    : T extends object
      ? {
            [TKey in keyof T & string]: ITableNonNullish<T[TKey]> extends readonly unknown[]
                ? TKey
                : ITableNonNullish<T[TKey]> extends ITablePrimitive
                  ? never
                  : ITableNonNullish<T[TKey]> extends object
                    ? `${TKey}.${ITableArrayFieldPath<ITableNonNullish<T[TKey]>, [...TDepth, unknown]>}`
                    : never
        }[keyof T & string]
      : never

/** 根据点路径获取 Schema 中对应字段的类型。 */
type ITableFieldPathValue<T, TPath extends string> = TPath extends `${infer TKey}.${infer TRest}`
    ? TKey extends keyof T
        ? ITableFieldPathValue<ITableNonNullish<T[TKey]>, TRest>
        : never
    : TPath extends keyof T
      ? ITableNonNullish<T[TPath]>
      : never

/** 为具有明确 Schema 的 Table 生成数组字段更新定义。 */
type ITableSchemaArrayUpdate<TSchema> = {
    [TPath in ITableArrayFieldPath<TSchema>]?: ITableArrayAddOp<
        ITableArrayElement<ITableFieldPathValue<TSchema, TPath>>
    >
}

/**
 * 数组字段更新定义。
 *
 * 使用默认 ITableDoc 的底层 Adapter 没有业务 Schema，继续接受动态字段；
 * 具有额外业务字段的 Table 则根据 Schema 严格推导数组元素类型。
 */
type ITableArrayUpdate<TSchema extends ITableDoc> = [Exclude<keyof TSchema, keyof ITableDoc>] extends [never]
    ? { [field: string]: ITableArrayAddOp<any> }
    : ITableSchemaArrayUpdate<TSchema>

/**
 * 向数组添加一个或多个元素。
 *
 * TElement 由目标数组字段推导，避免要求普通业务接口声明字符串索引签名。
 */
export type ITableArrayAddOp<TElement = ITableValue> =
    | TElement
    | {
          $each: TElement[]
          $position?: number
          $slice?: number
      }

// ITableArrayAddOp
// 添加元素到数组时的注意事项：
// MongoDB 会进行深度对比。只有当字段名和字段值
// 的顺序完全一致时，才会被视为“已存在”
// { a: 1, b: 2 } 与 { b: 2, a: 1 } 在 $addToSet 眼里是不同的
// 所以数组操作时，要进行对象排序，确保字段顺序一致

export type MatchKeysAndValues<TSchema> = Readonly<Partial<TSchema>> & Record<string, any>
