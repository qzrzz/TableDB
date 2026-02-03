import { describe, it, expect } from 'vitest';
import { defineClass } from './defineClass';

describe('defineClass', () => {
    it('应该正确推断类型并混合方法', () => {
        // 定义独立的测试函数
        // Define standalone test functions
        function test1(this: any, val: number) {
            return val * 2;
        }

        function test2(this: any, id: string) {
            return `ID: ${id}`;
        }

        // 定义基类
        // Define base class
        class Base {
            constructor(public data: string) {}
            static staticVal = 999;
        }

        // 使用 defineClass
        // Use defineClass
        const MixedClass = defineClass(Base, { test1, test2 });

        // 实例化
        // Instantiate
        const instance = new MixedClass('test-data');


        instance.test1

        // 验证静态属性
        expect(MixedClass.staticVal).toBe(999);

        // 验证类型推断 (编译期检查，这里通过运行时行为验证)
        // Verify type inference (compile-time check, verified here by runtime behavior)
        expect(instance.data).toBe('test-data');
        expect(instance.test1(123)).toBe(246);
        expect(instance.test2('abc')).toBe('ID: abc');
        
        // 验证 instance of
        expect(instance).toBeInstanceOf(Base);
        expect(instance).toBeInstanceOf(MixedClass);

        // 验证类名
        expect(MixedClass.name).toBe('BaseMixed');
    });

    it('应该支持自定义类名', () => {
        class MyBase {}
        const MyCls = defineClass(MyBase, {}, 'CustomName');
        expect(MyCls.name).toBe('CustomName');
    });
});
