import { SQLiteAdapter } from "../../../adapter/SQLite"
import { TableTree } from "../TableTree"
import { defineTableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"

// 使用 SQLite 内存数据库来测试 defineTableTree 的创建和功能
describe("defineTableTree 快捷定义树形表", () => {
    test("应该能够正确创建 TableTree 实例，并且是 TableTree 的子类", async () => {
        // 定义一个名为 test-tree-define 的树形表
        const useTestTree = defineTableTree<ITreeNode>({
            name: "test-tree-define",
            adapter: SQLiteAdapter({ filename: ":memory:", driver: "better-sqlite3" }),
            enableMarkDelete: true,
        })

        // 获取表实例
        const treeTable = await useTestTree()

        // 验证实例是否继承自 TableTree
        expect(treeTable).toBeInstanceOf(TableTree)

        // 验证动态生成的类名
        expect(treeTable.constructor.name).toBe("test-tree-defineTable")

        // 验证实例上存在 TableTree 专属的核心方法
        expect(typeof treeTable.createNodes).toBe("function")
        expect(typeof treeTable.listNodes).toBe("function")

        // 测试插入和列表操作，保证其功能运行正常
        await treeTable.createNodes(
            [
                { id: "root-dir", name: "根目录", isDir: true },
            ],
            "/",
        )

        await treeTable.createNodes(
            [
                { id: "sub-file", name: "子文件.txt", isDir: false, size: 100 },
            ],
            "root-dir",
        )

        // 获取根目录，验证其 ctotal 统计是否被自动更新
        const rootDir = await treeTable.get("root-dir")
        expect(rootDir).toBeDefined()
        expect(rootDir?.ctotal).toBe(1)
        expect(rootDir?.csize).toBe(100)

        // 列出子节点
        const listRe = await treeTable.listNodes("root-dir", { pageSize: 10 })
        expect(listRe.list.length).toBe(1)
        expect(listRe.list[0].id).toBe("sub-file")

        // 清理
        await treeTable.clearAll()
    })
})
