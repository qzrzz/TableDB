import { ITableIndexConfig } from "../adapter/adapter"
import { Table } from "./Table"
import { dtoExtractMeta } from "fzz"

/**
 * 对于标记为 isUUID 的字段，记录其路径信息
 * 在存储为字符串时，可以进行 UUID 格式验证
 */
export interface ISchemaHints {
    UUIDPaths: string[][]
}

export async function __schema_init(this: Table): Promise<void> {
    let finIndexes: ITableIndexConfig[] = []
    let schemaHits: ISchemaHints = {
        UUIDPaths: [],
    }

    if (this.schema) {
        let metaList = dtoExtractMeta(this.schema, { onlyWithMeta: false })
        metaList.forEach((item) => {
            if (item.meta?.index !== undefined) {
                if (typeof item.meta.index === "boolean") {
                    finIndexes.push({
                        key: item.paths.join("."),
                        disabled: item.meta.index === false,
                    })
                } else if (typeof item.meta.index === "object") {
                    finIndexes.push({
                        key: item.paths.join("."),
                        ...item.meta.index,
                    })
                }
            }

            if (item.meta?.isUUID) {
                schemaHits.UUIDPaths.push(item.paths)
            }
        })
    }

    if (this.options.indexes) {
        this.options.indexes.forEach((idx) => {
            finIndexes.push(idx)
        })
    }

    // 如果用户没有为 id 设置索引，则自动为 id 创建唯一索引
    if (!finIndexes.find((idx) => idx.key === "id")) {
        finIndexes.push({ key: "id", unique: true })
    }

    // 保存 schema hints
    this.__schema_hints = schemaHits

    // 定义索引
    if (Object.keys(finIndexes).length > 0) {
        this.adapter.defineIndexes(finIndexes, { rebuild: false })
    }
}
