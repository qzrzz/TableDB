import type { ITreeNodeMetadataKeys } from "../tree.types"

type TreeNumberStatKey = keyof ITreeNodeMetadataKeys

/**
 * 目录统计字段保持 0 值不落库的历史语义：有值则 set，无值则 unset。
 *
 * 这样可以让空目录保持字段精简，同时所有 metadata 刷新入口都使用同一套 0 值处理规则。
 */
export function setTreeNumberStat(
    $set: Record<string, any>,
    $unset: Record<string, true>,
    key: TreeNumberStatKey,
    value: number,
): void {
    if (value > 0) {
        $set[key] = value
    } else {
        $unset[key] = true
    }
}
