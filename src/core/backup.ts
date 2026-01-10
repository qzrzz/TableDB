import { decode, encode } from "cbor-x"
import { Gzip, Gunzip } from "fflate"
import type { Table } from "./Table"

// ----------------------------------------------------------------------
// Types & Interfaces

export interface IBackupOptions {
    /** 是否压缩备份数据 gzip，默认 true */
    compress?: boolean
    /** 备份进度回调，百分比 0~100 */
    progress?: (percent: number) => void
}

export interface IImportOptions {
    /** 恢复进度回调，百分比 0~100 */
    progress?: (percent: number) => void
    /**
     *  是否在导入前清空现有数据，默认 false，即合并导入
     *  如果设置为 true，会先清空表数据和索引，再导入
     */
    clear?: boolean

    /** 指定只恢复某些文档的 ID 列表，默认恢复所有文档*/
    docIds?: string[]

    /** 是否忽略索引恢复，默认 false，即恢复索引 */
    ignoreIndexes?: boolean
}

interface IBackupHeader {
    magic: "FZZ_TABLE_BACKUP"
    version: number
    name: string
    indexes: any[]
    count: number
}

// ----------------------------------------------------------------------
// Web Stream Operations (Core)

/** 备份为 ReadableStream (Web Standard) */
export function exportBinaryStream(this: Table, options?: IBackupOptions): ReadableStream<Uint8Array> {
    const compress = options?.compress ?? true
    const indexes = this.options.indexes || []
    let gzip: Gzip | null = null

    return new ReadableStream({
        start: (controller) => {
            const push = (chunk: Uint8Array) => controller.enqueue(chunk)

            let totalRawBytes = 0
            let totalCompressedBytes = 0

            const output = (data: Uint8Array, final: boolean) => {
                totalRawBytes += data.length
                if (compress) {
                    if (!gzip) {
                        gzip = new Gzip()
                        gzip.ondata = (compressed, _) => {
                            totalCompressedBytes += compressed.length
                            push(compressed)
                        }
                    }
                    gzip.push(data, final)
                } else {
                    push(data)
                }
            }

            // Helper to encode and push length-prefixed chunk
            const write = (data: any) => {
                const buf = encode(data)
                const lenBuf = new Uint8Array(4)
                new DataView(lenBuf.buffer).setUint32(0, buf.byteLength, true) // Little Endian
                output(lenBuf, false)
                output(buf, false)
            }

            // Run async process in background
            ;(async () => {
                try {
                    const count = await this.count()
                    // console.log("Exporting count:", count)
                    const header: IBackupHeader = {
                        magic: "FZZ_TABLE_BACKUP",
                        version: 1,
                        name: this.name,
                        indexes,
                        count,
                    }
                    write(header)

                    let processed = 0
                    // 使用 id 作为排序键，避免 _id 导致的 projection 问题
                    await this.eachBatch({}, { pageSize: 1000, sortKey: "id" }, async (docs) => {
                        // console.log("Batch size:", docs.length)
                        for (const doc of docs) {
                            const prepared = await prepareForCbor(doc)
                            write(prepared)
                        }
                        processed += docs.length
                        if (options?.progress) options.progress((processed / count) * 100)
                    })
                    // console.log("Export processed:", processed)

                    // Finalize
                    if (compress && gzip) {
                        gzip.push(new Uint8Array(0), true)
                    }
                    controller.close()
                } catch (err) {
                    controller.error(err)
                }
            })()
        },
    })
}

/** 从 ReadableStream 恢复 (Web Standard) */
export async function importBinaryStream(
    this: Table,
    stream: ReadableStream<Uint8Array>,
    options?: IImportOptions
): Promise<{ docsCount: number }> {
    // 1. Clear if requested
    if (options?.clear) {
        await this.clearAll()
    }

    const reader = stream.getReader()
    let gunzip: Gunzip | null = null
    let isGzipDetected: boolean | null = null

    // Parser State
    let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
    let state: "READ_LEN" | "READ_DATA" = "READ_LEN"
    let needed = 4

    // Logic State
    let header: IBackupHeader | null = null
    let docsCount = 0
    const docIdsSet = options?.docIds ? new Set(options.docIds) : null

    // Queue for async processing
    const itemsQueue: any[] = []

    const processBuffer = () => {
        // console.log("processBuffer start, buffer len:", buffer.length, "state:", state, "needed:", needed)
        while (true) {
            if (state === "READ_LEN") {
                if (buffer.length >= 4) {
                    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
                    needed = view.getUint32(0, true)
                    buffer = buffer.subarray(4)
                    state = "READ_DATA"
                    // console.log("READ_LEN done, needed:", needed)
                } else {
                    break
                }
            }

            if (state === "READ_DATA") {
                if (buffer.length >= needed) {
                    const data = buffer.subarray(0, needed)
                    buffer = buffer.subarray(needed)
                    state = "READ_LEN"
                    needed = 4

                    // Decode Item
                    try {
                        const decoded = decode(data)
                        const item = restoreFromCbor(decoded)
                        itemsQueue.push(item)
                    } catch (e) {
                        throw e
                    }
                } else {
                    break
                }
            }
        }
        // console.log("processBuffer end, buffer len:", buffer.length)
    }

    const handleItems = async () => {
        let processedInBatch = 0
        while (itemsQueue.length > 0) {
            const item = itemsQueue.shift()
            processedInBatch++
            if (!header) {
                header = item as IBackupHeader
                if (header.magic !== "FZZ_TABLE_BACKUP") {
                    throw new Error("Invalid backup format")
                }
                if (!options?.ignoreIndexes && header.indexes) {
                    await this.defineIndexes(header.indexes)
                }
            } else {
                const doc = item
                if (!docIdsSet || docIdsSet.has(doc.id)) {
                    await this.set(doc.id, doc)
                    docsCount++
                }
            }
        }
        // console.log("handleItems end, processed:", processedInBatch, "total docs:", docsCount)
    }

    let totalBytesRead = 0

    while (true) {
        const { done, value } = await reader.read()
        if (done) break

        totalBytesRead += value.length

        if (isGzipDetected === null) {
            // Detect Gzip
            if (value.length >= 2 && value[0] === 0x1f && value[1] === 0x8b) {
                isGzipDetected = true
                gunzip = new Gunzip()
                gunzip.ondata = (chunk, _) => {
                    buffer = concat(buffer, chunk)
                    processBuffer()
                }
            } else {
                isGzipDetected = false
            }
        }

        if (isGzipDetected && gunzip) {
            gunzip.push(value)
        } else {
            buffer = concat(buffer, value)
            processBuffer()
        }

        // Process parsed items
        await handleItems()
    }

    if (isGzipDetected && gunzip) {
        gunzip.push(new Uint8Array(0), true)
        // Process any remaining items
        await handleItems()
    }

    return { docsCount }
}

// ----------------------------------------------------------------------
// In-Memory Operations (Wrappers)

/** 备份 Table 到的数据和索引配置到二进制格式 (In-Memory) */
export async function exportBinary(this: Table, options?: IBackupOptions): Promise<Uint8Array> {
    const stream = exportBinaryStream.call(this, options)
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let totalLength = 0

    while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        totalLength += value.length
    }

    const result = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of chunks) {
        result.set(chunk, offset)
        offset += chunk.length
    }
    return result
}

/** 从二进制格式的数据恢复 Table 数据和索引配置 (In-Memory) */
export async function importBinary(
    this: Table,
    data: Uint8Array,
    options?: IImportOptions
): Promise<{ docsCount: number }> {
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(data)
            controller.close()
        },
    })
    return importBinaryStream.call(this, stream, options)
}

// ----------------------------------------------------------------------
// File Operations (Node.js Wrappers)

/** 备份到文件 (Node.js Stream) */
export async function exportBinaryToFile(this: Table, filePath: string, options?: IBackupOptions): Promise<void> {
    const { createWriteStream } = await import("fs")
    const { Writable } = await import("stream")
    const { pipeline } = await import("stream/promises")

    const webStream = exportBinaryStream.call(this, options)
    // @ts-ignore - Readable.fromWeb is available in Node 18+
    const nodeStream = Writable.fromWeb ? require("stream").Readable.fromWeb(webStream) : nodeReadableFromWeb(webStream)
    const fileStream = createWriteStream(filePath)

    await pipeline(nodeStream, fileStream)
}

/** 从文件恢复 (Node.js Stream) */
export async function importBinaryFromFile(
    this: Table,
    filePath: string,
    options?: IImportOptions
): Promise<{ docsCount: number }> {
    const { createReadStream, statSync } = await import("fs")
    const { Readable } = await import("stream")

    const fileSize = statSync(filePath).size
    let bytesRead = 0

    const fileStream = createReadStream(filePath)
    fileStream.on("data", (chunk: Buffer | string) => {
        bytesRead += chunk.length
        if (options?.progress) options.progress((bytesRead / fileSize) * 100)
    })

    // @ts-ignore - Readable.toWeb is available in Node 18+
    const webStream = (
        Readable.toWeb ? Readable.toWeb(fileStream) : nodeReadableToWeb(fileStream)
    ) as ReadableStream<Uint8Array>

    return importBinaryStream.call(this, webStream, options)
}

// ----------------------------------------------------------------------
// Helpers

function concat(a: Uint8Array<ArrayBufferLike>, b: Uint8Array<ArrayBufferLike>): Uint8Array {
    const c = new Uint8Array(a.length + b.length)
    c.set(a)
    c.set(b, a.length)
    return c
}

// Polyfills for older Node versions if needed (simplified)
function nodeReadableFromWeb(webStream: ReadableStream): any {
    const { Readable } = require("stream")
    return Readable.fromWeb(webStream)
}

function nodeReadableToWeb(nodeStream: any): ReadableStream {
    const { Readable } = require("stream")
    return Readable.toWeb(nodeStream)
}

async function prepareForCbor(data: any): Promise<any> {
    // null 直接返回
    if (data === null) return data

    // undefined 需要特殊标记，因为 CBOR 对 undefined 支持不完善
    if (data === undefined) return { $t: "undefined" }

    // cbor-x 原生支持 Date, BigInt, Uint8Array, Map, Set
    // 我们只需要处理 Blob, File, ArrayBuffer 和其他 TypedArray

    if (ArrayBuffer.isView(data)) {
        if (data instanceof Uint8Array) {
            // Uint8Array 直接复制，确保序列化数据独立
            return data.slice()
        }
        // 其他 TypedArray 保留类型信息
        const typeName = data.constructor.name
        // 复制数据确保独立，避免原始数据被修改影响备份
        const uint8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
        return { $t: "typed_array", type: typeName, v: uint8 }
    }

    if (data instanceof ArrayBuffer) {
        // 复制 ArrayBuffer 内容
        const uint8 = new Uint8Array(data).slice()
        return { $t: "array_buffer", v: uint8 }
    }

    if (typeof Blob !== "undefined" && data instanceof Blob) {
        const buffer = await data.arrayBuffer()
        const uint8 = new Uint8Array(buffer)
        const isFile = typeof File !== "undefined" && data instanceof File
        return {
            $t: "blob",
            isFile,
            name: isFile ? (data as File).name : undefined,
            type: data.type,
            lastModified: isFile ? (data as File).lastModified : undefined,
            v: uint8,
        }
    }

    if (Array.isArray(data)) {
        return Promise.all(data.map((item) => prepareForCbor(item)))
    }

    if (typeof data === "object") {
        // 排除 Date (cbor-x 支持)
        if (data instanceof Date) return data

        // 简单对象递归处理
        if (data.constructor === Object || data.constructor === undefined) {
            const result: any = {}
            for (const key in data) {
                if (Object.prototype.hasOwnProperty.call(data, key)) {
                    result[key] = await prepareForCbor(data[key])
                }
            }
            return result
        }
    }

    return data
}

function restoreFromCbor(data: any): any {
    if (data === null || data === undefined) return data

    if (typeof data === "object") {
        if (data.$t) {
            switch (data.$t) {
                case "typed_array": {
                    const uint8 = data.v as Uint8Array
                    const ctor = (globalThis as any)[data.type]
                    if (ctor) {
                        // 始终复制数据，避免共享 cbor-x 解码时的底层 buffer
                        // 这样恢复后的 TypedArray 拥有独立的内存
                        const buffer = uint8.slice().buffer
                        return new ctor(buffer)
                    }
                    // 未知类型时返回复制的 Uint8Array
                    return uint8.slice()
                }
                case "array_buffer":
                    // 使用 slice() 确保返回独立的 ArrayBuffer
                    // 直接返回 .buffer 会获取整个共享的底层 buffer
                    return (data.v as Uint8Array).slice().buffer
                case "blob": {
                    // Blob 数据也需要复制，确保独立内存
                    const blobParts = [(data.v as Uint8Array).slice()]
                    if (data.isFile && typeof File !== "undefined") {
                        return new File(blobParts, data.name, { type: data.type, lastModified: data.lastModified })
                    }
                    if (typeof Blob !== "undefined") {
                        return new Blob(blobParts, { type: data.type })
                    }
                    return (data.v as Uint8Array).slice()
                }
                case "undefined":
                    // 恢复 undefined 值
                    return undefined
            }
        }

        if (Array.isArray(data)) {
            return data.map(restoreFromCbor)
        }

        if (data instanceof Date) return data
        if (data instanceof Uint8Array) return data
        // cbor-x decode BigInt as BigInt (primitive)

        // 普通对象
        if (data.constructor === Object || data.constructor === undefined) {
            const result: any = {}
            for (const key in data) {
                result[key] = restoreFromCbor(data[key])
            }
            return result
        }
    }

    return data
}
