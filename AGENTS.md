# AGENTS.md

-   我是中文用户
-   代码注释要描述清楚意图和目标，并且使用**中文代码注释**
-   使用 `vitest` 作为测试框架，并且使用 `global` 模式，不用每个测试文件都引入 vitest 函数
-   单元测试倾向使用 `test` 而不是 `it`
-   单元测试的说明要用**中文描述**
-   使用 `bun` 作为包管理工具
-   使用 `chalk` 作为终端颜色输出库，倾向使用多彩的输出提升可读性
-   从 `DEV.md` 文件获取项目开发规范和说明
-   此项目使用 vitest 测试代码，注意使用 node 运行 vitest 而不是 bun，因为 bun 不支持 better-sqlite3

## 构建说明

-   `bun run dev` 用于开发模式，监听文件变化并自动重建（使用 `rslib`）
-   `bun run build` 用于编译项目 TypeScript 到 JavaScript，输出到 `dist` 目录（使用 `rslib`）
-   `bun run build:bundler` 用于构建捆绑依赖的 JavaScript 文件，输出到 `bundle` 目录（使用 `bun bundler`）

## 性能分析

-   `bun --heap-prof-md <script>` 可以生成内存使用的 Markdown 报告
-   `bun --cpu-prof-md <script>` 可以生成 CPU 使用的 Markdown 报告

## 基准测试

-   可以使用 `tinybench` 进行基准测试
-   如果是简单的性能测试，直接用 `performance.now()` 进行测量，因为 `tinybench` 会进行多轮测试，速度很慢

## 项目结构
要了解和分析此项目请一定查看

-   非常重要的接口类型：src/core/types.ts
-   Table 实现：src/core/Table.ts
-   适配器定义：src/adapter/adapter.ts
-   非常重要的文档：README-ZH.md
