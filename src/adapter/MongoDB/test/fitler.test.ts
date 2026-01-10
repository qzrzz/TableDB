import { ITableDBAdapterInstance } from "../../adapter"
import { getTestAdapter } from "./getTestMongo"

describe("filter 详尽测试", () => {
    let adapter!: ITableDBAdapterInstance

    beforeAll(async () => {
        adapter = await getTestAdapter("filterTestTable")
    })

    beforeEach(async () => {
        await adapter.clear()
    })

    describe("ITableFilter", () => {
        beforeEach(async () => {
            await adapter.insertMany([
                {
                    id: "1",
                    name: "Alice",
                    age: 20,
                    tags: ["a", "b"],
                    score: 85,
                    meta: { city: "Beijing" },
                    date: new Date("2023-01-01"),
                },
                {
                    id: "2",
                    name: "Bob",
                    age: 25,
                    tags: ["b", "c"],
                    score: 90,
                    meta: { city: "Shanghai" },
                    date: new Date("2023-02-01"),
                },
                {
                    id: "3",
                    name: "Charlie",
                    age: 30,
                    tags: ["a", "c"],
                    score: 95,
                    meta: { city: "Beijing" },
                    date: new Date("2023-03-01"),
                },
                { id: "4", name: "David", age: 35, tags: ["d"], score: 80, date: new Date("2023-04-01") },
            ])
        })

        test("基础比较操作符 ($eq, $ne, $gt, $gte, $lt, $lte)", async () => {
            // $eq (隐式)
            expect((await adapter.findMany({ age: 25 })).length).toBe(1)
            // $ne
            expect((await adapter.findMany({ age: { $ne: 25 } })).length).toBe(3)
            // $gt
            expect((await adapter.findMany({ age: { $gt: 25 } })).length).toBe(2)
            // $gte
            expect((await adapter.findMany({ age: { $gte: 25 } })).length).toBe(3)
            // $lt
            expect((await adapter.findMany({ age: { $lt: 25 } })).length).toBe(1)
            // $lte
            expect((await adapter.findMany({ age: { $lte: 25 } })).length).toBe(2)
        })

        test("集合操作符 ($in, $nin)", async () => {
            expect((await adapter.findMany({ age: { $in: [20, 30] } })).length).toBe(2)
            expect((await adapter.findMany({ age: { $nin: [20, 30] } })).length).toBe(2)
        })

        test("逻辑组合 ($and, $or, $nor, $not)", async () => {
            // $and
            expect((await adapter.findMany({ $and: [{ age: { $gt: 20 } }, { score: { $lt: 95 } }] })).length).toBe(2)
            // $or
            expect((await adapter.findMany({ $or: [{ age: 20 }, { age: 35 }] })).length).toBe(2)
            // $nor
            expect((await adapter.findMany({ $nor: [{ age: 20 }, { age: 25 }] })).length).toBe(2)
            // $not
            expect((await adapter.findMany({ age: { $not: { $gte: 30 } } })).length).toBe(2)
        })

        test("元素与数组操作符 ($exists, $all, $elemMatch, $size)", async () => {
            // $exists
            expect((await adapter.findMany({ "meta.city": { $exists: true } })).length).toBe(3)
            expect((await adapter.findMany({ "meta.city": { $exists: false } })).length).toBe(1)
            // $all
            expect((await adapter.findMany({ tags: { $all: ["a", "b"] } })).length).toBe(1)
            // $size
            expect((await adapter.findMany({ tags: { $size: 2 } })).length).toBe(3)
            // $elemMatch (简单数组)
            expect((await adapter.findMany({ tags: { $elemMatch: { $eq: "a" } } })).length).toBe(2)
        })

        test("正则匹配 ($regex)", async () => {
            expect((await adapter.findMany({ name: { $regex: "^A" } })).length).toBe(1)
            expect((await adapter.findMany({ name: { $regex: "i", $options: "i" } })).length).toBe(3) // Alice, Charlie, David
        })

        test("嵌套对象与特殊类型匹配", async () => {
            // 嵌套路径
            expect((await adapter.findMany({ "meta.city": "Beijing" })).length).toBe(2)
            // Date 类型
            expect((await adapter.findMany({ date: { $gt: new Date("2023-02-15") } })).length).toBe(2)
        })
    })

    describe("更新操作 (ITableUpdateOp) 全覆盖", () => {
        beforeEach(async () => {
            await adapter.set("u1", { id: "u1", val: 10, tags: ["old"], meta: { a: 1 } })
        })

        test("字段更新算子 ($set, $unset, $inc, $mul, $min, $max, $rename)", async () => {
            // $set & $inc
            await adapter.updateOne({ id: "u1" }, { $set: { name: "new" }, $inc: { val: 5 } })
            let res = await adapter.get("u1")
            expect(res?.name).toBe("new")
            expect(res?.val).toBe(15)

            // $mul
            await adapter.updateOne({ id: "u1" }, { $mul: { val: 2 } })
            expect((await adapter.get("u1"))?.val).toBe(30)

            // $min / $max
            await adapter.updateOne({ id: "u1" }, { $min: { val: 20 } })
            expect((await adapter.get("u1"))?.val).toBe(20)
            await adapter.updateOne({ id: "u1" }, { $max: { val: 50 } })
            expect((await adapter.get("u1"))?.val).toBe(50)

            // $unset
            await adapter.updateOne({ id: "u1" }, { $unset: { name: true } })
            expect((await adapter.get("u1"))?.name).toBeUndefined()

            // $rename
            await adapter.updateOne({ id: "u1" }, { $rename: { val: "newVal" } })
            res = await adapter.get("u1")
            expect(res?.val).toBeUndefined()
            expect(res?.newVal).toBe(50)
        })

        test("数组更新算子 ($push, $pop, $pull, $addToSet)", async () => {
            // $push
            await adapter.updateOne({ id: "u1" }, { $push: { tags: "new" } })
            expect((await adapter.get("u1"))?.tags).toContain("new")

            // $addToSet
            await adapter.updateOne({ id: "u1" }, { $addToSet: { tags: "new" } })
            expect(((await adapter.get("u1")) as any)?.tags?.length).toBe(2) // 不重复添加

            // $pop
            await adapter.updateOne({ id: "u1" }, { $pop: { tags: 1 } }) // 移除最后一个
            expect((await adapter.get("u1"))?.tags).not.toContain("new")

            // $pull
            await adapter.updateOne({ id: "u1" }, { $pull: { tags: "old" } })
            expect(((await adapter.get("u1")) as any)?.tags?.length).toBe(0)
        })
    })

    describe("返回值验证", () => {
        test("updateMany 返回值", async () => {
            await adapter.insertMany([
                { id: "r1", type: "a", v: 1 },
                { id: "r2", type: "a", v: 2 },
                { id: "r3", type: "b", v: 3 },
            ])

            const res = await adapter.updateMany({ type: "a" }, { $inc: { v: 10 } })
            expect(res.matchedCount).toBe(2)
            expect(res.modifiedCount).toBe(2)
        })

        test("deleteOne / deleteMany 返回值", async () => {
            await adapter.insertMany([
                { id: "d1", x: 1 },
                { id: "d2", x: 1 },
            ])

            const res1 = await adapter.deleteOne({ x: 1 })
            expect(res1.deletedCount).toBe(1)

            const res2 = await adapter.deleteMany({ x: 1 })
            expect(res2.deletedCount).toBe(1)
        })

        test("upsert 行为与返回值", async () => {
            const res = await adapter.updateOne({ id: "non-existent" }, { $set: { data: "new" } }, { upsert: true })
            expect(res.matchedCount).toBe(0)
            expect(await adapter.has("non-existent")).toBe(true)
            expect((await adapter.get("non-existent"))?.data).toBe("new")
        })
    })

    describe("边缘情况与特殊类型", () => {
        test("空过滤器 (匹配所有)", async () => {
            await adapter.insertMany([{ id: "e1" }, { id: "e2" }])
            expect((await adapter.findMany({})).length).toBe(2)
        })

        test("对不存在的字段进行操作", async () => {
            // 查询不存在字段
            expect((await adapter.findMany({ nonExistent: "foo" })).length).toBe(0)
            // 更新不存在字段 (会创建该字段)
            await adapter.set("e3", { id: "e3" })
            await adapter.updateOne({ id: "e3" }, { $set: { newField: 123 } })
            expect((await adapter.get("e3"))?.newField).toBe(123)
        })

        test("BigInt 过滤", async () => {
            const big = BigInt("900719925474099123456")
            await adapter.set("big1", { id: "big1", val: big })
            const found = await adapter.findOne({ val: big })
            expect(found).toBeDefined()
            expect(found?.id).toBe("big1")

            const notFound = await adapter.findOne({ val: big + 1n })
            expect(notFound).toBeUndefined()
        })

        test("深度嵌套对象匹配", async () => {
            await adapter.set("nest1", { id: "nest1", a: { b: { c: { d: 1 } } } })
            expect(await adapter.findOne({ "a.b.c.d": 1 })).toBeDefined()
            expect(await adapter.findOne({ "a.b.c.d": 2 })).toBeUndefined()
        })
    })
})
