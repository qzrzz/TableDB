import { useOfArgs } from "fzz"
import { createRequire } from "module"
import type { Db, MongoClient as IMongoClient } from "mongodb"

const require = createRequire(import.meta.url)

export interface IMongoDBConnection {
    db: Db
    client: IMongoClient
}

export const useMongoDB = useOfArgs(async (config: { auth: string; dbName: string }): Promise<IMongoDBConnection> => {
    const mongodb = require("mongodb")
    let mongodbClient: IMongoClient = new mongodb.MongoClient(config?.auth || "mongodb://localhost:27017")
    await mongodbClient.connect()

    let mongodbDB = mongodbClient.db(config?.dbName || "testdb")
    return { db: mongodbDB, client: mongodbClient }
})

// 测试 auth uri: mongodb://root:w2xO4Fd28Wc76o1sl8WAt3lo5sc42ver02@localhost:12779/App
