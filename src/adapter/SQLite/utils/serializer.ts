

/**
 * 将 JS 对象序列化为 SQLite 可存储的 JSON 友好格式
 * 异步版本：支持 Blob 转 Base64
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
 * 同步版本：不支持 Blob (除非 Blob逻辑是sync的，但通常不是)
 * 用于 JsPatch 等同步环境
 */
export function serializeSync(value: any): any {
    if (value === null || value === undefined) return value

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

    // Buffer (Node.js)
    if (Buffer.isBuffer(value)) {
        return { $t: "b", v: value.toString("base64") }
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
                case "m":
                    // Restore Map
                    return new Map(value["v"].map(([k, v]: [any, any]) => [deserialize(k), deserialize(v)]))
                case "s":
                    // Restore Set
                    return new Set(value["v"].map((v: any) => deserialize(v)))
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
