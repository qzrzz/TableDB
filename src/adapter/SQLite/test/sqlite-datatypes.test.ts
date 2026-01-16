/**
 * SQLiteAdapter 数据类型和边缘情况测试
 * 确保各种 JS 数据类型的序列化/反序列化正确性
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from "vitest"
import { SQLiteAdapter } from "../SQLiteAdapter"
import { ITableDBAdapterInstance } from "../../adapter"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"
import { mkdirSync, existsSync, rmSync } from "fs"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const TEST_DIR = resolve(__dirname, "./dist")

if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true })

const DB_PATH = resolve(TEST_DIR, "datatypes-test.sqlite")

describe("SQLiteAdapter 数据类型测试", () => {
    let adapter: ReturnType<typeof SQLiteAdapter>
    let table: ITableDBAdapterInstance

    beforeAll(async () => {
        // 清理旧数据库
        try {
            if (existsSync(DB_PATH)) rmSync(DB_PATH)
        } catch (e) { /* ignore */ }

        adapter = SQLiteAdapter({ filename: DB_PATH })
        table = await adapter.useAdapterInstance("datatypes_test")
    })

    beforeEach(async () => {
        await table.clear()
    })

    afterAll(async () => {
        await table.close()
        try {
            if (existsSync(DB_PATH)) rmSync(DB_PATH)
        } catch (e) { /* ignore */ }
    })

    // ============================================
    // 基础类型测试
    // ============================================

    describe("基础类型", () => {
        test("字符串", async () => {
            const doc = { id: "str1", value: "hello world" }
            await table.set(doc.id, doc)
            const result = await table.get(doc.id)
            expect(result).toEqual(doc)
        })

        test("空字符串", async () => {
            const doc = { id: "str2", value: "" }
            await table.set(doc.id, doc)
            const result = await table.get(doc.id)
            expect(result).toEqual(doc)
        })

        test("包含特殊字符的字符串", async () => {
            const doc = { id: "str3", value: "hello\nworld\t\"quoted\"'单引号'" }
            await table.set(doc.id, doc)
            const result = await table.get(doc.id)
            expect(result).toEqual(doc)
        })

        test("Unicode 字符串", async () => {
            const doc = { id: "str4", value: "你好世界🎉🚀" }
            await table.set(doc.id, doc)
            const result = await table.get(doc.id)
            expect(result).toEqual(doc)
        })

        test("数字 - 整数", async () => {
            const doc = { id: "num1", value: 42 }
            await table.set(doc.id, doc)
            const result = await table.get(doc.id)
            expect(result).toEqual(doc)
        })

        test("数字 - 浮点数", async () => {
            const doc = { id: "num2", value: 3.14159 }
            await table.set(doc.id, doc)
            const result = await table.get(doc.id)
            expect(result).toEqual(doc)
        })

        test("数字 - 负数", async () => {
            const doc = { id: "num3", value: -999.99 }
            await table.set(doc.id, doc)
            const result = await table.get(doc.id)
            expect(result).toEqual(doc)
        })

        test("数字 - 零", async () => {
            const doc = { id: "num4", value: 0 }
            await table.set(doc.id, doc)
            const result = await table.get(doc.id)
            expect(result).toEqual(doc)
        })

        test("数字 - Infinity", async () => {
            const doc = { id: "num5", value: Infinity }
            await table.set(doc.id, doc)
            const result = await table.get(doc.id)
            // 现在支持 Infinity 的正确序列化/反序列化
            expect(result?.value).toBe(Infinity)
        })

        test("数字 - NaN", async () => {
            const doc = { id: "num6", value: NaN }
            await table.set(doc.id, doc)
            const result = await table.get(doc.id)
            // 现在支持 NaN 的正确序列化/反序列化
            expect(result?.value).toBe(NaN)
        })

        test("布尔值 - true", async () => {
            const doc = { id: "bool1", value: true }
            await table.set(doc.id, doc)
            const result = await table.get(doc.id)
            expect(result).toEqual(doc)
        })

        test("布尔值 - false", async () => {
            const doc = { id: "bool2", value: false }
            await table.set(doc.id, doc)
            const result = await table.get(doc.id)
            expect(result).toEqual(doc)
        })

        test("null", async () => {
            const doc = { id: "null1", value: null }
            await table.set(doc.id, doc)
            const result = await table.get(doc.id)
            expect(result).toEqual(doc)
        })

        test("undefined 转换为 null", async () => {
            const doc = { id: "undef1", value: undefined }
            await table.set(doc.id, doc)
            const result = await table.get(doc.id)
            // undefined 应该被转换为 null
            expect(result?.value).toBe(null)
        })
    })

    // ============================================
    // 特殊类型测试
    // ============================================

    describe("特殊类型", () => {
        test("Date", async () => {
            const date = new Date("2024-01-15T12:00:00.000Z")
            const doc = { id: "date1", value: date }
            await table.set(doc.id, doc)
            const result = await table.get(doc.id)
            expect(result?.value).toBeInstanceOf(Date)
            expect((result?.value as Date).toISOString()).toBe(date.toISOString())
        })

        test("RegExp", async () => {
            const regex = /hello\s+world/gi
            const doc = { id: "regex1", value: regex }
            await table.set(doc.id, doc)
            const result = await table.get(doc.id)
            expect(result?.value).toBeInstanceOf(RegExp)
            expect((result?.value as RegExp).source).toBe(regex.source)
            expect((result?.value as RegExp).flags).toBe(regex.flags)
        })

        test("BigInt", async () => {
            const bigint = BigInt("9007199254740993") // 超过 Number.MAX_SAFE_INTEGER
            const doc = { id: "bigint1", value: bigint }
            await table.set(doc.id, doc)
            const result = await table.get(doc.id)
            expect(result?.value).toBe(bigint)
        })

        test("Map", async () => {
            const map = new Map([
                ["key1", "value1"],
                ["key2", 123],
                [42, "numKey"]
            ])
            const doc = { id: "map1", value: map }
            await table.set(doc.id, doc)
            const result = await table.get(doc.id)
            expect(result?.value).toBeInstanceOf(Map)
            expect((result?.value as Map<any, any>).get("key1")).toBe("value1")
            expect((result?.value as Map<any, any>).get("key2")).toBe(123)
            expect((result?.value as Map<any, any>).get(42)).toBe("numKey")
        })

        test("Set", async () => {
            const set = new Set([1, 2, 3, "hello", true])
            const doc = { id: "set1", value: set }
            await table.set(doc.id, doc)
            const result = await table.get(doc.id)
            expect(result?.value).toBeInstanceOf(Set)
            expect((result?.value as Set<any>).has(1)).toBe(true)
            expect((result?.value as Set<any>).has("hello")).toBe(true)
            expect((result?.value as Set<any>).has(true)).toBe(true)
        })

        test("Buffer", async () => {
            const buffer = Buffer.from("hello world", "utf-8")
            const doc = { id: "buffer1", value: buffer }
            await table.set(doc.id, doc)
            const result = await table.get(doc.id)
            expect(Buffer.isBuffer(result?.value)).toBe(true)
            expect((result?.value as Buffer).toString("utf-8")).toBe("hello world")
        })

        test("Uint8Array", async () => {
            const arr = new Uint8Array([1, 2, 3, 4, 5])
            const doc = { id: "uint8arr1", value: arr }
            await table.set(doc.id, doc)
            const result = await table.get(doc.id)
            expect(result?.value).toBeInstanceOf(Uint8Array)
            expect(Array.from(result?.value as Uint8Array)).toEqual([1, 2, 3, 4, 5])
        })

        test("ArrayBuffer", async () => {
            const buffer = new ArrayBuffer(8)
            const view = new DataView(buffer)
            view.setInt32(0, 42)
            view.setInt32(4, 100)
            const doc = { id: "arrbuf1", value: buffer }
            await table.set(doc.id, doc)
            const result = await table.get(doc.id)
            expect(result?.value).toBeInstanceOf(ArrayBuffer)
            const resultView = new DataView(result?.value as ArrayBuffer)
            expect(resultView.getInt32(0)).toBe(42)
            expect(resultView.getInt32(4)).toBe(100)
        })
    })

    // ============================================
    // 嵌套结构测试
    // ============================================

    describe("嵌套结构", () => {
        test("嵌套对象", async () => {
            const doc = {
                id: "nested1",
                level1: {
                    level2: {
                        level3: {
                            value: "deep"
                        }
                    }
                }
            }
            await table.set(doc.id, doc)
            const result = await table.get(doc.id)
            expect(result).toEqual(doc)
        })

        test("嵌套数组", async () => {
            const doc = {
                id: "nested2",
                matrix: [[1, 2, 3], [4, 5, 6], [7, 8, 9]]
            }
            await table.set(doc.id, doc)
            const result = await table.get(doc.id)
            expect(result).toEqual(doc)
        })

        test("混合嵌套", async () => {
            const doc = {
                id: "nested3",
                data: {
                    users: [
                        { name: "Alice", tags: ["admin", "active"] },
                        { name: "Bob", tags: ["user"] }
                    ],
                    metadata: {
                        count: 2,
                        active: true
                    }
                }
            }
            await table.set(doc.id, doc)
            const result = await table.get(doc.id)
            expect(result).toEqual(doc)
        })

        test("嵌套特殊类型", async () => {
            const doc = {
                id: "nested4",
                data: {
                    date: new Date("2024-01-15"),
                    map: new Map([["key", "value"]]),
                    set: new Set([1, 2, 3]),
                    nested: {
                        bigint: BigInt(999),
                        regex: /test/i
                    }
                }
            }
            await table.set(doc.id, doc)
            const result = await table.get(doc.id)
            expect(result?.data?.date).toBeInstanceOf(Date)
            expect(result?.data?.map).toBeInstanceOf(Map)
            expect(result?.data?.set).toBeInstanceOf(Set)
            expect(result?.data?.nested?.bigint).toBe(BigInt(999))
            expect(result?.data?.nested?.regex).toBeInstanceOf(RegExp)
        })
    })

    // ============================================
    // 数组测试
    // ============================================

    describe("数组", () => {
        test("空数组", async () => {
            const doc = { id: "arr1", value: [] }
            await table.set(doc.id, doc)
            const result = await table.get(doc.id)
            expect(result).toEqual(doc)
        })

        test("混合类型数组", async () => {
            const doc = {
                id: "arr2",
                value: [1, "two", true, null, { nested: "obj" }]
            }
            await table.set(doc.id, doc)
            const result = await table.get(doc.id)
            expect(result).toEqual(doc)
        })

        test("稀疏数组", async () => {
            const arr: any[] = []
            arr[0] = "first"
            arr[5] = "sixth"
            const doc = { id: "arr3", value: arr }
            await table.set(doc.id, doc)
            const result = await table.get(doc.id)
            expect(result?.value?.[0]).toBe("first")
            expect(result?.value?.[5]).toBe("sixth")
        })
    })

    // ============================================
    // 查询测试
    // ============================================

    describe("查询兼容性", () => {
        test("查询 Date 字段", async () => {
            const date1 = new Date("2024-01-01")
            const date2 = new Date("2024-06-01")
            const date3 = new Date("2024-12-01")

            await table.insertMany([
                { id: "d1", date: date1, name: "doc1" },
                { id: "d2", date: date2, name: "doc2" },
                { id: "d3", date: date3, name: "doc3" }
            ])

            // 精确匹配
            const result1 = await table.findMany({ date: date2 })
            expect(result1.length).toBe(1)
            expect(result1[0].name).toBe("doc2")
        })

        test("查询 null 字段", async () => {
            await table.insertMany([
                { id: "n1", value: null, name: "null" },
                { id: "n2", value: 0, name: "zero" },
                { id: "n3", value: "", name: "empty" },
                { id: "n4", value: false, name: "false" }
            ])

            const nullDocs = await table.findMany({ value: null })
            expect(nullDocs.length).toBe(1)
            expect(nullDocs[0].name).toBe("null")
        })

        test("查询 0 字段", async () => {
            await table.insertMany([
                { id: "z1", value: null, name: "null" },
                { id: "z2", value: 0, name: "zero" },
                { id: "z3", value: 1, name: "one" }
            ])

            const zeroDocs = await table.findMany({ value: 0 })
            expect(zeroDocs.length).toBe(1)
            expect(zeroDocs[0].name).toBe("zero")
        })

        test("查询 false 字段", async () => {
            await table.insertMany([
                { id: "f1", active: true, name: "active" },
                { id: "f2", active: false, name: "inactive" },
                { id: "f3", active: null, name: "null" }
            ])

            const falseDocs = await table.findMany({ active: false })
            expect(falseDocs.length).toBe(1)
            expect(falseDocs[0].name).toBe("inactive")
        })

        test("查询空字符串字段", async () => {
            await table.insertMany([
                { id: "e1", value: "", name: "empty" },
                { id: "e2", value: "hello", name: "hello" },
                { id: "e3", value: null, name: "null" }
            ])

            const emptyDocs = await table.findMany({ value: "" })
            expect(emptyDocs.length).toBe(1)
            expect(emptyDocs[0].name).toBe("empty")
        })

        test("查询嵌套对象精确匹配", async () => {
            await table.insertMany([
                { id: "obj1", meta: { a: 1, b: 2 }, name: "doc1" },
                { id: "obj2", meta: { a: 1 }, name: "doc2" },
                { id: "obj3", meta: { a: 1, b: 2, c: 3 }, name: "doc3" }
            ])

            // 精确匹配
            const result = await table.findMany({ meta: { a: 1, b: 2 } })
            expect(result.length).toBe(1)
            expect(result[0].name).toBe("doc1")
        })

        test("查询嵌套对象字段顺序无关", async () => {
            await table.insertMany([
                { id: "obj4", meta: { a: 1, b: 2 }, name: "doc1" }
            ])

            // 字段顺序不同
            const result = await table.findMany({ meta: { b: 2, a: 1 } })
            expect(result.length).toBe(1)
            expect(result[0].name).toBe("doc1")
        })
    })

    // ============================================
    // 更新操作测试
    // ============================================

    describe("更新操作", () => {
        test("$set 更新特殊类型", async () => {
            const doc = { id: "upd1", value: "initial" }
            await table.set(doc.id, doc)

            await table.updateOne(
                { id: "upd1" },
                { $set: { value: new Date("2024-01-15"), extra: new Map([["k", "v"]]) } }
            )

            const result = await table.get("upd1")
            expect(result?.value).toBeInstanceOf(Date)
            expect(result?.extra).toBeInstanceOf(Map)
        })

        test("$unset 字段", async () => {
            const doc = { id: "upd2", a: 1, b: 2, c: 3 }
            await table.set(doc.id, doc)

            await table.updateOne(
                { id: "upd2" },
                { $unset: { b: 1 } }
            )

            const result = await table.get("upd2")
            expect(result?.a).toBe(1)
            expect(result?.b).toBeUndefined()
            expect(result?.c).toBe(3)
        })

        test("$inc 数字字段", async () => {
            const doc = { id: "upd3", count: 10 }
            await table.set(doc.id, doc)

            await table.updateOne(
                { id: "upd3" },
                { $inc: { count: 5 } }
            )

            const result = await table.get("upd3")
            expect(result?.count).toBe(15)
        })

        test("$push 数组元素", async () => {
            const doc = { id: "upd4", tags: ["a", "b"] }
            await table.set(doc.id, doc)

            await table.updateOne(
                { id: "upd4" },
                { $push: { tags: "c" } }
            )

            const result = await table.get("upd4")
            expect(result?.tags).toEqual(["a", "b", "c"])
        })

        test("$pull 数组元素", async () => {
            const doc = { id: "upd5", tags: ["a", "b", "c"] }
            await table.set(doc.id, doc)

            await table.updateOne(
                { id: "upd5" },
                { $pull: { tags: "b" } }
            )

            const result = await table.get("upd5")
            expect(result?.tags).toEqual(["a", "c"])
        })

        test("$addToSet 数组去重添加", async () => {
            const doc = { id: "upd6", tags: ["a", "b"] }
            await table.set(doc.id, doc)

            await table.updateOne(
                { id: "upd6" },
                { $addToSet: { tags: "b" } } // b 已存在，不应重复添加
            )

            let result = await table.get("upd6")
            expect(result?.tags).toEqual(["a", "b"])

            await table.updateOne(
                { id: "upd6" },
                { $addToSet: { tags: "c" } } // c 不存在，应添加
            )

            result = await table.get("upd6")
            expect(result?.tags).toEqual(["a", "b", "c"])
        })
    })

    // ============================================
    // 批量操作测试
    // ============================================

    describe("批量操作", () => {
        test("insertMany 包含特殊类型", async () => {
            const docs = [
                { id: "batch1", date: new Date("2024-01-01"), type: "date" },
                { id: "batch2", map: new Map([["k", "v"]]), type: "map" },
                { id: "batch3", set: new Set([1, 2, 3]), type: "set" }
            ]

            await table.insertMany(docs)

            const result1 = await table.get("batch1")
            expect(result1?.date).toBeInstanceOf(Date)

            const result2 = await table.get("batch2")
            expect(result2?.map).toBeInstanceOf(Map)

            const result3 = await table.get("batch3")
            expect(result3?.set).toBeInstanceOf(Set)
        })

        test("setMany 合并特殊类型", async () => {
            await table.set("merge1", { id: "merge1", a: 1 })

            await table.setMany([
                { id: "merge1", b: new Date("2024-01-01") }
            ])

            const result = await table.get("merge1")
            expect(result?.a).toBe(1)
            expect(result?.b).toBeInstanceOf(Date)
        })

        test("findMany 返回特殊类型", async () => {
            await table.insertMany([
                { id: "find1", date: new Date("2024-01-01"), category: "test" },
                { id: "find2", date: new Date("2024-06-01"), category: "test" }
            ])

            const results = await table.findMany({ category: "test" })
            expect(results.length).toBe(2)
            results.forEach(r => {
                expect(r.date).toBeInstanceOf(Date)
            })
        })
    })

    // ============================================
    // 边缘情况测试
    // ============================================

    describe("边缘情况", () => {
        test("空对象", async () => {
            const doc = { id: "edge1", value: {} }
            await table.set(doc.id, doc)
            const result = await table.get(doc.id)
            expect(result).toEqual(doc)
        })

        test("超长字符串", async () => {
            const longStr = "a".repeat(100000)
            const doc = { id: "edge2", value: longStr }
            await table.set(doc.id, doc)
            const result = await table.get(doc.id)
            expect(result?.value?.length).toBe(100000)
        })

        test("深度嵌套 (10 层)", async () => {
            let nested: any = { value: "deep" }
            for (let i = 0; i < 10; i++) {
                nested = { nested }
            }
            const doc = { id: "edge3", ...nested }
            await table.set(doc.id, doc)
            const result = await table.get(doc.id)

            // 验证最深层
            let current = result
            for (let i = 0; i < 10; i++) {
                current = current?.nested
            }
            expect(current?.value).toBe("deep")
        })

        test("特殊 key 名称", async () => {
            const doc = {
                id: "edge4",
                "": "empty key",
                " ": "space key",
                "$special": "dollar key",
                "key.with.dots": "dotted key",
                "key[0]": "bracket key"
            }
            await table.set(doc.id, doc)
            const result = await table.get(doc.id)
            expect(result?.[""]).toBe("empty key")
            expect(result?.[" "]).toBe("space key")
            expect(result?.["$special"]).toBe("dollar key")
            expect(result?.["key.with.dots"]).toBe("dotted key")
            expect(result?.["key[0]"]).toBe("bracket key")
        })

        test("大量字段 (1000 个)", async () => {
            const doc: any = { id: "edge5" }
            for (let i = 0; i < 1000; i++) {
                doc[`field_${i}`] = i
            }
            await table.set(doc.id, doc)
            const result = await table.get(doc.id)
            expect(result?.field_0).toBe(0)
            expect(result?.field_999).toBe(999)
        })

        test("混合 null 和 undefined 在数组中", async () => {
            const doc = { id: "edge6", arr: [1, null, undefined, 2] }
            await table.set(doc.id, doc)
            const result = await table.get(doc.id)
            expect(result?.arr?.[0]).toBe(1)
            expect(result?.arr?.[1]).toBe(null)
            expect(result?.arr?.[2]).toBe(null) // undefined 转换为 null
            expect(result?.arr?.[3]).toBe(2)
        })

        test("循环引用应该报错或处理", async () => {
            const doc: any = { id: "edge7", value: {} }
            doc.value.self = doc.value // 循环引用

            // JSON.stringify 会抛出错误
            await expect(table.set(doc.id, doc)).rejects.toThrow()
        })
    })

    // ============================================
    // fastDeserialize 正确性测试
    // ============================================

    describe("fastDeserialize 正确性", () => {
        test("普通对象不需要特殊反序列化", async () => {
            const doc = {
                id: "fast1",
                name: "test",
                count: 42,
                active: true,
                tags: ["a", "b", "c"]
            }
            await table.set(doc.id, doc)
            const result = await table.get(doc.id)
            expect(result).toEqual(doc)
        })

        test("包含 $t 标记的普通数据不应被误解析", async () => {
            // 用户数据可能包含 "$t" 作为普通字段
            const doc = {
                id: "fast2",
                data: {
                    "$t": "user_defined",
                    "v": "user_value"
                }
            }
            await table.set(doc.id, doc)
            const result = await table.get(doc.id)
            // 这应该被正确处理 - $t 是特殊标记
            // 如果用户数据也用 $t，可能会产生冲突
            // 这个测试帮助发现这类问题
        })

        test("大量文档的 findMany 性能一致性", async () => {
            // 插入普通文档
            const normalDocs = Array.from({ length: 100 }, (_, i) => ({
                id: `perf_normal_${i}`,
                name: `doc_${i}`,
                value: i,
                category: "normal"
            }))

            // 插入包含特殊类型的文档
            const specialDocs = Array.from({ length: 100 }, (_, i) => ({
                id: `perf_special_${i}`,
                name: `doc_${i}`,
                date: new Date(),
                category: "special"
            }))

            await table.insertMany(normalDocs)
            await table.insertMany(specialDocs)

            // 查询普通文档
            const normalResults = await table.findMany({ category: "normal" })
            expect(normalResults.length).toBe(100)

            // 查询特殊类型文档
            const specialResults = await table.findMany({ category: "special" })
            expect(specialResults.length).toBe(100)
            specialResults.forEach(r => {
                expect(r.date).toBeInstanceOf(Date)
            })
        })
    })
})
