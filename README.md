# 全文检索引擎（fulltext-search-engine）

基于 **Node.js + Express + SQLite** 的独立可部署全文检索中间件服务。围绕文档索引生命周期管理与检索查询链路，提供倒排索引构建与增量维护、多字段组合查询、短语匹配、布尔逻辑运算、TF-IDF 相关性评分、分页 / 高亮 / 多维过滤，以及配套的检索验证工作台与索引管理后台。

## 功能特性

- **索引引擎**：文档采集入库、中英文分词、倒排索引建立与增量维护（增 / 删 / 改实时同步，支持全量重建）
- **检索语义**：多词 AND（默认）、`AND` / `OR` / `NOT`（`-`）布尔运算、`"短语"` 位置匹配、`title:` / `content:` 字段限定、括号分组
- **相关性评分**：TF-IDF 模型（标题字段加权 ×3、文档长度归一化），结果按相关度降序返回，支持评分明细（explain）查看
- **检索体验**：结果分页、命中关键词 `<mark>` 高亮片段、按时间范围 / 文档类型 / 来源多维过滤、评分分布直方图
- **性能设计**：批量事务写入、单连接 + 预编译语句复用、LRU 查询缓存、文档长度缓存、倒排列表单次拉取
- **验证工具**：检索工作台（`/`）实时观察命中与评分分布；索引管理后台（`/admin`）支持文档 CRUD、批量导入、索引重建 / 清空、词项统计

## 环境依赖

- Node.js ≥ 18（推荐 20+）
- 依赖包：`express@4`、`better-sqlite3@12`（含预编译原生绑定，安装时自动获取）

## 快速启动

```bash
npm install          # 安装依赖
npm run seed         # 可选：生成 2000 篇示例文档（可指定数量：npm run seed -- 10000）
npm start            # 启动服务，默认 http://localhost:3000
```

- 检索工作台：http://localhost:3000/
- 索引管理后台：http://localhost:3000/admin
- 运行接口自测（24 项断言）：`npm test`

环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 服务监听端口 |
| `SEARCH_DB_PATH` | `./data.db` | SQLite 数据库文件路径 |

## 目录结构

```
├── server.js            # 服务入口：Express 应用装配与中间件链路
├── src/
│   ├── db.js            # SQLite 连接（WAL）与 schema 定义
│   ├── tokenizer.js     # 中英文分词（CJK bigram + 拉丁词），带字符偏移
│   ├── indexer.js       # 索引构建与增量维护（批量事务写入）
│   ├── queryParser.js   # 查询语法解析（布尔 / 短语 / 字段 / 括号）
│   ├── search.js        # 检索执行：集合求值 + TF-IDF 评分 + 过滤分页高亮
│   ├── cache.js         # 检索结果 LRU 缓存（索引变更自动失效）
│   └── routes.js        # REST API 路由
├── public/              # 检索工作台（index.html）与索引管理后台（admin.html）
├── scripts/
│   ├── seed.js          # 示例数据生成（node scripts/seed.js [数量]）
│   └── test-api.js      # 接口自测（进程内模拟 HTTP，无需启动服务）
└── README.md
```

模块职责单一、边界清晰：替换底层存储时仅需重写 `db.js` 与 `indexer.js` 的持久化部分；接入新数据源只需调用 `POST /api/documents/bulk`。

## 查询语法

| 语法 | 示例 | 说明 |
| --- | --- | --- |
| 多词查询 | `全文检索` | 分词后按 AND 组合 |
| 布尔运算 | `索引 AND 引擎`、`检索 OR 缓存`、`检索 -倒排` | `NOT` 与 `-` 前缀等价 |
| 短语匹配 | `"全文检索引擎"` | 按字符偏移精确相邻 |
| 字段限定 | `title:索引`、`content:"批量事务"` | 限定标题 / 正文字段 |
| 分组 | `(索引 OR 分词) AND 引擎` | 括号改变优先级 |

过滤参数（与查询语法正交）：`type`（文档类型）、`from` / `to`（创建日期）、`source`（来源）。

## API 接口约定

统一 JSON 交互；错误响应为 `{ "error": "描述" }` 并携带相应 HTTP 状态码。

### 检索

`GET /api/search`

| 参数 | 说明 |
| --- | --- |
| `q` | 查询串（语法见上），可空（空时按过滤条件浏览） |
| `page` / `pageSize` | 分页，默认 1 / 10，pageSize ≤ 100 |
| `type` / `from` / `to` / `source` | 多维过滤 |
| `explain` | `1` 时返回各词项评分构成 |

响应：`{ total, page, pageSize, pages, tookMs, cached, queryTerms, scoreDist, items[] }`，
`items[]` 含 `id / title / docType / source / createdAt / score / snippet`（`<mark>` 高亮）。

### 文档管理

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/documents` | 新增单篇 `{title, content, doc_type, source, created_at}` |
| `POST` | `/api/documents/bulk` | 批量新增 `{documents: [...]}`，单批 ≤ 5000，单事务提交 |
| `GET` | `/api/documents?page=&pageSize=&type=` | 文档分页列表 |
| `GET` | `/api/documents/:id` | 文档详情 |
| `PUT` | `/api/documents/:id` | 更新（索引同步重建该文档） |
| `DELETE` | `/api/documents/:id` | 删除（索引同步移除） |

### 索引管理

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/stats` | 文档 / 词项 / 倒排记录数、平均长度、DB 体积、热门词 TOP15、类型分布、缓存状态 |
| `POST` | `/api/index/rebuild` | 全量重建倒排索引 |
| `DELETE` | `/api/index` | 清空全部文档与索引 |
| `GET` | `/api/health` | 健康检查 |

## 评分模型（TF-IDF）

```
idf(t)   = ln(1 + N / df(t))
tf'(t,d) = (3.0·tf_title + 1.0·tf_content) / (1 + len(d) / avgLen)
score(d) = Σ_t idf(t) · tf'(t,d)
```

- 标题命中权重为正文的 3 倍；
- 文档长度归一化抑制长文档的词频优势；
- 高频命中且区分度高（df 低）的词项贡献更大，检索结果按 score 降序、同分按 id 升序排列，保证分页稳定。

## 性能设计

- **写入**：批量导入包裹在单个 SQLite 事务中；预编译语句复用；WAL 模式提升读写并发。实测 1 万文档 / 105 万条倒排记录全量索引约 4.5 秒（约 2200 篇/秒）。
- **查询**：倒排列表按词项单次拉取；短语匹配链式位置校验且每词项仅取一次；文档长度表内存缓存；检索结果 LRU 缓存（索引变更自动整体失效）。实测万级文档下单词 / 短语 / 布尔查询均在 10–80 ms。
- **分页与过滤一致性**：过滤条件与索引求值结果在 SQL 层求交后再评分排序，分页基于稳定排序（score 降序 + id 升序），跨页不重复不遗漏。

## 部署

1. 准备 Node.js ≥ 18 环境，`npm install --omit=dev` 安装依赖；
2. （可选）`SEARCH_DB_PATH=/var/lib/search/data.db PORT=8080` 配置环境变量；
3. `npm start` 前台运行，或使用进程管理器：
   `pm2 start server.js --name fulltext-search` / `systemd` 单元守护；
4. 反向代理（Nginx）将 `/` 与 `/api` 转发至服务端口即可对外提供检索能力；
5. 数据库为单文件 SQLite（WAL 模式产生 `-wal` / `-shm` 伴生文件），备份时直接复制三个文件或使用 `VACUUM INTO`。

## 常见问题（FAQ）

**Q：`npm install` 时 better-sqlite3 编译失败？**
A：优先使用官方预编译二进制（需网络）。离线环境请准备对应平台的 prebuild，或安装 `python3 + make + g++` 工具链后重试。

**Q：单个汉字查询不到结果？**
A：分词器对连续汉字生成二元组（bigram），单字查询无法命中 bigram 索引。请使用至少两个汉字，或对单字加引号外的完整词语。

**Q：短语查询对英文大小写 / 多空格敏感吗？**
A：索引与查询统一小写化；短语按分词后的字符偏移差精确匹配，多余空格或标点导致的偏移差异会使短语不命中，属于预期行为。

**Q：如何接入新的数据源？**
A：定时或实时调用 `POST /api/documents/bulk` 推送文档即可；更新与删除走对应 REST 接口，索引自动增量维护。

**Q：如何替换底层存储引擎？**
A：持久化细节集中在 `src/db.js`（连接与 schema）与 `src/indexer.js`（读写路径），检索层 `src/search.js` 仅依赖倒排拉取接口，按相同数据结构实现即可平滑替换。

**Q：数据文件损坏或服务异常退出？**
A：WAL 模式具备崩溃恢复能力；极端情况下可保留 `documents` 表后调用 `POST /api/index/rebuild` 重建全部倒排索引。
