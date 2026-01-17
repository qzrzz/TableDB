import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest"
import { Table } from "../index"
import { getTestTableByType, TestDatabaseType } from "./getTestTable"

const DATABASE_TYPES: TestDatabaseType[] = ["sqlite", "mongodb"] // 暂时只测试 sqlite，因为 mongodb 环境可能未就绪，或者可以加上 "mongodb" 但需确保连接

describe.each(DATABASE_TYPES)("表格类型支持测试 - %s", (dbType) => {
    let table: Table<any>

    beforeEach(async () => {
        table = await getTestTableByType("TypeTest", dbType)
        await table.clearAll()
    })

    const testType = async (label: string, value: any, updateValue: any, queryCheck?: (val: any) => any) => {
        it(`应该支持 ${label}`, async () => {
            const id = `id_${label}`

            // 1. 插入
            await table.insertOne({ id, val: value })
            const doc = await table.get(id)
            expect(doc?.val).toEqual(value)

            // 检查类型保留
            if (value !== null && value !== undefined) {
                expect(doc?.val).toBeTypeOf(typeof value)
                if (value instanceof Date) expect(doc?.val).toBeInstanceOf(Date)
                if (value instanceof RegExp) expect(doc?.val).toBeInstanceOf(RegExp)
                if (value instanceof Map) expect(doc?.val).toBeInstanceOf(Map)
                if (value instanceof Set) expect(doc?.val).toBeInstanceOf(Set)
                if (value instanceof ArrayBuffer) expect(doc?.val).toBeInstanceOf(ArrayBuffer)
                // TypedArrays 检查
                if (ArrayBuffer.isView(value)) {
                    expect(doc?.val.constructor).toBe(value.constructor)
                }
            }

            // 2. 查询
            const find = await table.findOne({ val: queryCheck ? queryCheck(value) : value })
            expect(find).toBeDefined()
            expect(find?.id).toBe(id)

            // 3. 更新
            await table.updateOne({ id }, { $set: { val: updateValue } })
            const updated = await table.get(id)
            expect(updated?.val).toEqual(updateValue)
        })
    }

    // 基础类型
    testType("string", "hello world", "updated string")
    testType("number", 123.456, 789)
    testType("boolean", true, false)
    testType("bigint", BigInt("9007199254740991"), BigInt("1234567890123456789"))

    // Null/Undefined
    it("应该正确处理 null 和 undefined", async () => {
        // undefined 应该被存储为 null (根据文档)
        await table.insertOne({ id: "undefined", val: undefined })
        const docUndef = await table.get("undefined")
        expect(docUndef?.val).toBeNull()

        await table.insertOne({ id: "null", val: null })
        const docNull = await table.get("null")
        expect(docNull?.val).toBeNull()

        // 查询 null 应该匹配两者
        const finds = await table.findMany({ val: null })
        expect(finds.length).toBeGreaterThanOrEqual(2)
    })

    // Date
    testType("Date", new Date("2023-01-01T00:00:00.000Z"), new Date())

    // RegExp
    it("应该支持 RegExp 存储、更新和类型保留", async () => {
        const id = "regexp"
        const val = /test/i
        const updateVal = /update/g

        // 1. 插入
        await table.insertOne({ id, val })
        const doc = await table.get(id)
        expect(doc?.val).toEqual(val)
        expect(doc?.val).toBeInstanceOf(RegExp)

        // 2. 查询
        // 注意: 在标准 Mongo 语法中，按值严格查询存储的 RegExp 对象可能有歧义
        // 因为 { val: /regex/ } 意味着对字符串字段进行正则匹配。
        // 这里我们要验证是否可以通过 ID 找到并检查值。
        // 如果我们想测试是否可以*通过*它进行查询，我们需要知道严格相等行为。
        // 目前，我们假设当值为 RegExp 时，不进行简单的正则模式匹配。
        // 检查 $exists
        const findExists = await table.findOne({ id, val: { $exists: true } })
        expect(findExists).toBeDefined()

        // 3. 更新
        await table.updateOne({ id }, { $set: { val: updateVal } })
        const updated = await table.get(id)
        expect(updated?.val).toEqual(updateVal)
        expect(updated?.val).toBeInstanceOf(RegExp)
    })

    // Map
    it("应该支持 Map 存储和检索", async () => {
        const id = "map"
        const val = new Map<any, any>([
            ["key1", "value1"],
            ["key2", 123],
            [{ nested: "key" }, new Set([1, 2])],
        ])
        await table.insertOne({ id, val })

        const doc = await table.get(id)
        expect(doc?.val).toBeInstanceOf(Map)
        expect(doc?.val.get("key1")).toBe("value1")
        expect(doc?.val.get("key2")).toBe(123)

        const entries = Array.from(doc?.val.entries())
        expect(entries).toHaveLength(3)

        // 更新
        const newVal = new Map([["new", 1]])
        await table.updateOne({ id }, { $set: { val: newVal } })
        const updated = await table.get(id)
        expect(updated?.val).toEqual(newVal)
    })

    // Set
    it("应该支持 Set 存储和检索", async () => {
        const id = "set"
        const val = new Set([1, "string", new Map([["a", 1]]), new Set([3, 4])])
        await table.insertOne({ id, val })

        const doc = await table.get(id)
        expect(doc?.val).toBeInstanceOf(Set)
        expect(doc?.val.has(1)).toBe(true)
        expect(doc?.val.has("string")).toBe(true)

        const arr = Array.from(doc?.val)
        expect(arr).toHaveLength(4)

        // 更新
        const newVal = new Set([5, 6])
        await table.updateOne({ id }, { $set: { val: newVal } })
        const updated = await table.get(id)
        expect(updated?.val).toEqual(newVal)
    })

    // Binary
    it("应该支持 ArrayBuffer", async () => {
        const id = "buffer"
        const val = new ArrayBuffer(8)
        const view = new Uint8Array(val)
        view[0] = 1
        view[1] = 255

        await table.insertOne({ id, val })
        const doc = await table.get(id)
        expect(doc?.val).toBeInstanceOf(ArrayBuffer)
        const resView = new Uint8Array(doc?.val)
        expect(resView[0]).toBe(1)
        expect(resView[1]).toBe(255)
    })

    it("应该支持 Uint8Array", async () => {
        const id = "u8"
        const val = new Uint8Array([1, 2, 3, 255])
        await table.insertOne({ id, val })
        const doc = await table.get(id)
        expect(doc?.val).toBeInstanceOf(Uint8Array)
        expect(doc?.val).toEqual(val)
    })

    // Complex nested object
    it("应该支持复杂嵌套结构", async () => {
        const id = "complex"
        const val = {
            s: "str",
            n: 123,
            d: new Date(),
            r: /regexp/,
            m: new Map([["k", "v"]]),
            set: new Set([1, 2]),
            buf: new Uint8Array([0x00, 0xff]),
            nested: {
                list: [new Map([["inner", true]])],
            },
        }
        await table.insertOne({ id, val })
        const doc = await table.get(id)

        expect(doc?.val.s).toBe("str")
        expect(doc?.val.n).toBe(123)
        expect(doc?.val.d).toBeInstanceOf(Date)
        expect(doc?.val.r).toBeInstanceOf(RegExp)
        expect(doc?.val.m).toBeInstanceOf(Map)
        expect(doc?.val.set).toBeInstanceOf(Set)
        expect(doc?.val.buf).toBeInstanceOf(Uint8Array)
        expect(doc?.val.nested.list[0]).toBeInstanceOf(Map)
    })

    // Update with operators on special types
    it("应该支持使用 $set 更新 Map 和 Set", async () => {
        const id = "update_map_set"
        await table.insertOne({ id, m: new Map(), s: new Set() })

        // 替换 map
        const newMap = new Map([["a", 1]])
        await table.updateOne({ id }, { $set: { m: newMap } })
        let doc = await table.get(id)
        expect(doc?.m).toEqual(newMap)
    })

    it("应该支持对数字使用 $gt 查询", async () => {
        await table.insertMany([
            { id: 1, val: 10 },
            { id: 2, val: 20 },
            { id: 3, val: 30 },
        ])

        const res = await table.findMany({ val: { $gt: 15 } })
        expect(res.length).toBe(2)
        expect(res.map((d) => d.val).sort()).toEqual([20, 30])
    })

    it("应该支持对混合类型使用 $in 查询", async () => {
        const d = new Date()
        await table.insertMany([
            { id: 1, val: "a" },
            { id: 2, val: 10 },
            { id: 3, val: d },
        ])

        const res = await table.findMany({ val: { $in: ["a", d] } })
        expect(res.length).toBe(2)
    })

    // Deep Nesting
    it("应该支持 Map, Set, Array 的深度嵌套", async () => {
        const id = "deep_nest"

        // Map -> Set -> Array -> Map
        const deepVal = new Map([["level1", new Set(["item1", ["array_item", new Map([["deep_key", "deep_value"]])]])]])

        await table.insertOne({ id, val: deepVal })
        const doc = await table.get(id)

        expect(doc?.val).toBeInstanceOf(Map)
        const l1 = doc?.val.get("level1")
        expect(l1).toBeInstanceOf(Set)

        const arr = Array.from(l1).find((i) => Array.isArray(i)) as any[]
        expect(arr).toBeDefined()
        expect(arr[0]).toBe("array_item")

        const deepMap = arr[1]
        expect(deepMap).toBeInstanceOf(Map)
        expect(deepMap.get("deep_key")).toBe("deep_value")
    })

    // Comprehensive Nested Types
    const getAllTypes = () => {
        const buffer = new ArrayBuffer(8)
        const view = new DataView(buffer)
        view.setInt8(0, 127)

        return {
            string: "str",
            number: 123.456,
            boolean: true,
            null: null,
            // undefined: undefined, // undefined usually becomes null
            date: new Date("2024-01-01T00:00:00.000Z"),
            regexp: /test/i,
            map: new Map([["k", "v"]]),
            set: new Set([1, 2]),
            bigint: 9007199254740991n,
            arrayBuffer: buffer,
            dataView: view,
            int8: new Int8Array([127]),
            int16: new Int16Array([32767]),
            int32: new Int32Array([2147483647]),
            uint8: new Uint8Array([255]),
            uint8Clamped: new Uint8ClampedArray([255]),
            uint16: new Uint16Array([65535]),
            uint32: new Uint32Array([4294967295]),
            float32: new Float32Array([1.5]),
            float64: new Float64Array([1.123456789]),
            bigInt64: new BigInt64Array([9007199254740991n]),
            bigUint64: new BigUint64Array([18446744073709551615n]),
        }
    }

    it("Map 应该支持嵌套所有支持的数据格式", async () => {
        const id = "map_all_types"
        const allTypes = getAllTypes()

        // 构建一个包含所有类型的 Map
        // Key testing: string key mostly, but maybe verifying strict value preservation
        const map = new Map<string, any>()
        for (const [k, v] of Object.entries(allTypes)) {
            map.set(k, v)
        }

        await table.insertOne({ id, val: map })
        const doc = await table.get(id)

        expect(doc?.val).toBeInstanceOf(Map)
        const resMap = doc?.val as Map<string, any>

        expect(resMap.get("string")).toBe("str")
        expect(resMap.get("number")).toBe(123.456)
        expect(resMap.get("boolean")).toBe(true)
        expect(resMap.get("null")).toBeNull()
        expect(resMap.get("date")).toEqual(new Date("2024-01-01T00:00:00.000Z"))
        expect(resMap.get("regexp")).toEqual(/test/i)
        expect(resMap.get("map")).toBeInstanceOf(Map)
        expect(resMap.get("map").get("k")).toBe("v")
        expect(resMap.get("set")).toBeInstanceOf(Set)
        expect(resMap.get("set").has(1)).toBe(true)
        expect(resMap.get("bigint")).toBe(9007199254740991n)

        // Binary types check
        expect(resMap.get("arrayBuffer")).toBeInstanceOf(ArrayBuffer)
        expect(resMap.get("dataView")).toBeInstanceOf(DataView)
        expect(resMap.get("int8")).toBeInstanceOf(Int8Array)
        expect(resMap.get("bigUint64")).toBeInstanceOf(BigUint64Array)
        expect(resMap.get("bigUint64")[0]).toBe(18446744073709551615n)
    })

    it("Set 应该支持嵌套所有支持的数据格式", async () => {
        const id = "set_all_types"
        const allTypes = getAllTypes()
        const set = new Set(Object.values(allTypes)) // 将所有类型放入 Set

        await table.insertOne({ id, val: set })
        const doc = await table.get(id)

        expect(doc?.val).toBeInstanceOf(Set)
        const resSet = doc?.val as Set<any>
        expect(resSet.size).toBe(Object.keys(allTypes).length)

        // 验证基本类型存在
        expect(resSet.has("str")).toBe(true)
        expect(resSet.has(123.456)).toBe(true)
        expect(resSet.has(true)).toBe(true)
        expect(resSet.has(null)).toBe(true)
        expect(resSet.has(9007199254740991n)).toBe(true)

        // 验证引用/复杂类型 (需要遍历查找，因为 strict equality 可能不成立)
        // 实际上 TableDB 对于某些类型可能保留引用或还原为新对象
        // 我们遍历检查 instanceof
        const arr = Array.from(resSet)
        expect(arr.some((x) => x instanceof Date && x.toISOString() === "2024-01-01T00:00:00.000Z")).toBe(true)
        expect(arr.some((x) => x instanceof RegExp && x.source === "test")).toBe(true)
        expect(arr.some((x) => x instanceof Map && x.get("k") === "v")).toBe(true)
        expect(arr.some((x) => x instanceof Set && x.has(1))).toBe(true)
        expect(arr.some((x) => x instanceof Int8Array)).toBe(true)
        expect(arr.some((x) => x instanceof BigUint64Array)).toBe(true)
    })

    it("Array 应该支持嵌套所有支持的数据格式", async () => {
        const id = "array_all_types"
        const allTypes = getAllTypes()
        const array = Object.values(allTypes) // 将所有类型放入 Array

        await table.insertOne({ id, val: array })
        const doc = await table.get(id)

        expect(Array.isArray(doc?.val)).toBe(true)
        const resArr = doc?.val as any[]
        expect(resArr.length).toBe(Object.keys(allTypes).length)

        // 按索引或类型验证
        // 因为 Object.values 顺序确定，我们可以对应检查 (如果 key 顺序稳定)
        // 但为了安全，我们针对特定已知值检查

        // Basic
        expect(resArr).toContain("str")
        expect(resArr).toContain(123.456)
        expect(resArr).toContain(true)
        expect(resArr).toContain(null)
        expect(resArr).toContain(9007199254740991n)

        // Complex
        expect(resArr.some((x) => x instanceof Date)).toBe(true)
        expect(resArr.some((x) => x instanceof RegExp)).toBe(true)
        expect(resArr.some((x) => x instanceof Map)).toBe(true)
        expect(resArr.some((x) => x instanceof Set)).toBe(true)
        expect(resArr.some((x) => x instanceof Uint8Array)).toBe(true)
        expect(resArr.some((x) => x instanceof Float64Array)).toBe(true)
    })

    it("数组全面测试", async () => {
        // 准备两条文档，覆盖数字、字符串、混合、日期数组
        const docs = [
            {
                id: "d1",
                arr_numbers: [1, 2, 3, 5, 6],
                arr_strings: ["a", "b", "c"],
                arr_mixed: [1, "two", null, new Date("2020-01-01T00:00:00.000Z")],
                arr_date: [
                    new Date("2021-01-01T00:00:00.000Z"),
                    new Date("2022-02-02T00:00:00.000Z"),
                    new Date("2023-03-03T00:00:00.000Z"),
                ],
            },
            {
                id: "d2",
                arr_numbers: [10, 20, 30],
                arr_strings: ["x"],
                arr_mixed: [null, "str", new Date("2020-01-01T00:00:00.000Z")],
                arr_date: [new Date("2019-01-01T00:00:00.000Z")],
            },
        ]

        // 插入
        await table.insertMany(docs)

        // 读取与类型保留
        const got = await table.get("d1")
        expect(got).toBeDefined()
        expect(Array.isArray(got?.arr_numbers)).toBe(true)
        expect(got?.arr_numbers).toEqual([1, 2, 3, 5, 6])

        // 精确数组匹配（字符串数组）
        const exact = await table.findOne({ arr_strings: ["a", "b", "c"] })
        expect(exact).toBeDefined()
        expect(exact?.id).toBe("d1")

        // 元素存在查询：数字元素 5 在 d1 中
        const hasFive = await table.findMany({ arr_numbers: { $in: [5] } })
        expect(hasFive.some((r) => r.id === "d1")).toBe(true)

        // 日期元素查询：使用 $in 包含 Date 对象
        const dateToFind = new Date("2022-02-02T00:00:00.000Z")
        const dateRes = await table.findMany({ arr_date: { $in: [dateToFind] } })
        expect(dateRes.some((r) => r.id === "d1")).toBe(true)

        // dot-notation 索引查询（第一项等于 1）
        const idx0 = await table.findOne({ "arr_numbers.0": 1 })
        expect(idx0).toBeDefined()
        expect(idx0?.id).toBe("d1")

        // 更新：整体替换数组
        await table.updateOne({ id: "d1" }, { $set: { arr_numbers: [7, 8] } })
        const afterSet = await table.get("d1")
        expect(afterSet?.arr_numbers).toEqual([7, 8])

        // 更新：通过点位替换数组内某个索引（arr_mixed[2] 原为 null，替换为 Date）
        const newNestedDate = new Date("2021-01-01T00:00:00.000Z")
        await table.updateOne({ id: "d1" }, { $set: { "arr_mixed.2": newNestedDate } })
        const afterIdxSet = await table.get("d1")
        expect(afterIdxSet?.arr_mixed[2]).toBeInstanceOf(Date)
        expect((afterIdxSet?.arr_mixed[2] as Date).toISOString()).toBe(newNestedDate.toISOString())

        // 验证另一条记录仍然存在且未被改动
        const other = await table.get("d2")
        expect(other).toBeDefined()
        expect(other?.arr_numbers).toEqual([10, 20, 30])
    })

    it("Date 全面测试", async () => {
        // 插入多个日期文档以及一个 null
        const d1 = new Date("2020-01-01T00:00:00.000Z")
        const d2 = new Date("2021-06-15T12:30:00.000Z")
        const d3 = new Date("2022-12-31T23:59:59.999Z")

        await table.insertMany([
            { id: "date1", val: d1 },
            { id: "date2", val: d2 },
            { id: "date3", val: d3 },
            { id: "dateNull", val: null },
        ])

        // 读取与类型保留
        const got2 = await table.get("date2")
        expect(got2).toBeDefined()
        expect(got2?.val).toBeInstanceOf(Date)
        expect(got2?.val).toEqual(d2)

        // 精确匹配查询
        const exact = await table.findOne({ val: d1 })
        expect(exact).toBeDefined()
        expect(exact?.id).toBe("date1")

        // 范围查询： $gt / $lt
        const gtRes = await table.findMany({ val: { $gt: new Date("2021-01-01T00:00:00.000Z") } })
        expect(gtRes.map((r) => r.id).sort()).toEqual(["date2", "date3"])

        const ltRes = await table.findMany({ val: { $lt: new Date("2021-01-01T00:00:00.000Z") } })
        expect(ltRes.map((r) => r.id)).toEqual(["date1"])

        // 边界包含查询 $gte / $lte
        const between = await table.findMany({ val: { $gte: d2, $lte: d3 } })
        expect(between.map((r) => r.id).sort()).toEqual(["date2", "date3"])

        // $in 查询
        const inRes = await table.findMany({ val: { $in: [d2, new Date("2030-01-01T00:00:00.000Z")] } })
        expect(inRes.length).toBe(1)
        expect(inRes[0].id).toBe("date2")

        // 按时间排序（在内存中验证）。排除 null 值，确保日期顺序正确
        const all = await table.findMany({})
        const dateDocs = all
            .filter((d) => d.val instanceof Date)
            .sort((a, b) => (a.val as Date).getTime() - (b.val as Date).getTime())
        expect(dateDocs.map((d) => d.id)).toEqual(["date1", "date2", "date3"])

        // 更新日期字段
        const newDate = new Date("2025-05-05T05:05:05.000Z")
        await table.updateOne({ id: "date1" }, { $set: { val: newDate } })
        const afterUpd = await table.get("date1")
        expect(afterUpd?.val).toBeInstanceOf(Date)
        expect(afterUpd?.val).toEqual(newDate)

        // 嵌套对象中的 Date 查询与更新
        await table.insertOne({ id: "nested_date", obj: { d: new Date("2000-01-01T00:00:00.000Z") } })
        const nestedFound = await table.findOne({ "obj.d": new Date("2000-01-01T00:00:00.000Z") })
        expect(nestedFound).toBeDefined()

        await table.updateOne({ id: "nested_date" }, { $set: { "obj.d": new Date("2001-02-03T04:05:06.000Z") } })
        const nestedAfter = await table.get("nested_date")
        expect(nestedAfter?.obj?.d).toBeInstanceOf(Date)
        expect(nestedAfter?.obj?.d).toEqual(new Date("2001-02-03T04:05:06.000Z"))
    })

    it("Blob 全面测试", async () => {
        const id = "blob"
        const bytes = new Uint8Array([1, 2, 3, 255])

        const makeBlob = () => {
            if (typeof Blob !== "undefined") return new Blob([bytes])
            return bytes.buffer
        }

        await table.insertOne({ id, val: makeBlob() })
        const doc = await table.get(id)
        expect(doc).toBeDefined()

        const extractBytes = async (val: any) => {
            if (typeof Blob !== "undefined" && val instanceof Blob) {
                const ab = await val.arrayBuffer()
                return new Uint8Array(ab)
            }
            if (val instanceof ArrayBuffer) return new Uint8Array(val)
            if (ArrayBuffer.isView(val)) return new Uint8Array(val.buffer, val.byteOffset, val.byteLength)
            return new Uint8Array(val)
        }

        const view = await extractBytes(doc?.val)
        expect(Array.from(view)).toEqual(Array.from(bytes))

        // 更新为新的 Blob/二进制
        const newBytes = new Uint8Array([9, 8, 7])
        const newVal = typeof Blob !== "undefined" ? new Blob([newBytes]) : newBytes.buffer
        await table.updateOne({ id }, { $set: { val: newVal } })
        const updated = await table.get(id)
        const updatedView = await extractBytes(updated?.val)
        expect(Array.from(updatedView)).toEqual(Array.from(newBytes))
    })

    it("NaN,Infinity 全面测试", async () => {
        let docs = [
            { id: "nan", val: NaN, arr: [1, 2, 3, NaN], ob: { val: NaN } },
            { id: "infinity", val: Infinity, arr: [1, 2, 3, 4, Infinity, -Infinity], ob: { val: Infinity } },
            { id: "neg_infinity", val: -Infinity, arr: [1, 2, 3, 4 - Infinity], ob: { val: -Infinity } },
            { id: "normal", val: 12345, arr: [1, 2, 3], ob: { val: 6789 } },
        ]
        // 插入包含 NaN 和 Infinity 的文档
        await table.insertMany(docs)

        // 读取并验证 NaN 和 Infinity 的类型保留
        const re_get_nan = await table.get("nan")
        expect(re_get_nan.val).toBeNaN()
        expect(re_get_nan.arr[3]).toBeNaN()
        expect(re_get_nan.ob.val).toBeNaN()
        expect(re_get_nan).toEqual(docs[0])

        const re_find_nan = await table.findOne({ id: "nan" })
        expect(re_find_nan.val).toBeNaN()
        expect(re_find_nan.arr[3]).toBeNaN()
        expect(re_find_nan.ob.val).toBeNaN()
        expect(re_find_nan).toEqual(docs[0])

        const re_get_infinity = await table.get("infinity")
        expect(re_get_infinity.val).toBe(Infinity)
        expect(re_get_infinity.arr[4]).toBe(Infinity)
        expect(re_get_infinity.arr[5]).toBe(-Infinity)
        expect(re_get_infinity.ob.val).toBe(Infinity)
        expect(re_get_infinity).toEqual(docs[1])

        const re_find_infinity = await table.findOne({ id: "infinity" })
        expect(re_find_infinity.val).toBe(Infinity)
        expect(re_find_infinity.arr[4]).toBe(Infinity)
        expect(re_find_infinity.arr[5]).toBe(-Infinity)
        expect(re_find_infinity.ob.val).toBe(Infinity)
        expect(re_find_infinity).toEqual(docs[1])

        const re_get_neg_infinity = await table.get("neg_infinity")
        expect(re_get_neg_infinity.val).toBe(-Infinity)
        expect(re_get_neg_infinity.arr[3]).toBe(-Infinity)
        expect(re_get_neg_infinity.ob.val).toBe(-Infinity)
        expect(re_get_neg_infinity).toEqual(docs[2])

        const re_find_neg_infinity = await table.findOne({ id: "neg_infinity" })
        expect(re_find_neg_infinity.val).toBe(-Infinity)
        expect(re_find_neg_infinity.arr[3]).toBe(-Infinity)
        expect(re_find_neg_infinity.ob.val).toBe(-Infinity)
        expect(re_find_neg_infinity).toEqual(docs[2])

        // 匹配 NaN 和 Infinity
        const re_find_nan_2 = await table.findMany({ val: NaN })
        expect(re_find_nan_2).toHaveLength(1)
        expect(re_find_nan_2[0].id).toBe("nan")

        const re_find_infinity_2 = await table.findMany({ val: Infinity })
        expect(re_find_infinity_2).toHaveLength(1)
        expect(re_find_infinity_2[0].id).toBe("infinity")

        const re_find_neg_infinity_2 = await table.findMany({ val: -Infinity })
        expect(re_find_neg_infinity_2).toHaveLength(1)
        expect(re_find_neg_infinity_2[0].id).toBe("neg_infinity")

        // 把 NaN 和 Infinity 更新为正常数，再查询
        await table.updateOne({ id: "nan" }, { $set: { val: 100, "arr.3": 4, "ob.val": 100 } })
        await table.updateOne({ id: "infinity" }, { $set: { val: 200, "arr.4": 5, "ob.val": 200 } })

        const doc_nan_normal = await table.get("nan")
        expect(doc_nan_normal.val).toBe(100)
        expect(doc_nan_normal.arr[3]).toBe(4)
        expect(doc_nan_normal.ob.val).toBe(100)

        const doc_inf_normal = await table.get("infinity")
        expect(doc_inf_normal.val).toBe(200)
        expect(doc_inf_normal.arr[4]).toBe(5)
        expect(doc_inf_normal.ob.val).toBe(200)

        // 再更新为 NaN 和 Infinity  再查询
        await table.updateOne({ id: "nan" }, { $set: { val: NaN, "arr.3": NaN, "ob.val": NaN } })
        await table.updateOne({ id: "infinity" }, { $set: { val: Infinity, "arr.4": Infinity, "ob.val": Infinity } })

        const doc_nan_back = await table.get("nan")
        expect(doc_nan_back.val).toBeNaN()
        expect(doc_nan_back.arr[3]).toBeNaN()
        expect(doc_nan_back.ob.val).toBeNaN()

        const doc_inf_back = await table.get("infinity")
        expect(doc_inf_back.val).toBe(Infinity)
        expect(doc_inf_back.arr[4]).toBe(Infinity)
        expect(doc_inf_back.ob.val).toBe(Infinity)

        // 验证可以通过值再次查找到
        const find_nan_back = await table.findOne({ val: NaN })
        expect(find_nan_back?.id).toBe("nan")

        // 再把 NaN 和 Infinity 更新为正常数，再查询
        await table.updateOne({ id: "nan" }, { $set: { val: 0 } })
        await table.updateOne({ id: "infinity" }, { $set: { val: 9999 } })

        const doc_nan_final = await table.get("nan")
        expect(doc_nan_final.val).toBe(0)
        
        const doc_inf_final = await table.get("infinity")
        expect(doc_inf_final.val).toBe(9999)
    })
})
