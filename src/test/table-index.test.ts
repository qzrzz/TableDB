
import { Table } from "../core/Table"
import { getTestTableByType, TestDatabaseType } from "./getTestTable"

const DATABASE_TYPES: TestDatabaseType[] = ["mongodb", "sqlite", "indexeddb"]

// 使用 describe.each 并在描述中包含 dbType 以区分测试
describe.each(DATABASE_TYPES)("索引测试 (Table Index) - %s", (dbType) => {
    let table!: Table

    // 每个测试前清空表
    beforeEach(async () => {
        table = await getTestTableByType("table-index-test", dbType)
        await table.clearAll()
    })

    test("基础标量索引 (Scalar Indexing)", async () => {
        // 1. 定义索引
        await table.defineIndexes([
            { key: "age" },
            { key: "name" }
        ])

        // 2. 插入数据
        const docs = [
            { id: "1", name: "Alice", age: 30 },
            { id: "2", name: "Bob", age: 25 },
            { id: "3", name: "Charlie", age: 35 },
            { id: "4", name: "David", age: 30 }, // 重复 age
        ]
        await table.insertMany(docs)

        // 3. 测试相等 ($eq)
        const eqRes = await table.findMany({ age: 30 })
        expect(eqRes.length).toBe(2)
        expect(eqRes.map((d: any) => d.name).sort()).toEqual(["Alice", "David"])

        // 4. 测试范围 ($gt, $lt)
        const gtRes = await table.findMany({ age: { $gt: 30 } })
        expect(gtRes.length).toBe(1)
        expect((gtRes[0] as any).name).toBe("Charlie")

        const ltRes = await table.findMany({ age: { $lt: 30 } })
        expect(ltRes.length).toBe(1)
        expect((ltRes[0] as any).name).toBe("Bob")

        // 5. 测试字符串匹配 ($regex) - 确保索引不破坏正则
        const regexRes = await table.findMany({ name: { $regex: "^D" } })
        expect(regexRes.length).toBe(1)
        expect((regexRes[0] as any).name).toBe("David")
    })

    test("数组/多键索引 (Array/Multikey Indexing - Side Table)", async () => {
        // 1. 定义数组字段索引
        await table.defineIndexes([{ key: "tags" }])

        // 2. 插入数据 (包含标量和数组)
        const docs = [
            { id: "1", tags: ["red", "blue"] },   // 数组
            { id: "2", tags: "blue" },            // 标量 (隐式数组)
            { id: "3", tags: ["green", "red"] },  // 数组
            { id: "4", tags: [] },                // 空数组
            { id: "5", tags: "yellow" }           // 标量
        ]
        await table.insertMany(docs)

        // 3. 隐式匹配 (Implicit Matching)
        // tags: "red" 应该匹配到 id=1 和 id=3
        const redRes = await table.findMany({ tags: "red" })
        expect(redRes.length).toBe(2)
        expect(redRes.map((d: any) => d.id).sort()).toEqual(["1", "3"])

        // tags: "blue" 应该匹配到 id=1 和 id=2
        const blueRes = await table.findMany({ tags: "blue" })
        expect(blueRes.length).toBe(2)
        expect(blueRes.map((d: any) => d.id).sort()).toEqual(["1", "2"])

        // 4. $in 查询
        // tags: { $in: ["green", "yellow"] } -> 3, 5
        const inRes = await table.findMany({ tags: { $in: ["green", "yellow"] } })
        expect(inRes.length).toBe(2)
        expect(inRes.map((d: any) => d.id).sort()).toEqual(["3", "5"])

        // 5. 不存在的元素
        const noneRes = await table.findMany({ tags: "purple" })
        expect(noneRes.length).toBe(0)
    })

    test("混合类型索引与变更 (Mixed Types & Mutation)", async () => {
        await table.defineIndexes([{ key: "val" }])

        // 1. 插入混合类型
        await table.insertMany([
            { id: "num", val: 123 },
            { id: "str", val: "123" }
        ])

        // 2. 精确类型查询
        const numRes = await table.findMany({ val: 123 })
        expect(numRes.length).toBe(1)
        expect(numRes[0].id).toBe("num")

        const strRes = await table.findMany({ val: "123" })
        expect(strRes.length).toBe(1)
        expect(strRes[0].id).toBe("str")

        // 3. 类型变更 (Update Mutation)
        // 将数字改为字符串: id=num, val=123 -> val="456"
        await table.updateOne({ id: "num" }, { $set: { val: "456" } })

        // 旧值查不到
        const oldValRes = await table.findMany({ val: 123 })
        expect(oldValRes.length).toBe(0)

        // 新值能查到
        const newValRes = await table.findMany({ val: "456" })
        expect(newValRes.length).toBe(1)
        expect(newValRes[0].id).toBe("num")

        // 4. 再次变更为数组
        // id=str, val="123" -> val=["tags", "123"]
        await table.updateOne({ id: "str" }, { $set: { val: ["tags", "123"] } })

        // 应该能通过 "tags" 查到
        const arrRes = await table.findMany({ val: "tags" })
        expect(arrRes.length).toBe(1)
        expect(arrRes[0].id).toBe("str")

        // 应该也能通过 "123" 查到 (数组包含)
        const arrRes2 = await table.findMany({ val: "123" })
        expect(arrRes2.length).toBe(1)
        expect(arrRes2[0].id).toBe("str")
    })

    test("边界情况 (Edge Cases)", async () => {
        await table.defineIndexes([{ key: "f" }])

        await table.insertMany([
            { id: "null", f: null },
            { id: "empty" }, // undefined/missing
            { id: "val", f: "val" }
        ])

        // 1. 查询 null
        const nullRes = await table.findMany({ f: null })
        // 通常 {f: null} 也会匹配缺失字段的情况，视具体实现而定。
        // TableDB 规范类似 MongoDB，null 匹配 null 值或缺失。
        // 但如果启用了索引，行为必须一致。
        // 预期：匹配 id="null" 和 id="empty"
        expect(nullRes.length).toBeGreaterThanOrEqual(1)
        const ids = nullRes.map(d => d.id)
        expect(ids).toContain("null")
        // 如果实现遵循 Mongo，'empty' 也应该在其中
        expect(ids).toContain("empty")

        // 2. 查询存在性 ($exists)
        const existsRes = await table.findMany({ f: { $exists: true } })
        // 应该是 "null" (值为null但字段存在) 和 "val"
        // 注意：Mongo 中 {a: null} 的存储，exists:true 是包含 null 的。
        expect(existsRes.length).toBe(2)
        const existIds = existsRes.map(d => d.id).sort()
        expect(existIds).toEqual(["null", "val"])
    })

    test("重复数组元素 (Duplicate Array Elements)", async () => {
        await table.defineIndexes([{ key: "tags" }])

        // 插入带重复元素的数组
        try {
            await table.insertOne({ id: "dup", tags: ["A", "A", "B"] })
        } catch (e) {
            throw new Error("Insert should not fail even if array has duplicates")
        }

        // 查询 "A" - 应该只返回一次该文档
        const res = await table.findMany({ tags: "A" })
        expect(res.length).toBe(1)
        expect(res[0].id).toBe("dup")

        // 删除元素 "A"
        await table.updateOne({ id: "dup" }, { $pull: { tags: "A" } })

        // 再次查询 "A" 应为空 (因为 $pull 删除了所有匹配的 "A")
        const resAfter = await table.findMany({ tags: "A" })
        expect(resAfter.length).toBe(0)

        // 查询 "B" 应仍在
        const resB = await table.findMany({ tags: "B" })
        expect(resB.length).toBe(1)
    })

    test("嵌套对象索引 (Nested Object Indexing)", async () => {
        await table.defineIndexes([{ key: "info.city" }])

        await table.insertMany([
            { id: "1", info: { city: "Beijing", zip: 100 } },
            { id: "2", info: { city: "Shanghai", zip: 200 } }
        ])

        // 1. 精确匹配嵌套字段
        const res = await table.findMany({ "info.city": "Beijing" })
        expect(res.length).toBe(1)
        expect(res[0].id).toBe("1")

        // 2. 确保索引未破坏非匹配项
        const res2 = await table.findMany({ "info.city": "Shenzhen" })
        expect(res2.length).toBe(0)
    })

    test("Date 类型索引 (Date Indexing)", async () => {
        await table.defineIndexes([{ key: "createdAt" }])
        const now = new Date()
        // 确保时间差异足以区分 (例如 +/- 1秒)
        const yesterday = new Date(now.getTime() - 10000)
        const tomorrow = new Date(now.getTime() + 10000)

        await table.insertMany([
            { id: "1", createdAt: now, type: "now" },
            { id: "2", createdAt: yesterday, type: "old" },
            { id: "3", createdAt: tomorrow, type: "future" }
        ])

        // 1. 范围查询 ($gt)
        // 理论上序列化为 {$t:'d', v: ISOString}，字符串比较应有效
        const futureRes = await table.findMany({ createdAt: { $gt: now } })
        expect(futureRes.length).toBe(1)
        expect(futureRes[0].id).toBe("3")

        // 2. 范围查询 ($lte)
        const pastRes = await table.findMany({ createdAt: { $lte: now } })
        expect(pastRes.length).toBe(2)
        const ids = pastRes.map((d: any) => d.id).sort()
        expect(ids).toEqual(["1", "2"])
    })
})
