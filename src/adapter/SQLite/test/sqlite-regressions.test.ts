import { SQLiteAdapter } from "../SQLiteAdapter"
import { defineTable } from "../../../core/defineTable"

describe("SQLiteAdapter 修复回归测试", () => {
    let adapter: any
    let factory: any

    beforeEach(async () => {
        factory = SQLiteAdapter({ filename: ":memory:" })
        adapter = await factory.useAdapterInstance("regressionTable")
    })

    afterEach(async () => {
        if (adapter) await adapter.close()
    })

    test("仅投影 _id 时不应泄露文档字段", async () => {
        await adapter.set("doc", { id: "doc", name: "secret", value: 1 })

        const docs = await adapter.findMany({}, { projection: { _id: 1 } })

        expect(docs).toEqual([{ _id: 1 }])
    })

    test("混合类型字段的范围查询只匹配同类型标量", async () => {
        await adapter.insertMany([
            { id: "number", age: 10 },
            { id: "string", age: "1" },
            { id: "array", age: [20] },
        ])

        const docs = await adapter.findMany({ age: { $gt: 0 } })

        // MongoDB 范围查询允许数组元素参与比较，但字符串不应被隐式转换为数字。
        expect(docs.map((doc: any) => doc.id)).toEqual(["number", "array"])
    })

    test("Infinity 仍参与同类型数值范围比较", async () => {
        await adapter.insertMany([
            { id: "max", value: Number.MAX_SAFE_INTEGER },
            { id: "infinity", value: Infinity },
        ])

        const docs = await adapter.findMany({ value: { $gt: Number.MAX_SAFE_INTEGER } })

        expect(docs.map((doc: any) => doc.id)).toEqual(["infinity"])
    })

    test("默认 _id 游标分页返回完整文档", async () => {
        const useTable = defineTable({
            name: "cursorRegressionTable",
            adapter: SQLiteAdapter({ filename: ":memory:" }),
        })
        const table = await useTable()
        await table.insertMany([
            { id: "one", value: 1 },
            { id: "two", value: 2 },
            { id: "three", value: 3 },
        ])

        const result = await table.listPagingByCursor({}, { pageSize: 2 })

        expect(result.list).toEqual([
            { id: "one", value: 1 },
            { id: "two", value: 2 },
        ])
        expect(result.hasNext).toBe(true)
        expect(result.nextCursor).toBeDefined()
        await table.close()
    })

    test("第二个实例查询前会刷新 dirty 字段信息", async () => {
        const writer = await factory.useAdapterInstance("sharedTable")
        const reader = await factory.useAdapterInstance("sharedTable")

        await writer.set("doc", { id: "doc", tags: ["red"] })
        await writer.close()
        const docs = await reader.findMany({ tags: "red" })

        expect(docs.map((doc: any) => doc.id)).toEqual(["doc"])
        await reader.close()
        await adapter.close()
        adapter = undefined
    })

    test("复合索引不会错误引用不存在的单字段侧表", async () => {
        await adapter.defineIndexes([{ key: { a: 1, b: 1 } }])
        await adapter.insertMany([
            { id: "one", a: 1, b: 2 },
            { id: "two", a: 2, b: 1 },
        ])

        const docs = await adapter.findMany({ a: 1 })

        expect(docs.map((doc: any) => doc.id)).toEqual(["one"])
    })

    test("adapter 直接 insertMany 时无 id 文档也各自生成 id", async () => {
        const result = await adapter.insertMany([{ value: 1 }, { value: 2 }, { value: 3 }])

        expect(result.insertedCount).toBe(3)
        expect(result.skippedCount).toBe(0)
        expect(await adapter.count()).toBe(3)
    })

    test("_id 字符串必须严格是数字才参与整数比较", async () => {
        await adapter.insertMany(Array.from({ length: 12 }, (_, index) => ({ id: `doc-${index}` })))

        const docs = await adapter.findMany({ _id: "12abc" })

        expect(docs).toEqual([])
    })

    test("查询从未出现的字段不会误匹配全部文档", async () => {
        await adapter.set("doc", { value: 1 })

        expect(await adapter.findMany({ missing: 42 })).toEqual([])
        expect(await adapter.count({ missing: 42 })).toBe(0)
    })

    test("id 和 _id 的集合及范围查询使用数据库真实列", async () => {
        await adapter.set("x", { value: 1 })
        await adapter.set("z", { value: 2 })

        expect(await adapter.findMany({ id: { $in: ["x"] } })).toEqual([{ value: 1 }])
        expect(await adapter.findMany({ _id: { $in: [1] } })).toEqual([{ value: 1 }])
        expect(await adapter.findMany({ id: { $gt: "y" } })).toEqual([{ value: 2 }])
    })

    test("普通的 $t 对象不会被误解释为序列化标记", async () => {
        const markerLike = { $t: "d", v: "2030-01-01T00:00:00.000Z" }
        await adapter.set("marker", { id: "marker", payload: markerLike })

        const doc = await adapter.get("marker")

        expect(doc?.payload).toEqual(markerLike)
        expect(doc?.payload).not.toBeInstanceOf(Date)
    })

    test("用户字段名与内部序列化标记冲突时仍可无损往返", async () => {
        const payload = {
            "\u0000$t": "d",
            "\u0000key:$t": "keep",
            v: "2030-01-01T00:00:00.000Z",
        }
        await adapter.set("reserved-keys", { payload })

        expect((await adapter.get("reserved-keys"))?.payload).toEqual(payload)
    })

    test("setMany 合并新 Blob 时保留 Blob 类型", async () => {
        if (typeof Blob === "undefined") return
        await adapter.setMany([{ id: "blob", value: 1 }])
        await adapter.setMany([{ id: "blob", payload: new Blob(["x"]) }])

        const doc = await adapter.get("blob")

        expect(doc?.payload).toBeInstanceOf(Blob)
        expect((doc?.payload as Blob).size).toBe(1)
    })

    test("bulkUpdateSync 的 no-op 和 upsert 计数与普通更新一致", async () => {
        await adapter.set("one", { id: "one", value: 1 })

        const noOp = await adapter.bulkUpdateSync([{ filter: { id: "one" }, updateOp: { $set: { value: 1 } } }])
        const upsert = await adapter.bulkUpdateSync([
            { filter: { id: "two" }, updateOp: { $set: { value: 2 } }, options: { upsert: true } },
        ])

        expect(noOp).toMatchObject({ matchedCount: 1, modifiedCount: 0 })
        expect(upsert).toMatchObject({ matchedCount: 0, modifiedCount: 0 })
        expect(upsert.upsertedIds).toEqual(["two"])
    })

    test("默认模式的 runTransaction 会在异常时回滚", async () => {
        await expect(
            (adapter as any).runTransaction(async () => {
                await adapter.set("doc", { id: "doc", value: 1 })
                throw new Error("rollback")
            }),
        ).rejects.toThrow("rollback")

        expect(await adapter.has("doc")).toBe(false)
    })

    test("drop 会清理侧表，重建同名表后不返回旧值", async () => {
        await adapter.defineIndexes([{ key: "tags" }])
        await adapter.set("same", { id: "same", tags: ["old"] })
        await adapter.drop()

        const recreated = await factory.useAdapterInstance("regressionTable")
        await recreated.defineIndexes([{ key: "tags" }])
        await recreated.set("same", { id: "same", tags: ["new"] })

        expect(await recreated.findMany({ tags: "old" })).toEqual([])
        expect((await recreated.findMany({ tags: "new" })).map((doc: any) => doc.id)).toEqual(["same"])
        await recreated.close()
        await adapter.close()
        adapter = undefined
    })
})
