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
    ITableTransactionOptions,
} from "./adapter/adapter"
export { SQLiteAdapter } from "./adapter/SQLite"
export { MongoDBAdapter } from "./adapter/MongoDB"
export type { MongoDBAdapterConfig } from "./adapter/MongoDB"
export { TableTree, defineTableTree } from "./extension/tree"
export type {
    ITableTreeOptions,
    ITreeCreateNodesOptions,
    ITreeCreateResult,
    ITreeUpdateNodesOptions,
    ITreeDeleteNodesOptions,
    ITreeDeleteResult,
    ITreeMoveNodesOptions,
    ITreeSetNodesOptions,
    ITreeSetNodesResult,
} from "./extension/tree"
export { TableJSON } from "fzz"
