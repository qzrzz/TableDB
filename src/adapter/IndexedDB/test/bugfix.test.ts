import "fake-indexeddb/auto"
import { describe, test, expect, beforeAll, beforeEach } from "vitest"
import { ITableDBAdapterInstance } from "../../adapter"
import { IndexedDBAdapter } from "../IndexedDBAdapter"

/**
 * BUG 回归测试：覆盖审查中发现的严重问题的修复
 *
 * 1. setMany 更新文档时 _id 保持稳定（游标分页依赖）
 * 2. 同一毫秒内批量插入大量文档时 _id 不重复
 * 3. drop 只删除当前表，不影响同库其他表
 * 4. upsert 时操作符条件不污染文档、操作符 id 生成有效 key
 * 5. $set 修改 id 不产生孤儿文档
 * 6. 混合类型排序与游标 $gt 过滤规则一致
 * 7. 并发实例升级（版本竞争重试）
 * 8. clearAll 清除索引
 */
describe("IndexedDB Adapter BUG 回归", () => {
    let adapter!: ITableDBAdapterInstance

    beforeAll(async () => {
        const factory = IndexedDBAdapter({ dbName: "bugfixDB" })
        adapter = await factory.useAdapterInstance("bugfixTable")
        await adapter.clearAll()
    })

    beforeEach(async () => {
        await adapter.clearAll()
    })

    describe("_id 稳定性", () => {
        test("setMany 更新已存在文档时 _id 保持稳定 意图：修复 setMany 每次重新生成 _id 导致游标分页错乱", async () => {
            await adapter.setMany([{ id: "stable1", name: "初始" }])
            const before = await adapter.findMany({ id: "stable1" }, { projection: { _id: 1 } } as any)
            const idBefore = (before[0] as any)._id
            expect(idBefore).toBeDefined()

            // 模拟真实调用：更新时文档不携带 _id（get 返回的文档默认隐藏 _id）
            await adapter.setMany([{ id: "stable1", name: "更新后" }])
            const after = await adapter.findMany({ id: "stable1" }, { projection: { _id: 1 } } as any)
            expect((after[0] as any)._id).toBe(idBefore)

            // updateOne 路径同样保持稳定
            await adapter.updateOne({ id: "stable1" }, { $set: { name: "再更新" } })
            const after2 = await adapter.findMany({ id: "stable1" }, { projection: { _id: 1 } } as any)
            expect((after2[0] as any)._id).toBe(idBefore)
        })

        test("同一毫秒内批量插入大量文档时 _id 不重复 意图：修复 generateId 同毫秒 1000 条后重复的问题", async () => {
            const docs = Array.from({ length: 5000 }, (_, i) => ({ id: `bulk${i}`, v: i }))
            await adapter.insertMany(docs)
            const all = await adapter.findMany({}, { projection: { _id: 1 } } as any)
            const ids = all.map((d: any) => d._id)
            expect(ids.length).toBe(5000)
            expect(new Set(ids).size).toBe(5000)
        })
    })

    describe("drop 单表语义", () => {
        test("drop 只删除当前表，不影响同库其他表的数据 意图：修复 deleteDatabase 删除整个数据库导致其他表数据丢失", async () => {
            const factory = IndexedDBAdapter({ dbName: "multiTableDB" })
            const t1 = await factory.useAdapterInstance("dropTableA")
            const t2 = await factory.useAdapterInstance("dropTableB")
            await t1.set("a1", { id: "a1", v: "A" })
            await t2.set("b1", { id: "b1", v: "B" })

            await t1.drop()

            // B 表数据必须保留
            const bDoc = await t2.get("b1")
            expect(bDoc).toBeDefined()
            expect((bDoc as any).v).toBe("B")

            // drop 后再次写入自动重建表
            await t1.set("a2", { id: "a2", v: "A2" })
            expect(await t1.get("a2")).toBeDefined()
            // 且不会影响 B 表
            expect(await t2.get("b1")).toBeDefined()
        })
    })

    describe("upsert 语义", () => {
        test("upsert 时 filter 中的操作符条件不会写入文档 意图：修复操作符对象被原样存储污染数据", async () => {
            const res = await adapter.updateOne(
                { status: { $ne: "x" } },
                { $set: { score: 1 } },
                { upsert: true }
            )
            const newId = res.upsertedIds![0]
            const doc = await adapter.get(newId)
            expect(doc).toBeDefined()
            expect((doc as any).status).toBeUndefined()
            expect((doc as any).score).toBe(1)
        })

        test("upsert 时 filter.id 为操作符对象时生成有效 id 意图：修复对象 key 导致 store.put 抛 DataError", async () => {
            const res = await adapter.updateOne(
                { id: { $gt: 100 }, name: "opId" },
                { $set: { score: 2 } },
                { upsert: true }
            )
            expect(res.upsertedIds![0]).toBeDefined()
            const doc = await adapter.get(res.upsertedIds![0])
            expect(doc).toBeDefined()
            expect((doc as any).name).toBe("opId")
            expect((doc as any).score).toBe(2)
        })
    })

    describe("主键变更", () => {
        test("updateOne $set 修改 id 时不产生孤儿文档 意图：修复旧 key 残留导致数据重复", async () => {
            await adapter.set("old1", { id: "old1", v: 1 })
            await adapter.updateOne({ id: "old1" }, { $set: { id: "new1", v: 2 } })

            expect(await adapter.get("old1")).toBeUndefined()
            const doc = await adapter.get("new1")
            expect(doc).toBeDefined()
            expect((doc as any).v).toBe(2)
        })

        test("updateMany $set 修改 id 时不产生孤儿文档 意图：批量更新路径同样修复", async () => {
            await adapter.setMany([
                { id: "mold1", group: "g", v: 1 },
                { id: "mold2", group: "g", v: 2 },
            ])
            await adapter.updateMany({ group: "g" }, { $set: { v: 10 } })
            // 仅改值，id 不变
            expect((await adapter.get("mold1"))?.v).toBe(10)

            await adapter.updateMany({ id: "mold1" }, { $set: { id: "mnew1" } })
            expect(await adapter.get("mold1")).toBeUndefined()
            expect((await adapter.get("mnew1"))?.v).toBe(10)
        })

        test("setMany merge 模式正常合并且不产生孤儿文档 意图：验证合并更新路径数据一致性", async () => {
            await adapter.setMany([{ id: "sold1", name: "旧", tags: ["a"] }])
            await adapter.setMany([{ id: "sold1", name: "新", tags: ["b"] }], { merge: true } as any)
            const doc = await adapter.get("sold1")
            expect((doc as any).name).toBe("新")
            expect((doc as any).tags).toEqual(["a", "b"])
            expect(await adapter.count()).toBe(1)
        })
    })

    describe("排序与分页", () => {
        test("混合类型排序与 matcher 规则一致 意图：修复 JS 隐式转换导致排序与 $gt 游标不自洽", async () => {
            await adapter.setMany([
                { id: "s1", sortVal: 10 },
                { id: "s2", sortVal: "20" },
                { id: "s3", sortVal: 5 },
                { id: "s4", sortVal: "3" },
            ])
            const sorted = await adapter.findMany({}, { sort: { sortVal: 1 } } as any)
            // number 类型整体排在 string 之前（typeof "number" < "string"，与 matcher.compare 一致）
            expect(sorted.map((d) => d.id)).toEqual(["s3", "s1", "s2", "s4"])
        })

        test("无排序时 limit/offset 生效 意图：无 sort 走自然序并提前终止游标", async () => {
            await adapter.insertMany(Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, v: i })))
            const page = await adapter.findMany({}, { limit: 3, offset: 2 })
            expect(page.length).toBe(3)
            expect(page.map((d) => d.id)).toEqual(["p2", "p3", "p4"])
        })
    })

    describe("并发升级", () => {
        test("两个实例并发定义索引不失败 意图：修复版本竞争导致 VersionError 无限重试死循环", async () => {
            const factory = IndexedDBAdapter({ dbName: "concurrentDB" })
            const ta = await factory.useAdapterInstance("conTableA")
            const tb = await factory.useAdapterInstance("conTableB")
            // 两个实例同时触发版本升级（一个建表，一个建索引）
            await Promise.all([
                ta.defineIndexes([{ key: "a", name: "idx_a" }]),
                tb.defineIndexes([{ key: "b", name: "idx_b" }]),
            ])
            await ta.set("x", { id: "x", a: 1 })
            await tb.set("y", { id: "y", b: 2 })
            expect(await ta.get("x")).toBeDefined()
            expect(await tb.get("y")).toBeDefined()
        })
    })

    describe("clearAll", () => {
        test("clearAll 清除数据同时删除索引 意图：与接口契约和 SQLite 适配器行为一致", async () => {
            await adapter.defineIndexes([{ key: "category", name: "idx_clearall" }])
            await adapter.insertMany([{ id: "c1", category: "A" }])
            await adapter.clearAll()
            expect(await adapter.count()).toBe(0)
            // 清除索引后重新定义（若索引残留会导致多次升级，行为上不报错即可）
            await adapter.defineIndexes([{ key: "category", name: "idx_clearall" }])
            await adapter.insertMany([{ id: "c2", category: "B" }])
            const res = await adapter.findMany({ category: "B" })
            expect(res.length).toBe(1)
        })
    })
})
