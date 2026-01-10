import { describe, test, expect, beforeAll, beforeEach } from "vitest"
import { Table } from "../core/Table"
import { joinListWithTable } from "../core/join"
import { getTestTableByType, TestDatabaseType } from "./getTestTable"
import { ITableDoc } from "../adapter/adapter"

const DATABASE_TYPES: TestDatabaseType[] = ["sqlite", "mongodb"]

interface IUserDoc extends ITableDoc {
    id: string
    name: string
    age: number
    departmentId: string
    categoryIds?: string[]
}

interface IDepartmentDoc extends ITableDoc {
    id: string
    name: string
    managerId: string
}

interface ICategoryDoc extends ITableDoc {
    id: string
    name: string
    color: string
}

describe.each(DATABASE_TYPES)("Table Join 功能 - %s", async (dbType) => {
    let userTable!: Table<IUserDoc>
    let departmentTable!: Table<IDepartmentDoc>
    let categoryTable!: Table<ICategoryDoc>

    beforeAll(async () => {
        userTable = (await getTestTableByType("join-test-users", dbType)) as any
        departmentTable = (await getTestTableByType("join-test-departments", dbType)) as any
        categoryTable = (await getTestTableByType("join-test-categories", dbType)) as any

        await userTable.clearAll()
        await departmentTable.clearAll()
        await categoryTable.clearAll()

        await userTable.defineIndexes([{ key: "id", unique: true }])
        await departmentTable.defineIndexes([{ key: "id", unique: true }])
        await categoryTable.defineIndexes([{ key: "id", unique: true }])
    })

    beforeEach(async () => {
        await userTable.clear()
        await departmentTable.clear()
        await categoryTable.clear()

        // 填充部门数据
        await departmentTable.insertMany([
            { id: "dept1", name: "Engineering", managerId: "1" },
            { id: "dept2", name: "Marketing", managerId: "2" },
            { id: "dept3", name: "Sales", managerId: "3" },
        ])

        // 填充分类数据
        await categoryTable.insertMany([
            { id: "cat1", name: "Frontend", color: "blue" },
            { id: "cat2", name: "Backend", color: "green" },
            { id: "cat3", name: "DevOps", color: "orange" },
            { id: "cat4", name: "Design", color: "purple" },
        ])

        // 填充用户数据
        await userTable.insertMany([
            { id: "1", name: "Alice", age: 30, departmentId: "dept1", categoryIds: ["cat1", "cat2"] },
            { id: "2", name: "Bob", age: 25, departmentId: "dept2", categoryIds: ["cat4"] },
            { id: "3", name: "Charlie", age: 35, departmentId: "dept1", categoryIds: ["cat2", "cat3"] },
            { id: "4", name: "David", age: 40, departmentId: "dept3", categoryIds: [] },
            { id: "5", name: "Eve", age: 28, departmentId: "dept1" }, // 没有 categoryIds
        ])
    })

    describe("joinListWithTable 直接调用", () => {
        test("一对一连接 - 基本功能", async () => {
            const users = await userTable.findMany({})

            await joinListWithTable(users, [
                {
                    table: departmentTable,
                    localKey: "departmentId",
                    targetKey: "id",
                },
            ])

            // 验证 departmentId 被替换为完整的 department 对象
            expect(users[0].departmentId).toMatchObject({
                id: "dept1",
                name: "Engineering",
            })
            expect(users[1].departmentId).toMatchObject({
                id: "dept2",
                name: "Marketing",
            })
        })

        test("一对一连接 - 使用 newLocalKey 保留原字段", async () => {
            const users = await userTable.findMany({})

            await joinListWithTable(users, [
                {
                    table: departmentTable,
                    localKey: "departmentId",
                    targetKey: "id",
                    newLocalKey: "department",
                },
            ])

            // 验证原字段保留，新字段添加
            expect(users[0].departmentId).toBe("dept1")
            expect((users[0] as any).department).toMatchObject({
                id: "dept1",
                name: "Engineering",
            })
        })

        test("一对一连接 - 使用投影", async () => {
            const users = await userTable.findMany({})

            await joinListWithTable(users, [
                {
                    table: departmentTable,
                    localKey: "departmentId",
                    targetKey: "id",
                    projection: ["id", "name"], // 需要包含 id 字段用于匹配
                },
            ])

            // 验证只包含指定字段
            const dept = users[0].departmentId as any
            expect(dept.id).toBe("dept1")
            expect(dept.name).toBe("Engineering")
            expect(dept.managerId).toBeUndefined()
        })

        test("一对多连接 - 数组键值", async () => {
            const users = await userTable.findMany({})

            await joinListWithTable(users, [
                {
                    table: categoryTable,
                    localKey: "categoryIds",
                    targetKey: "id",
                },
            ])

            // Alice 有两个分类
            const aliceCats = users[0].categoryIds as any[]
            expect(aliceCats.length).toBe(2)
            expect(aliceCats[0]).toMatchObject({ id: "cat1", name: "Frontend" })
            expect(aliceCats[1]).toMatchObject({ id: "cat2", name: "Backend" })

            // Bob 有一个分类
            const bobCats = users[1].categoryIds as any[]
            expect(bobCats.length).toBe(1)
            expect(bobCats[0]).toMatchObject({ id: "cat4", name: "Design" })

            // David 的数组为空
            const davidCats = users[3].categoryIds as any[]
            expect(davidCats.length).toBe(0)
        })

        test("多个连接操作", async () => {
            const users = await userTable.findMany({})

            await joinListWithTable(users, [
                {
                    table: departmentTable,
                    localKey: "departmentId",
                    targetKey: "id",
                    newLocalKey: "department",
                },
                {
                    table: categoryTable,
                    localKey: "categoryIds",
                    targetKey: "id",
                    newLocalKey: "categories",
                },
            ])

            // 验证两个连接都生效
            expect(users[0].departmentId).toBe("dept1")
            expect((users[0] as any).department.name).toBe("Engineering")
            expect((users[0] as any).categories.length).toBe(2)
            expect((users[0] as any).categories[0].name).toBe("Frontend")
        })

        test("空列表处理", async () => {
            const emptyList: any[] = []
            await joinListWithTable(emptyList, [
                {
                    table: departmentTable,
                    localKey: "departmentId",
                    targetKey: "id",
                },
            ])
            expect(emptyList.length).toBe(0)
        })

        test("空操作列表处理", async () => {
            const users = await userTable.findMany({})
            const originalUsers = JSON.parse(JSON.stringify(users))

            await joinListWithTable(users, [])

            // 数据应该保持不变
            expect(users).toEqual(originalUsers)
        })

        test("处理不存在的外键", async () => {
            // 添加一个引用不存在部门的用户
            await userTable.insertMany([{ id: "6", name: "Frank", age: 32, departmentId: "dept999" }])

            const users = await userTable.findMany({ id: "6" })
            await joinListWithTable(users, [
                {
                    table: departmentTable,
                    localKey: "departmentId",
                    targetKey: "id",
                },
            ])

            // departmentId 应该保持原值（因为找不到匹配的文档）
            expect(users[0].departmentId).toBe("dept999")
        })

        test("处理 null 和 undefined 键值", async () => {
            const users = [
                { id: "7", name: "Grace", departmentId: null },
                { id: "8", name: "Henry", departmentId: undefined },
            ]

            await joinListWithTable(users, [
                {
                    table: departmentTable,
                    localKey: "departmentId",
                    targetKey: "id",
                },
            ])

            // null 和 undefined 应该保持不变
            expect(users[0].departmentId).toBeNull()
            expect(users[1].departmentId).toBeUndefined()
        })
    })

    describe("listPaging 中的 join", () => {
        test("skip 分页中使用 join", async () => {
            const result = await userTable.listPaging(
                {},
                {
                    pageIndex: 1,
                    pageSize: 3,
                    join: [
                        {
                            table: departmentTable,
                            localKey: "departmentId",
                            targetKey: "id",
                            newLocalKey: "department",
                        },
                    ],
                }
            )

            expect(result.list.length).toBe(3)
            expect(result.list[0].departmentId).toBe("dept1")
            expect((result.list[0] as any).department).toMatchObject({
                id: "dept1",
                name: "Engineering",
            })
        })

        test("skip 分页中使用多个 join", async () => {
            const result = await userTable.listPaging(
                {},
                {
                    pageIndex: 1,
                    pageSize: 2,
                    join: [
                        {
                            table: departmentTable,
                            localKey: "departmentId",
                            targetKey: "id",
                            newLocalKey: "department",
                        },
                        {
                            table: categoryTable,
                            localKey: "categoryIds",
                            targetKey: "id",
                            newLocalKey: "categories",
                        },
                    ],
                }
            )

            expect(result.list.length).toBe(2)
            expect((result.list[0] as any).department.name).toBe("Engineering")
            expect((result.list[0] as any).categories.length).toBe(2)
        })
    })

    describe("listPagingByCursor 中的 join", () => {
        test("cursor 分页中使用 join", async () => {
            const result = await userTable.listPagingByCursor(
                {},
                {
                    pageSize: 3,
                    join: [
                        {
                            table: departmentTable,
                            localKey: "departmentId",
                            targetKey: "id",
                            newLocalKey: "department",
                        },
                    ],
                }
            )

            expect(result.list.length).toBe(3)
            expect((result.list[0] as any).department).toBeDefined()
            expect((result.list[0] as any).department.name).toBeDefined()
        })

        test("cursor 分页中使用多个 join", async () => {
            const result = await userTable.listPagingByCursor(
                {},
                {
                    pageSize: 2,
                    join: [
                        {
                            table: departmentTable,
                            localKey: "departmentId",
                            targetKey: "id",
                            newLocalKey: "department",
                        },
                        {
                            table: categoryTable,
                            localKey: "categoryIds",
                            targetKey: "id",
                            newLocalKey: "categories",
                        },
                    ],
                }
            )

            expect(result.list.length).toBe(2)
            expect((result.list[0] as any).department).toBeDefined()
            expect((result.list[0] as any).categories).toBeDefined()
        })

        test("cursor 分页翻页后 join 仍然有效", async () => {
            // 第一页
            const page1 = await userTable.listPagingByCursor(
                {},
                {
                    pageSize: 2,
                    join: [
                        {
                            table: departmentTable,
                            localKey: "departmentId",
                            targetKey: "id",
                            newLocalKey: "department",
                        },
                    ],
                }
            )

            expect(page1.hasNext).toBe(true)

            // 第二页
            const page2 = await userTable.listPagingByCursor(
                {},
                {
                    pageSize: 2,
                    cursor: page1.nextCursor,
                    join: [
                        {
                            table: departmentTable,
                            localKey: "departmentId",
                            targetKey: "id",
                            newLocalKey: "department",
                        },
                    ],
                }
            )

            expect(page2.list.length).toBeGreaterThan(0)
            expect((page2.list[0] as any).department).toBeDefined()
        })
    })

    describe("性能优化验证", () => {
        test("批量查询优化 - 避免 N+1 问题", async () => {
            // 创建多个用户指向同一个部门
            await userTable.clear()
            const users = Array.from({ length: 100 }, (_, i) => ({
                id: `user${i}`,
                name: `User${i}`,
                age: 20 + i,
                departmentId: "dept1", // 都指向同一个部门
            }))
            await userTable.insertMany(users)

            const userList = await userTable.findMany({})

            // 应该只查询一次 dept1，而不是 100 次
            await joinListWithTable(userList, [
                {
                    table: departmentTable,
                    localKey: "departmentId",
                    targetKey: "id",
                },
            ])

            // 验证所有用户都正确连接了部门
            expect(userList.every((u) => (u.departmentId as any).name === "Engineering")).toBe(true)
        })

        test("并行执行多个 join 操作", async () => {
            const users = await userTable.findMany({})

            const startTime = Date.now()

            // 多个 join 应该并行执行
            await joinListWithTable(users, [
                {
                    table: departmentTable,
                    localKey: "departmentId",
                    targetKey: "id",
                    newLocalKey: "department",
                },
                {
                    table: categoryTable,
                    localKey: "categoryIds",
                    targetKey: "id",
                    newLocalKey: "categories",
                },
            ])

            const duration = Date.now() - startTime

            // 验证结果正确
            expect((users[0] as any).department).toBeDefined()
            expect((users[0] as any).categories).toBeDefined()

            // 并行执行应该比顺序执行快（这里只是简单验证没有超时）
            expect(duration).toBeLessThan(5000)
        })
    })
})
