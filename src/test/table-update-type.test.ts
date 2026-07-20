import { ITableDoc } from "../adapter/adapter"
import { ITableArrayAddOp, ITableUpdateOp } from "../core/types"

interface IUserLogin {
    time: Date
    ip: string
}

interface IUserProfile {
    loginRecords?: IUserLogin[]
}

interface IUserSchema extends ITableDoc {
    id: string
    name: string
    lastLogin: IUserLogin[]
    profile?: IUserProfile
}

describe("Table 数组更新类型", () => {
    test("普通业务接口可以作为数组元素用于 $push", () => {
        const loginInfo: IUserLogin = {
            time: new Date("2026-07-20T00:00:00.000Z"),
            ip: "127.0.0.1",
        }

        const update: ITableUpdateOp<IUserSchema> = {
            $push: {
                lastLogin: {
                    $each: [loginInfo],
                    $slice: -20,
                },
            },
        }

        expectTypeOf(update.$push?.lastLogin).toEqualTypeOf<ITableArrayAddOp<IUserLogin> | undefined>()
    })

    test("嵌套数组路径可以推导元素类型", () => {
        const loginInfo: IUserLogin = {
            time: new Date("2026-07-20T00:00:00.000Z"),
            ip: "127.0.0.1",
        }

        const update: ITableUpdateOp<IUserSchema> = {
            $addToSet: {
                "profile.loginRecords": loginInfo,
            },
        }

        expectTypeOf(update.$addToSet?.["profile.loginRecords"]).toEqualTypeOf<
            ITableArrayAddOp<IUserLogin> | undefined
        >()
    })

    test("无业务 Schema 的底层更新仍然支持动态数组字段", () => {
        const update: ITableUpdateOp = {
            $push: {
                tags: {
                    $each: ["table", "database"],
                    $position: 0,
                },
            },
        }

        expect(update.$push?.tags).toEqual({
            $each: ["table", "database"],
            $position: 0,
        })
    })

    test("业务 Schema 会拒绝错误的数组元素和非数组字段", () => {
        const loginInfo: IUserLogin = {
            time: new Date("2026-07-20T00:00:00.000Z"),
            ip: "127.0.0.1",
        }

        const invalidElementUpdate: ITableUpdateOp<IUserSchema> = {
            $push: {
                lastLogin: {
                    // @ts-expect-error 验证 lastLogin 只接受 IUserLogin 元素
                    $each: ["错误元素"],
                },
            },
        }

        const invalidFieldUpdate: ITableUpdateOp<IUserSchema> = {
            $push: {
                // @ts-expect-error 验证非数组字段不能使用 $push
                name: loginInfo,
            },
        }

        expect(invalidElementUpdate.$push?.lastLogin).toBeDefined()
        expect(invalidFieldUpdate.$push).toBeDefined()
    })
})
