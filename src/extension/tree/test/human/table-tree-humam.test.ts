// 人类编写的单元测试

import { SQLiteAdapter } from "../../../../adapter/SQLite"
import { defineTableTree } from "../../TableTree"

async function createDefinedTreeTable(name: string) {
    const useTreeTable = defineTableTree({
        name: `test-${name}`,
        adapter: SQLiteAdapter({ filename: ":memory:" }),
        enableMarkDelete: true,
    })

    return await useTreeTable()
}

test("n1", async () => {
    let tree = await createDefinedTreeTable("n1")
    let re1 = await tree.createNodes([{ id: "1", name: "n1" }], "/", { returnNewNodes: true })
    let newNodes = re1.newNodes!

 
    expect(newNodes[0]).toEqual(expect.objectContaining({ id: "1", name: "n1" }))

})
