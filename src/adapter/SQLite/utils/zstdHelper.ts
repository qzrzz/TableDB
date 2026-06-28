import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs"
import { resolve } from "path"
import { createRequire } from "module"
import type { ISqliteDatabase } from "../driver/types"

const require = createRequire(import.meta.url)

let zstdCache: any = null
function getZstd() {
    if (!zstdCache) {
        try {
            zstdCache = require("zstd-napi")
        } catch (e) {
            throw new Error("[SQLiteAdapter] 无法加载可选依赖 zstd-napi，请确保该依赖已正确安装和编译。错误信息: " + (e as Error).message)
        }
    }
    return zstdCache
}

/**
 * 检查文件是否为 ZSTD 压缩文件 (Magic Number: 0xFD2FB528)
 */
export function isZstdFile(filepath: string): boolean {
    if (!existsSync(filepath)) return false
    try {
        const buf = readFileSync(filepath, { flag: "r" } as any).slice(0, 4)
        if (buf.length < 4) return false
        // 0xFD2FB528 => LE: 28 B5 2F FD
        return buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd
    } catch (e) {
        return false
    }
}

/**
 * 如果数据库文件存在且被 zstd 压缩，则解压它。
 * @param filename 数据库文件名
 */
export function checkAndDecompressDb(filename: string): void {
    const resolvedPath = resolve(filename)
    if (!existsSync(resolvedPath)) return

    if (isZstdFile(resolvedPath)) {
        // console.log("[SQLiteAdapter] Decompressing ZSTD database...")
        try {
            const tmpFile = `${resolvedPath}.tmp`

            // Read file to buffer
            const compressedBuf = readFileSync(resolvedPath)

            // Decompress
            const decompressedBuf = getZstd().decompress(compressedBuf)

            // Write decompressed data to tmp file
            writeFileSync(tmpFile, decompressedBuf)

            // 重命名 tmp -> original
            renameSync(tmpFile, resolvedPath)
        } catch (error) {
            console.error("[SQLiteAdapter] 解压 ZSTD 数据库失败:", error)
            throw error // 如果解压失败，直接抛出错误
        }
    }
}

export function prepareForCompression(db: ISqliteDatabase) {
    if (db && db.isOpen) {
        db.checkpoint("TRUNCATE")
    }
}

export function compressFile(filename: string) {
    const resolvedPath = resolve(filename)
    if (!existsSync(resolvedPath)) return

    try {
        const tmpFile = `${resolvedPath}.tmp`

        // console.log("[SQLiteAdapter] Compressing database to ZSTD...")

        // Read original file
        const sourceBuf = readFileSync(resolvedPath)

        // Compress
        // Default level is usually fine (3), can pass second arg { level: 3 }
        const compressedBuf = getZstd().compress(sourceBuf)

        // Write compressed data to tmp file
        writeFileSync(tmpFile, compressedBuf)

        // 重命名替换
        renameSync(tmpFile, resolvedPath)

        // 清理可能遗留的 WAL/SHM 文件（虽然 checkpoint 应该已经处理了）
        if (existsSync(`${resolvedPath}-wal`)) unlinkSync(`${resolvedPath}-wal`)
        if (existsSync(`${resolvedPath}-shm`)) unlinkSync(`${resolvedPath}-shm`)

    } catch (e) {
        console.error("[SQLiteAdapter] 压缩失败:", e)
    }
}
