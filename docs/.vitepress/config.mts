import { defineConfig } from "vitepress"

// https://vitepress.dev/reference/site-config
export default defineConfig({
    title: "TableDB",
    description: "A simple NoSQL abstraction layer.",
    themeConfig: {
        search: {
            provider: "local",
        },
        // https://vitepress.dev/reference/default-theme-config
        nav: [
            { text: "Home", link: "/" },
            { text: "NPM", link: "https://www.npmjs.com/package/tbdb", target: "_blank" },
            { text: "Github", link: "https://github.com/qzrzz/tableDB", target: "_blank" },
        ],

        sidebar: [
            {
                text: "Guide",
                items: [{ text: "Introduction", link: "/" }],
            },
        ],

        socialLinks: [{ icon: "github", link: "https://github.com/qzrzz/tableDB" }],
    },
})
