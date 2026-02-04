/**
 * SQLite Driver 抽象层类型定义
 * 
 * 提供统一的接口让 better-sqlite3 和 node:sqlite 可以互换使用
 */

/**
 * SQLite Statement 抽象接口
 * 对应 better-sqlite3 的 Statement 和 node:sqlite 的 StatementSync
 */
export interface ISqliteStatement {
    /**
     * 执行语句并返回所有结果行
     */
    all(...params: any[]): any[]

    /**
     * 执行语句并返回第一行结果
     */
    get(...params: any[]): any

    /**
     * 执行语句（用于 INSERT/UPDATE/DELETE）
     * @returns 包含 changes 和 lastInsertRowid 的对象
     */
    run(...params: any[]): ISqliteRunResult
}

/**
 * Statement.run() 的返回值
 */
export interface ISqliteRunResult {
    /** 受影响的行数 */
    changes: number | bigint
    /** 最后插入行的 rowid */
    lastInsertRowid: number | bigint
}

/**
 * SQLite 事务函数类型
 * better-sqlite3 使用 db.transaction() 返回一个可调用函数
 * node:sqlite 需要手动管理 BEGIN/COMMIT
 */
export type ISqliteTransactionFn<T extends (...args: any[]) => any> = T & {
    /** 立即执行事务 */
    immediate: T
    /** 独占执行事务 */
    exclusive: T
    /** 延迟执行事务 */
    deferred: T
}

/**
 * SQLite Database 抽象接口
 * 统一 better-sqlite3 和 node:sqlite 的 API 差异
 */
export interface ISqliteDatabase {
    /**
     * 数据库是否已打开
     */
    readonly isOpen: boolean

    /**
     * 准备 SQL 语句
     * @param sql SQL 语句
     * @returns 预编译的语句对象
     */
    prepare(sql: string): ISqliteStatement

    /**
     * 执行 SQL 语句（不返回结果）
     * @param sql SQL 语句
     */
    exec(sql: string): void

    /**
     * 注册自定义函数
     * @param name 函数名
     * @param fn 函数实现
     */
    function(name: string, fn: (...args: any[]) => any): void

    /**
     * 创建事务
     * @param fn 事务函数
     * @returns 可调用的事务函数
     */
    transaction<T extends (...args: any[]) => any>(fn: T): ISqliteTransactionFn<T>

    /**
     * 执行 WAL checkpoint
     * 用于在压缩数据库文件前确保所有 WAL 数据已写入主文件
     * @param mode checkpoint 模式，默认 "TRUNCATE"
     */
    checkpoint(mode?: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE"): void

    /**
     * 关闭数据库连接
     */
    close(): void
}

/**
 * SQLite Driver 工厂配置
 */
export interface ISqliteDriverConfig {
    /** 数据库文件路径，":memory:" 表示内存数据库 */
    filename: string
    /** 是否启用 WAL 模式 */
    walMode?: boolean
    /** 同步模式: "OFF" | "NORMAL" | "FULL" */
    synchronous?: "OFF" | "NORMAL" | "FULL"
}

/**
 * SQLite Driver 类型枚举
 */
export type SqliteDriverType = "better-sqlite3" | "node:sqlite"
