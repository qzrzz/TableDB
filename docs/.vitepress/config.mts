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
                text: "指南",
                collapsed: false,
                items: [
                    { text: "介绍", link: "/" },
                    { text: "安装", link: "/" },
                    { text: "基本用法", link: "/" },
                    { text: "实现原理", link: "/" },
                ],
            },
            {
                text: "增删改查",
                collapsed: false,
                items: [
                    { text: "文档", link: "/增删改查/文档.md" },
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
