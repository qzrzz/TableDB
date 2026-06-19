import { ITableDBAdapter, ITableDoc } from "../adapter/adapter"
import { ITableOptions, Table } from "./Table"

/** 定义一个 Table，返回一个 useTable 函数
 *
 *  useTable 函数调用后返回表实例（单例）
 *
 * @param tableOptions Table 的配置选项
 *
 * @example
 * ```ts
 *
 *  const useUserTable = defineTable({name: "user"})
 *
 *  // 在需要使用的地方
 *  const userTable = await useUserTable()
 *
 *
 * // 如果要指定 adapter
 * const useCustomTable = defineTable({adapter : SQLiteAdapter({filename: ":memory:"})})
 */
export function defineTable<
    TSchema extends ITableDoc = ITableDoc,
    TTable extends Table<TSchema> = Table<TSchema>
>(
    tableOptions: ITableOptions<TSchema>,
    TableClass?: new (options: ITableOptions<TSchema>) => TTable
): UseTableFunction<TSchema, TTable> {
    const { name } = tableOptions

    // 使用 Map 按 adapter 区分单例
    const singletonMap = new Map<ITableDBAdapter | undefined, TTable>()

    let className = name + "Table"
    const TargetClass = TableClass ?? (Table as any)
    let tempOb = {
        [className]: class extends TargetClass {
            constructor(options: any) {
                super(options)
            }
        },
    }

    return async (options?: { adapter?: ITableDBAdapter }) => {
        const adapter = options?.adapter
        
        // 检查是否已有该 adapter 对应的单例
        if (singletonMap.has(adapter)) {
            return singletonMap.get(adapter)!
        }

        // 合并 adapter 配置，调用时传入的 adapter 优先级更高
        const mergedOptions = adapter
            ? { ...tableOptions, adapter }
            : tableOptions

        let Cls = tempOb[className] as new (options: ITableOptions<TSchema>) => TTable
        let table = new Cls(mergedOptions)
        await table.inited
        singletonMap.set(adapter, table as TTable)
        return table as TTable
    }
}

/** 兼容旧的拼写错误类型 */
export type UseTalbeFunction<
    TSchema extends ITableDoc = ITableDoc,
    TTable extends Table<TSchema> = Table<TSchema>
> = UseTableFunction<TSchema, TTable>

/** 定义使用 Table 函数的类型 */
export type UseTableFunction<
    TSchema extends ITableDoc = ITableDoc,
    TTable extends Table<TSchema> = Table<TSchema>
> = (options?: {
    adapter?: ITableDBAdapter
}) => Promise<TTable>

/** 定义全局的数据库适配器（SQLite/MongoDB）
 *
 * @param adapter 数据库适配器实例
 */
export function defineGlobalDBAdapter(adapter: ITableDBAdapter) {
    Table.globalAdapter = adapter
}
