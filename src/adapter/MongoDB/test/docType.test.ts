import { Binary, UUID } from "mongodb"
import { jsToMongo, mongoToJs } from "../lib/docType"
import { inspect } from "util"

describe("MongoTableDocType 编解码测试", () => {
    it("应正确处理基本类型 (string, number, boolean, null, Date)", async () => {
        const input = {
            s: "hello",
            n: 123.456,
            b: true,
            u: null,
            d: new Date("2024-01-01T00:00:00Z"),
            ud: undefined,
            u8n: new Uint8Array([1, 2, 3]),
        }

        const encoded = await jsToMongo(input)
        const decoded = (await mongoToJs(encoded)) as any

        expect(decoded).toEqual(input)
        expect(decoded?.d).toBeInstanceOf(Date)
    })

    it("应正确处理 BigInt (转换为特殊标记对象)", async () => {
        const input = {
            id: 9007199254740991n,
            large: BigInt("9223372036854775807"),
        }

        const encoded = (await jsToMongo(input)) as any

        // 验证中间存储格式
        expect(encoded.id.__type).toBe("bigint")
        expect(typeof encoded.id.val).toBe("string")

        const decoded = (await mongoToJs(encoded)) as any
        expect(decoded).toEqual(input)
        expect(typeof decoded.id).toBe("bigint")
    })

    it("应确保对象存储时 Key 进行了字典排序", async () => {
        // 输入时乱序的 key
        const input = { z: 1, a: 2, m: 3 }

        const encoded = await jsToMongo(input)

        // 获取编码后对象的 keys
        const keys = Object.keys(encoded)
        // 验证顺序是否为 a, m, z
        expect(keys).toEqual(["a", "m", "z"])
    })

    it("应正确处理各类 TypedArray 并确保内存空间独立", async () => {
        const input = {
            u8: new Uint8Array([1, 2, 3]),
            f64: new Float64Array([1.1, 2.2, 3.3]),
            bi64: new BigInt64Array([100n, 200n]),
        }

        const encoded = await jsToMongo(input)

        // 验证编码后变成了 MongoDB Binary
        expect(encoded.u8.val).toBeInstanceOf(Binary)
        expect(encoded.f64.__type).toBe("Float64Array")

        const decoded = (await mongoToJs(encoded)) as any

        expect(decoded.u8).toBeInstanceOf(Uint8Array)
        expect(decoded.f64).toBeInstanceOf(Float64Array)
        expect(Array.from(decoded.f64)).toEqual([1.1, 2.2, 3.3])

        // 核心检查：验证底层 ArrayBuffer 的 byteOffset 是否为 0 (内存已独立且对齐)
        expect(decoded.f64.byteOffset).toBe(0)
        expect(decoded.f64.buffer.byteLength).toBe(input.f64.byteLength)
    })

    it("应正确处理 ArrayBuffer", async () => {
        const buffer = new ArrayBuffer(8)
        const view = new Uint8Array(buffer)
        view.set([255, 0, 255, 0])

        const input = { buf: buffer }
        const encoded = (await jsToMongo(input)) as any
        const decoded = (await mongoToJs(encoded)) as any

        expect(decoded.buf).toBeInstanceOf(ArrayBuffer)
        expect(new Uint8Array(decoded.buf)[0]).toBe(255)
    })

    it("应处理深度嵌套的复杂对象", async () => {
        const input = {
            level1: {
                level2: [
                    {
                        val: new Int32Array([10, 20]),
                        time: new Date(),
                    },
                    {
                        val: 42n,
                        arr: [1, null, "text"],
                    },
                ],
            },
        }

        const encoded = (await jsToMongo(input)) as any
        const decoded = (await mongoToJs(encoded)) as any

        expect(decoded).toEqual(input)
        expect(decoded.level1.level2[0].val).toBeInstanceOf(Int32Array)
        expect(typeof decoded.level1.level2[1].val).toBe("bigint")
    })

    it("处理 Blob 类型 (仅限支持 Blob 的环境)", async () => {
        const blob = new Blob(["hello world"], { type: "text/plain" })
        const blobType = blob.type

        const input = { file: blob }

        const encoded = (await jsToMongo(input)) as any

        expect(encoded.file.__type).toBe("Blob")
        expect(encoded.file.blobType).toBe(blobType)

        const decoded = (await mongoToJs(encoded)) as any
        expect(decoded.file).toBeInstanceOf(Blob)
        expect(decoded.file.type).toBe(blobType)
    })

    it("处理 MongoDB UUID", async () => {
        let uuid1 = new UUID("550e8400-e29b-41d4-a716-446655440000")

        expect(uuid1).toBeInstanceOf(UUID)

        let mongoVal = await jsToMongo(uuid1)

        // 应该对 MongoDB UUID 保持不变
        expect(mongoVal).toBeInstanceOf(UUID)

        // 从 MongoDB 取出的 UUID 应该转换为 string
        let jsVal = await mongoToJs(mongoVal)
        expect(jsVal).toBe("550e8400-e29b-41d4-a716-446655440000")
    })
})
