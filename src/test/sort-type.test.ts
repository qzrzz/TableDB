import { describe, test, expect, beforeAll, beforeEach } from "vitest"
import { Table, } from "../core/Table"
import { getTestTableByType, TestDatabaseType } from "./getTestTable"

const DATABASE_TYPES: TestDatabaseType[] = ["sqlite", "mongodb"]

describe.each(DATABASE_TYPES)("Table 类型排序与过滤测试 - %s", async (dbType) => {
    let table: Table 

    beforeAll(async () => {
        table = (await getTestTableByType("sortTypeTestTable", dbType)) as any
    })

    beforeEach(async () => {
        await table.clearAll()
    })

    test("String: 排序与过滤", async () => {
        await table.insertMany([
            { id: "1", strVal: "A" },
            { id: "2", strVal: "C" },
            { id: "3", strVal: "B" },
        ])

        // 升序排序
        const asc = await table.findMany({}, { sort: { strVal: 1 } })
        expect(asc.map((d) => d.strVal)).toEqual(["A", "B", "C"])

        // 降序排序
        const desc = await table.findMany({}, { sort: { strVal: -1 } })
        expect(desc.map((d) => d.strVal)).toEqual(["C", "B", "A"])

        // 过滤 $eq
        const eq = await table.findMany({ strVal: "B" })
        expect(eq).toHaveLength(1)
        expect(eq[0].strVal).toBe("B")

        // 过滤 $like
        const like = await table.findMany({ strVal: { $like: "%B%" } })
        expect(like).toHaveLength(1)
        expect(like[0].strVal).toBe("B")
    })

    test("Number: 排序与过滤", async () => {
        await table.insertMany([
            { id: "1", numVal: 10 },
            { id: "2", numVal: 30 },
            { id: "3", numVal: 20 },
        ])

        // 升序排序
        const asc = await table.findMany({}, { sort: { numVal: 1 } })
        expect(asc.map((d) => d.numVal)).toEqual([10, 20, 30])

        // 降序排序
        const desc = await table.findMany({}, { sort: { numVal: -1 } })
        expect(desc.map((d) => d.numVal)).toEqual([30, 20, 10])

        // 过滤 $gt
        const gt = await table.findMany({ numVal: { $gt: 15 } }, { sort: { numVal: 1 } })
        expect(gt.map((d) => d.numVal)).toEqual([20, 30])

        // 过滤 $lt
        const lt = await table.findMany({ numVal: { $lt: 25 } }, { sort: { numVal: 1 } })
        expect(lt.map((d) => d.numVal)).toEqual([10, 20])
    })

    test("Boolean: 排序与过滤", async () => {
        await table.insertMany([
            { id: "1", boolVal: true },
            { id: "2", boolVal: false },
            { id: "3", boolVal: true },
        ])

        // 升序排序 (False < True)
        const asc = await table.findMany({}, { sort: { boolVal: 1 } })
        expect(asc.map((d) => d.boolVal)).toEqual([false, true, true])

        // 过滤 $eq
        const eq = await table.findMany({ boolVal: false })
        expect(eq).toHaveLength(1)
        expect(eq[0].boolVal).toBe(false)
    })

    test("Date: 排序与过滤", async () => {
        const d1 = new Date("2023-01-01")
        const d2 = new Date("2023-01-02")
        const d3 = new Date("2023-01-03")

        await table.insertMany([
            { id: "1", dateVal: d2 },
            { id: "2", dateVal: d1 },
            { id: "3", dateVal: d3 },
        ])

        // 升序排序
        const asc = await table.findMany({}, { sort: { dateVal: 1 } })
        expect(asc.map((d) => (d.dateVal as Date | undefined)?.getTime())).toEqual([d1.getTime(), d2.getTime(), d3.getTime()])

        // 过滤 $gt
        const gt = await table.findMany({ dateVal: { $gt: d1 } }, { sort: { dateVal: 1 } })
        expect(gt.map((d) => (d.dateVal as Date | undefined)?.getTime())).toEqual([d2.getTime(), d3.getTime()])
    })

    test("BigInt: 排序与过滤", async () => {
        const b1 = BigInt(1)
        const b2 = BigInt(2)
        const b3 = BigInt(3)

        await table.insertMany([
            { id: "1", bigIntVal: b2 },
            { id: "2", bigIntVal: b3 },
            { id: "3", bigIntVal: b1 },
        ])

        // 升序排序 (1 < 2 < 3)
        const asc = await table.findMany({}, { sort: { bigIntVal: 1 } })
        expect(asc.map((d) => d.bigIntVal)).toEqual([b1, b2, b3])

        // 过滤 $gt
        const gt = await table.findMany({ bigIntVal: { $gt: b2 } })
        expect(gt).toHaveLength(1)
        expect(gt[0].bigIntVal).toBe(b3)
    })

    test("Null/Undefined: 过滤", async () => {
        await table.insertMany([
            { id: "1", nullVal: null },
            { id: "2", strVal: "exists" }, // nullVal is undefined here
        ])

        // 过滤 $exists: true (应该找到显式为 null 的那个)
        const exists = await table.findMany({ nullVal: { $exists: true } })
        const hasNull = exists.find((d) => d.id === "1")
        expect(hasNull).toBeDefined()

        // 过滤 $exists: false (应该找到 undefined 的那个)
        const notExists = await table.findMany({ nullVal: { $exists: false } })
        const hasNoNull = notExists.find((d) => d.id === "2")
        expect(hasNoNull).toBeDefined()
    })

    test("Uint8Array: 排序", async () => {
        const b1 = new Uint8Array([1])
        const b2 = new Uint8Array([2])
        const b3 = new Uint8Array([3])

        await table.insertMany([
            { id: "1", binVal: b2 },
            { id: "2", binVal: b3 },
            { id: "3", binVal: b1 },
        ])

        // Base64: [1] -> AQ==, [2] -> Ag==, [3] -> Aw==
        // Sort order: AQ== < Ag== < Aw==
        const asc = await table.findMany({}, { sort: { binVal: 1 } })
        const res = asc.map((d) => d.binVal)
        expect(res[0]).toEqual(b1)
        expect(res[1]).toEqual(b2)
        expect(res[2]).toEqual(b3)
    })
})
