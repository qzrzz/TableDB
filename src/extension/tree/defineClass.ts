export type Constructor<T = any> = new (...args: any[]) => T;

/**
 * 展开类型，用于优化类型提示
 * Expand type for better type hints
 */
type Expand<T> = T extends infer O ? { [K in keyof O]: O[K] } : never;

/**
 * 定义类，混合基类和方法对象
 * Define a class, mixing the base class and the methods object
 * 
 * @param classBase 基类构造函数
 * @param methods 要混入的方法对象
 * @param className 可选的自定义类名
 * @returns 混合后的类构造函数
 */
export function defineClass<
    TBase extends Constructor,
    TMethods extends Record<string, any>
>(
    classBase: TBase,
    methods: TMethods,
    className?: string
): { new (...args: ConstructorParameters<TBase>): Expand<InstanceType<TBase> & TMethods> } & TBase {
    // 确定类名：优先使用传入的 className，否则使用基类名+Mixed，最后兜底 MixedClass
    const name = className || (classBase.name ? `${classBase.name}Mixed` : 'MixedClass');
    
    // 创建一个继承自 classBase 的新类，并命名
    const MixedClass = {
        [name]: class extends (classBase as any) {
            constructor(...args: any[]) {
                super(...args);
            }
        }
    }[name];

    // 将方法混合到原型上
    // Mix methods into the prototype
    if (methods) {
        Object.assign(MixedClass.prototype, methods);
    }

    return MixedClass as any;
}