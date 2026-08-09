import type { TableTree } from "../TableTree"
import type { ITreeNode } from "../tree.types"
import type { TreeOperationView } from "../core/context"
import { runTreeMutation } from "../internal/runTreeMutation"
import { refreshTreeMetadata as refreshTreeMetadataUtil } from "../util/refreshTreeMetadata"

/**
 * 从指定节点开始，按“先子节点、后父节点”的顺序完整刷新目录树 metadata。
 *
 * 这是旧版 `tool/refreshTreeMetadata.ts` 的新版实现。旧版依赖 `TableTree` 上暴露的
 * `runTreeTransaction`，而新设计不再把事务方法放进 `TableTree` 公共接口，因此这里
 * 改用内部的 `runTreeMutation`：调用方仍然只传入 `TableTree` 和父节点 ID，事务及
 * adapter session 绑定全部隐藏在工具内部。
 *
 * `parentId` 可以是：
 * - `/`：刷新整棵可达树；
 * - 任意节点 ID：只刷新该节点及其可达子树。
 *
 * 该工具适合修复历史数据、外部批量写入或异常中断后可能不准确的 `ctotal`、`cftotal`、
 * `csize` 和 `childLastIndex`。正常的 create/move/delete/update 操作已经会增量维护
 * metadata，不需要每次额外调用本工具。
 */
export async function refreshTreeMetadata<TNode extends ITreeNode = ITreeNode>(
    table: TableTree<TNode>,
    parentId: string,
): Promise<void> {
    await runTreeMutation(table, (context) => refreshChildrenFirst(context.view, parentId))
}

/** 递归刷新子树；必须使用事务上下文中的 view，不能回退到事务外的 table.adapter。 */
async function refreshChildrenFirst<TNode extends ITreeNode>(
    view: TreeOperationView<TNode>,
    parentId: string,
): Promise<void> {
    const children = await view.findMany({ parentId }, { ignoreMarkDelete: true })
    for (const child of children) {
        await refreshChildrenFirst(view, child.id)
    }

    if (parentId !== "/") {
        // statIds 会重算节点自身统计；nodeIds 只会刷新其父级祖先链，空目录会修不到自己。
        await refreshTreeMetadataUtil(view as any, { statIds: [parentId] })
    }
}
