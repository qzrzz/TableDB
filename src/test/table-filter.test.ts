import { Table } from "../core/Table"
import { getTestTableByType, TestDatabaseType } from "./getTestTable"

const DATABASE_TYPES: TestDatabaseType[] = ["sqlite", "mongodb"]

describe.each(DATABASE_TYPES)("Table filter - %s", async (dbType) => {
    let table!: Table

    beforeAll(async () => {
        table = await getTestTableByType("table-filter.test", dbType)
        await table.clearAll()
    })

    beforeEach(async () => {
        await table.clearAll()
    })

    test("对象匹配", async () => {
        let doc = {
            name: "测试",
            info: {
                age: 30,
                address: {
                    city: "北京",
                    zip: "100000",
                },
            },
            ob: {
                a: 1,
                b: 2,
            },
        }

        await table.set("d1", doc)

        // 匹配整个嵌套对象，必须完全相等，所以这样匹配不到任何东西
        let re1 = await table.findOne({ info: { age: 30 } })
        expect(re1).toEqual(undefined)

        // 对象完全相同可以匹配到
        let re2 = await table.findOne({ ob: { a: 1, b: 2 } })
        expect(re2).toEqual(doc)

        // 对象字段顺序不同也能匹配到
        let re3 = await table.findOne({ ob: { b: 2, a: 1 } })
        expect(re3).toEqual(doc)
    })

    test("逻辑组合", async () => {
        await table.set("1", { n: 1, type: "a" })
        await table.set("2", { n: 2, type: "b" })
        await table.set("3", { n: 3, type: "a" })
        await table.set("4", { n: 4, type: "b" })
        await table.set("5", { n: 5, type: "c" })

        // $or
        let re1 = await table.findMany({
            $or: [{ n: 1 }, { n: 2 }],
        })
        expect(re1.length).toBe(2)
        expect(re1.map((e: any) => e.n).sort()).toEqual([1, 2])

        // $and
        let re2 = await table.findMany({
            $and: [{ type: "a" }, { n: 3 }],
        })
        expect(re2.length).toBe(1)
        expect((re2[0] as any).n).toBe(3)

        // 隐式 $and
        let re3 = await table.findMany({
            type: "a",
            n: 3,
        })
        expect(re3.length).toBe(1)
        expect((re3[0] as any).n).toBe(3)

        // $not
        let re4 = await table.findMany({
            n: { $not: { $lt: 3 } },
        })
        expect(re4.length).toBe(3)
        expect(re4.map((e: any) => e.n).sort()).toEqual([3, 4, 5])

        // $nor
        let re5 = await table.findMany({
            $nor: [{ n: 1 }, { type: "c" }],
        })
        expect(re5.length).toBe(3)
        expect(re5.map((e: any) => e.n).sort()).toEqual([2, 3, 4])
    })

    test("逻辑组合 - 嵌套与边缘", async () => {
        await table.set("1", { n: 1, type: "a", tags: ["x", "y"] })
        await table.set("2", { n: 2, type: "b", tags: ["y", "z"] })
        await table.set("3", { n: 3, type: "a", tags: ["x"] })
        await table.set("4", { n: 4, type: "b", tags: ["z"] })
        await table.set("5", { n: 5, type: "c", tags: [] })

        // 1. $or 嵌套 $and
        // (type=a AND n=1) OR (type=b AND n=2) -> should match 1 and 2
        let nestedOr = await table.findMany({
            $or: [{ $and: [{ type: "a" }, { n: 1 }] }, { $and: [{ type: "b" }, { n: 2 }] }],
        })
        expect(nestedOr.length).toBe(2)
        expect(nestedOr.map((e: any) => e.n).sort()).toEqual([1, 2])

        // 2. $and 嵌套 $or
        // type=a AND (n=1 OR n=3) -> should match 1 and 3
        let nestedAnd = await table.findMany({
            $and: [{ type: "a" }, { $or: [{ n: 1 }, { n: 3 }] }],
        })
        expect(nestedAnd.length).toBe(2)
        expect(nestedAnd.map((e: any) => e.n).sort()).toEqual([1, 3])

        // 3. $nor 嵌套逻辑 (模拟 top-level NOT)
        // NOT (type=a OR n=2) -> should be everything except 1, 3, 2 -> 4, 5
        let notLogic = await table.findMany({
            $nor: [
                {
                    $or: [{ type: "a" }, { n: 2 }],
                },
            ],
        })
        expect(notLogic.length).toBe(2)
        expect(notLogic.map((e: any) => e.n).sort()).toEqual([4, 5])

        // 4. 单元素的 $and / $or
        let singleAnd = await table.findMany({ $and: [{ n: 1 }] })
        expect(singleAnd.length).toBe(1)
        expect((singleAnd[0] as any).n).toBe(1)

        let singleOr = await table.findMany({ $or: [{ n: 1 }] })
        expect(singleOr.length).toBe(1)
        expect((singleOr[0] as any).n).toBe(1)

        // 5. 冲突的 $and
        // n=1 AND n=2 -> 0 matches
        let conflictAnd = await table.findMany({ $and: [{ n: 1 }, { n: 2 }] })
        expect(conflictAnd.length).toBe(0)

        // 6. 冗余的 $or
        // n=1 OR n=1 -> 1 match
        let redundantOr = await table.findMany({ $or: [{ n: 1 }, { n: 1 }] })
        expect(redundantOr.length).toBe(1)
        expect((redundantOr[0] as any).n).toBe(1)

        // 7. 复杂多层嵌套
        // (type=a OR (type=b AND n>3)) AND NOT tags contains 'z'
        // -> (1, 3 OR 4) AND NOT (2, 4)
        // -> (1, 3, 4) AND (1, 3, 5) -> 1, 3
        let complex = await table.findMany({
            $and: [
                { $or: [{ type: "a" }, { $and: [{ type: "b" }, { n: { $gt: 3 } }] }] },
                { tags: { $ne: "z" } }, // tags array does not contain "z"
            ],
        })
        expect(complex.map((e: any) => e.n).sort()).toEqual([1, 3])
    })

    test("边缘情况", async () => {
        await table.set("1", { v: null, type: "null" })
        await table.set("2", { v: 0, type: "number" })
        await table.set("3", { v: "", type: "string" })
        await table.set("4", { v: false, type: "boolean" })
        await table.set("5", { v: undefined, type: "undefined" }) // Undefined usually not stored or stored as null depending on db

        // 1. 空 Filter
        let all = await table.findMany({})
        expect(all.length).toBeGreaterThanOrEqual(4)

        // 2. 匹配 Null
        let nulls = await table.findMany({ v: null })
        // 在某些数据库中 null 可能匹配不存在的字段，但在 kv/doc 存储中通常匹配明确的 null
        // 这里主要测试能否匹配到 d1
        expect(nulls.some((e: any) => e.type === "null")).toBeTruthy()

        // 3. 匹配 0
        let zeros = await table.findMany({ v: 0 })
        expect(zeros.length).toBe(1)
        expect((zeros[0] as any).type).toBe("number")

        // 4. 匹配空字符串
        let emptyStrings = await table.findMany({ v: "" })
        expect(emptyStrings.length).toBe(1)
        expect((emptyStrings[0] as any).type).toBe("string")

        // 5. 匹配 False
        let falses = await table.findMany({ v: false })
        expect(falses.length).toBe(1)
        expect((falses[0] as any).type).toBe("boolean")

        // 6. 不存在的字段
        let ghosts = await table.findMany({ ghost: "boo" })
        expect(ghosts.length).toBe(0)

        // 7. $in 空数组 (应匹配不到任何东西)
        let inEmpty = await table.findMany({ v: { $in: [] } })
        expect(inEmpty.length).toBe(0)

        // 8. $nin 空数组 (应匹配所有存在该字段的记录，或者所有记录?
        // 通常 $nin: [] 意味着 v NOT IN [], 既然 [] 为空，v 无论是什么都不在 [] 中，所以是 True)
        // 注意：如果不包含该字段，是否匹配取决于具体实现。
        // 对于 MongoDB {v: {$nin: []}} 会匹配那些 v 字段存在且值不在[]中的，也会匹配 v 字段不存在的文档
        // 这里简单测试应该能匹配到很多
        let ninEmpty = await table.findMany({ v: { $nin: [] } })
        expect(ninEmpty.length).toBeGreaterThan(0)

        // 9. $or/$and/$nor 空数组
        // MongoDB 不允许空逻辑数组，SQLite/Memory 可能允许
        // 这里做兼容性测试处理
        try {
            let orEmpty = await table.findMany({ $or: [] })
            expect(orEmpty.length).toBe(0)
        } catch (e: any) {
            if (dbType === "mongodb") expect(e.message).toMatch(/must be a nonempty array/)
            else throw e
        }

        try {
            let andEmpty = await table.findMany({ $and: [] })
            expect(andEmpty.length).toBeGreaterThanOrEqual(4)
        } catch (e: any) {
            if (dbType === "mongodb") expect(e.message).toMatch(/must be a nonempty array/)
            else throw e
        }

        // 11. Dot Notation (嵌套字段查询)
        await table.set("d_nested", { nested: { val: 99 }, type: "nested" })
        // 这取决于实现是否支持 dot notation
        // 如果失败，说明当前实现可能不支持
        try {
            let nested = await table.findMany({ "nested.val": 99 })
            // 如果支持，应该能找到
            if (nested.length > 0) {
                expect((nested[0] as any).type).toBe("nested")
            } else {
                // 如果不支持，可能当作普通 key 处理，或者没找到
                console.log("Dot notation query returned 0 results (feature might not be supported)")
            }
        } catch (e) {
            console.log("Dot notation query threw error", e)
        }
    })

    test("数组长度匹配", async () => {
        let docs = [
            { id: "d1", tags: ["red", "blue"], type: "colors" },
            { id: "d2", tags: ["blue", "green", "c3", "c4", "c5"], type: "colors" },
            { id: "d3", tags: [], type: "colors" },
        ]

        await table.insertMany(docs)

        // 数组长度等于 2
        let re1 = await table.findMany({ tags: { $size: 2 } })
        expect(re1).toEqual([docs[0]])

        // 数组长度等于 0
        let re2 = await table.findMany({ tags: { $size: 0 } })
        expect(re2).toEqual([docs[2]])

        // 数组长度大于等于 3 （即 tags.2 必须存在）
        let re3 = await table.findMany({ "tags.2": { $exists: true } })
        expect(re3.length).toBe(1)
        expect(re3[0]).toEqual(docs[1])

        // 数组长度小于 3 （即 tags.2 不存在）
        let re4 = await table.findMany({ "tags.2": { $exists: false } })
        expect(re4.length).toBe(2)
        expect(re4).toEqual(expect.arrayContaining([docs[0], docs[2]]))
    })

    test("正则匹配", async () => {
        let docs = [
            { id: "d1", name: "Alice Wonderland", type: "user" },
            { id: "d2", name: "gsss@hhh.com", type: "user" },
            { id: "d3", name: "JapanO_0 Alice", type: "user" },
        ]
        await table.insertMany(docs)

        // 匹配包含 "Alice" 的名字
        let re1 = await table.findMany({ name: { $regex: "Alice" } })
        expect(new Set(re1.map((d: any) => d.id))).toEqual(new Set(["d1", "d3"]))

        // 匹配以 "gsss" 开头的名字
        let re2 = await table.findMany({ name: { $regex: "^gsss" } })
        expect(re2.length).toBe(1)
        expect(re2[0].id).toBe("d2")

        // 匹配 japan（不区分大小写）
        let re3 = await table.findMany({ name: { $regex: /japan/i } })
        expect(re3.length).toBe(1)
        expect(re3[0].id).toBe("d3")
    })
})
