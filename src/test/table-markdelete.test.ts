import { describe, test, expect, beforeAll, beforeEach, afterAll } from "vitest"
import { Table } from "../core/Table"
import { getTestTableByType, TestDatabaseType } from "./getTestTable"

const DATABASE_TYPES: TestDatabaseType[] = ["sqlite", "mongodb", "indexeddb"]

describe.each(DATABASE_TYPES)("Table MarkDelete - %s", async (dbType) => {
    let table!: Table

    beforeAll(async () => {
        table = await getTestTableByType("table-markdelete.test", dbType)
        table.options.enableMarkDelete = true
        await table.clearAll()
    })

    beforeEach(async () => {
        await table.clearAll()
    })

    afterAll(() => {
        table.options.enableMarkDelete = false
    })

    test("delete 默认标记删除，读取默认过滤", async () => {
        await table.setMany([
            { id: "1", group: "A", val: 10 },
            { id: "2", group: "B", val: 20 },
        ])

        await table.delete("1")

        expect(await table.get("1")).toBeUndefined()
        expect(await table.has("1")).toBe(false)
        expect(await table.count()).toBe(1)

        // 默认查询不会返回标记删除的数据
        const list = await table.findMany({})
        expect(list.map((d) => d.id)).toEqual(["2"])
        expect(await table.findOne({ id: "1" })).toBeUndefined()

        // ignoreMarkDelete: true 时可看到标记删除数据
        const listAll = await table.findMany({}, { ignoreMarkDelete: true })
        expect(listAll.map((d) => d.id).sort()).toEqual(["1", "2"])
        expect((listAll.find((d) => d.id === "1") as any)._isDeleted).toBe(true)
        const oneAll = await table.findOne({ id: "1" }, { ignoreMarkDelete: true })
        expect((oneAll as any)._isDeleted).toBe(true)
    })

    test("get/has 支持 ignoreMarkDelete", async () => {
        await table.set("k1", { val: 1 })
        await table.delete("k1")

        expect(await table.get("k1")).toBeUndefined()
        expect(await table.has("k1")).toBe(false)

        const ignored = await table.get("k1", { ignoreMarkDelete: true })
        expect((ignored as any)._isDeleted).toBe(true)
        expect(await table.has("k1", { ignoreMarkDelete: true })).toBe(true)
    })

    test("delete readDelete 直接物理删除", async () => {
        await table.set("d1", { val: 1 })

        await table.delete("d1", { readDelete: true })

        expect(await table.has("d1")).toBe(false)
        expect(await table.count({}, { ignoreMarkDelete: true })).toBe(0)
        expect(await table.findMany({}, { ignoreMarkDelete: true })).toEqual([])
    })

    test("deleteOne readDelete 物理删除", async () => {
        await table.setMany([
            { id: "rd1", group: "RD", score: 1 },
            { id: "rd2", group: "RD", score: 2 },
        ])

        const res = await table.deleteOne({ group: "RD" }, { sort: { score: 1 }, readDelete: true })
        expect(res.deletedCount).toBe(1)

        // 即便忽略标记删除，也找不到已物理删除的文档
        const all = await table.findMany({ group: "RD" }, { ignoreMarkDelete: true, sort: { score: 1 } })
        expect(all.map((d) => d.id)).toEqual(["rd2"])
    })

    test("deleteMany 标记删除并统计", async () => {
        await table.setMany([
            { id: "a1", group: "A" },
            { id: "a2", group: "A" },
            { id: "b1", group: "B" },
        ])

        const res = await table.deleteMany({ group: "A" })
        expect(res.deletedCount).toBe(2)

        // 默认计数/查询只看到未删除数据
        expect(await table.count()).toBe(1)
        expect((await table.findMany({})).map((d) => d.id)).toEqual(["b1"])

        // 忽略标记删除时可以看到被标记的数据
        const all = await table.findMany({}, { ignoreMarkDelete: true })
        expect(all.map((d) => d.id).sort()).toEqual(["a1", "a2", "b1"])
        expect(all.filter((d) => (d as any)._isDeleted === true).length).toBe(2)
    })

    test("findMany/findOne 显式查询已删除数据", async () => {
        await table.setMany([
            { id: "f1", group: "F" },
            { id: "f2", group: "F" },
        ])

        await table.delete("f1")

        // 通过 _isDeleted:true 可直接查到已删除文档（__check_filter 不会覆盖）
        const deletedOnly = await table.findMany({ _isDeleted: true })
        expect(deletedOnly.map((d) => d.id)).toEqual(["f1"])

        const deletedOne = await table.findOne({ _isDeleted: true })
        expect(deletedOne && (deletedOne as any)._isDeleted).toBe(true)

        // 未删除文档仍可正常查到
        const normal = await table.findMany({ group: "F" })
        expect(normal.map((d) => d.id)).toEqual(["f2"])
    })

    test("count 默认过滤已删除，可通过 ignoreMarkDelete 查看全部", async () => {
        await table.setMany([
            { id: "c1" },
            { id: "c2" },
        ])
        await table.delete("c1")

        expect(await table.count()).toBe(1)
        expect(await table.count({}, { ignoreMarkDelete: true })).toBe(2)
    })

    test("listPaging 默认过滤已删除，ignoreMarkDelete 返回全部", async () => {
        await table.setMany([
            { id: "l1", score: 1 },
            { id: "l2", score: 2 },
            { id: "l3", score: 3 },
            { id: "l4", score: 4 },
            { id: "l5", score: 5 },
        ])

        await table.delete("l1")
        await table.delete("l2")

        const re = await table.listPaging({}, { pageIndex: 1, pageSize: 3, sort: { id: 1 }, getTotal: true })
        expect(re.list.map((d) => d.id)).toEqual(["l3", "l4", "l5"])
        expect(re.total).toBe(3)
        expect(re.hasNext).toBe(false)

        const reAll = await table.listPaging(
            {},
            { pageIndex: 1, pageSize: 5, sort: { id: 1 }, getTotal: true, ignoreMarkDelete: true }
        )
        expect(reAll.list.map((d) => d.id)).toEqual(["l1", "l2", "l3", "l4", "l5"])
        expect((reAll.list.find((d) => d.id === "l1") as any)._isDeleted).toBe(true)
        expect(reAll.total).toBe(5)
    })

    test("listPagingByCursor 默认过滤标记删除，可忽略过滤", async () => {
        await table.setMany([
            { id: "c1", score: 1 },
            { id: "c2", score: 2 },
            { id: "c3", score: 3 },
            { id: "c4", score: 4 },
            { id: "c5", score: 5 },
        ])

        await table.delete("c1")
        await table.delete("c2")

        // 默认只返回未删除
        const page1 = await table.listPagingByCursor({}, { pageSize: 2, sortKey: "id", sortOrder: 1 })
        expect(page1.list.map((d) => d.id)).toEqual(["c3", "c4"])
        expect(page1.hasNext).toBe(true)
        expect(page1.nextCursor).toBe("c4")

        const page2 = await table.listPagingByCursor({}, { pageSize: 2, sortKey: "id", sortOrder: 1, cursor: page1.nextCursor })
        expect(page2.list.map((d) => d.id)).toEqual(["c5"])
        expect(page2.hasNext).toBe(false)

        // 忽略标记删除时返回全部并保留标记
        const pAll1 = await table.listPagingByCursor(
            {},
            { pageSize: 2, sortKey: "id", sortOrder: 1, ignoreMarkDelete: true }
        )
        expect(pAll1.list.map((d) => d.id)).toEqual(["c1", "c2"])
        expect((pAll1.list[0] as any)._isDeleted).toBe(true)
        expect(pAll1.hasNext).toBe(true)

        const pAll2 = await table.listPagingByCursor(
            {},
            { pageSize: 2, sortKey: "id", sortOrder: 1, cursor: pAll1.nextCursor, ignoreMarkDelete: true }
        )
        expect(pAll2.list.map((d) => d.id)).toEqual(["c3", "c4"])
        expect(pAll2.hasNext).toBe(true)
    })

    test("deleteOne 标记删除并可恢复查询", async () => {
        await table.setMany([
            { id: "x1", group: "X", score: 1 },
            { id: "x2", group: "X", score: 2 },
        ])

        const res = await table.deleteOne({ group: "X" }, { sort: { score: 1 } })
        expect(res.deletedCount).toBe(1)

        // 默认只剩下一条未删除记录
        const remain = await table.findMany({ group: "X" })
        expect(remain.map((d) => d.id)).toEqual(["x2"])

        // ignoreMarkDelete: true 返回全部并能看到 _isDeleted 标记
        const withDeleted = await table.findMany({ group: "X" }, { ignoreMarkDelete: true, sort: { score: 1 } })
        expect(withDeleted.map((d) => d.id)).toEqual(["x1", "x2"])
        expect((withDeleted.find((d) => d.id === "x1") as any)._isDeleted).toBe(true)
    })
})
