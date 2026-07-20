import { defineTable, SQLiteAdapter } from "tbdb";
import { dto } from "fzz";

const { String, Number } = dto;

export class UserSchema {
  id: string = String();
  /** 名字 */
  name: string = String();
  /** 年龄 */
  age: number = Number();
}

const useUserTable = defineTable({
  name: "user",
  schema: new UserSchema(),
  adapter: SQLiteAdapter({ filename: "./data/user.sqlite" }),
});

const userTable = await useUserTable();
await userTable.insertOne({ id: "u_1", name: "Alice", age: 20 });
let re = (await userTable.findOne({ id: "u_1" }))!;
re.age;
