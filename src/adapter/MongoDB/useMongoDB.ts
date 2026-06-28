import { useOfArgs } from "fzz"
import { createRequire } from "module"
import type { MongoClient as IMongoClient, Collection, UUID } from "mongodb"

const require = createRequire(import.meta.url)

export const useMongoDB = useOfArgs(async (config: { auth: string; dbName: string }) => {
    const mongodb = require("mongodb")
    let mongodbClient = new mongodb.MongoClient(config?.auth || "mongodb://localhost:27017")
    await mongodbClient.connect()

    let mongodbDB = mongodbClient.db(config?.dbName || "testdb")
    return mongodbDB
})

// 测试 auth uri: mongodb://root:w2xO4Fd28Wc76o1sl8WAt3lo5sc42ver02@localhost:12779/App
