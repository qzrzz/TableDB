/**
 * Grok 对抗性单元测试：专门压边界路径，试图暴露 TableTree 的逻辑漏洞。
 * 约定：断言写的是“正确语义”，失败即视为发现 bug。
 */
import {
    childIds,
    createGrokTree,
    dir,
    expectStatsMatchChildren,
    file,
    statsOf,
    type IGrokTreeNode,
} from "./helpers"

describe("TableTree · Grok 挖 bug · 结构移动", () => {
    test("默认 moveNodes 不得误删目标父级下的无关兄弟", async () => {
        const table = await createGrokTree("move-no-sibling-wipe")
        await table.setNodes([
            dir("a"),
            dir("b"),
            file("f1", "a"),
            file("f2", "b"),
            file("f3", "b"),
            file("f4", "b"),
        ])

        await table.moveNodes(["f1"], "b")

        expect((await table.get("f1"))?.parentId).toBe("b")
        expect(await table.get("f2")).toBeDefined()
        expect(await table.get("f3")).toBeDefined()
        expect(await table.get("f4")).toBeDefined()
        expect((await childIds(table, "b")).sort()).toEqual(["f1", "f2", "f3", "f4"])
        await expectStatsMatchChildren(table, "a")
        await expectStatsMatchChildren(table, "b")
    })

    test("同父级仅重排 index 时不得删除其它兄弟", async () => {
        const table = await createGrokTree("move-reorder-same-parent")
        await table.createNodes([dir("d")], "/")
        await table.createNodes(
            [file("a", "d"), file("b", "d"), file("c", "d")],
            "d",
            { index: { toEnd: true } },
        )

        await table.moveNodes(["c"], "d", { index: { toStart: true } })

        expect((await childIds(table, "d")).sort()).toEqual(["a", "b", "c"])
        expect((await childIds(table, "d"))[0]).toBe("c")
    })

    test("批量移动多个节点到已有子节点的目录，不得清空目标", async () => {
        const table = await createGrokTree("move-batch-preserve")
        await table.setNodes([
            dir("src"),
            dir("dst"),
            file("keep", "dst"),
            file("m1", "src"),
            file("m2", "src"),
        ])

        await table.moveNodes(["m1", "m2"], "dst")

        expect((await childIds(table, "dst")).sort()).toEqual(["keep", "m1", "m2"])
        expect((await childIds(table, "src"))).toEqual([])
        await expectStatsMatchChildren(table, "dst")
        await expectStatsMatchChildren(table, "src")
    })

    test("禁止把节点移动到自身或其后代下", async () => {
        const table = await createGrokTree("move-no-cycle")
        await table.setNodes([
            dir("p"),
            dir("c", "p"),
            dir("g", "c"),
            file("f", "g"),
        ])

        await expect(table.moveNodes(["p"], "p")).rejects.toThrow()
        await expect(table.moveNodes(["p"], "c")).rejects.toThrow()
        await expect(table.moveNodes(["p"], "g")).rejects.toThrow()
        expect((await table.get("p"))?.parentId).toBe("/")
    })

    test("父子同时出现在 move 输入时只应移动最外层，后代不该被平铺", async () => {
        const table = await createGrokTree("move-top-selected")
        await table.setNodes([
            dir("a"),
            dir("b"),
            dir("folder", "a"),
            file("nested", "folder"),
        ])

        await table.moveNodes(["folder", "nested"], "b")

        expect((await table.get("folder"))?.parentId).toBe("b")
        // nested 应随 folder 走，而不是被单独挪到 b 下
        expect((await table.get("nested"))?.parentId).toBe("folder")
        expect(await childIds(table, "b")).toEqual(["folder"])
    })
})

describe("TableTree · Grok 挖 bug · updateNodes", () => {
    test("updateNodes 必须忽略 parentId，其它字段仍可更新", async () => {
        const table = await createGrokTree("update-ignore-parent")
        await table.setNodes([
            dir("p"),
            dir("c", "p"),
            file("f", "c", "f.txt", 3),
        ])

        await table.updateNodes(
            { id: "p" },
            { $set: { parentId: "c", note: "ok", name: "父新名" } as any },
        )

        const p = await table.get("p")
        expect(p?.parentId).toBe("/")
        expect(p?.note).toBe("ok")
        expect(p?.name).toBe("父新名")
        expect((await table.get("c"))?.parentId).toBe("p")
    })

    test("updateNodes 不得通过 $set 写入受管理统计字段", async () => {
        const table = await createGrokTree("update-strip-stats")
        await table.setNodes([
            dir("d"),
            file("f", "d", "f", 10),
        ])

        await table.updateNodes(
            { id: "d" },
            { $set: { ctotal: 999, cftotal: 999, csize: 999, childLastIndex: "zzz" } as any },
        )

        // 被忽略后，全量 refresh 或下一次 stats 变更前可能仍是旧值；
        // 至少不应把错误的业务写入当成权威：再 refresh 后应回到真实值。
        await table.refreshTreeMetadata("d")
        const s = await statsOf(table, "d")
        expect(s.ctotal).toBe(1)
        expect(s.cftotal).toBe(1)
        expect(s.csize).toBe(10)
    })

    test("deep 更新应波及后代，但不得改 parentId", async () => {
        const table = await createGrokTree("update-deep")
        await table.setNodes([
            dir("d"),
            dir("sub", "d"),
            file("f", "sub"),
        ])

        await table.updateNodes(
            { id: "d" },
            { $set: { note: "deep", parentId: "/" } as any },
            { deep: true },
        )

        expect((await table.get("d"))?.note).toBe("deep")
        expect((await table.get("sub"))?.note).toBe("deep")
        expect((await table.get("f"))?.note).toBe("deep")
        expect((await table.get("sub"))?.parentId).toBe("d")
        expect((await table.get("f"))?.parentId).toBe("sub")
    })

    test("更新 size 后祖先 csize 必须同步", async () => {
        const table = await createGrokTree("update-size-stats")
        await table.setNodes([
            dir("root"),
            dir("mid", "root"),
            file("f", "mid", "f", 5),
        ])

        await table.updateNodes({ id: "f" }, { $set: { size: 20 } })
        expect((await statsOf(table, "mid")).csize).toBe(20)
        expect((await statsOf(table, "root")).csize).toBe(20)
        await expectStatsMatchChildren(table, "mid")
        await expectStatsMatchChildren(table, "root")
    })

    test("名称包含斜杠必须拒绝", async () => {
        const table = await createGrokTree("update-name-slash")
        await table.setNodes([file("f", "/", "ok")])
        await expect(
            table.updateNodes({ id: "f" }, { $set: { name: "a/b" } }),
        ).rejects.toThrow()
        expect((await table.get("f"))?.name).toBe("ok")
    })
})

describe("TableTree · Grok 挖 bug · 删除与软删除", () => {
    test("删除目录应连带后代，并从父级统计中移除整棵子树", async () => {
        const table = await createGrokTree("delete-subtree")
        await table.setNodes([
            dir("root"),
            dir("d", "root"),
            file("f1", "d", "f1", 4),
            file("f2", "d", "f2", 6),
            file("keep", "root", "keep", 1),
        ])

        await table.deleteNodes(["d"])
        expect(await table.get("d")).toBeUndefined()
        expect(await table.get("f1")).toBeUndefined()
        expect(await table.get("f2")).toBeUndefined()
        expect(await table.get("keep")).toBeDefined()
        await expectStatsMatchChildren(table, "root")
        expect((await statsOf(table, "root")).csize).toBe(1)
    })

    test("软删除后再次软删除应幂等，统计不得被重复扣减", async () => {
        const table = await createGrokTree("delete-idempotent")
        await table.setNodes([
            dir("d"),
            file("f", "d", "f", 8),
        ])

        await table.deleteNodes(["f"])
        const afterFirst = await statsOf(table, "d")
        await table.deleteNodes(["f"])
        const afterSecond = await statsOf(table, "d")
        expect(afterSecond).toEqual(afterFirst)
        expect(afterSecond.ctotal).toBe(0)
    })

    test("父子同时删除时统计只应按最外层扣减一次", async () => {
        const table = await createGrokTree("delete-parent-and-child")
        await table.setNodes([
            dir("root"),
            dir("d", "root"),
            file("f", "d", "f", 10),
        ])

        await table.deleteNodes(["d", "f"])
        await expectStatsMatchChildren(table, "root")
        expect((await statsOf(table, "root")).ctotal).toBe(0)
    })

    test("realDelete 可清理已软删除节点，且不破坏仍存活的兄弟统计", async () => {
        const table = await createGrokTree("real-delete-marked")
        await table.setNodes([
            dir("d"),
            file("gone", "d", "gone", 3),
            file("keep", "d", "keep", 7),
        ])
        await table.deleteNodes(["gone"])
        await table.deleteNodes(["gone"], { realDelete: true })

        expect(await table.get("gone", { ignoreMarkDelete: true })).toBeUndefined()
        expect(await table.get("keep")).toBeDefined()
        await expectStatsMatchChildren(table, "d")
        expect((await statsOf(table, "d")).csize).toBe(7)
    })

    test("setNodes 恢复软删除节点后父级统计必须回来", async () => {
        const table = await createGrokTree("restore-soft-deleted")
        await table.setNodes([
            dir("a"),
            dir("b"),
            file("f", "a", "f", 5),
        ])
        await table.deleteNodes(["f"])
        expect((await statsOf(table, "a")).ctotal).toBe(0)

        await table.setNodes([file("f", "b", "恢复", 5)])
        expect((await table.get("f"))?.parentId).toBe("b")
        expect((await table.get("f"))?._isDeleted).not.toBe(true)
        await expectStatsMatchChildren(table, "a")
        await expectStatsMatchChildren(table, "b")
        expect((await statsOf(table, "b")).csize).toBe(5)
    })
})

describe("TableTree · Grok 挖 bug · 覆盖策略", () => {
    test("replace 按 name 覆盖文件应删除旧节点并写入新节点", async () => {
        const table = await createGrokTree("overwrite-replace-file")
        await table.setNodes([file("old", "/", "same.txt", 1)])
        await table.setNodes([file("new", "/", "same.txt", 9)], {
            uniqueBy: "name",
            overwriteMode: "replace",
        })

        expect(await table.get("old")).toBeUndefined()
        expect((await table.get("new"))?.size).toBe(9)
    })

    test("newName 冲突应生成不碰撞后缀，且不得覆盖原节点", async () => {
        const table = await createGrokTree("overwrite-newname")
        await table.setNodes([file("a", "/", "doc.txt")])
        await table.setNodes([file("b", "/", "doc.txt")], {
            uniqueBy: "name",
            overwriteMode: "newName",
        })
        await table.setNodes([file("c", "/", "doc.txt")], {
            uniqueBy: "name",
            overwriteMode: "newName",
        })

        expect((await table.get("a"))?.name).toBe("doc.txt")
        expect((await table.get("b"))?.name).toBe("doc (1).txt")
        expect((await table.get("c"))?.name).toBe("doc (2).txt")
    })

    test("moveNodes newName 必须把新名称写入数据库", async () => {
        const table = await createGrokTree("move-newname-persist")
        await table.setNodes([
            dir("d1"),
            dir("d2"),
            file("a", "d1", "file.txt"),
            file("b", "d2", "file.txt"),
        ])

        await table.moveNodes(["a"], "d2", { uniqueBy: "name", overwriteMode: "newName" })
        const a = await table.get("a")
        expect(a?.parentId).toBe("d2")
        expect(a?.name).toBe("file (1).txt")
        expect((await table.get("b"))?.name).toBe("file.txt")
        const names = (await table.listNodes("d2")).list.map((n) => n.name).sort()
        expect(names).toEqual(["file (1).txt", "file.txt"])
    })

    test("默认禁止文件覆盖目录；开启 enableFileOverwriteDir 后可替换", async () => {
        const table = await createGrokTree("file-over-dir")
        await table.setNodes([
            dir("item"),
            file("child", "item", "c", 2),
            dir("src"),
            file("f", "src", "item", 5),
        ])

        await table.moveNodes(["f"], "/", { uniqueBy: "name", overwriteMode: "replace" })
        expect(await table.get("item")).toBeDefined()
        expect(await table.get("child")).toBeDefined()
        expect((await table.get("f"))?.parentId).toBe("src")

        await table.moveNodes(["f"], "/", {
            uniqueBy: "name",
            overwriteMode: "replace",
            enableFileOverwriteDir: true,
        })
        expect(await table.get("item")).toBeUndefined()
        expect(await table.get("child")).toBeUndefined()
        expect((await table.get("f"))?.parentId).toBe("/")
    })

    test("setNodes merge 同名目录应合并子树并删除来源目录节点", async () => {
        const table = await createGrokTree("set-merge-dirs")
        await table.setNodes([
            dir("target", "/", "合并目录"),
            file("t1", "target", "t1", 1),
        ])
        // 第二批：同名目录 + 其子节点（source id 不同）
        await table.setNodes([
            dir("source", "/", "合并目录"),
            file("s1", "source", "s1", 3),
        ], { uniqueBy: "name", overwriteMode: "merge" })

        expect(await table.get("source")).toBeUndefined()
        expect(await table.get("target")).toBeDefined()
        expect((await table.get("s1"))?.parentId).toBe("target")
        expect((await table.get("t1"))?.parentId).toBe("target")
        await expectStatsMatchChildren(table, "target")
    })

    test("merge 文件冲突应按替换：旧文件消失，来源落到目标父级", async () => {
        const table = await createGrokTree("merge-files")
        await table.setNodes([
            dir("d"),
            file("a", "d", "same.txt", 1),
            dir("src"),
            file("b", "src", "same.txt", 2),
        ])

        await table.moveNodes(["b"], "d", { uniqueBy: "name", overwriteMode: "merge" })
        expect(await table.get("a")).toBeUndefined()
        expect((await table.get("b"))?.parentId).toBe("d")
        expect((await table.get("b"))?.size).toBe(2)
        await expectStatsMatchChildren(table, "d")
    })

    test("setNodes mergeByModif：目标更新则跳过输入；输入更新则替换", async () => {
        const table = await createGrokTree("merge-by-modif")
        await table.setNodes([{ id: "old", parentId: "/", name: "f.txt", modif: 100, size: 1 }])

        await table.setNodes(
            [{ id: "newer-input-but-older-modif", parentId: "/", name: "f.txt", modif: 50, size: 9 }],
            { uniqueBy: "name", overwriteMode: "mergeByModif" },
        )
        expect(await table.get("old")).toBeDefined()
        expect(await table.get("newer-input-but-older-modif")).toBeUndefined()
        expect((await table.get("old"))?.size).toBe(1)

        await table.setNodes(
            [{ id: "fresh", parentId: "/", name: "f.txt", modif: 200, size: 7 }],
            { uniqueBy: "name", overwriteMode: "mergeByModif" },
        )
        expect(await table.get("old")).toBeUndefined()
        expect((await table.get("fresh"))?.size).toBe(7)
    })

    test("skip 模式遇到同名应保留原节点且不写入输入", async () => {
        const table = await createGrokTree("overwrite-skip")
        await table.setNodes([file("old", "/", "x.txt", 1)])
        await table.setNodes([file("new", "/", "x.txt", 9)], {
            uniqueBy: "name",
            overwriteMode: "skip",
        })
        expect(await table.get("old")).toBeDefined()
        expect(await table.get("new")).toBeUndefined()
        expect((await table.get("old"))?.size).toBe(1)
    })

    test("uniqueBy 点路径 meta.hash 应能识别冲突", async () => {
        const table = await createGrokTree("unique-by-path")
        await table.setNodes([
            { id: "a", parentId: "/", name: "a", isDir: false, size: 1, meta: { hash: "h1" } },
        ])
        await table.setNodes(
            [{ id: "b", parentId: "/", name: "b", isDir: false, size: 2, meta: { hash: "h1" } }],
            { uniqueBy: "meta.hash", overwriteMode: "replace" },
        )
        expect(await table.get("a")).toBeUndefined()
        expect(await table.get("b")).toBeDefined()
    })
})

describe("TableTree · Grok 挖 bug · setNodes 编排", () => {
    test("父不存在时 setNodes 应整批回滚，不留下部分写入", async () => {
        const table = await createGrokTree("set-topology-rollback")
        await expect(table.setNodes([
            file("child2", "ghost", "c"),
            dir("tmp"),
        ])).rejects.toThrow()
        expect(await table.get("tmp")).toBeUndefined()
        expect(await table.get("child2")).toBeUndefined()
    })

    test("同一批可创建深层父子并维护每一层统计", async () => {
        const table = await createGrokTree("set-deep-batch")
        await table.setNodes([
            file("leaf", "mid", "leaf", 4),
            dir("mid", "root"),
            dir("root"),
        ])

        expect((await table.get("leaf"))?.parentId).toBe("mid")
        expect((await table.get("mid"))?.parentId).toBe("root")
        await expectStatsMatchChildren(table, "mid")
        await expectStatsMatchChildren(table, "root")
        expect((await statsOf(table, "root")).csize).toBe(4)
    })

    test("setNodes 移动已有节点不得误删目标兄弟", async () => {
        const table = await createGrokTree("set-move-no-wipe")
        await table.setNodes([
            dir("a"),
            dir("b"),
            file("f1", "a"),
            file("f2", "b"),
            file("f3", "b"),
        ])
        await table.setNodes([file("f1", "b", "f1")])
        expect((await childIds(table, "b")).sort()).toEqual(["f1", "f2", "f3"])
    })

    test("批次内重复 id 必须拒绝", async () => {
        const table = await createGrokTree("set-dup-id")
        await expect(table.setNodes([
            file("x", "/", "a"),
            file("x", "/", "b"),
        ])).rejects.toThrow()
    })

    test("updateOnly 不得创建新节点", async () => {
        const table = await createGrokTree("set-update-only")
        await table.setNodes([file("exist", "/", "e", 1)])
        await table.setNodes(
            [
                file("exist", "/", "e", 5),
                file("ghost", "/", "g", 1),
            ],
            { updateOnly: true },
        )
        expect((await table.get("exist"))?.size).toBe(5)
        expect(await table.get("ghost")).toBeUndefined()
    })

    test("setNodes 输入中的 ctotal 等统计字段不得污染库", async () => {
        const table = await createGrokTree("set-strip-managed")
        await table.setNodes([
            { id: "d", parentId: "/", name: "d", isDir: true, ctotal: 999, csize: 999 } as any,
            file("f", "d", "f", 3),
        ])
        await expectStatsMatchChildren(table, "d")
        expect((await statsOf(table, "d")).ctotal).toBe(1)
        expect((await statsOf(table, "d")).csize).toBe(3)
    })
})

describe("TableTree · Grok 挖 bug · metadata 与 refresh", () => {
    test("create/move/delete 组合后祖先统计应自洽", async () => {
        const table = await createGrokTree("meta-combo")
        await table.createNodes([dir("a"), dir("b")], "/")
        await table.createNodes([file("f1", "a", "f1", 2), file("f2", "a", "f2", 3)], "a")
        await table.moveNodes(["f1"], "b")
        await table.deleteNodes(["f2"])
        await table.createNodes([file("f3", "b", "f3", 7)], "b")

        await expectStatsMatchChildren(table, "a")
        await expectStatsMatchChildren(table, "b")
        expect((await statsOf(table, "a")).ctotal).toBe(0)
        expect((await statsOf(table, "b")).csize).toBe(9)
    })

    test("refreshTreeMetadata 应修复空目录上的脏统计", async () => {
        const table = await createGrokTree("refresh-empty-dirty")
        await table.setNodes([dir("d"), file("f", "d", "f", 12)])
        await table.adapter.updateMany(
            { id: "d" },
            { $set: { ctotal: 99, cftotal: 88, csize: 777 } as any },
        )
        await table.adapter.deleteMany({ id: "f" }, { readDelete: true } as any)

        await table.refreshTreeMetadata("d")
        const s = await statsOf(table, "d")
        expect(s.ctotal).toBe(0)
        expect(s.cftotal).toBe(0)
        expect(s.csize).toBe(0)
    })

    test("refreshTreeMetadata('/') 应修复整棵可达树", async () => {
        const table = await createGrokTree("refresh-root")
        await table.setNodes([
            dir("d"),
            dir("sub", "d"),
            file("f", "sub", "f", 5),
        ])
        await table.adapter.updateMany(
            { id: { $in: ["d", "sub"] } },
            { $unset: { ctotal: "", cftotal: "", csize: "" } as any },
        )

        await table.refreshTreeMetadata("/")
        expect((await statsOf(table, "sub")).ctotal).toBe(1)
        expect((await statsOf(table, "sub")).csize).toBe(5)
        expect((await statsOf(table, "d")).ctotal).toBe(2)
        expect((await statsOf(table, "d")).csize).toBe(5)
    })

    test("软删除节点默认不计入 list 与父级统计", async () => {
        const table = await createGrokTree("mark-delete-hidden")
        await table.setNodes([
            dir("d"),
            file("a", "d", "a", 1),
            file("b", "d", "b", 2),
        ])
        await table.deleteNodes(["a"])

        expect(await childIds(table, "d")).toEqual(["b"])
        expect((await table.listNodes("d", { ignoreMarkDelete: true })).list.map((n) => n.id).sort())
            .toEqual(["a", "b"])
        await expectStatsMatchChildren(table, "d")
        expect((await statsOf(table, "d")).csize).toBe(2)
    })
})

describe("TableTree · Grok 挖 bug · listNodes 与约束", () => {
    test("listNodes 不得被 options.filter.parentId 越权", async () => {
        const table = await createGrokTree("list-parent-lock")
        await table.setNodes([
            dir("a"),
            dir("b"),
            file("fa", "a"),
            file("fb", "b"),
        ])

        const result = await table.listNodes("a", {
            filter: { parentId: "b" } as any,
            pageSize: 100,
        })
        expect(result.list.map((n) => n.id)).toEqual(["fa"])
    })

    test("onlyTypes / onlyNotTypes 过滤生效且 onlyTypes 优先", async () => {
        const table = await createGrokTree("list-types")
        await table.setNodes([
            dir("d"),
            { id: "t1", parentId: "d", name: "t1", isDir: false, size: 1, type: "text" },
            { id: "i1", parentId: "d", name: "i1", isDir: false, size: 1, type: "image" },
            { id: "t2", parentId: "d", name: "t2", isDir: false, size: 1, type: "text" },
        ] as Partial<IGrokTreeNode>[])

        const onlyText = await table.listNodes("d", { onlyTypes: ["text"] })
        expect(onlyText.list.map((n) => n.id).sort()).toEqual(["t1", "t2"])

        const notImage = await table.listNodes("d", { onlyNotTypes: ["image"] })
        expect(notImage.list.map((n) => n.id).sort()).toEqual(["t1", "t2"])

        // 同时传入时 onlyTypes 优先
        const both = await table.listNodes("d", {
            onlyTypes: ["image"],
            onlyNotTypes: ["image"],
        })
        expect(both.list.map((n) => n.id)).toEqual(["i1"])
    })

    test("createNodes 名称含 / 应拒绝", async () => {
        const table = await createGrokTree("create-slash-name")
        await expect(
            table.createNodes([{ id: "bad", name: "a/b", isDir: false }], "/"),
        ).rejects.toThrow()
    })

    test("createNodes 父节点不存在应拒绝", async () => {
        const table = await createGrokTree("create-missing-parent")
        await expect(
            table.createNodes([file("x", "nope")], "nope"),
        ).rejects.toThrow(/父节点/)
    })

    test("空 createNodes / moveNodes / deleteNodes 应安全空操作", async () => {
        const table = await createGrokTree("empty-ops")
        await table.setNodes([dir("d")])
        expect(await table.createNodes([], "d")).toEqual({ createdNodeIds: [] })
        expect(await table.moveNodes([], "d")).toEqual({})
        expect(await table.deleteNodes([])).toEqual({
            hasDeleted: false,
            hasChildDeleted: false,
            deletedCount: 0,
        })
    })
})

describe("TableTree · Grok 挖 bug · 排序 index", () => {
    test("toStart / toEnd / 插在两节点之间顺序正确", async () => {
        const table = await createGrokTree("index-positions")
        await table.createNodes([dir("d")], "/")
        await table.createNodes([file("a", "d"), file("b", "d")], "d", { index: { toEnd: true } })
        await table.createNodes([file("start", "d")], "d", { index: { toStart: true } })
        await table.createNodes([file("mid", "d")], "d", {
            index: { prevNodeId: "a", nextNodeId: "b" },
        })

        expect(await childIds(table, "d")).toEqual(["start", "a", "mid", "b"])
    })

    test("连续 toStart 插入多个节点后顺序与统计仍合理", async () => {
        const table = await createGrokTree("index-many-start")
        await table.createNodes([dir("d")], "/")
        for (const id of ["a", "b", "c", "dnode", "e"]) {
            await table.createNodes([file(id, "d")], "d", { index: { toStart: true } })
        }
        const ids = await childIds(table, "d")
        expect(ids).toHaveLength(5)
        expect(new Set(ids).size).toBe(5)
        await expectStatsMatchChildren(table, "d")
    })
})

describe("TableTree · Grok 挖 bug · 并发串行与边界输入", () => {
    test("同一实例并发写应串行完成且数据一致", async () => {
        const table = await createGrokTree("serial-writes")
        await table.createNodes([dir("d")], "/")

        await Promise.all([
            table.createNodes([file("a", "d", "a", 1)], "d", { index: { toEnd: true } }),
            table.createNodes([file("b", "d", "b", 2)], "d", { index: { toEnd: true } }),
            table.createNodes([file("c", "d", "c", 3)], "d", { index: { toEnd: true } }),
        ])

        expect((await childIds(table, "d")).sort()).toEqual(["a", "b", "c"])
        await expectStatsMatchChildren(table, "d")
        expect((await statsOf(table, "d")).csize).toBe(6)
    })

    test("文件节点也可以拥有子节点（isDir 非父子约束）", async () => {
        const table = await createGrokTree("file-with-children")
        await table.setNodes([
            file("pkg", "/", "pkg.zip", 10),
            file("inner", "pkg", "inner.bin", 3),
        ])
        expect((await table.get("inner"))?.parentId).toBe("pkg")
        await expectStatsMatchChildren(table, "pkg")
        expect((await statsOf(table, "pkg")).ctotal).toBe(1)
        // csize 含后代 size，不含自身
        expect((await statsOf(table, "pkg")).csize).toBe(3)
    })

    test("moveNodes 到不存在的父级应失败", async () => {
        const table = await createGrokTree("move-missing-parent")
        await table.setNodes([file("f")])
        await expect(table.moveNodes(["f"], "ghost")).rejects.toThrow()
        expect((await table.get("f"))?.parentId).toBe("/")
    })

    test("关闭 markDelete 时 delete 应为物理删除", async () => {
        const table = await createGrokTree("no-mark-delete", { enableMarkDelete: false })
        await table.setNodes([file("f", "/", "f", 1)])
        await table.deleteNodes(["f"])
        expect(await table.get("f")).toBeUndefined()
        expect(await table.get("f", { ignoreMarkDelete: true })).toBeUndefined()
    })
})

describe("TableTree · Grok 挖 bug · 深层合并与复杂同步", () => {
    test("mergeByModif 目录合并时较旧输入文件不应覆盖较新目标文件", async () => {
        const table = await createGrokTree("deep-merge-modif")
        await table.setNodes([
            dir("target", "/", "sync"),
            { id: "tf", parentId: "target", name: "data.bin", isDir: false, size: 1, modif: 100 },
        ])

        await table.setNodes([
            dir("source", "/", "sync"),
            { id: "sf", parentId: "source", name: "data.bin", isDir: false, size: 9, modif: 50 },
        ], { uniqueBy: "name", overwriteMode: "mergeByModif" })

        // 目标文件更新，合并后应保留 target 侧
        expect(await table.get("source")).toBeUndefined()
        const kept = (await table.listNodes("target")).list.find((n) => n.name === "data.bin")
        expect(kept?.size).toBe(1)
        expect(kept?.id).toBe("tf")
    })

    test("多层目录 setNodes 同步后统计与 list 一致", async () => {
        const table = await createGrokTree("multi-layer-sync")
        const batch: Partial<IGrokTreeNode>[] = []
        // 3 层，每层 2 目录 + 叶子文件
        for (const l1 of ["A", "B"]) {
            batch.push(dir(l1, "/", l1))
            for (const l2 of ["x", "y"]) {
                const id2 = `${l1}-${l2}`
                batch.push(dir(id2, l1, l2))
                batch.push(file(`${id2}-f`, id2, "f.txt", 2))
            }
        }
        await table.setNodes(batch)

        for (const id of ["A", "B", "A-x", "A-y", "B-x", "B-y"]) {
            await expectStatsMatchChildren(table, id)
        }
        expect((await statsOf(table, "A")).ctotal).toBe(4) // 2 dir + 2 file
        expect((await statsOf(table, "A")).csize).toBe(4)
    })
})
