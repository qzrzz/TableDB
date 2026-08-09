import { isEqual } from "es-toolkit/compat"

/**
 * 按 TableDB 的值语义比较覆盖键。
 *
 * uniqueBy 可以指向对象、数组或 Date，不能使用 JavaScript 的引用相等，否则内容相同
 * 但引用不同的值会被错误地认为不是冲突。
 */
export function isTreeUniqueValueEqual(left: unknown, right: unknown): boolean {
    return isEqual(left, right)
}
