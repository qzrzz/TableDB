import { defineTable, SQLiteAdapter } from "tbdb"
import { dto } from "fzz"
const { String, Number, Boolean, Array, Date, Any, optional, or } = dto

export class UserTableSchema {
    id: string = String()
    name: string = String()
}

// 定义 User 表

export const useUserTable = defineTable({
    name: "User",
    adapter: SQLiteAdapter({ filename: ":memory:" }),
})

useUserTable()
