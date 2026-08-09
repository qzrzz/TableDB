/**
 * 获取一组文件名的唯一不冲突的文件名列表
 * 如果有重复的文件名，则在后面添加 "(1)"、"(2)" 等后缀来区分
 * 如果没有重复的文件名，则返回原名
 * 
 * 要注意的是如果文件名是 `文件(2).txt`，会识别出已有的 `(2)` 后缀
 * 并在数字基础上继续递增，例如 `文件(2).txt` -> `文件(3).txt`，而不是 `文件(2) (1).txt`。

 * 
 * @param oldNames 原文件名
 * @param existsNames 已经占用的文件名
 */
export async function getUniqueFileNames(oldNames: string[], existsNames: Iterable<string> = []): Promise<string[]> {
    const usedNames = new Set(existsNames)
    const result: string[] = []

    for (const oldName of oldNames) {
        let nextName = oldName
        while (usedNames.has(nextName)) {
            nextName = increaseFileNameIndex(nextName)
        }
        usedNames.add(nextName)
        result.push(nextName)
    }

    return result
}

function increaseFileNameIndex(fileName: string): string {
    const dotIndex = fileName.lastIndexOf(".")
    const hasExt = dotIndex > 0
    const baseName = hasExt ? fileName.slice(0, dotIndex) : fileName
    const extName = hasExt ? fileName.slice(dotIndex) : ""
    const matched = baseName.match(/^(.*?)(?:\s*\((\d+)\))$/)

    if (!matched) {
        return `${baseName} (1)${extName}`
    }

    return `${matched[1]} (${Number(matched[2]) + 1})${extName}`
}
