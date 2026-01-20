import { Table } from "../core/Table"
import { getTestTableByType, TestDatabaseType } from "./getTestTable"
import { TabeEvents } from "../core/event"

const DATABASE_TYPES: TestDatabaseType[] = ["mongodb", "sqlite", "indexeddb"]

describe.each(DATABASE_TYPES)("Table eventHub - %s", async (dbType) => {
    test("CheckInputDoc: 触发并允许修改待写入文档", async () => {
        const table = await getTestTableByType("table-event-check-inputdoc", dbType)
        await table.clearAll()

        let called = false
        ;(table as any).eventHub.on(TabeEvents.CheckInputDoc, (doc: any) => {
            called = true
            // 在事件中修改文档，确保修改能被写入
            doc.__event_hook__ = true
        })

        await table.set("d1", { name: "A" })
        const d = await table.get("d1")

        expect(called).toBeTruthy()
        expect((d as any).__event_hook__).toBeTruthy()
    })

    test("CheckOutputDoc: 输出前触发，可修改返回结果", async () => {
        const table = await getTestTableByType("table-event-check-outputdoc", dbType)
        await table.clearAll()

        await table.set("d1", { name: "B" })

        let called = false
        ;(table as any).eventHub.on(TabeEvents.CheckOutputDoc, (doc: any) => {
            called = true
            doc.__output_hook__ = 123
        })

        const d = await table.get("d1")
        expect(called).toBeTruthy()
        expect((d as any).__output_hook__).toBe(123)
    })

    test("CheckFilter: 在 filter 检查前触发并接收 filter/options", async () => {
        const table = await getTestTableByType("table-event-check-filter", dbType)
        await table.clearAll()

        await table.set("a", { n: 1 })
        await table.set("b", { n: 2 })

        let called = false
        let captured: any = null
        ;(table as any).eventHub.on(TabeEvents.CheckFilter, (payload: any) => {
            called = true
            captured = payload
        })

        const re = await table.findMany({ n: 1 }, { projection: undefined })
        expect(called).toBeTruthy()
        expect(captured).not.toBeNull()
        expect(captured.filter).toBeDefined()
        // 确保 find 操作仍能返回正确结果
        expect(re.length).toBe(1)
        expect((re[0] as any).n).toBe(1)
    })

    test("CheckFindOptions: 在解析 find options 前触发", async () => {
        const table = await getTestTableByType("table-event-check-findoptions", dbType)
        await table.clearAll()

        await table.set("d1", { name: "X" })

        let called = false
        let captured: any = null
        ;(table as any).eventHub.on(TabeEvents.CheckFindOptions, (options: any) => {
            called = true
            captured = options
            // 可修改 options（例如添加自定义标记）
            if (options) options.__opt_hook__ = true
        })

        // 传入一个空对象以确保事件接收到 options 引用
        const re = await table.findMany({}, {})
        expect(called).toBeTruthy()
        expect(captured).not.toBeNull()
        // adapter 不一定会返回该标记，但我们至少验证事件被调用并能修改对象
        expect((captured as any).__opt_hook__).toBeTruthy()
        expect(re.length).toBeGreaterThanOrEqual(1)
    })

    test("CheckUpdateOp: 在 update 操作前触发并能修改 updateOp", async () => {
        const table = await getTestTableByType("table-event-check-updateop", dbType)
        await table.clearAll()

        await table.set("d1", { v: 1 })

        let called = false
        ;(table as any).eventHub.on(TabeEvents.CheckUpdateOp, (updateOp: any) => {
            called = true
            if (!updateOp.$set) updateOp.$set = {}
            updateOp.$set.__updated_by_hook__ = true
        })

        await table.updateOne({ id: "d1" }, { $set: { v: 2 } })
        const d = await table.get("d1")

        expect(called).toBeTruthy()
        expect((d as any).__updated_by_hook__).toBeTruthy()
        expect((d as any).v).toBe(2)
    })
})
