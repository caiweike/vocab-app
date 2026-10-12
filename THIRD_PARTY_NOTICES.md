# 第三方数据与依赖声明

## ECDICT 词典数据

- 来源：<https://github.com/skywind3000/ECDICT>
- 协议：MIT（Copyright (c) 2025 Linwei）
- 用途：`scripts/build-books.mjs` 在构建期读取 `dict/ecdict.csv`，
  按 `tag` 字段筛出四级 / 考研词表，抽取中文释义、音标、词性、BNC/COCA 频率，
  生成 `src/data/books/*.json`。
- 分发的只有筛选后的词表 JSON，原始 62.9 MB 数据不随应用分发（`dict/` 已在 .gitignore 中）。
- 该数据集的释义可上溯至 cdict 等社区词典，本项目不声明其为原创内容。

## 运行时依赖

| 包 | 协议 | 用途 |
|---|---|---|
| react / react-dom | MIT | UI 框架 |
| react-router-dom | MIT | 路由 |
| dexie, dexie-react-hooks, dexie-export-import | Apache-2.0 | IndexedDB 封装与备份 |
| ts-fsrs | MIT | FSRS-6 间隔重复算法 |
| zustand | MIT | 会话状态 |
| tailwindcss | MIT | 样式 |
| recharts | MIT | 统计图表 |
| papaparse | MIT | CSV 解析 |
| lucide-react | ISC | 图标 |
| hono, @hono/node-server | MIT | AI 中转服务 |
| vite, typescript, vitest, eslint | MIT | 构建与测试工具链 |

构建期工具 `ECDICT` 见上。
