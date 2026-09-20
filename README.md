# 全文检索中间件服务（fulltext-search-engine）

基于 **Node.js + Express + SQLite** 的独立可部署全文检索中间件。覆盖文档索引生命周期管理（采集、分词、倒排索引建立与增量维护）与检索查询链路（多字段组合查询、短语匹配、布尔逻辑、TF-IDF 相关性评分、分页 / 过滤 / 高亮），并内置检索验证工作台与索引管理后台两个页面。

## 功能特性

- **索引引擎**：中文 bigram + 英文整词分词，倒排索引存于 SQLite，支持单条 / 批量采集、更新、删除等增量维护，以及全量重建
- **检索语义**：多词 AND（默认）、`OR`、`NOT`（或 `-`）、英文双引号短语匹配、`title:` / `content:` 字段限定、括号分组
- **相关性评分**：TF-IDF 模型（`fieldWeight × (1 + ln tf) × ln(1 + N/df)`），标题字段权重高于正文，结果按得分降序
- **检索体验**：分页返回、命中词 `<em>` 高亮（标题 + 摘要）、按时间范围 / 文档类型 / 作者过滤、类型 facet 统计
- **性能设计**：批量事务写入、预编译语句复用、结果 LRU 缓存（随索引代次自动失效）、IDF 缓存、分页后回表避免大字段传输
- **内置页面**：`/index.html` 检索验证工作台（实时观察命中、评分分布、facet），`/admin.html` 索引管理后台（统计、增删文档、重建索引）

## 环境依赖

- Node.js ≥ 18（开发验证环境为 v20）
- 依赖：`express@4`、`better-sqlite3@11`（含预编译原生二进制，无需联网安装）

## 快速开始

```bash
npm install          # 安装依赖（如已存在 node_modules 可跳过）
npm run seed         # 生成 5000 篇示例文档（可用 npm run seed -- 10000 指定数量）
npm start            # 启动服务，默认 0.0.0.0:3000
```

启动后访问：

- 检索工作台：http://localhost:3000/index.html
- 索引管理台：http://localhost:3000/admin.html
- 健康自查：http://localhost:3000/api/stats

环境变量：`PORT`（端口，默认 3000）、`HOST`（监听地址，默认 0.0.0.0）、`DB_PATH`（数据库文件路径，默认 `data/search.db`）。

## 目录结构

```
├── server.js            # 服务入口：Express 应用装配、静态资源、错误处理
├── src/
│   ├── config.js        # 端口、路径、分页、字段权重等配置
│   ├── db.js            # SQLite 连接、建表、元信息（文档数/索引代次）
│   ├── tokenizer.js     # 分词器：中文 bigram、英文整词、位置信息
│   ├── indexer.js       # 索引生命周期：采集/批量/更新/删除/重建、统计
│   ├── queryParser.js   # 查询语法解析：布尔、短语、字段限定、括号
│   ├── search.js        # 检索核心：求值、TF-IDF 评分、过滤分页、高亮、缓存
│   └── routes.js        # REST API 路由
├── public/              # 检索工作台与索引管理后台（HTML/JS/CSS）
├── scripts/seed.js      # 示例数据生成与批量索引脚本
├── docs/DEPLOYMENT.md   # 部署与使用文档
└── data/                # SQLite 数据文件（运行时生成）
```

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/search` | 检索：`q`、`page`、`pageSize`、`type`、`author`、`from`、`to` |
| POST | `/api/documents` | 采集文档：单条对象或数组（批量 ≤1000） |
| GET | `/api/documents` | 文档分页列表 |
| GET/PUT/DELETE | `/api/documents/:id` | 文档详情 / 更新 / 删除（增量维护索引） |
| GET | `/api/stats` | 索引统计（文档数、词项数、倒排记录数、类型分布） |
| POST | `/api/admin/reindex` | 全量重建倒排索引 |

查询语法示例：

```
全文检索                  # 多词默认 AND
搜索引擎 OR 算法           # 或
检索 NOT 广告  /  检索 -广告 # 非
"全文检索"                 # 短语（按序相邻）
title:索引                # 字段限定
(搜索 OR 检索) AND 引擎     # 括号分组
```

详细接口约定、部署步骤与常见问题见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。
