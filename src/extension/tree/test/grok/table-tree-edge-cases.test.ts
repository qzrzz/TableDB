/**
 * 更刁钻的边界场景：软删冲突、排序参考节点、批次环、isDir 翻转等。
 */
import {
    childIds,
    createGrokTree,
    dir,
    expectStatsMatchChildren,
    file,
    statsOf,
} from "./helpers"

describe("TableTree · Grok 边界 · 软删除与覆盖交互", () => {
    test("replace 覆盖时不应把软删除同名节点当存活冲突误伤", async () => {
        const table = await createGrokTree("soft-conflict-replace")
        await table.setNodes([file("old", "/", "same.txt", 1)])
        await table.deleteNodes(["old"])

        // 软删后同名再建：应成功写入，不因隐藏节点卡死
        await table.setNodes([file("new", "/", "same.txt", 2)], {
            uniqueBy: "name",
            overwriteMode: "replace",
        })
        expect(await table.get("new")).toBeDefined()
        expect((await table.get("new"))?.size).toBe(2)
        // 旧软删记录可仍在库中，但不可见
        expect(await table.get("old")).toBeUndefined()
    })

    test("newName 生成后缀时不应与已有 (n) 名称继续碰撞", async () => {
        const table = await createGrokTree("newname-chain")
        await table.setNodes([
            file("a", "/", "pic.png"),
            file("b", "/", "pic (1).png"),
        ])
        await table.setNodes([file("c", "/", "pic.png")], {
            uniqueBy: "name",
            overwriteMode: "newName",
        })
        const names = (await table.listNodes("/")).list.map((n) => n.name).sort()
        expect(names).toContain("pic.png")
        expect(names).toContain("pic (1).png")
        expect(names).toContain("pic (2).png")
        expect(new Set(names).size).toBe(names.length)
    })

    test("同级已有 file (2).txt 时 newName 应从 (2) 递增而非叠后缀", async () => {
        const table = await createGrokTree("newname-increment")
        await table.setNodes([file("a", "/", "file (2).txt")])
        await table.setNodes([file("b", "/", "file (2).txt")], {
            uniqueBy: "name",
            overwriteMode: "newName",
        })
        expect((await table.get("b"))?.name).toBe("file (3).txt")
    })
})

describe("TableTree · Grok 边界 · 排序与校验", () => {
    test("prevNodeId 不存在时应抛错且不写入半成品", async () => {
        const table = await createGrokTree("index-missing-prev")
        await table.createNodes([dir("d")], "/")
        await table.createNodes([file("a", "d")], "d", { index: { toEnd: true } })

        await expect(
            table.createNodes([file("x", "d")], "d", { index: { prevNodeId: "ghost" } }),
        ).rejects.toThrow()
        expect(await table.get("x")).toBeUndefined()
        expect(await childIds(table, "d")).toEqual(["a"])
    })

    test("prevNodeId 不属于目标父级时应拒绝", async () => {
        const table = await createGrokTree("index-wrong-parent")
        await table.setNodes([
            dir("d1"),
            dir("d2"),
            file("a", "d1"),
            file("b", "d2"),
        ])
        await expect(
            table.createNodes([file("x", "d2")], "d2", { index: { prevNodeId: "a" } }),
        ).rejects.toThrow()
        expect(await table.get("x")).toBeUndefined()
    })

    test("createNodes 显式空 index 且无 options.index 时允许空串排序", async () => {
        const table = await createGrokTree("empty-index")
        await table.createNodes([dir("d")], "/")
        await table.createNodes(
            [
                { id: "a", name: "a", isDir: false, size: 1, index: "" },
                { id: "b", name: "b", isDir: false, size: 1, index: "" },
            ],
            "d",
        )
        expect((await childIds(table, "d")).sort()).toEqual(["a", "b"])
        await expectStatsMatchChildren(table, "d")
    })
})

describe("TableTree · Grok 边界 · isDir 与 size 翻转", () => {
    test("文件改为目录后 cftotal 应按 isDir 重算", async () => {
        const table = await createGrokTree("isdir-flip")
        await table.setNodes([
            dir("p"),
            file("n", "p", "n", 5),
        ])
        expect((await statsOf(table, "p")).cftotal).toBe(1)

        await table.updateNodes({ id: "n" }, { $set: { isDir: true, size: 0 } })
        // n 变为目录且无子节点时，对父级仍贡献 1 个节点，但不再计为文件
        await expectStatsMatchChildren(table, "p")
        expect((await statsOf(table, "p")).cftotal).toBe(0)
        expect((await statsOf(table, "p")).ctotal).toBe(1)
    })

    test("目录下挂文件后把目录 isDir 改成 false，统计仍应自洽", async () => {
        const table = await createGrokTree("dir-to-file-with-kids")
        await table.setNodes([
            dir("p"),
            dir("bag", "p"),
            file("f", "bag", "f", 4),
        ])
        await table.updateNodes({ id: "bag" }, { $set: { isDir: false } })
        await expectStatsMatchChildren(table, "p")
        // bag 自身按文件计 1 + 其 cftotal
        const p = await statsOf(table, "p")
        expect(p.ctotal).toBe(2)
        expect(p.cftotal).toBe(2) // bag(文件) + f
        expect(p.csize).toBe(4)
    })
})

describe("TableTree · Grok 边界 · 批次拓扑与环", () => {
    test("setNodes 输入形成父子环时应失败或拒绝落库成环", async () => {
        const table = await createGrokTree("set-cycle-batch")
        // A 父是 B，B 父是 A
        await expect(
            table.setNodes([
                dir("A", "B", "A"),
                dir("B", "A", "B"),
            ]),
        ).rejects.toThrow()

        expect(await table.get("A")).toBeUndefined()
        expect(await table.get("B")).toBeUndefined()
    })

    test("已有树上 setNodes 把父节点挪到子节点下应被拒绝", async () => {
        const table = await createGrokTree("set-move-into-descendant")
        await table.setNodes([
            dir("p"),
            dir("c", "p"),
            file("f", "c"),
        ])

        await expect(
            table.setNodes([
                { id: "p", parentId: "c", name: "p", isDir: true },
            ]),
        ).rejects.toThrow()

        expect((await table.get("p"))?.parentId).toBe("/")
        expect((await table.get("c"))?.parentId).toBe("p")
    })
})

describe("TableTree · Grok 边界 · 删除与移动混合", () => {
    test("删除后再 move 已删除节点应为空操作或不抛脏状态", async () => {
        const table = await createGrokTree("move-deleted")
        await table.setNodes([
            dir("a"),
            dir("b"),
            file("f", "a"),
        ])
        await table.deleteNodes(["f"])
        const result = await table.moveNodes(["f"], "b")
        // 软删后 get 不可见，move 应找不到可移动节点
        expect(result).toEqual({})
        expect(await table.get("f")).toBeUndefined()
        await expectStatsMatchChildren(table, "a")
        await expectStatsMatchChildren(table, "b")
    })

    test("移动目录时子树统计应完整迁到新父级", async () => {
        const table = await createGrokTree("move-dir-subtree-stats")
        await table.setNodes([
            dir("a"),
            dir("b"),
            dir("folder", "a"),
            file("f1", "folder", "f1", 3),
            file("f2", "folder", "f2", 5),
        ])

        await table.moveNodes(["folder"], "b")
        await expectStatsMatchChildren(table, "a")
        await expectStatsMatchChildren(table, "b")
        await expectStatsMatchChildren(table, "folder")
        expect((await statsOf(table, "a")).ctotal).toBe(0)
        expect((await statsOf(table, "b")).ctotal).toBe(3)
        expect((await statsOf(table, "b")).csize).toBe(8)
    })

    test("根级多个目录互相 move 子节点后统计交叉正确", async () => {
        const table = await createGrokTree("cross-move-stats")
        await table.setNodes([
            dir("L"),
            dir("R"),
            file("l1", "L", "l1", 1),
            file("l2", "L", "l2", 2),
            file("r1", "R", "r1", 4),
        ])
        await table.moveNodes(["l1"], "R")
        await table.moveNodes(["r1"], "L")
        await expectStatsMatchChildren(table, "L")
        await expectStatsMatchChildren(table, "R")
        expect((await statsOf(table, "L")).csize).toBe(6) // l2+r1
        expect((await statsOf(table, "R")).csize).toBe(1) // l1
    })
})

describe("TableTree · Grok 边界 · list 分页与投影", () => {
    test("pageSize 分页不丢节点且可拼回全量", async () => {
        const table = await createGrokTree("list-paging")
        await table.createNodes([dir("d")], "/")
        const ids = Array.from({ length: 15 }, (_, i) => `n${i}`)
        await table.createNodes(
            ids.map((id) => file(id, "d")),
            "d",
            { index: { toEnd: true } },
        )

        // 分页字段是 pageIndex（从 1 开始），不是 page
        const page1 = await table.listNodes("d", { pageSize: 6, pageIndex: 1 })
        const page2 = await table.listNodes("d", { pageSize: 6, pageIndex: 2 })
        const page3 = await table.listNodes("d", { pageSize: 6, pageIndex: 3 })
        const all = [...page1.list, ...page2.list, ...page3.list].map((n) => n.id)
        expect(all.sort()).toEqual([...ids].sort())
        expect(page1.list).toHaveLength(6)
        expect(page2.list).toHaveLength(6)
        expect(page3.list).toHaveLength(3)
        expect(page1.hasNext).toBe(true)
        expect(page3.hasNext).toBe(false)
    })

    test("projection 只返回请求字段时 id 仍可用", async () => {
        const table = await createGrokTree("list-projection")
        await table.setNodes([file("f", "/", "name", 9)])
        const result = await table.listNodes("/", {
            projection: ["id", "name"],
            pageSize: 10,
        })
        expect(result.list[0]?.id).toBe("f")
        expect(result.list[0]?.name).toBe("name")
    })
})

describe("TableTree · Grok 边界 · defineTableTree 与空树", () => {
    test("空树上 list/refresh/delete 应安全", async () => {
        const table = await createGrokTree("empty-tree")
        expect(await childIds(table, "/")).toEqual([])
        await table.refreshTreeMetadata("/")
        expect(await table.deleteNodes(["nope"])).toMatchObject({ deletedCount: 0 })
        expect(await table.moveNodes(["nope"], "/")).toEqual({})
    })

    test("createNodes returnNewNodes 应返回实际插入节点", async () => {
        const table = await createGrokTree("return-new-nodes")
        const result = await table.createNodes(
            [file("a", "/", "a", 1), file("b", "/", "b", 2)],
            "/",
            { returnNewNodes: true, index: { toEnd: true } },
        )
        expect(result.createdNodeIds.sort()).toEqual(["a", "b"])
        expect(result.newNodes?.map((n) => n.id).sort()).toEqual(["a", "b"])
        expect(result.newNodes?.every((n) => typeof n.modif === "number")).toBe(true)
    })
})
