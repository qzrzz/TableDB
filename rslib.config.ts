import { defineConfig } from "@rslib/core"

export default defineConfig({
    lib: [
        {
            format: "esm",
            syntax: ["node 18"],
            dts: true,
        },
    ],
    source: {
        tsconfigPath: "./tsconfig.build.json",
    },
    output: {
        externals: [
            /^bun:/, // 这会将所有 'bun:' 开头的内置模块（如 bun:sqlite, bun:test）都视为外部依赖
        ],
    },
})
