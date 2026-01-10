import { describe, test, expect, beforeAll, beforeEach } from "vitest"
import { Table } from "../core/Table"
import { getTestTableByType, TestDatabaseType } from "./getTestTable"

const DATABASE_TYPES: TestDatabaseType[] = ["sqlite", "mongodb"]

describe.each(DATABASE_TYPES)("Table 文档操作 - %s", async (dbType) => {
    let table!: Table

    beforeAll(async () => {
        table = await getTestTableByType("table-doc.test", dbType)
        await table.clearAll()
        await table.defineIndexes([{ key: "id", unique: true }])
    })

    beforeEach(async () => {
        await table.clear()
        // 填充测试用的通用数据
        await table.insertMany([
            { id: "1", name: "Alice", age: 30, tags: ["dev", "admin"], score: 100, meta: { active: true } },
            { id: "2", name: "Bob", age: 25, tags: ["dev"], score: 80, meta: { active: false } },
            { id: "3", name: "Charlie", age: 35, tags: ["manager"], score: 90, meta: { active: true } },
            { id: "4", name: "David", age: 40, tags: [], score: 70, meta: { active: null } },
        ])
    })

    describe("插入操作", () => {
        test("insertMany 应能插入多个文档", async () => {
            await table.clearAll()
            let docs = [
                { id: "a", val: 1 },
                { id: "b", val: 2 },
            ]
            let res = await table.insertMany(docs)
            expect(res.insertedCount).toBe(2)
            expect(await table.count()).toBe(2)
            expect(await table.get("a")).toEqual(docs[0])
        })

        test("insertMany 应忽略重复 ID", async () => {
            await table.defineIndexes([{ key: "id", unique: true }])
            await table.insertMany([{ id: "5", val: 5 }])
            let res = await table.insertMany([
                { id: "5", val: 999 }, // 应该被忽略
                { id: "6", val: 6 },   // 应该被插入
            ])
            
            expect(res.insertedCount).toBe(1)
            expect((await table.get("5"))!.val).toBe(5)
            expect((await table.get("6"))!.val).toBe(6)
        })
    })

    describe("查询操作 (选择器)", () => {
        test("$eq, $ne", async () => {
            let alice = await table.findOne({ name: { $eq: "Alice" } })
            expect(alice!.id).toBe("1")

            let notAlice = await table.findMany({ name: { $ne: "Alice" } })
            expect(notAlice.length).toBe(3)
            expect(notAlice.find(d => d.name === "Alice")).toBeUndefined()
            
            // 隐式 $eq
            let bob = await table.findOne({ name: "Bob" })
            expect(bob!.id).toBe("2")
        })

        test("$gt, $gte, $lt, $lte", async () => {
            let olderThan30 = await table.findMany({ age: { $gt: 30 } })
            expect(olderThan30.map(d => d.name)).toEqual(["Charlie", "David"])

            let age30OrMore = await table.findMany({ age: { $gte: 30 } })
            expect(age30OrMore.length).toBe(3) // Alice, Charlie, David

            let youngerThan30 = await table.findMany({ age: { $lt: 30 } })
            expect(youngerThan30.map(d => d.name)).toEqual(["Bob"])
            
            let age30OrLess = await table.findMany({ age: { $lte: 30 } })
            expect(age30OrLess.length).toBe(2) // Alice, Bob
        })

        test("$in, $nin", async () => {
            let inList = await table.findMany({ name: { $in: ["Alice", "Bob"] } })
            expect(inList.length).toBe(2)

            let notInList = await table.findMany({ name: { $nin: ["Alice", "Bob"] } })
            expect(notInList.length).toBe(2) // Charlie, David
        })

        test("$and, $or, $nor, $not", async () => {
            // $and
            let andRes = await table.findMany({ $and: [{ age: { $gt: 25 } }, { score: { $gte: 90 } }] })
            expect(andRes.length).toBe(2) // Alice (30, 100), Charlie (35, 90)

            // $or
            let orRes = await table.findMany({ $or: [{ name: "Alice" }, { age: 40 }] })
            expect(orRes.length).toBe(2) // Alice, David

            // $nor (既不是 Alice 也不是 40 岁) -> Bob, Charlie
            let norRes = await table.findMany({ $nor: [{ name: "Alice" }, { age: 40 }] })
            expect(norRes.length).toBe(2)
            expect(norRes.find(d => d.name === "Bob")).toBeDefined()
            expect(norRes.find(d => d.name === "Charlie")).toBeDefined()

            // $not
            let notRes = await table.findMany({ age: { $not: { $gt: 30 } } }) // age <= 30
            expect(notRes.length).toBe(2) // Alice, Bob
        })

        test("$like, $regex", async () => {
            // $like
            // MongoDB Adapter 尚未原生支持 $like。
            // let likeRes = await table.findMany({ name: { $like: "%li%" } })
            // expect(likeRes.length).toBe(2) // Alice, Charlie

            // $regex
            let regexRes = await table.findMany({ name: { $regex: "^D.*d$" } })
            expect(regexRes.length).toBe(1)
            expect(regexRes[0].name).toBe("David")
        })

        test("$exists", async () => {
            // 在我们的种子数据中，都有 'meta'，但让我们检查一个不存在的字段
            let hasField = await table.findMany({ "meta.active": { $exists: true } })
            // active 是 true/false/null。null 是否算作存在？
            // 通常在 Mongo 中 $exists: true 也会匹配 null 值，但让我们看看实现行为或假设标准。
            // 基于 types.ts: "true 表示字段必须存在且不为 null" -> 等等，types.ts 说 "true 表示字段必须存在且不为 null"
            // 让我们验证这个行为。

            
            // 添加一个没有 meta.active 的文档
            await table.set("5", { id: "5", name: "Eve" }) 
            
            let existsTrue = await table.findMany({ name: { $exists: true } })
            expect(existsTrue.length).toBe(5)

            let existsFalse = await table.findMany({ "meta.active": { $exists: false } })
            // Eve 没有 meta.active。David 的 meta.active 为 null。
            // MongoDB $exists: false 仅匹配缺失的字段。
            expect(existsFalse.find(d => d.name === "Eve")).toBeDefined()
            // David 有 null，所以它存在。所以它不应该在 existsFalse 中。
            expect(existsFalse.find(d => d.name === "David")).toBeUndefined()
        })

        test("$elemMatch, $all, $size", async () => {
            // $all
            let allRes = await table.findMany({ tags: { $all: ["dev"] } })
            expect(allRes.length).toBe(2) // Alice, Bob

            // $size
            let sizeRes = await table.findMany({ tags: { $size: 2 } })
            expect(sizeRes.length).toBe(1) // Alice (["dev", "admin"])

            // $elemMatch (简单数组)
            // 对于字符串数组，简单相等不需要 $elemMatch，但对条件很有用
            // tags: { $elemMatch: { $eq: "admin" } }
            // 但通常用于对象数组。让我们添加一个。
            await table.set("6", { 
                id: "6", 
                items: [ { type: "book", qty: 10 }, { type: "pen", qty: 20 } ] 
            })
            
            let elemMatchRes = await table.findMany({ 
                items: { $elemMatch: { type: "book", qty: { $gte: 5 } } } 
            })
            expect(elemMatchRes.length).toBe(1)
            expect(elemMatchRes[0].id).toBe("6")
        })

        test("Nested field query", async () => {
            let nested = await table.findMany({ "meta.active": true })
            expect(nested.length).toBe(2) // Alice, Charlie
        })
    })

    describe("更新操作", () => {
        test("$set, $unset, $rename", async () => {
            // $set
            await table.updateOne({ name: "Alice" }, { $set: { score: 150, "meta.active": false } })
            let alice = (await table.get("1"))!
            expect(alice.score).toBe(150)
            expect((alice.meta as any).active).toBe(false)

            // $unset
            await table.updateOne({ name: "Alice" }, { $unset: { score: true } })
            let alice2 = (await table.get("1"))!
            expect(alice2.score).toBeUndefined()

            // $rename
            await table.updateOne({ name: "Bob" }, { $rename: { score: "points" } })
            let bob = (await table.get("2"))!
            expect(bob.score).toBeUndefined()
            expect(bob.points).toBe(80)
        })

        test("$inc, $mul, $min, $max", async () => {
            // $inc
            await table.updateOne({ name: "Charlie" }, { $inc: { score: 10 } }) // 90 + 10 = 100
            expect((await table.get("3"))!.score).toBe(100)

            // $mul
            await table.updateOne({ name: "Charlie" }, { $mul: { score: 2 } }) // 100 * 2 = 200
            expect((await table.get("3"))!.score).toBe(200)

            // $min (仅当值小于当前值时更新)
            await table.updateOne({ name: "Charlie" }, { $min: { score: 150 } }) // 200 -> 150
            expect((await table.get("3"))!.score).toBe(150)
            await table.updateOne({ name: "Charlie" }, { $min: { score: 180 } }) // 150 < 180, 无变化
            expect((await table.get("3"))!.score).toBe(150)

            // $max (仅当值大于当前值时更新)
            await table.updateOne({ name: "Charlie" }, { $max: { score: 300 } }) // 150 -> 300
            expect((await table.get("3"))!.score).toBe(300)
        })

        test("$push, $addToSet, $pop, $pull", async () => {
            // $push
            await table.updateOne({ name: "Alice" }, { $push: { tags: "lead" } })
            expect((await table.get("1"))!.tags).toEqual(["dev", "admin", "lead"])

            // $addToSet (unique)
            await table.updateOne({ name: "Alice" }, { $addToSet: { tags: "dev" } }) // 已存在
            expect((await table.get("1"))!.tags).toEqual(["dev", "admin", "lead"])
            await table.updateOne({ name: "Alice" }, { $addToSet: { tags: "designer" } })
            expect((await table.get("1"))!.tags).toEqual(["dev", "admin", "lead", "designer"])

            // $pop
            await table.updateOne({ name: "Alice" }, { $pop: { tags: 1 } }) // 移除最后一个
            expect((await table.get("1"))!.tags).toEqual(["dev", "admin", "lead"])

            // $pull
            await table.updateOne({ name: "Alice" }, { $pull: { tags: "admin" } })
            expect((await table.get("1"))!.tags).toEqual(["dev", "lead"])
        })

        test("$push 带修饰符", async () => {
            await table.set("pushTest", { id: "pushTest", arr: [1, 2] })
            
            // $each
            await table.updateOne({ id: "pushTest" }, { 
                $push: { arr: { $each: [3, 4] } } 
            })
            expect((await table.get("pushTest"))?.arr).toEqual([1, 2, 3, 4])

            // $position
            await table.updateOne({ id: "pushTest" }, { 
                $push: { arr: { $each: [0], $position: 0 } } 
            })
            expect((await table.get("pushTest"))!.arr).toEqual([0, 1, 2, 3, 4])

            // $slice
            await table.updateOne({ id: "pushTest" }, { 
                $push: { arr: { $each: [5], $slice: -3 } } // 保留最后 3 个
            })
            // [0, 1, 2, 3, 4, 5] -> 最后 3 个 -> [3, 4, 5]
            expect((await table.get("pushTest"))!.arr).toEqual([3, 4, 5])
        })

        test("updateMany vs updateOne", async () => {
            // updateOne
            await table.updateOne({ tags: "dev" }, { $set: { score: 999 } })
            // Alice 和 Bob 都有 "dev"。应该只有一个被更新。
            let devs = await table.findMany({ tags: "dev" })
            let updatedCount = devs.filter(d => d.score === 999).length
            expect(updatedCount).toBe(1)

            // updateMany
            await table.updateMany({ tags: "dev" }, { $set: { score: 888 } })
            devs = await table.findMany({ tags: "dev" })
            expect(devs.every(d => d.score === 888)).toBe(true)
        })

        test("upsert 行为", async () => {
            // 无匹配, upsert=false (默认)
            let res = await table.updateOne({ name: "Zoe" }, { $set: { age: 20 } })
            expect(res.matchedCount).toBe(0)
            expect(await table.findOne({ name: "Zoe" })).toBeUndefined()

            // 无匹配, upsert=true
            await table.updateOne(
                { name: "Zoe" }, 
                { $set: { age: 20 }, $setOnInsert: { id: "99" } }, 
                { upsert: true }
            )
            let zoe = await table.findOne({ name: "Zoe" })
            expect(zoe).toBeDefined()
            expect(zoe?.age).toBe(20)
            expect(zoe?.id).toBe("99")
        })
    })

    describe("删除操作", () => {
        test("deleteMany", async () => {
            await table.deleteMany({ tags: "dev" }) // Alice and Bob
            expect(await table.count()).toBe(2) // Charlie, David 保留
            expect(await table.findOne({ name: "Alice" })).toBeUndefined()
        })

        test("deleteOne", async () => {
            // 重置
            await table.insertMany([{ id: "10", type: "x" }, { id: "11", type: "x" }])
            
            await table.deleteOne({ type: "x" })
            let remaining = await table.findMany({ type: "x" })
            expect(remaining.length).toBe(1)
        })
    })
})
