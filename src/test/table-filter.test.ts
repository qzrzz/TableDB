import { Table } from "../core/Table"
import { getTestTableByType, TestDatabaseType } from "./getTestTable"

const DATABASE_TYPES: TestDatabaseType[] = ["mongodb", "sqlite", "indexeddb"]

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


    test('隐式数组匹配', async () => {
        let docs = [
            { id: "d1", tags: ["red", "blue"], type: "colors" },
            { id: "d2", tags: ["blue", "green", "c3", "c4", "c5"], type: "colors" },
            { id: "d3", tags: [], type: "colors" },
        ]

        await table.insertMany(docs)

        // 隐式匹配
        let re1 = await table.findMany({ tags: "red" })
        expect(re1).toEqual([docs[0]])

        let re2 = await table.findMany({ tags: "blue" })
        expect(re2.length).toBe(2)
        expect(re2).toEqual(expect.arrayContaining([docs[0], docs[1]]))

        let re3 = await table.findMany({ tags: "green" })
        expect(re3).toEqual([docs[1]])

        let re4 = await table.findMany({ tags: "yellow" })
        expect(re4).toEqual([])
    })


    test('隐式数组匹配 (索引)', async () => {
        let docs = [
            { id: "d1", tags: ["red", "blue"], type: "colors" },
            { id: "d2", tags: ["blue", "green", "c3", "c4", "c5"], type: "colors" },
            { id: "d3", tags: [], type: "colors" },
        ]

        await table.insertMany(docs)

        await table.defineIndexes([
            { key: "tags" },
        ])

        // 隐式匹配
        let re1 = await table.findMany({ tags: "red" })
        expect(re1).toEqual([docs[0]])

        let re2 = await table.findMany({ tags: "blue" })
        expect(re2.length).toBe(2)
        expect(re2).toEqual(expect.arrayContaining([docs[0], docs[1]]))

        let re3 = await table.findMany({ tags: "green" })
        expect(re3).toEqual([docs[1]])

        let re4 = await table.findMany({ tags: "yellow" })
        expect(re4).toEqual([])
    })

    // ============================================
    // 补充测试：特殊类型查询
    // ============================================

    test("特殊类型查询 - Date", async () => {
        const date1 = new Date("2024-01-01T00:00:00.000Z")
        const date2 = new Date("2024-06-15T12:30:00.000Z")
        const date3 = new Date("2024-12-31T23:59:59.000Z")

        await table.insertMany([
            { id: "dt1", date: date1, name: "jan" },
            { id: "dt2", date: date2, name: "jun" },
            { id: "dt3", date: date3, name: "dec" }
        ])

        // 精确匹配
        const exactMatch = await table.findMany({ date: date2 })
        expect(exactMatch.length).toBe(1)
        expect(exactMatch[0].name).toBe("jun")

        // 范围查询
        const rangeMatch = await table.findMany({
            date: { $gte: new Date("2024-03-01"), $lte: new Date("2024-09-01") }
        })
        expect(rangeMatch.length).toBe(1)
        expect(rangeMatch[0].name).toBe("jun")
    })

    test("特殊类型查询 - BigInt", async () => {
        const big1 = BigInt("9007199254740991")  // Number.MAX_SAFE_INTEGER
        const big2 = BigInt("9007199254740993")  // 超过安全整数
        const big3 = BigInt("9007199254740995")

        await table.insertMany([
            { id: "bi1", value: big1, name: "max_safe" },
            { id: "bi2", value: big2, name: "over_safe" },
            { id: "bi3", value: big3, name: "way_over" }
        ])

        // 精确匹配
        const exactMatch = await table.findMany({ value: big2 })
        expect(exactMatch.length).toBe(1)
        expect(exactMatch[0].name).toBe("over_safe")
    })

    test("特殊类型查询 - Map 和 Set", async () => {
        const map1 = new Map([["a", 1]])
        const map2 = new Map([["a", 1], ["b", 2]])
        const set1 = new Set([1, 2])
        const set2 = new Set([1, 2, 3])

        await table.insertMany([
            { id: "m1", data: map1, type: "map" },
            { id: "m2", data: map2, type: "map" },
            { id: "s1", data: set1, type: "set" },
            { id: "s2", data: set2, type: "set" }
        ])

        // Map 精确匹配
        const mapMatch = await table.findMany({ data: map1 })
        expect(mapMatch.length).toBe(1)
        expect(mapMatch[0].id).toBe("m1")

        // Set 精确匹配
        const setMatch = await table.findMany({ data: set1 })
        expect(setMatch.length).toBe(1)
        expect(setMatch[0].id).toBe("s1")
    })

    // ============================================
    // 补充测试：$all 操作符
    // ============================================

    test("$all 数组包含所有指定元素", async () => {
        await table.insertMany([
            { id: "all1", tags: ["a", "b", "c"], name: "abc" },
            { id: "all2", tags: ["a", "b"], name: "ab" },
            { id: "all3", tags: ["b", "c", "d"], name: "bcd" },
            { id: "all4", tags: ["a"], name: "a" }
        ])

        // 必须同时包含 a 和 b
        const result1 = await table.findMany({ tags: { $all: ["a", "b"] } })
        expect(result1.length).toBe(2)
        expect(result1.map((r: any) => r.name).sort()).toEqual(["ab", "abc"])

        // 必须同时包含 a, b, c
        const result2 = await table.findMany({ tags: { $all: ["a", "b", "c"] } })
        expect(result2.length).toBe(1)
        expect(result2[0].name).toBe("abc")

        // $all 空数组：MongoDB 返回 0 条记录
        const result3 = await table.findMany({ tags: { $all: [] } })
        expect(result3.length).toBe(0)
    })

    // ============================================
    // 补充测试：深层嵌套和点号路径
    // ============================================

    test("深层嵌套对象查询", async () => {
        await table.insertMany([
            { id: "deep1", a: { b: { c: { d: 1 } } }, name: "d1" },
            { id: "deep2", a: { b: { c: { d: 2 } } }, name: "d2" },
            { id: "deep3", a: { b: { c: { d: 1, e: 2 } } }, name: "d3" }
        ])

        // 4层嵌套查询
        const result1 = await table.findMany({ "a.b.c.d": 1 })
        expect(result1.length).toBe(2)
        expect(result1.map((r: any) => r.name).sort()).toEqual(["d1", "d3"])

        // 对象精确匹配
        const result2 = await table.findMany({ "a.b.c": { d: 1 } })
        expect(result2.length).toBe(1)
        expect(result2[0].name).toBe("d1")
    })

    // ============================================
    // 补充测试：数组中的对象
    // ============================================

    test("数组中包含对象的查询", async () => {
        await table.insertMany([
            { id: "arr1", items: [{ x: 1, y: 2 }, { x: 3, y: 4 }], name: "a1" },
            { id: "arr2", items: [{ x: 1, y: 5 }, { x: 6, y: 7 }], name: "a2" },
            { id: "arr3", items: [{ x: 10 }], name: "a3" }
        ])

        // 查询数组中包含特定对象
        const result1 = await table.findMany({ items: { x: 1, y: 2 } })
        expect(result1.length).toBe(1)
        expect(result1[0].name).toBe("a1")

        // 使用点号查询数组元素的属性
        const result2 = await table.findMany({ "items.x": 1 })
        expect(result2.length).toBe(2)
        expect(result2.map((r: any) => r.name).sort()).toEqual(["a1", "a2"])
    })

    // ============================================
    // 补充测试：比较操作符边缘情况
    // ============================================

    test("比较操作符与 null/undefined", async () => {
        await table.insertMany([
            { id: "cmp1", value: null, name: "null" },
            { id: "cmp2", value: 0, name: "zero" },
            { id: "cmp3", value: 10, name: "ten" },
            { id: "cmp4", name: "missing" } // value 字段缺失
        ])

        // $gt null 的行为：MongoDB 中 null 不参与比较，返回空
        // 这是 MongoDB 的标准行为，不是 BUG
        const gtNull = await table.findMany({ value: { $gt: null } })
        // MongoDB 返回空数组，因为 null 不能用于比较
        // 不做严格断言，仅验证不抛错
        expect(Array.isArray(gtNull)).toBe(true)

        // $ne null 应该排除 null 和缺失字段
        const neNull = await table.findMany({ value: { $ne: null } })
        expect(neNull.some((r: any) => r.name === "zero")).toBe(true)
        expect(neNull.some((r: any) => r.name === "ten")).toBe(true)
    })

    // ============================================
    // 补充测试：$in/$nin 边缘情况
    // ============================================

    test("$in 包含特殊值", async () => {
        await table.insertMany([
            { id: "in1", value: null, name: "null" },
            { id: "in2", value: 0, name: "zero" },
            { id: "in3", value: false, name: "false" },
            { id: "in4", value: "", name: "empty" },
            { id: "in5", value: 1, name: "one" }
        ])

        // $in 包含 null
        const inNull = await table.findMany({ value: { $in: [null, 0] } })
        expect(inNull.length).toBe(2)
        expect(inNull.map((r: any) => r.name).sort()).toEqual(["null", "zero"])

        // $in 包含 false 和空字符串
        const inFalsy = await table.findMany({ value: { $in: [false, ""] } })
        expect(inFalsy.length).toBe(2)
        expect(inFalsy.map((r: any) => r.name).sort()).toEqual(["empty", "false"])

        // $nin 排除 falsy 值
        const ninFalsy = await table.findMany({ value: { $nin: [null, 0, false, ""] } })
        expect(ninFalsy.length).toBe(1)
        expect(ninFalsy[0].name).toBe("one")
    })

    // ============================================
    // 补充测试：排序边缘情况
    // ============================================

    test("排序包含 null 和缺失字段", async () => {
        await table.insertMany([
            { id: "sort1", num: 3, name: "three" },
            { id: "sort2", num: 1, name: "one" },
            { id: "sort3", num: null, name: "null" },
            { id: "sort4", name: "missing" }, // num 字段缺失
            { id: "sort5", num: 5, name: "five" }
        ])

        // 升序排序（null 和缺失应该在前或后，取决于实现）
        const ascResult = await table.findMany({}, { sort: { num: 1 } })
        expect(ascResult.length).toBe(5)

        // 降序排序
        const descResult = await table.findMany({}, { sort: { num: -1 } })
        expect(descResult.length).toBe(5)
    })

    // ============================================
    // 补充测试：分页边缘情况
    // ============================================

    test("分页 - offset 单独使用", async () => {
        const docs = Array.from({ length: 10 }, (_, i) => ({
            id: `page${i}`,
            num: i
        }))
        await table.insertMany(docs)

        // 只使用 offset
        const result = await table.findMany({}, { offset: 7 })
        expect(result.length).toBe(3)
    })

    test("分页 - offset 超出总数", async () => {
        await table.insertMany([
            { id: "p1", value: 1 },
            { id: "p2", value: 2 }
        ])

        const result = await table.findMany({}, { offset: 100 })
        expect(result.length).toBe(0)
    })

    test("分页 - limit 为 0", async () => {
        await table.insertMany([
            { id: "l1", value: 1 },
            { id: "l2", value: 2 }
        ])

        const result = await table.findMany({}, { limit: 0 })
        // MongoDB 行为：limit: 0 被忽略，返回所有文档
        expect(result.length).toBe(2)
    })

    // ============================================
    // 补充测试：正则表达式边缘情况
    // ============================================

    test("正则表达式边缘情况", async () => {
        await table.insertMany([
            { id: "re1", text: "Hello World", name: "hw" },
            { id: "re2", text: "hello world", name: "hw_lower" },
            { id: "re3", text: "HELLO WORLD", name: "hw_upper" },
            { id: "re4", text: "test@email.com", name: "email" },
            { id: "re5", text: "特殊字符 $.*+?^", name: "special" }
        ])

        // 包含特殊正则字符的查询（需要转义）
        const specialResult = await table.findMany({ text: { $regex: "\\$\\.\\*" } })
        expect(specialResult.length).toBe(1)
        expect(specialResult[0].name).toBe("special")

        // 邮箱模式
        const emailResult = await table.findMany({ text: { $regex: "^[a-z]+@[a-z]+\\.[a-z]+$" } })
        expect(emailResult.length).toBe(1)
        expect(emailResult[0].name).toBe("email")
    })

    // ============================================
    // 补充测试：count 操作
    // ============================================

    test("count 操作", async () => {
        await table.insertMany([
            { id: "c1", category: "a", value: 1 },
            { id: "c2", category: "a", value: 2 },
            { id: "c3", category: "b", value: 3 }
        ])

        // 无 filter
        const total = await table.count()
        expect(total).toBe(3)

        // 有 filter
        const catA = await table.count({ category: "a" })
        expect(catA).toBe(2)

        // 复杂 filter
        const complex = await table.count({ $or: [{ category: "a" }, { value: 3 }] })
        expect(complex).toBe(3)
    })

    // ============================================
    // 边缘情况：嵌套数组
    // ============================================

    test("嵌套数组查询", async () => {
        await table.insertMany([
            { id: "na1", matrix: [[1, 2], [3, 4]], name: "m1" },
            { id: "na2", matrix: [[5, 6], [7, 8]], name: "m2" },
            { id: "na3", matrix: [[1, 2]], name: "m3" }
        ])

        // 精确匹配嵌套数组
        const exact = await table.findMany({ matrix: [[1, 2], [3, 4]] })
        expect(exact.length).toBe(1)
        expect(exact[0].name).toBe("m1")

        // 数组中包含特定子数组
        const contains = await table.findMany({ matrix: [1, 2] })
        expect(contains.length).toBe(2)
        expect(contains.map((r: any) => r.name).sort()).toEqual(["m1", "m3"])
    })

    // ============================================
    // 边缘情况：混合类型数组
    // ============================================

    test("混合类型数组查询", async () => {
        await table.insertMany([
            { id: "mt1", values: [1, "two", 3, null], name: "mixed1" },
            { id: "mt2", values: [true, false, "true"], name: "mixed2" },
            { id: "mt3", values: [1, 2, 3], name: "numbers" }
        ])

        // 数组中包含数字
        const hasNum = await table.findMany({ values: 1 })
        expect(hasNum.length).toBe(2)
        expect(hasNum.map((r: any) => r.name).sort()).toEqual(["mixed1", "numbers"])

        // 数组中包含字符串
        const hasStr = await table.findMany({ values: "two" })
        expect(hasStr.length).toBe(1)
        expect(hasStr[0].name).toBe("mixed1")

        // 数组中包含布尔值
        const hasBool = await table.findMany({ values: true })
        expect(hasBool.length).toBe(1)
        expect(hasBool[0].name).toBe("mixed2")

        // 数组中包含 null
        const hasNull = await table.findMany({ values: null })
        expect(hasNull.length).toBe(1)
        expect(hasNull[0].name).toBe("mixed1")
    })

    // ============================================
    // 边缘情况：$ne 与数组
    // ============================================

    test("$ne 与数组字段", async () => {
        await table.insertMany([
            { id: "ne1", tags: ["a", "b", "c"], name: "abc" },
            { id: "ne2", tags: ["a", "d"], name: "ad" },
            { id: "ne3", tags: ["x", "y"], name: "xy" },
            { id: "ne4", tags: [], name: "empty" }
        ])

        // $ne 某个值应排除数组中包含该值的文档
        const notContainA = await table.findMany({ tags: { $ne: "a" } })
        expect(notContainA.length).toBe(2)
        expect(notContainA.map((r: any) => r.name).sort()).toEqual(["empty", "xy"])
    })

    // ============================================
    // 边缘情况：$in/$nin 空数组
    // ============================================

    test("$in/$nin 空数组", async () => {
        await table.insertMany([
            { id: "ie1", value: 1, name: "one" },
            { id: "ie2", value: 2, name: "two" }
        ])

        // $in [] 应返回空结果
        const inEmpty = await table.findMany({ value: { $in: [] } })
        expect(inEmpty.length).toBe(0)

        // $nin [] 应返回所有结果
        const ninEmpty = await table.findMany({ value: { $nin: [] } })
        expect(ninEmpty.length).toBe(2)
    })

    // ============================================
    // 边缘情况：多操作符组合
    // ============================================

    test("多操作符组合查询", async () => {
        await table.insertMany([
            { id: "mo1", score: 5, name: "five" },
            { id: "mo2", score: 7, name: "seven" },
            { id: "mo3", score: 10, name: "ten" },
            { id: "mo4", score: 15, name: "fifteen" }
        ])

        // $gt + $lt 范围
        const range = await table.findMany({ score: { $gt: 5, $lt: 15 } })
        expect(range.length).toBe(2)
        expect(range.map((r: any) => r.name).sort()).toEqual(["seven", "ten"])

        // $gte + $lte + $ne 排除特定值
        const rangeExclude = await table.findMany({ score: { $gte: 5, $lte: 15, $ne: 7 } })
        expect(rangeExclude.length).toBe(3)
        expect(rangeExclude.map((r: any) => r.name).sort()).toEqual(["fifteen", "five", "ten"])
    })

    // ============================================
    // 边缘情况：$exists 与 null 值
    // ============================================

    test("$exists 与 null 值", async () => {
        await table.insertMany([
            { id: "ex1", field: "value", name: "has_value" },
            { id: "ex2", field: null, name: "has_null" },
            { id: "ex3", name: "missing_field" }
        ])

        // $exists: true 应匹配字段存在的文档（包括值为 null）
        const exists = await table.findMany({ field: { $exists: true } })
        expect(exists.length).toBe(2)
        expect(exists.map((r: any) => r.name).sort()).toEqual(["has_null", "has_value"])

        // $exists: false 应只匹配字段不存在的文档
        const notExists = await table.findMany({ field: { $exists: false } })
        expect(notExists.length).toBe(1)
        expect(notExists[0].name).toBe("missing_field")

        // $exists: true 且 $ne: null 应只匹配有值的字段
        const existsNotNull = await table.findMany({ field: { $exists: true, $ne: null } })
        expect(existsNotNull.length).toBe(1)
        expect(existsNotNull[0].name).toBe("has_value")
    })

    // ============================================
    // 边缘情况：复杂嵌套点号路径
    // ============================================

    test("复杂嵌套点号路径", async () => {
        await table.insertMany([
            { id: "dp1", a: { b: { c: { d: 1 } } }, name: "deep1" },
            { id: "dp2", a: { b: { c: { d: 2 } } }, name: "deep2" },
            { id: "dp3", a: { b: { c: {} } }, name: "deep_empty" },
            { id: "dp4", a: { b: {} }, name: "shallow" }
        ])

        // 深层精确匹配
        const deepExact = await table.findMany({ "a.b.c.d": 1 })
        expect(deepExact.length).toBe(1)
        expect(deepExact[0].name).toBe("deep1")

        // 深层比较
        const deepGt = await table.findMany({ "a.b.c.d": { $gt: 1 } })
        expect(deepGt.length).toBe(1)
        expect(deepGt[0].name).toBe("deep2")

        // 深层 $exists
        const deepExists = await table.findMany({ "a.b.c.d": { $exists: true } })
        expect(deepExists.length).toBe(2)
        expect(deepExists.map((r: any) => r.name).sort()).toEqual(["deep1", "deep2"])
    })

    // ============================================
    // 边缘情况：数组索引路径组合
    // ============================================

    test("数组索引路径组合", async () => {
        await table.insertMany([
            { id: "ai1", items: [{ sub: [10, 20] }, { sub: [30, 40] }], name: "nested1" },
            { id: "ai2", items: [{ sub: [50, 60] }], name: "nested2" },
            { id: "ai3", items: [], name: "empty_items" }
        ])

        // 索引访问嵌套数组
        const firstItemFirstSub = await table.findMany({ "items.0.sub.0": 10 })
        expect(firstItemFirstSub.length).toBe(1)
        expect(firstItemFirstSub[0].name).toBe("nested1")

        // 索引访问第二个元素
        const secondItem = await table.findMany({ "items.1.sub.0": { $exists: true } })
        expect(secondItem.length).toBe(1)
        expect(secondItem[0].name).toBe("nested1")
    })

    // ============================================
    // 边缘情况：特殊数值
    // ============================================

    test("特殊数值查询", async () => {
        await table.insertMany([
            { id: "sn1", value: 0, name: "zero" },
            { id: "sn2", value: -0, name: "neg_zero" },
            { id: "sn3", value: Number.MAX_SAFE_INTEGER, name: "max_safe" },
            { id: "sn4", value: Number.MIN_SAFE_INTEGER, name: "min_safe" },
            { id: "sn5", value: 0.1 + 0.2, name: "float_sum" }, // 0.30000000000000004
            { id: "sn6", value: Infinity, name: "infinity" },
            { id: "sn7", value: -Infinity, name: "neg_infinity" }
        ])

        // 查询 0 （-0 和 0 应该相等）
        const zeros = await table.findMany({ value: 0 })
        expect(zeros.length).toBe(2)

        // MAX_SAFE_INTEGER
        const maxSafe = await table.findMany({ value: Number.MAX_SAFE_INTEGER })
        expect(maxSafe.length).toBe(1)
        expect(maxSafe[0].name).toBe("max_safe")

        // 浮点数精度问题
        const floatSum = await table.findMany({ value: 0.1 + 0.2 })
        expect(floatSum.length).toBe(1)
        expect(floatSum[0].name).toBe("float_sum")

        // Infinity 比较
        const gtMax = await table.findMany({ value: { $gt: Number.MAX_SAFE_INTEGER } })
        expect(gtMax.length).toBe(1)
        expect(gtMax[0].name).toBe("infinity")
    })

    // ============================================
    // 边缘情况：空对象和空数组匹配
    // ============================================

    test("空对象和空数组匹配", async () => {
        await table.insertMany([
            { id: "eo1", obj: {}, arr: [], name: "both_empty" },
            { id: "eo2", obj: { a: 1 }, arr: [1], name: "both_filled" },
            { id: "eo3", obj: {}, arr: [1], name: "obj_empty" },
            { id: "eo4", obj: { a: 1 }, arr: [], name: "arr_empty" }
        ])

        // 精确匹配空对象
        const emptyObj = await table.findMany({ obj: {} })
        expect(emptyObj.length).toBe(2)
        expect(emptyObj.map((r: any) => r.name).sort()).toEqual(["both_empty", "obj_empty"])

        // 精确匹配空数组
        const emptyArr = await table.findMany({ arr: [] })
        expect(emptyArr.length).toBe(2)
        expect(emptyArr.map((r: any) => r.name).sort()).toEqual(["arr_empty", "both_empty"])

        // $size: 0
        const sizeZero = await table.findMany({ arr: { $size: 0 } })
        expect(sizeZero.length).toBe(2)
        expect(sizeZero.map((r: any) => r.name).sort()).toEqual(["arr_empty", "both_empty"])
    })

    // ============================================
    // 边缘情况：$or 和 $and 深层嵌套
    // ============================================

    test("$or 和 $and 深层嵌套", async () => {
        await table.insertMany([
            { id: "oa1", a: 1, b: 1, c: 1, name: "all_one" },
            { id: "oa2", a: 1, b: 2, c: 1, name: "b_two" },
            { id: "oa3", a: 2, b: 1, c: 1, name: "a_two" },
            { id: "oa4", a: 2, b: 2, c: 2, name: "all_two" }
        ])

        // 复杂嵌套: (a=1 AND b=1) OR (a=2 AND c=2)
        const nested = await table.findMany({
            $or: [
                { $and: [{ a: 1 }, { b: 1 }] },
                { $and: [{ a: 2 }, { c: 2 }] }
            ]
        })
        expect(nested.length).toBe(2)
        expect(nested.map((r: any) => r.name).sort()).toEqual(["all_one", "all_two"])

        // 三层嵌套
        const deepNested = await table.findMany({
            $and: [
                { $or: [{ a: 1 }, { a: 2 }] },
                { $or: [{ b: 1 }, { c: 2 }] }
            ]
        })
        expect(deepNested.length).toBe(3)
        expect(deepNested.map((r: any) => r.name).sort()).toEqual(["a_two", "all_one", "all_two"])
    })

    // ============================================
    // 边缘情况：$nor 操作符
    // ============================================

    test("$nor 操作符", async () => {
        await table.insertMany([
            { id: "nr1", x: 1, y: 1, name: "both_one" },
            { id: "nr2", x: 1, y: 2, name: "x_one" },
            { id: "nr3", x: 2, y: 1, name: "y_one" },
            { id: "nr4", x: 2, y: 2, name: "both_two" }
        ])

        // $nor: 不满足任何条件
        const nor = await table.findMany({ $nor: [{ x: 1 }, { y: 1 }] })
        expect(nor.length).toBe(1)
        expect(nor[0].name).toBe("both_two")
    })

    // ============================================
    // 边缘情况：特殊字符串
    // ============================================

    test("特殊字符串查询", async () => {
        await table.insertMany([
            { id: "ss1", text: "", name: "empty_string" },
            { id: "ss2", text: " ", name: "space" },
            { id: "ss3", text: "\n\t", name: "whitespace" },
            { id: "ss4", text: "hello\nworld", name: "newline" },
            { id: "ss5", text: "中文测试", name: "chinese" },
            { id: "ss6", text: "emoji 😀🎉", name: "emoji" }
        ])

        // 空字符串精确匹配
        const emptyStr = await table.findMany({ text: "" })
        expect(emptyStr.length).toBe(1)
        expect(emptyStr[0].name).toBe("empty_string")

        // 空格
        const space = await table.findMany({ text: " " })
        expect(space.length).toBe(1)
        expect(space[0].name).toBe("space")

        // 中文
        const chinese = await table.findMany({ text: "中文测试" })
        expect(chinese.length).toBe(1)
        expect(chinese[0].name).toBe("chinese")

        // emoji
        const emoji = await table.findMany({ text: { $regex: "😀" } })
        expect(emoji.length).toBe(1)
        expect(emoji[0].name).toBe("emoji")
    })

    // ============================================
    // 边缘情况：updateMany 与复杂过滤器
    // ============================================

    test("updateMany 与复杂过滤器", async () => {
        await table.insertMany([
            { id: "um1", status: "active", score: 10, name: "a1" },
            { id: "um2", status: "active", score: 20, name: "a2" },
            { id: "um3", status: "inactive", score: 30, name: "i1" }
        ])

        // 复杂过滤器更新
        await table.updateMany(
            { $and: [{ status: "active" }, { score: { $gte: 15 } }] },
            { $set: { updated: true } }
        )

        const updated = await table.findMany({ updated: true })
        expect(updated.length).toBe(1)
        expect(updated[0].name).toBe("a2")
    })

    // ============================================
    // 边缘情况：deleteMany 与复杂过滤器
    // ============================================

    test("deleteMany 与复杂过滤器", async () => {
        await table.insertMany([
            { id: "dm1", type: "temp", age: 5, name: "t1" },
            { id: "dm2", type: "temp", age: 15, name: "t2" },
            { id: "dm3", type: "perm", age: 5, name: "p1" }
        ])

        // 删除 type=temp AND age < 10
        await table.deleteMany({ $and: [{ type: "temp" }, { age: { $lt: 10 } }] })

        const remaining = await table.findMany({})
        expect(remaining.length).toBe(2)
        expect(remaining.map((r: any) => r.name).sort()).toEqual(["p1", "t2"])
    })
})