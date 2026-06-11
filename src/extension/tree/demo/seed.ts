import type { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"
import type { ITreeWritableNode } from "../core/treeCoreTypes"

/**
 * 演示用的目录树种子数据。
 *
 * 用普通的嵌套结构描述一棵“前端项目”目录树，随后通过 TableTree.createNodes
 * 自底向上逐层写入。文件夹会带上子节点，文件带上一个模拟的体积。
 */
interface ISeedNode {
    name: string
    /** 文件体积（字节）。文件夹不需要，统计字段由 TableTree 内部维护。 */
    size?: number
    /** 节点类型，文件取扩展名，文件夹为 "dir" */
    type?: string
    children?: ISeedNode[]
}

const SEED_TREE: ISeedNode[] = [
    {
        name: "src",
        children: [
            { name: "index.ts", size: 1280, type: "ts" },
            { name: "App.tsx", size: 3450, type: "tsx" },
            {
                name: "components",
                children: [
                    { name: "Button.tsx", size: 1820, type: "tsx" },
                    { name: "Modal.tsx", size: 2960, type: "tsx" },
                    { name: "Sidebar.tsx", size: 4100, type: "tsx" },
                    {
                        name: "icons",
                        children: [
                            { name: "home.svg", size: 540, type: "svg" },
                            { name: "search.svg", size: 610, type: "svg" },
                            { name: "settings.svg", size: 720, type: "svg" },
                        ],
                    },
                ],
            },
            {
                name: "utils",
                children: [
                    { name: "format.ts", size: 980, type: "ts" },
                    { name: "request.ts", size: 2240, type: "ts" },
                    { name: "storage.ts", size: 1560, type: "ts" },
                ],
            },
            {
                name: "pages",
                children: [
                    { name: "Home.tsx", size: 5200, type: "tsx" },
                    { name: "About.tsx", size: 1900, type: "tsx" },
                    { name: "Settings.tsx", size: 3300, type: "tsx" },
                ],
            },
        ],
    },
    {
        name: "public",
        children: [
            { name: "favicon.ico", size: 4286, type: "ico" },
            { name: "logo.png", size: 18240, type: "png" },
            { name: "robots.txt", size: 120, type: "txt" },
        ],
    },
    {
        name: "docs",
        children: [
            { name: "guide.md", size: 6400, type: "md" },
            { name: "api.md", size: 9800, type: "md" },
            {
                name: "images",
                children: [
                    { name: "diagram.png", size: 24500, type: "png" },
                    { name: "screenshot.png", size: 31200, type: "png" },
                ],
            },
        ],
    },
    { name: "package.json", size: 860, type: "json" },
    { name: "tsconfig.json", size: 540, type: "json" },
    { name: "README.md", size: 3120, type: "md" },
    { name: ".gitignore", size: 180, type: "gitignore" },
]

let idCounter = 0
function nextId(): string {
    idCounter += 1
    return `seed-${idCounter.toString().padStart(4, "0")}`
}

/** 把一个 ISeedNode 转成 TableTree 可写入的节点文档。 */
function toWritableNode(seed: ISeedNode): ITreeWritableNode<ITreeNode> {
    const isDir = Array.isArray(seed.children)
    return {
        id: nextId(),
        // parentId 会被 createNodes 覆盖，这里随便给个占位值
        parentId: "/",
        name: seed.name,
        isDir,
        size: seed.size ?? 0,
        modif: Date.now(),
        type: isDir ? "dir" : seed.type,
    }
}

/**
 * 按层级写入种子数据。
 *
 * 先在 parentId 下创建当前层全部节点，再对其中的文件夹递归写入子节点，
 * 这样可以触发 TableTree 真实的祖先统计字段维护逻辑。
 */
async function createSeedLevel(table: TableTree<ITreeNode>, seeds: ISeedNode[], parentId: string): Promise<void> {
    const writableNodes = seeds.map(toWritableNode)
    await table.createNodes(writableNodes, parentId, { index: { toEnd: true } })

    for (let i = 0; i < seeds.length; i++) {
        const seed = seeds[i]
        if (seed.children && seed.children.length > 0) {
            await createSeedLevel(table, seed.children, writableNodes[i].id)
        }
    }
}

/** 重新生成整棵演示目录树。调用前应保证表已被清空。 */
export async function seedTree(table: TableTree<ITreeNode>): Promise<void> {
    idCounter = 0
    await createSeedLevel(table, SEED_TREE, "/")
}
