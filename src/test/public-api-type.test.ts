import {
    defineTable,
    type IPlvMap,
    type ITableDoc,
    type ITableOptions,
    type Table,
    type UseTableFunction,
} from "../index"

interface IPublicUserSchema extends ITableDoc {
    id: string
    name: string
}

const tableOptions: ITableOptions<IPublicUserSchema> = {
    name: "public-api-type-test",
}

/**
 * 保留导出变量的类型推导场景，用于验证消费方生成声明时需要的类型均可从包入口引用。
 */
export const usePublicUserTable = defineTable<IPublicUserSchema>(tableOptions)

describe("包入口公开类型", () => {
    test("defineTable 返回类型及其依赖类型均可从包入口引用", () => {
        expectTypeOf(usePublicUserTable).toEqualTypeOf<UseTableFunction<IPublicUserSchema>>()
        expectTypeOf<Awaited<ReturnType<typeof usePublicUserTable>>>().toEqualTypeOf<Table<IPublicUserSchema>>()
        expectTypeOf<IPlvMap>().toMatchTypeOf<Record<string, string[] | Record<string, 1 | -1>>>()
    })
})
