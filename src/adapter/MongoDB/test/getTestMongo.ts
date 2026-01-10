import { MongoDBAdapter } from "../MongoDBAdapter"

export async function getTestAdapter(tableName = "testTable") {
    let AdapterFactory = MongoDBAdapter({
        auth: "mongodb://root:w2xO4Fd28Wc76o1sl8WAt3lo5sc42ver02@localhost:12779",
        dbName: "tableDbTest",
    })

    return await AdapterFactory.useAdapterInstance(tableName)
}
