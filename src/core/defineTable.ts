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
export function defineTable<TSchema extends ITableDoc = ITableDoc>(
    tableOptions: ITableOptions<TSchema>
): UseTalbeFunction<TSchema> {
    const { name } = tableOptions

    // 使用 Map 按 adapter 区分单例
    const singletonMap = new Map<ITableDBAdapter | undefined, Table<TSchema>>()

    let className = name + "Table"
    let tempOb = {
        [className]: class extends Table {},
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

        let Cls = tempOb[className]
        let table = new Cls(mergedOptions)
        await table.inited
        singletonMap.set(adapter, table as Table<TSchema>)
        return table as Table<TSchema>
    }
}

export type UseTalbeFunction<TSchema extends ITableDoc = ITableDoc> = (opitons?: {
    adapter?: ITableDBAdapter
}) => Promise<Table<TSchema>>

/** 定义全局的数据库适配器（SQLite/MongoDB） */
export function defineGlobalDBAdapter(adapter: ITableDBAdapter) {
    Table.globalAdapter = adapter
}
