import { ITableDBAdapterInstance } from "../../adapter"
import { getTestAdapter } from "./getTestMongo"

describe("updateOne 详尽测试", () => {
    let adapter!: ITableDBAdapterInstance

    beforeAll(async () => {
        adapter = await getTestAdapter("updateOneTestTable")
    })

    beforeEach(async () => {
        await adapter.clear()
    })

    test("基础更新：修改现有文档的单个字段", async () => {
        await adapter.set("u1", { id: "u1", name: "Alice", age: 20 })
        const res = await adapter.updateOne({ id: "u1" }, { $set: { name: "Alice Updated" } })

        expect(res.matchedCount).toBe(1)
        expect(res.modifiedCount).toBe(1)

        const doc = await adapter.get("u1")
        expect(doc?.name).toBe("Alice Updated")
        expect(doc?.age).toBe(20)
    })

    test("多算子组合：同时使用 $set 和 $inc", async () => {
        await adapter.set("u1", { id: "u1", score: 100, level: 1 })
        await adapter.updateOne(
            { id: "u1" },
            {
                $set: { status: "active" },
                $inc: { score: 10, level: 1 },
            }
        )

        const doc = await adapter.get("u1")
        expect(doc?.status).toBe("active")
        expect(doc?.score).toBe(110)
        expect(doc?.level).toBe(2)
    })

    test("匹配多个文档时仅更新第一个", async () => {
        await adapter.insertMany([
            { id: "u1", group: "A", val: 1 },
            { id: "u2", group: "A", val: 1 },
        ])

        const res = await adapter.updateOne({ group: "A" }, { $inc: { val: 1 } })

        expect(res.matchedCount).toBe(1)
        expect(res.modifiedCount).toBe(1)

        const docs = await adapter.findMany({ group: "A" })
        const updatedCount = docs.filter((d) => d.val === 2).length
        expect(updatedCount).toBe(1)
    })

    test("未匹配到文档时的行为", async () => {
        const res = await adapter.updateOne({ id: "non-existent" }, { $set: { x: 1 } })

        expect(res.matchedCount).toBe(0)
        expect(res.modifiedCount).toBe(0)
    })

    describe("upsert 选项测试", () => {
        test("upsert: true 且文档不存在时应创建新文档", async () => {
            const res = await adapter.updateOne({ id: "new-doc" }, { $set: { data: "hello" } }, { upsert: true })

            expect(res.matchedCount).toBe(0)
            // 注意：MongoDB 的 updateOne 在 upsert 时 modifiedCount 为 0
            expect(await adapter.has("new-doc")).toBe(true)
            const doc = await adapter.get("new-doc")
            expect(doc?.data).toBe("hello")
        })

        test("upsert: true 且文档存在时应更新现有文档", async () => {
            await adapter.set("u1", { id: "u1", data: "old" })
            const res = await adapter.updateOne({ id: "u1" }, { $set: { data: "new" } }, { upsert: true })

            expect(res.matchedCount).toBe(1)
            expect(res.modifiedCount).toBe(1)
            expect((await adapter.get("u1"))?.data).toBe("new")
        })

        test("upsert: false (默认) 且文档不存在时不应创建", async () => {
            await adapter.updateOne({ id: "no-upsert" }, { $set: { x: 1 } }, { upsert: false })
            expect(await adapter.has("no-upsert")).toBe(false)
        })
    })

    test("嵌套字段更新", async () => {
        await adapter.set("u1", { id: "u1", profile: { city: "Beijing", tags: ["tech"] } })

        // 更新嵌套对象中的属性
        await adapter.updateOne({ id: "u1" }, { $set: { "profile.city": "Shanghai" } })
        // 向嵌套数组中添加元素
        await adapter.updateOne({ id: "u1" }, { $push: { "profile.tags": "ai" } })

        const doc = (await adapter.get("u1")) as any
        expect(doc?.profile?.city).toBe("Shanghai")
        expect(doc?.profile?.tags).toContain("ai")
        expect(doc?.profile?.tags).toContain("tech")
    })

    test("使用复杂过滤器进行更新", async () => {
        await adapter.insertMany([
            { id: "u1", age: 25, status: "pending" },
            { id: "u2", age: 35, status: "pending" },
        ])

        // 仅更新年龄大于 30 的文档
        await adapter.updateOne({ status: "pending", age: { $gt: 30 } }, { $set: { status: "verified" } })

        expect((await adapter.get("u1"))?.status).toBe("pending")
        expect((await adapter.get("u2"))?.status).toBe("verified")
    })

    test("特殊类型更新 (BigInt & Date)", async () => {
        const initialDate = new Date("2020-01-01")
        const newDate = new Date("2024-01-01")
        const big = 100n
        const newBig = 200n

        await adapter.set("u1", { id: "u1", lastLogin: initialDate, balance: big })

        await adapter.updateOne(
            { id: "u1" },
            {
                $set: { lastLogin: newDate, balance: newBig },
            }
        )

        const doc = (await adapter.get("u1")) as any
        expect(doc?.lastLogin.getTime()).toBe(newDate.getTime())
        expect(doc?.balance).toBe(newBig)
    })

    test("字段重命名 ($rename)", async () => {
        await adapter.set("u1", { id: "u1", oldName: "foo" })
        await adapter.updateOne({ id: "u1" }, { $rename: { oldName: "newName" } })

        const doc = await adapter.get("u1")
        expect(doc?.oldName).toBeUndefined()
        expect(doc?.newName).toBe("foo")
    })

    test("删除字段 ($unset)", async () => {
        await adapter.set("u1", { id: "u1", temporary: "secret", permanent: "keep" })
        await adapter.updateOne({ id: "u1" }, { $unset: { temporary: 1 } })

        const doc = await adapter.get("u1")
        expect(doc?.temporary).toBeUndefined()
        expect(doc?.permanent).toBe("keep")
    })

    test("sort 选项：在匹配多个文档时指定更新顺序", async () => {
        await adapter.insertMany([
            { id: "u1", group: "A", priority: 10, status: "old" },
            { id: "u2", group: "A", priority: 20, status: "old" },
            { id: "u3", group: "A", priority: 5, status: "old" },
        ])

        // 按 priority 降序排列，应该更新 priority 为 20 的文档 (u2)
        await adapter.updateOne({ group: "A" }, { $set: { status: "updated" } }, { sort: { priority: -1 } })

        expect((await adapter.get("u2"))?.status).toBe("updated")
        expect((await adapter.get("u1"))?.status).toBe("old")
        expect((await adapter.get("u3"))?.status).toBe("old")

        // 按 priority 升序排列，应该更新剩余匹配项中 priority 最小的 (u3)
        await adapter.updateOne({ group: "A", status: "old" }, { $set: { status: "updated" } }, { sort: ["priority"] })

        expect((await adapter.get("u3"))?.status).toBe("updated")
        expect((await adapter.get("u1"))?.status).toBe("old")
    })
})
