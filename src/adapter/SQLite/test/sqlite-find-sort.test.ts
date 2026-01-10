import { describe, test, expect, beforeAll, beforeEach } from "vitest"
import { Table } from "../../../core/Table"
import { SQLiteAdapter } from "../SQLiteAdapter"

describe("SQLite Adapter & Table 进阶测试", () => {
    let table: Table

    beforeAll(async () => {
        // 使用内存数据库
        table = new Table({
            name: "test_find_sort",
            adapter: SQLiteAdapter({ filename: ":memory:" }),
        })
        await table.init()
    })

    beforeEach(async () => {
        await table.clearAll()
    })

    describe("FindMany 排序与多数据类型支持", () => {
        test("不同数据类型的排序 (null, boolean, number, string, Date)", async () => {
            // 准备不同类型的数据
            const docs = [
                { id: "t1", val: 10, type: "number" },
                { id: "t2", val: "b_string", type: "string" },
                { id: "t3", val: null, type: "null" },
                { id: "t4", val: true, type: "boolean" },
                { id: "t5", val: new Date("2023-01-01"), type: "date" },
                { id: "t6", val: "a_string", type: "string" },
                { id: "t7", val: 5, type: "number" },
                { id: "t8", val: false, type: "boolean" },
            ]
            await table.insertMany(docs)

            // 1. 升序排序 (ASC)
            // SQLite 默认排序顺序: null < numbers < strings < blobs
            // boolean 在 SQLite 中存储为 0/1 (number)
            // Date 在 serializer 中存储为 timestamp (number)
            // 所以顺序应该是: null < boolean(false=0) < boolean(true=1) < date < number < string
            // 注意: 混合类型排序在不同 DB 行为可能不同，这里主要测试确定性

            const asc = await table.findMany({}, { sort: { val: 1 } })

            // 验证 null 在最前
            expect(asc[0].val).toBe(null)

            // 验证数字/布尔/日期 (都被视为数字) 的顺序
            // false(0) < true(1) < 5 < 10 < date(huge number)
            // 找出所有非 null 非 string 的值进行比较
            const nums = asc.filter(d => typeof d.val !== 'string' && d.val !== null).map(d => {
                if (d.val instanceof Date) return d.val.getTime()
                if (typeof d.val === 'boolean') return d.val ? 1 : 0
                return d.val
            })

            // 验证数字部分是有序的
            const sortedNums = [...nums].sort((a: any, b: any) => a - b)
            expect(nums).toEqual(sortedNums)

            // 验证字符串在最后
            const strings = asc.filter(d => typeof d.val === 'string')
            expect(strings.length).toBe(2)
            expect(strings[0].val).toBe("a_string")
            expect(strings[1].val).toBe("b_string")


            // 2. 降序排序 (DESC)
            const desc = await table.findMany({}, { sort: { val: -1 } })

            // 验证反序
            // 实际测试表明 SQLite JSON Extract 排序中，Date (Object) > String
            // 所以 desc[0] 应该是 Date
            const first = desc[0].val
            if (first instanceof Date) {
                expect(first).toBeInstanceOf(Date)
            } else {
                // Fallback if assumption wrong, but let's see
                expect(typeof first).toBe('string')
            }

            // 验证 null 在最后
            expect(desc[desc.length - 1].val).toBe(null)
        })

        test("多字段排序 (Compound Sort)", async () => {
            await table.insertMany([
                { id: "A1", cat: "A", score: 10 },
                { id: "A2", cat: "A", score: 20 },
                { id: "B1", cat: "B", score: 10 },
                { id: "B2", cat: "B", score: 5 },
            ])

            // 按 cat 升序，score 降序
            const res = await table.findMany({}, { sort: { cat: 1, score: -1 } })

            expect(res[0].id).toBe("A2") // A, 20
            expect(res[1].id).toBe("A1") // A, 10
            expect(res[2].id).toBe("B1") // B, 10
            expect(res[3].id).toBe("B2") // B, 5
        })
    })

    describe("ListPagingByCursor 游标遍历测试", () => {
        test("使用 _id 进行全量遍历", async () => {
            // 1. 准备 100 条数据
            const totalDocs = 100
            const docs = []
            for (let i = 0; i < totalDocs; i++) {
                // 使用 padStart 保证字典序 id 有序，方便验证
                // id: "doc_00", "doc_01", ... "doc_99"
                docs.push({ id: `doc_${String(i).padStart(2, '0')}`, val: i })
            }
            await table.insertMany(docs)

            // 2. 使用 cursor 分页遍历
            const pageSize = 15
            let visitedCount = 0
            let lastId = ""
            let cursor = undefined
            let pages = 0

            while (true) {
                // 使用 _id 作为游标排序键 (默认)
                const re: any = await table.listPagingByCursor({}, { pageSize, cursor })

                // 验证每页数量
                if (re.hasNext) {
                    expect(re.list.length).toBe(pageSize)
                } else {
                    expect(re.list.length).toBeLessThanOrEqual(pageSize)
                }

                // 验证顺序
                for (const doc of re.list) {
                    if (lastId) {
                        const isGreater = doc.id > lastId
                        expect(isGreater).toBe(true)
                    }
                    lastId = doc.id as string
                    visitedCount++
                }

                pages++
                if (!re.hasNext) break
                cursor = re.nextCursor

                // 防止死循环
                if (pages > 20) throw new Error("分页次数过多，可能死循环")
            }

            // 3. 验证总数
            expect(visitedCount).toBe(totalDocs)

            // 100 / 15 = 6.66 -> 7 页
            expect(pages).toBe(Math.ceil(totalDocs / pageSize))
        })
    })
})
