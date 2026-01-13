import { defineTable, SQLiteAdapter } from "tbdb"
import { rollString } from "fzz"
const __dirname = import.meta.dirname
export const useUserTable = defineTable({
    name: "User",
    adapter: SQLiteAdapter({ filename: __dirname + "/dist/big_350K.sqlite" }),
})

let userTable = await useUserTable()

// 插入 350 万条数据

for (let i = 0; i < 35; i++) {
    let docs = []
    for (let j = 0; j < 10000; j++) {
        let index = i * 10000 + j
        docs.push({
            name: "User " + index,
            age: index % 100,
            parentId: rollString(32),
            projectId: rollString(32),
            createUserId: rollString(32),
            modifUserId: rollString(32),
            preview: {
                dirCover: {
                    imgs: [rollString(64)],
                    cmodif: Date.now(),
                },
            },
            meta: {
                metaVer: 0.1,
                test: rollString(256),
            },
        })
    }
    let re = await userTable.insertMany(docs)
    console.log("Inserted batch:", i, re)
}

console.log("All done")
export {}
