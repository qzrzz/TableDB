export { Table } from "./core/Table"
export type { IPlvMap, ITableGetBaseOptions, ITableOptions } from "./core/Table"
export { defineGlobalDBAdapter, defineTable } from "./core/defineTable"
export type { UseTableFunction, UseTalbeFunction } from "./core/defineTable"
export type {
    ITableArrayAddOp,
    ITableFilter,
    ITableMatchLogic,
    ITableMatchOp,
    ITablePrimitive,
    ITableQuery,
    ITableUpdateOp,
    ITableValue,
    MatchKeysAndValues,
} from "./core/types"
export type {
    ITableDBAdapter,
    ITableDBAdapterInstance,
    ITableDebugResult,
    ITableDefineIndexesOptions,
    ITableDeleteOptions,
    ITableDeletedResult,
    ITableDoc,
    ITableFindOptions,
    ITableIndexConfig,
    ITableInsertResult,
    ITableSetOptions,
    ITableSetResult,
    ITableUpdateOptions,
    ITableUpdateResult,
} from "./adapter/adapter"
export { SQLiteAdapter } from "./adapter/SQLite"
export { MongoDBAdapter } from "./adapter/MongoDB"
export { TableTree } from "./extension/tree"
export { TableJSON } from "fzz"
