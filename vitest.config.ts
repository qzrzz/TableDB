import { defineConfig } from "vitest/config"
export default defineConfig({
    test: {
        watch: false,
        globals: true,
        exclude: ["es", "node_modules", "dist"],
    },
})
