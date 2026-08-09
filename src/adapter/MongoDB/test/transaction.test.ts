import { MongoDBAdapterInstance } from "../MongoDBAdapter"

test("MongoDB adapter 的事务回调使用绑定 session 实例", async () => {
    const operationOptions: any[] = []
    const session = {
        withTransaction: async (callback: () => Promise<unknown>, options: any) => {
            expect(options.readConcern).toEqual({ level: "snapshot" })
            expect(options.writeConcern).toEqual({ w: "majority" })
            return callback()
        },
        endSession: async () => undefined,
    }
    const client = {
        startSession: () => session,
        close: async () => undefined,
    }
    const collection = {
        db: { client },
        findOne: async (_filter: unknown, options: unknown) => {
            operationOptions.push(options)
            return null
        },
    }
    const adapter = new MongoDBAdapterInstance(collection as any, client as any)

    await adapter.runTransaction(async (transaction) => {
        expect(transaction).not.toBe(adapter)
        expect(await transaction.get("node-1")).toBeUndefined()
    })

    expect(operationOptions[0].session).toBe(session)
})
