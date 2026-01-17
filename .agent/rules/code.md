---
trigger: always_on
---

此项目使用 vitest 测试代码，注意使用 node 运行 vitest 而不是 bun，因为 bun 不支持 better-sqlite3


要了解和分析此项目请一定查看

- 非常重要的接口类型：src/core/types.ts
- Table 实现：src/core/Table.ts
- 适配器定义：src/adapter/adapter.ts
- 非常重要的文档：readme-cn.md