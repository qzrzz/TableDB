import type { ITableDBAdapter, ITableDBAdapterInstance } from "../../../adapter/adapter"

/**
 * 单次操作的底层数据库调用统计。
 *
 * TableTree 的每个高层方法（createNodes / moveNodes ...）内部都会触发若干次
 * 底层 adapter 调用（get / findMany / insertMany / updateOne ...）。
 * 这里把这些调用按方法名计数，并累计它们消耗的时间，用于在控制台展示
 * “执行了多少条命令、耗时多少”。
 */
export interface ICallStats {
    /** 按 adapter 方法名分桶的调用次数，例如 { get: 3, findMany: 5, updateOne: 2 } */
    calls: Record<string, number>
    /** 底层调用总次数 */
    totalCalls: number
    /** 底层调用累计耗时（毫秒） */
    dbTimeMs: number
}

export function createCollector(): ICallStats {
    return { calls: {}, totalCalls: 0, dbTimeMs: 0 }
}

/**
 * 当前正在收集统计的 collector。
 *
 * 服务端会把每个 API 请求串行化执行（见 server.ts 的互斥锁），
 * 因此同一时刻只会有一个 collector 处于激活状态，使用模块级变量是安全的。
 */
let activeCollector: ICallStats | null = null

/** 在指定 collector 的上下文中执行一段异步逻辑，期间所有底层 DB 调用都会被计入该 collector。 */
export async function withCollector<T>(collector: ICallStats, fn: () => Promise<T>): Promise<T> {
    const previous = activeCollector
    activeCollector = collector
    try {
        return await fn()
    } finally {
        activeCollector = previous
    }
}

/**
 * 包装一个 adapter，使其返回的实例上的每个方法调用都会被记录到当前 collector。
 *
 * 包装发生在 adapter 实例层（而不是 Table 层），因为 TableTree / Table 的高层方法
 * 最终都会落到 adapter 实例的方法上，这里是统计真实数据库命令最准确的位置。
 */
export function instrumentAdapter(adapter: ITableDBAdapter): ITableDBAdapter {
    return {
        name: adapter.name,
        async useAdapterInstance(tableName: string): Promise<ITableDBAdapterInstance> {
            const instance = await adapter.useAdapterInstance(tableName)
            return wrapInstance(instance)
        },
    }
}

function wrapInstance(instance: ITableDBAdapterInstance): ITableDBAdapterInstance {
    return new Proxy(instance, {
        get(target, prop, receiver) {
            const original = Reflect.get(target, prop, receiver)
            if (typeof original !== "function") {
                return original
            }
            const methodName = String(prop)
            return function instrumented(this: unknown, ...args: unknown[]) {
                const result = (original as (...a: unknown[]) => unknown).apply(target, args)

                // 只统计异步（返回 Promise）的数据库操作
                if (activeCollector && result && typeof (result as Promise<unknown>).then === "function") {
                    const collector = activeCollector
                    collector.calls[methodName] = (collector.calls[methodName] ?? 0) + 1
                    collector.totalCalls += 1
                    const start = performance.now()
                    return (result as Promise<unknown>).finally(() => {
                        collector.dbTimeMs += performance.now() - start
                    })
                }
                return result
            }
        },
    })
}
