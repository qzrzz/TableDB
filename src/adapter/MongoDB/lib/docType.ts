import { Binary, Decimal128, Document, UUID, ObjectId } from "mongodb"
import { ITableValue } from "../../../core/types"

// 支持的 TypedArray 构造函数映射
const TypedArrayMap: Record<string, any> = {
    Int8Array,
    Int16Array,
    Int32Array,
    Uint8Array,
    Uint8ClampedArray,
    Uint16Array,
    Uint32Array,
    Float32Array,
    Float64Array,
    BigInt64Array,
    BigUint64Array,
}

/**
 * 确保值为 ObjectId 类型
 * 处理字符串、ObjectId 实例、以及包含 $in/$eq 等操作符的对象
 */
function ensureObjectId(value: any): any {
    if (value === null || value === undefined) return value

    // 已经是 ObjectId
    if (value instanceof ObjectId) return value

    // 字符串形式的 ObjectId（24位十六进制）
    if (typeof value === "string" && ObjectId.isValid(value) && value.length === 24) {
        return new ObjectId(value)
    }

    // 处理查询操作符，如 { $in: [...] }, { $eq: ... }, { $ne: ... } 等
    if (typeof value === "object" && value !== null) {
        const result: any = {}
        for (const key of Object.keys(value)) {
            if (key.startsWith("$")) {
                // 操作符的值需要递归处理
                if (Array.isArray(value[key])) {
                    // $in, $nin 等数组操作符
                    result[key] = value[key].map((v: any) => ensureObjectId(v))
                } else {
                    // $eq, $ne, $gt, $lt 等单值操作符
                    result[key] = ensureObjectId(value[key])
                }
            } else {
                result[key] = value[key]
            }
        }
        return result
    }

    // 其他类型原样返回
    return value
}

/**
 * ITableValue 转换为 MongoDB 可存储格式
 */
export function jsToMongo(data: any, parseFilter = false): any | Promise<any> {
    if (data === null || typeof data !== "object") {
        if (typeof data === "bigint") {
            return { __type: "bigint", val: data.toString() }
        }
        return data
    }

    // Fast path for Arrays
    if (Array.isArray(data)) {
        const results = data.map((i) => jsToMongo(i, parseFilter))
        if (results.some((r) => r instanceof Promise)) {
            return Promise.all(results)
        }
        return results
    }

    // Fast path for Plain Objects (most common case)
    // Skip special type checks for plain objects
    if (data.constructor === Object) {
        return jsToMongoObject(data, parseFilter, true)
    }

    // 处理 Date
    if (data instanceof Date) return data

    // 处理 MongoDB UUID
    if (data instanceof UUID) return data

    // 处理 MongoDB ObjectId
    if (data instanceof ObjectId) return data

    // 处理 RegExp
    if (data instanceof RegExp) return data

    // 处理 DataView
    if (data instanceof DataView) {
        return {
            __type: "DataView",
            val: new Binary(Buffer.from(data.buffer, data.byteOffset, data.byteLength)),
        }
    }

    // 处理 TypedArray
    const constructorName = data.constructor?.name
    if (constructorName && TypedArrayMap[constructorName]) {
        return {
            __type: constructorName,
            // 将数据转为 Buffer 存储为 Binary
            val: new Binary(Buffer.from(data.buffer, data.byteOffset, data.byteLength)),
        }
    }

    // 处理 ArrayBuffer
    if (data instanceof ArrayBuffer) {
        return { __type: "ArrayBuffer", val: new Binary(Buffer.from(data)) }
    }

    // 处理 Blob / File (转换为 Uint8Array 存储)
    if (typeof Blob !== "undefined" && data instanceof Blob) {
        // Blob 提供异步的 arrayBuffer() 方法，先获取其 ArrayBuffer
        return (async () => {
            const ab = await (data as any).arrayBuffer()
            const u8 = new Uint8Array(ab)
            return { __type: "Blob", val: new Binary(Buffer.from(u8)), blobType: data.type }
        })()
    }

    // 处理 Map
    if (data instanceof Map) {
        const entries = Array.from(data.entries()).map(([k, v]) => [jsToMongo(k, parseFilter), jsToMongo(v, parseFilter)])
        const hasPromise = entries.some(([k, v]) => k instanceof Promise || v instanceof Promise)
        
        if (hasPromise) {
            return Promise.all(entries.map(async ([k, v]) => [await k, await v])).then(resolved => ({
                __type: "Map",
                val: resolved
            }))
        }
        
        return { __type: "Map", val: entries }
    }

    // 处理 Set
    if (data instanceof Set) {
        const values = Array.from(data).map(v => jsToMongo(v, parseFilter))
        const hasPromise = values.some(v => v instanceof Promise)
        
        if (hasPromise) {
            return Promise.all(values).then(resolved => ({
                __type: "Set",
                val: resolved
            }))
        }
        
        return { __type: "Set", val: values }
    }

    // Fallback for other objects
    return jsToMongoObject(data, parseFilter, true)
}

function jsToMongoObject(data: any, parseFilter: boolean, isTopLevel = false) {
    // 处理对象：排序 Key 并递归
    const keys = Object.keys(data).sort()
    const resultObj: any = {}
    const promises: Promise<any>[] = []
    const promiseKeys: string[] = []
    let hasPromise = false

    for (const key of keys) {
        if (parseFilter && key === "$like" && typeof data[key] === "string") {
            const pattern = data[key]
            const regex =
                "^" +
                pattern
                    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
                    .replace(/%/g, ".*")
                    .replace(/_/g, ".") +
                "$"
            resultObj["$regex"] = regex
            continue
        }

        // 只处理文档顶层的 _id 字段，确保是 ObjectId 类型
        if (isTopLevel && key === "_id") {
            resultObj[key] = ensureObjectId(data[key])
            continue
        }

        const val = jsToMongo(data[key], parseFilter)
        if (val instanceof Promise) {
            hasPromise = true
            promises.push(val)
            promiseKeys.push(key)
        } else {
            resultObj[key] = val
        }
    }

    if (hasPromise) {
        return Promise.all(promises).then((resolved) => {
            for (let i = 0; i < resolved.length; i++) {
                resultObj[promiseKeys[i]] = resolved[i]
            }
            return resultObj
        })
    }

    return resultObj
}

/**
 * MongoDB 数据还原为原始 ITableValue 类型
 */
export function mongoToJs(data: any): ITableValue {
    if (data === undefined) return undefined
    if (data === null || typeof data !== "object") return data
    if (data instanceof Date) return data
    if (data instanceof RegExp) return data
    if (data instanceof UUID) {
        return data.toString()
    }
    if (data instanceof ObjectId) return data as any

    // 检查类型标识
    if (data.__type) {
        const { __type, val } = data

        if (__type === "bigint") return BigInt(val)

        if (__type === "DataView") {
            const bin = val as Binary
            const nodeBuf = bin.buffer
            const arrayBufferCopy = nodeBuf.buffer.slice(nodeBuf.byteOffset, nodeBuf.byteOffset + nodeBuf.byteLength)
            return new DataView(arrayBufferCopy)
        }

        if (__type === "ArrayBuffer") {
            const bin = val as Binary
            const nodeBuf = bin.buffer as Buffer
            // 强制转换为 ArrayBuffer，避免 SharedArrayBuffer 类型
            const ab = nodeBuf.buffer.slice(nodeBuf.byteOffset, nodeBuf.byteOffset + nodeBuf.byteLength)
            // 保证返回 ArrayBuffer 类型（即使 ab 是 SharedArrayBuffer）
            if (ab instanceof ArrayBuffer) {
                return ab
            } else {
                // SharedArrayBuffer 转 ArrayBuffer
                const u8 = new Uint8Array(ab)
                const arrBuf = new ArrayBuffer(u8.length)
                new Uint8Array(arrBuf).set(u8)
                return arrBuf
            }
        }

        // 还原特定的 TypedArray
        const TypedArray = TypedArrayMap[__type]
        if (TypedArray) {
            const bin = val as Binary
            // 1. 获取 Node.js Buffer (Binary 包装内部的 buffer)
            const nodeBuf = bin.buffer

            // 2. 从 Node.js Buffer 中提取数据并创建独立的内存副本
            // 使用 .slice 确保返回的是一个新的 ArrayBuffer，避免多个视图共享同一个底层大 Buffer 池
            const arrayBufferCopy = nodeBuf.buffer.slice(nodeBuf.byteOffset, nodeBuf.byteOffset + nodeBuf.byteLength)

            return new TypedArray(arrayBufferCopy)
        }

        if (__type === "Blob") {
            const bin = val as Binary
            const nodeBuf = bin.buffer as Buffer
            const ab = nodeBuf.buffer.slice(nodeBuf.byteOffset, nodeBuf.byteOffset + nodeBuf.byteLength)
            // 保证 arrBuf 为 ArrayBuffer 类型
            let arrBuf: ArrayBuffer
            if (ab instanceof ArrayBuffer) {
                arrBuf = ab
            } else {
                const u8 = new Uint8Array(ab)
                arrBuf = new ArrayBuffer(u8.length)
                new Uint8Array(arrBuf).set(u8)
            }
            return new Blob([new Uint8Array(arrBuf)], { type: data.blobType })
        }

        if (__type === "Map") {
            const entries = (val as Array<[any, any]>).map(([k, v]) => [mongoToJs(k), mongoToJs(v)] as [any, any])
            return new Map(entries)
        }

        if (__type === "Set") {
            const values = (val as any[]).map(v => mongoToJs(v))
            return new Set(values)
        }
    }

    // 处理数组
    if (Array.isArray(data)) {
        return data.map((i) => mongoToJs(i))
    }

    // 处理普通对象
    const restoredObj: any = {}
    for (const key in data) {
        restoredObj[key] = mongoToJs(data[key])
    }
    return restoredObj
}
