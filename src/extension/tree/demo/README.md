# TableTree Demo

这是一个独立的 TableTree 网页 Demo，默认后端数据库写入 `dist/test.db`。

## 启动

```bash
cd src/extension/tree/demo
bun install
bun run dev
```

- 后端 API: `http://127.0.0.1:5173`
- 前端页面: `http://127.0.0.1:5174`

## 功能

- 可切换/载入服务器本地 SQLite DB 文件路径
- 可上传浏览器选择的 `.db/.sqlite` 文件到 demo 的 `dist/` 目录并载入
- 可一键生成 10 万文件级别的多层目录树示例
- 页面可以创建任意个用户小窗
- 每个小窗支持新建、重命名、删除、拖拽移动和排序
- 自动批量操作按钮会执行一组预置的新建、移动、重命名、删除操作
