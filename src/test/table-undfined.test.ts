import { Table } from "../core/Table"
import { getTestTableByType, TestDatabaseType } from "./getTestTable"

const DATABASE_TYPES: TestDatabaseType[] = ["sqlite", "mongodb", "indexeddb"]

describe.each(DATABASE_TYPES)("Table undefined - %s", async (dbType) => {
    let table!: Table

    beforeAll(async () => {
        table = await getTestTableByType("table-undefined.test", dbType)
        await table.clearAll()
    })

    beforeEach(async () => {
        await table.clearAll()
    })

    test("set undefined", async () => {
        let doc = {
            u: undefined,
            name: "呵呵",
        }

        await table.set("undef1", doc)

        let re1 = await table.get("undef1")
        expect(re1!.name).toEqual(doc.name)
        expect(re1!.u == undefined).toBe(true)
    })

    test("find undefined", async () => {
        let doc = {
            name: "呵呵",
            u: undefined,
            ob: {
                nu: null,
                u: undefined,
                n: 123,
            },
        }

        await table.set("n1", doc)

        // let re1 = await table.findOne({ ob: { n: 123 } })
        let re1 = await table.findOne({ "ob.nu": null })
        // console.log(re1)
        expect(re1!.name).toEqual(doc.name)
    })
})
