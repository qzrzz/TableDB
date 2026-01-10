import { Table } from "../core/Table"
import { getTestTableByType, TestDatabaseType } from "./getTestTable"

const DATABASE_TYPES: TestDatabaseType[] = ["sqlite", "mongodb"]

describe.each(DATABASE_TYPES)("Table Map and Set Types - %s", async (dbType) => {
    let table!: Table

    beforeAll(async () => {
        table = await getTestTableByType("map-set-types.test", dbType)
        await table.clearAll()
    })

    beforeEach(async () => {
        await table.clearAll()
    })

    test("Map type - basic operations", async () => {
        const testMap = new Map<string, string | number | boolean>([
            ["key1", "value1"],
            ["key2", 42],
            ["key3", true],
        ])

        const doc = {
            id: "map1",
            name: "Map Test",
            data: testMap,
        }

        await table.set("map1", doc)
        const result = await table.get("map1")

        expect(result).toBeDefined()
        expect(result?.data).toBeInstanceOf(Map)
        expect((result?.data as Map<any, any>).size).toBe(3)
        expect((result?.data as Map<any, any>).get("key1")).toBe("value1")
        expect((result?.data as Map<any, any>).get("key2")).toBe(42)
        expect((result?.data as Map<any, any>).get("key3")).toBe(true)
    })

    test("Set type - basic operations", async () => {
        const testSet = new Set([1, 2, 3, "four", true])

        const doc = {
            id: "set1",
            name: "Set Test",
            data: testSet,
        }

        await table.set("set1", doc)
        const result = await table.get("set1")

        expect(result).toBeDefined()
        expect(result?.data).toBeInstanceOf(Set)
        expect((result?.data as Set<any>).size).toBe(5)
        expect((result?.data as Set<any>).has(1)).toBe(true)
        expect((result?.data as Set<any>).has(2)).toBe(true)
        expect((result?.data as Set<any>).has(3)).toBe(true)
        expect((result?.data as Set<any>).has("four")).toBe(true)
        expect((result?.data as Set<any>).has(true)).toBe(true)
        expect((result?.data as Set<any>).has(99)).toBe(false)
    })

    test("Map with complex values", async () => {
        const testMap = new Map<string, any>([
            ["array", [1, 2, 3]],
            ["object", { a: 1, b: 2 }],
            ["date", new Date("2024-01-01T00:00:00Z")],
            ["nested", new Map([["inner", "value"]])],
        ])

        const doc = {
            id: "map2",
            complexMap: testMap,
        }

        await table.set("map2", doc)
        const result = await table.get("map2")

        expect(result).toBeDefined()
        expect(result?.complexMap).toBeInstanceOf(Map)
        expect((result?.complexMap as Map<any, any>).get("array")).toEqual([1, 2, 3])
        expect((result?.complexMap as Map<any, any>).get("object")).toEqual({ a: 1, b: 2 })
        expect((result?.complexMap as Map<any, any>).get("date")).toEqual(new Date("2024-01-01T00:00:00Z"))
        
        const nestedMap = (result?.complexMap as Map<any, any>).get("nested")
        expect(nestedMap).toBeInstanceOf(Map)
        expect(nestedMap.get("inner")).toBe("value")
    })

    test("Set with complex values", async () => {
        const testSet = new Set<any>([
            [1, 2, 3],
            { a: 1 },
            new Date("2024-01-01T00:00:00Z"),
            new Set(["nested"]),
        ])

        const doc = {
            id: "set2",
            complexSet: testSet,
        }

        await table.set("set2", doc)
        const result = await table.get("set2")

        expect(result).toBeDefined()
        expect(result?.complexSet).toBeInstanceOf(Set)
        expect((result?.complexSet as Set<any>).size).toBe(4)

        // Check if array is in set
        let hasArray = false
        for (const item of (result!.complexSet as Set<any>)) {
            if (Array.isArray(item) && item[0] === 1 && item[1] === 2 && item[2] === 3) {
                hasArray = true
                break
            }
        }
        expect(hasArray).toBe(true)

        // Check if nested Set is in set
        let hasNestedSet = false
        for (const item of (result!.complexSet as Set<any>)) {
            if (item instanceof Set && item.has("nested")) {
                hasNestedSet = true
                break
            }
        }
        expect(hasNestedSet).toBe(true)
    })

    test("Empty Map and Set", async () => {
        const doc = {
            id: "empty1",
            emptyMap: new Map(),
            emptySet: new Set(),
        }

        await table.set("empty1", doc)
        const result = await table.get("empty1")

        expect(result).toBeDefined()
        expect(result?.emptyMap).toBeInstanceOf(Map)
        expect((result?.emptyMap as Map<any, any>).size).toBe(0)
        expect(result?.emptySet).toBeInstanceOf(Set)
        expect((result?.emptySet as Set<any>).size).toBe(0)
    })

    test("Map with various key types", async () => {
        const objectKey = { id: "key" }
        const testMap = new Map<any, string>([
            [1, "number key"],
            ["string", "string key"],
            [true, "boolean key"],
            [objectKey, "object key"],
        ])

        const doc = {
            id: "map3",
            multiKeyMap: testMap,
        }

        await table.set("map3", doc)
        const result = await table.get("map3")

        expect(result).toBeDefined()
        expect(result?.multiKeyMap).toBeInstanceOf(Map)
        expect((result?.multiKeyMap as Map<any, any>).size).toBe(4)
        expect((result?.multiKeyMap as Map<any, any>).get(1)).toBe("number key")
        expect((result?.multiKeyMap as Map<any, any>).get("string")).toBe("string key")
        expect((result?.multiKeyMap as Map<any, any>).get(true)).toBe("boolean key")
        
        // Object keys should be preserved
        let hasObjectKey = false
        for (const [key, value] of (result!.multiKeyMap as Map<any, any>)) {
            if (typeof key === "object" && key !== null && (key as any).id === "key" && value === "object key") {
                hasObjectKey = true
                break
            }
        }
        expect(hasObjectKey).toBe(true)
    })

    test("findMany with Map and Set", async () => {
        await table.set("doc1", {
            id: "doc1",
            tags: new Set(["tag1", "tag2"]),
            metadata: new Map([["author", "Alice"]]),
        })

        await table.set("doc2", {
            id: "doc2",
            tags: new Set(["tag2", "tag3"]),
            metadata: new Map([["author", "Bob"]]),
        })

        const results = await table.findMany({})
        expect(results.length).toBe(2)

        for (const doc of results) {
            expect(doc.tags).toBeInstanceOf(Set)
            expect(doc.metadata).toBeInstanceOf(Map)
        }
    })

    test("updateOne with Map and Set in $set", async () => {
        await table.set("update1", {
            id: "update1",
            data: new Map([["old", "value"]]),
        })

        await table.updateOne(
            { id: "update1" },
            {
                $set: {
                    data: new Map([["new", "updated"]]),
                    tags: new Set(["tag1", "tag2"]),
                },
            }
        )

        const result = await table.get("update1")
        expect(result).toBeDefined()
        expect(result?.data).toBeInstanceOf(Map)
        expect((result?.data as Map<any, any>).get("new")).toBe("updated")
        expect((result?.data as Map<any, any>).has("old")).toBe(false)
        expect(result?.tags).toBeInstanceOf(Set)
        expect((result?.tags as Set<any>).has("tag1")).toBe(true)
    })

    test("Map and Set with bigint values", async () => {
        const testMap = new Map<string, bigint>([
            ["bigint1", 9007199254740991n],
            ["bigint2", -9007199254740991n],
        ])

        const testSet = new Set<bigint>([
            1234567890123456789n,
            -9876543210987654321n,
        ])

        const doc = {
            id: "bigint1",
            bigintMap: testMap,
            bigintSet: testSet,
        }

        await table.set("bigint1", doc)
        const result = await table.get("bigint1")

        expect(result).toBeDefined()
        expect(result?.bigintMap).toBeInstanceOf(Map)
        expect((result?.bigintMap as Map<any, any>).get("bigint1")).toBe(9007199254740991n)
        expect((result?.bigintMap as Map<any, any>).get("bigint2")).toBe(-9007199254740991n)
        
        expect(result?.bigintSet).toBeInstanceOf(Set)
        expect((result?.bigintSet as Set<any>).has(1234567890123456789n)).toBe(true)
        expect((result?.bigintSet as Set<any>).has(-9876543210987654321n)).toBe(true)
    })

    test("setMany with Map and Set", async () => {
        const docs = [
            {
                id: "bulk1",
                data: new Map([["key1", "value1"]]),
                tags: new Set(["a", "b"]),
            },
            {
                id: "bulk2",
                data: new Map([["key2", "value2"]]),
                tags: new Set(["c", "d"]),
            },
        ]

        await table.setMany(docs)

        const result1 = await table.get("bulk1")
        const result2 = await table.get("bulk2")

        expect(result1?.data).toBeInstanceOf(Map)
        expect(result1?.tags).toBeInstanceOf(Set)
        expect(result2?.data).toBeInstanceOf(Map)
        expect(result2?.tags).toBeInstanceOf(Set)
    })

    test("Map and Set with TypedArray values", async () => {
        const testMap = new Map<string, any>([
            ["uint8", new Uint8Array([1, 2, 3])],
            ["float32", new Float32Array([1.5, 2.5])],
        ])

        const testSet = new Set<any>([
            new Uint8Array([10, 20, 30]),
            new Int32Array([100, 200, 300]),
        ])

        const doc = {
            id: "typed1",
            typedMap: testMap,
            typedSet: testSet,
        }

        await table.set("typed1", doc)
        const result = await table.get("typed1")

        expect(result).toBeDefined()
        expect(result?.typedMap).toBeInstanceOf(Map)
        expect((result?.typedMap as Map<any, any>).get("uint8")).toBeInstanceOf(Uint8Array)
        expect((result?.typedMap as Map<any, any>).get("uint8")).toEqual(new Uint8Array([1, 2, 3]))
        expect((result?.typedMap as Map<any, any>).get("float32")).toBeInstanceOf(Float32Array)
        expect((result?.typedMap as Map<any, any>).get("float32")).toEqual(new Float32Array([1.5, 2.5]))

        expect(result?.typedSet).toBeInstanceOf(Set)
        // Check typed arrays in set
        let hasUint8 = false
        let hasInt32 = false
        for (const item of (result!.typedSet as Set<any>)) {
            if (item instanceof Uint8Array && item[0] === 10) {
                hasUint8 = true
            }
            if (item instanceof Int32Array && item[0] === 100) {
                hasInt32 = true
            }
        }
        expect(hasUint8).toBe(true)
        expect(hasInt32).toBe(true)
    })
})
