/**
 * SQLite Driver 抽象层测试
 * 
 * 测试 better-sqlite3 和 node:sqlite 两种驱动的统一接口
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest"
import {
    BetterSqlite3Driver,
    NodeSqliteDriver,
    createSqliteDriver,
    createAutoSqliteDriver,
    isSqliteDriverAvailable,
    type ISqliteDatabase,
    type SqliteDriverType,
} from ".."

// 获取可用的驱动列表
const availableDrivers: SqliteDriverType[] = []

if (isSqliteDriverAvailable("better-sqlite3")) {
    availableDrivers.push("better-sqlite3")
}

if (isSqliteDriverAvailable("node:sqlite")) {
    availableDrivers.push("node:sqlite")
}

describe("SQLite Driver 抽象层", () => {
    describe("驱动可用性检测", () => {
        test("至少有一个驱动可用", () => {
            expect(availableDrivers.length).toBeGreaterThan(0)
        })

        test("isSqliteDriverAvailable 正确检测", () => {
            // 至少 better-sqlite3 应该可用（项目依赖）
            expect(isSqliteDriverAvailable("better-sqlite3")).toBe(true)
        })
    })

    describe("createAutoSqliteDriver 自动选择", () => {
        test("能够自动创建可用的驱动", () => {
            const { db, type } = createAutoSqliteDriver({ filename: ":memory:" })
            expect(db).toBeDefined()
            expect(db.isOpen).toBe(true)
            expect(availableDrivers).toContain(type)
            db.close()
        })
    })

    // 为每个可用的驱动运行完整测试套件
    describe.each(availableDrivers)("驱动: %s", (driverType) => {
        let db: ISqliteDatabase

        beforeEach(() => {
            db = createSqliteDriver(driverType, { filename: ":memory:" })
        })

        afterEach(() => {
            if (db?.isOpen) {
                db.close()
            }
        })

        describe("基本操作", () => {
            test("isOpen 属性正确", () => {
                expect(db.isOpen).toBe(true)
            })

            test("exec 执行 DDL", () => {
                db.exec(`
                    CREATE TABLE test (
                        id INTEGER PRIMARY KEY,
                        name TEXT
                    )
                `)
                // 不抛出错误即为成功
            })

            test("prepare + run 插入数据", () => {
                db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)")

                const stmt = db.prepare("INSERT INTO test (id, name) VALUES (?, ?)")
                const result = stmt.run(1, "Alice")

                expect(Number(result.changes)).toBe(1)
                expect(Number(result.lastInsertRowid)).toBe(1)
            })

            test("prepare + get 查询单行", () => {
                db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)")
                db.prepare("INSERT INTO test (id, name) VALUES (?, ?)").run(1, "Alice")

                const stmt = db.prepare("SELECT * FROM test WHERE id = ?")
                const row = stmt.get(1)

                expect(row).toEqual({ id: 1, name: "Alice" })
            })

            test("prepare + all 查询多行", () => {
                db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)")
                db.prepare("INSERT INTO test (id, name) VALUES (?, ?)").run(1, "Alice")
                db.prepare("INSERT INTO test (id, name) VALUES (?, ?)").run(2, "Bob")

                const stmt = db.prepare("SELECT * FROM test ORDER BY id")
                const rows = stmt.all()

                expect(rows).toEqual([
                    { id: 1, name: "Alice" },
                    { id: 2, name: "Bob" },
                ])
            })

            test("get 无结果返回 undefined", () => {
                db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)")

                const stmt = db.prepare("SELECT * FROM test WHERE id = ?")
                const row = stmt.get(999)

                expect(row).toBeUndefined()
            })

            test("all 无结果返回空数组", () => {
                db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)")

                const stmt = db.prepare("SELECT * FROM test")
                const rows = stmt.all()

                expect(rows).toEqual([])
            })
        })

        describe("自定义函数", () => {
            test("注册并使用自定义函数", () => {
                db.function("myDouble", (x: number) => x * 2)

                db.exec("CREATE TABLE test (val INTEGER)")
                db.prepare("INSERT INTO test (val) VALUES (?)").run(5)

                const stmt = db.prepare("SELECT myDouble(val) as result FROM test")
                const row = stmt.get()

                expect(row.result).toBe(10)
            })

            test("多参数自定义函数", () => {
                db.function("myAdd", (a: number, b: number) => a + b)

                db.exec("CREATE TABLE test (a INTEGER, b INTEGER)")
                db.prepare("INSERT INTO test (a, b) VALUES (?, ?)").run(3, 7)

                const stmt = db.prepare("SELECT myAdd(a, b) as sum FROM test")
                const row = stmt.get()

                expect(row.sum).toBe(10)
            })

            test("返回字符串的自定义函数", () => {
                db.function("myConcat", (a: string, b: string) => `${a}-${b}`)

                db.exec("CREATE TABLE test (a TEXT, b TEXT)")
                db.prepare("INSERT INTO test (a, b) VALUES (?, ?)").run("Hello", "World")

                const stmt = db.prepare("SELECT myConcat(a, b) as result FROM test")
                const row = stmt.get()

                expect(row.result).toBe("Hello-World")
            })
        })

        describe("事务", () => {
            test("事务成功提交", () => {
                db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)")

                const insertMany = db.transaction((items: { id: number; name: string }[]) => {
                    const stmt = db.prepare("INSERT INTO test (id, name) VALUES (?, ?)")
                    for (const item of items) {
                        stmt.run(item.id, item.name)
                    }
                    return items.length
                })

                const count = insertMany([
                    { id: 1, name: "Alice" },
                    { id: 2, name: "Bob" },
                    { id: 3, name: "Charlie" },
                ])

                expect(count).toBe(3)

                const rows = db.prepare("SELECT * FROM test ORDER BY id").all()
                expect(rows.length).toBe(3)
            })

            test("事务失败回滚", () => {
                db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)")
                db.prepare("INSERT INTO test (id, name) VALUES (?, ?)").run(1, "Original")

                const failingTx = db.transaction(() => {
                    db.prepare("UPDATE test SET name = ? WHERE id = ?").run("Modified", 1)
                    throw new Error("故意抛出错误")
                })

                expect(() => failingTx()).toThrow("故意抛出错误")

                // 验证数据未被修改
                const row = db.prepare("SELECT name FROM test WHERE id = ?").get(1)
                expect(row.name).toBe("Original")
            })

            test("嵌套调用同一事务函数", () => {
                db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, val INTEGER)")

                const increment = db.transaction((id: number) => {
                    db.prepare("INSERT INTO test (id, val) VALUES (?, 1) ON CONFLICT(id) DO UPDATE SET val = val + 1").run(id)
                })

                // 调用多次
                increment(1)
                increment(1)
                increment(1)

                const row = db.prepare("SELECT val FROM test WHERE id = ?").get(1)
                expect(row.val).toBe(3)
            })
        })

        describe("close 操作", () => {
            test("close 后 isOpen 为 false", () => {
                expect(db.isOpen).toBe(true)
                db.close()
                expect(db.isOpen).toBe(false)
            })

            test("重复 close 不抛错", () => {
                db.close()
                expect(() => db.close()).not.toThrow()
            })
        })

        describe("Statement 缓存", () => {
            test("相同 SQL 返回相同语句（性能优化）", () => {
                db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY)")

                const sql = "SELECT * FROM test WHERE id = ?"
                const stmt1 = db.prepare(sql)
                const stmt2 = db.prepare(sql)

                // 由于缓存，应该是同一个对象
                expect(stmt1).toBe(stmt2)
            })
        })
    })
})
