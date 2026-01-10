import { defineTable, SQLiteAdapter } from "fzz/src/only/tableDB"
import { dto } from "fzz"
const { String, Number, Boolean, Array, Date, Any, optional, or } = dto

const __dirname = import.meta.dirname

export class UserTableSchema {
    id: string = String()
    name: string = String()
}

// 定义 User 表

export const useUserTable = defineTable({
    name: "User",
    adapter: SQLiteAdapter({ filename: __dirname + "/dist/user.sqlite" }),
})

let userTable = await useUserTable()

let re = await userTable.insertMany([
    {
        name: "Alice",
    },
    {
        name: "Bob",
    },
])

console.log("Inserted:", re)
