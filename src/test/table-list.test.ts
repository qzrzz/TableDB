import { Table } from "../core/Table"
import { getTestTableByType, TestDatabaseType } from "./getTestTable"
import { ITableDoc } from "../adapter/adapter"

const DATABASE_TYPES: TestDatabaseType[] = ["sqlite", "mongodb"]

interface ITestDoc extends ITableDoc {
    id: string
    name: string
    age: number
    tags: string[]
    score: number
    meta: { active: boolean }
}

describe.each(DATABASE_TYPES)("Table List - %s", async (dbType) => {
    let table!: Table<ITestDoc>

    beforeAll(async () => {
        table = (await getTestTableByType("table-list.test", dbType)) as any
        await table.clearAll()
    })

    beforeEach(async () => {
        await table.clearAll()
        // 填充测试用的通用数据
        let count = 5000

        let docs = []
        for (let i = 0; i < count; i++) {
            docs.push({
                id: `${i}`,
                name: `Name${i}`,
                age: 20 + (i % 30),
                tags: ["tag1", "tag2"],
                score: i * 10,
                meta: { active: i % 2 === 0 },
            })
        }
        await table.insertMany(docs)
    })

    test("listPaging", async () => {
        let re = await table.listPaging({}, { pageIndex: 1, pageSize: 10 })
        expect(re.pageIndex).toBe(1)
        expect(re.pageSize).toBe(10)
        expect(re.list.length).toBe(10)
        expect(re.hasNext).toBe(true)
        expect(re.list[0].id).toBe("0")

        let re2 = await table.listPaging({}, { pageIndex: 2, pageSize: 10 })
        expect(re2.pageIndex).toBe(2)
        expect(re2.pageSize).toBe(10)
        expect(re2.list.length).toBe(10)
        expect(re2.hasNext).toBe(true)
        expect(re2.list[0].id).toBe("10")
    })

    test("listPaging with getTotal", async () => {
        let re = await table.listPaging({}, { pageIndex: 1, pageSize: 10, getTotal: true })
        expect(re.total).toBe(5000)
    })

    test("listPaging sort", async () => {
        let re = await table.listPaging({}, { pageIndex: 1, pageSize: 10, sort: { score: -1 } })
        expect(re.list[0].score).toBe(49990)
        expect(re.list[1].score).toBe(49980)
    })

    test("listPaging markDelete", async () => {
        table.options.enableMarkDelete = true
        await table.delete("0")
        await table.delete("1")
        await table.delete("2")

        // 默认情况，应该过滤掉已删除的
        let re = await table.listPaging({}, { pageIndex: 1, pageSize: 10 })
        expect(re.list[0].id).toBe("3")
        expect(re.list.find((d) => d.id === "0")).toBeUndefined()

        // 验证总数（过滤后的）
        let reTotal = await table.listPaging({}, { pageIndex: 1, pageSize: 10, getTotal: true })
        expect(reTotal.total).toBe(4997)

        // 使用 ignoreMarkDelete: true，应该能查到已删除的
        let reIgnored = await table.listPaging({}, { pageIndex: 1, pageSize: 10, ignoreMarkDelete: true })
        expect(reIgnored.list.find((d) => d.id === "0")).toBeDefined()
        expect((reIgnored.list.find((d) => d.id === "0") as any)._isDeleted).toBe(true)

        // 验证总数（包含已删除的）
        let reTotalIgnored = await table.listPaging(
            {},
            {
                pageIndex: 1,
                pageSize: 10,
                getTotal: true,
                ignoreMarkDelete: true,
            }
        )
        expect(reTotalIgnored.total).toBe(5000)

        table.options.enableMarkDelete = false
    })

    test("listPagingByCursor", async () => {
        // 1. Default sort (by id string)
        let re1 = await table.listPagingByCursor({}, { pageSize: 10 })
        expect(re1.list.length).toBe(10)
        expect(re1.hasNext).toBe(true)
        expect(re1.nextCursor).toBeDefined()

        // 2. Sort by score (number)
        let reScore1 = await table.listPagingByCursor({}, { pageSize: 10, sortKey: "score", sortOrder: 1 })
        expect(reScore1.list.length).toBe(10)
        expect(reScore1.list[0].score).toBe(0)
        expect(reScore1.list[9].score).toBe(90)
        expect(reScore1.nextCursor).toBe(90)

        // 3. Next page with cursor
        let reScore2 = await table.listPagingByCursor(
            {},
            {
                pageSize: 10,
                sortKey: "score",
                sortOrder: 1,
                cursor: reScore1.nextCursor,
            }
        )
        expect(reScore2.list.length).toBe(10)
        expect(reScore2.list[0].score).toBe(100)

        // 4. Sort Desc
        let reDesc1 = await table.listPagingByCursor({}, { pageSize: 10, sortKey: "score", sortOrder: -1 })
        // 49990, 49980 ...
        expect(reDesc1.list[0].score).toBe(49990)
        expect(reDesc1.nextCursor).toBe(49900)

        let reDesc2 = await table.listPagingByCursor(
            {},
            {
                pageSize: 10,
                sortKey: "score",
                sortOrder: -1,
                cursor: reDesc1.nextCursor,
            }
        )
        expect(reDesc2.list[0].score).toBe(49890)
    })

    test("listPagingByCursor doc", async () => {
        await table.clearAll()
        let docs: any = [
            { id: "1", value: 1, t: "t1" },
            { id: "2", value: 2, t: "t2" },
            { id: "3", value: 3, t: "t3" },
        ]
        await table.insertMany(docs)

        let re1 = await table.listPagingByCursor({}, { pageSize: 10 })

        expect(re1).toEqual({
            list: docs,
            hasNext: false,
            nextCursor: re1.nextCursor,
        })
    })

    test("eachBatch", async () => {
        let totalDocs = 0
        let batchCount = 0

        await table.eachBatch({}, { pageSize: 1000 }, async (list, stop, batch) => {
            totalDocs += list.length
            batchCount = batch
        })

        expect(totalDocs).toBe(5000)
        expect(batchCount).toBe(4) // 0, 1, 2, 3, 4 -> 5 batches. 5000/1000 = 5. batch index starts at 0. So last batch index is 4.

        // Test stop
        let totalDocs2 = 0
        await table.eachBatch({}, { pageSize: 100 }, async (list, stop, batch) => {
            totalDocs2 += list.length
            if (totalDocs2 >= 200) {
                stop()
            }
        })
        expect(totalDocs2).toBe(200)
    })
})
