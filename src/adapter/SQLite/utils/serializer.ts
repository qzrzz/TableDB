

/**
 * 检测 JSON 字符串是否包含特殊类型标记
 * 用于快速判断是否需要完整的反序列化流程
 * @param json JSON 字符串
 * @returns 如果包含特殊类型标记（如 "$t"）返回 true，否则返回 false
 */
export function needsSpecialDeserialization(json: string): boolean {
    // 快速检测是否包含序列化标记 "$t"
    // 这比完整解析 JSON 再检查要快得多
    return json.includes('"$t"')
}

/**
 * 快速反序列化
 * 如果 JSON 不包含特殊类型，直接使用 JSON.parse
 * 否则使用完整的 deserialize 流程
 */
export function fastDeserialize(json: string): any {
    if (!needsSpecialDeserialization(json)) {
        return JSON.parse(json)
    }
    return deserialize(JSON.parse(json))
}

/**
 * 异步序列化版本
 * 将 JS 对象序列化为 SQLite 可存储的 JSON 友好格式
 * 支持 Blob 转 Base64
 */
export async function serialize(value: any): Promise<any> {
    if (value === null || value === undefined) return value

    if (typeof Blob !== "undefined" && value instanceof Blob) {
        const ab = await value.arrayBuffer()
        const meta: any = { $t: "b", v: Buffer.from(ab).toString("base64") }
        if (value instanceof File) {
            meta.ct = "File"
            meta.name = value.name
            meta.type = value.type
            meta.lm = value.lastModified
        } else {
            meta.ct = "Blob"
            meta.type = value.type
        }
        return meta
    }

    // 对于容器类型，需要递归并等待
    if (Array.isArray(value)) {
        return Promise.all(value.map(v => serialize(v)))
    }

    if (typeof value === "object" && value !== null) {
        // Fast path for known primitives handled by sync
        if (value instanceof Date || value instanceof RegExp || typeof value === "bigint" || value instanceof ArrayBuffer || Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
            return serializeSync(value)
        }

        // 处理 Error 类型（包括 name, message, stack, cause，cause 最多递归3层）
        if (value instanceof Error) {
            return serializeSync(value)
        }

        // Handle Map
        if (value instanceof Map) {
            const entries = await Promise.all(
                Array.from(value.entries()).map(async ([k, v]) => [await serialize(k), await serialize(v)])
            )
            return { $t: "m", v: entries }
        }

        // Handle Set
        if (value instanceof Set) {
            const values = await Promise.all(Array.from(value).map(v => serialize(v)))
            return { $t: "s", v: values }
        }

        // Plain object or unknown
        const newObj: any = {}
        for (const k in value) {
            newObj[k] = await serialize(value[k])
        }
        return newObj
    }

    return serializeSync(value)
}

/**
 * 同步序列化版本
 * 减少异步调用的开销，提高性能 
 * 将 JS 对象序列化为 SQLite 可存储的 JSON 友好格式
 * 不支持 Blob，因为 Blob 需要异步读取文件内容
 * 用于 JsPatch 等同步环境
 */
export function serializeSync(value: any): any {
    if (value === null || value === undefined) return value

    // 处理特殊数值：Infinity、-Infinity、NaN（JSON.stringify 会将它们转为 null）
    if (typeof value === "number") {
        if (Number.isNaN(value)) {
            return { $t: "nan" }
        }
        if (value === Infinity) {
            return { $t: "inf" }
        }
        if (value === -Infinity) {
            return { $t: "-inf" }
        }
        // 普通数字直接返回
        return value
    }

    if (typeof value === "bigint") {
        return { $t: "n", v: value.toString() }
    }

    if (value instanceof Date) {
        return { $t: "d", v: value.toISOString() }
    }

    if (value instanceof RegExp) {
        return { $t: "r", s: value.source, f: value.flags }
    }

    if (value instanceof ArrayBuffer) {
        return { $t: "b", v: Buffer.from(value).toString("base64"), ct: "ArrayBuffer" }
    }

    // TypedArrays
    if (ArrayBuffer.isView(value)) {
        const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
        return {
            $t: "b",
            v: buf.toString("base64"),
            ct: value.constructor.name
        }
    }

    // Blob / File (Existing ones with _buffer)
    // 如果是反序列化回来的 Blob/File，会挂载 _buffer 属性，可以直接同步序列化
    if ((value instanceof Blob || (typeof File !== "undefined" && value instanceof File)) && (value as any)._buffer) {
        const buf = (value as any)._buffer as Buffer
        const meta: any = { $t: "b", v: buf.toString("base64") }
        if (value instanceof File) {
            meta.ct = "File"
            meta.name = value.name
            meta.type = value.type
            meta.lm = value.lastModified
        } else {
            meta.ct = "Blob"
            meta.type = value.type
        }
        return meta
    }

    // Buffer (Node.js)
    if (Buffer.isBuffer(value)) {
        return { $t: "b", v: value.toString("base64") }
    }

    // 处理 Error 类型（包括 name, message, stack, cause，cause 最多递归3层）
    if (value instanceof Error) {
        return serializeError(value, 0)
    }

    // Handle Map
    if (value instanceof Map) {
        const entries = Array.from(value.entries()).map(([k, v]) => [serializeSync(k), serializeSync(v)])
        return { $t: "m", v: entries }
    }

    // Handle Set
    if (value instanceof Set) {
        const values = Array.from(value).map(v => serializeSync(v))
        return { $t: "s", v: values }
    }

    if (Array.isArray(value)) {
        return value.map(v => serializeSync(v))
    }

    if (typeof value === "object") {
        const newObj: any = {}
        for (const k in value) {
            newObj[k] = serializeSync(value[k])
        }
        return newObj
    }

    return value
}

/**
 * 将 SQLite 存储的 JSON 格式反序列化为 JS 对象
 */
export function deserialize(value: any): any {
    if (value === null || value === undefined) return value

    if (Array.isArray(value)) {
        return value.map(v => deserialize(v))
    }

    if (typeof value === "object") {
        if (value["$t"]) {
            switch (value["$t"]) {
                case "n":
                    return BigInt(value["v"])
                case "d":
                    return new Date(value["v"])
                case "r":
                    return new RegExp(value["s"], value["f"])
                case "nan":
                    return NaN
                case "inf":
                    return Infinity
                case "-inf":
                    return -Infinity
                case "m":
                    // Restore Map
                    return new Map(value["v"].map(([k, v]: [any, any]) => [deserialize(k), deserialize(v)]))
                case "s":
                    // Restore Set
                    return new Set(value["v"].map((v: any) => deserialize(v)))
                case "e":
                    // Restore Error
                    return deserializeError(value)
                case "b": {
                    const buf = Buffer.from(value["v"], "base64")
                    if (value["ct"]) {
                        // 尝试恢复具体的 TypedArray
                        if (typeof globalThis !== "undefined") {
                            const ctor = (globalThis as any)[value["ct"]]
                            if (ctor) {
                                if (value["ct"] === "File") {
                                    const f = new File([buf], value["name"], {
                                        type: value["type"],
                                        lastModified: value["lm"],
                                    })
                                    Object.defineProperty(f, "_buffer", { value: buf, enumerable: false })
                                    return f
                                }
                                if (value["ct"] === "Blob") {
                                    const b = new Blob([buf], { type: value["type"] })
                                    Object.defineProperty(b, "_buffer", { value: buf, enumerable: false })
                                    return b
                                }
                                if (value["ct"] === "ArrayBuffer") {
                                    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
                                }
                                if (value["ct"] === "DataView") {
                                    return new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
                                }
                                if (ctor.BYTES_PER_ELEMENT) {
                                    return new ctor(buf.buffer, buf.byteOffset, buf.byteLength / ctor.BYTES_PER_ELEMENT)
                                }
                            }
                        }
                    }
                    return buf
                }
            }
        }

        const newObj: any = {}
        for (const k in value) {
            newObj[k] = deserialize(value[k])
        }
        return newObj
    }

    return value
}

/**
 * 序列化 Error 对象
 * 支持 name, message, stack, cause（最多递归 3 层）
 * @param error Error 对象
 * @param depth 当前递归深度
 * @returns 序列化后的对象
 */
function serializeError(error: Error, depth: number): any {
    const result: any = {
        $t: "e",
        name: error.name,
        message: error.message,
    }
    
    // 只在有 stack 时存储
    if (error.stack) {
        result.stack = error.stack
    }
    
    // 处理 cause，最多递归 3 层
    if (error.cause !== undefined && depth < 3) {
        if (error.cause instanceof Error) {
            result.cause = serializeError(error.cause, depth + 1)
        } else {
            // cause 可能是任意值，使用 serializeSync 处理
            result.cause = serializeSync(error.cause)
        }
    }
    
    return result
}

/**
 * 反序列化 Error 对象
 * @param value 序列化后的 Error 数据
 * @returns Error 对象
 */
function deserializeError(value: any): Error {
    // 根据 name 创建对应的 Error 类型
    let error: Error
    const message = value.message || ""
    
    switch (value.name) {
        case "TypeError":
            error = new TypeError(message)
            break
        case "RangeError":
            error = new RangeError(message)
            break
        case "SyntaxError":
            error = new SyntaxError(message)
            break
        case "ReferenceError":
            error = new ReferenceError(message)
            break
        case "URIError":
            error = new URIError(message)
            break
        case "EvalError":
            error = new EvalError(message)
            break
        default:
            error = new Error(message)
            // 对于自定义 Error 类型，设置 name
            if (value.name && value.name !== "Error") {
                error.name = value.name
            }
            break
    }
    
    // 恢复 stack
    if (value.stack) {
        error.stack = value.stack
    }
    
    // 恢复 cause
    if (value.cause !== undefined) {
        if (value.cause && value.cause.$t === "e") {
            // cause 是 Error
            (error as any).cause = deserializeError(value.cause)
        } else {
            // cause 是其他值
            (error as any).cause = deserialize(value.cause)
        }
    }
    
    return error
}
