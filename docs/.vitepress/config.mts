import { defineConfig } from "vitepress"

// https://vitepress.dev/reference/site-config
export default defineConfig({
    title: "TableDB",
    description: "A simple NoSQL abstraction layer.",
    markdown: {
        theme: "github-dark", // or material-theme-palenight or whatever you want
    },
    themeConfig: {
        logo: "/logo/tbdb-icon_512.png",
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
                text: "基础",
                collapsed: false,
                items: [
                    { text: "介绍", link: "/" },
                    { text: "文档", link: "/基础/文档.md" },
                    { text: "定义表", link: "/基础/定义表.md" },
                    { text: "索引", link: "/基础/索引.md" },
                ],
            },
            {
                text: "增删改查",
                collapsed: false,
                items: [
                    { text: "创建", link: "/" },
                    { text: "查询", link: "/" },
                    { text: "更新", link: "/" },
                    { text: "删除", link: "/" },
                    { text: "遍历", link: "/" },
                ],
            },
        ],

        socialLinks: [{ icon: "github", link: "https://github.com/qzrzz/tableDB" }],
    },
    head: [["link", { rel: "icon", href: "/logo/tbdb-icon_32.png" }]],
})
