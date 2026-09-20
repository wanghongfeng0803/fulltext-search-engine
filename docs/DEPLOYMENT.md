# 部署与使用文档

## 1. 环境要求

- Node.js ≥ 18（推荐 20 LTS）
- 操作系统：Linux / macOS / Windows（WSL 亦可）
- 无需外部数据库，SQLite 内嵌于服务进程

## 2. 安装与启动

```bash
npm install            # 安装 express 与 better-sqlite3
npm run seed           # 可选：生成 5000 篇示例文档（npm run seed -- 10000 生成一万篇）
npm start              # 生产启动
npm run dev            # 开发启动（文件变更自动重启）
```

环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址，本机调试可设 `127.0.0.1` |
| `DB_PATH` | `data/search.db` | SQLite 文件路径 |

生产部署建议：使用 `pm2 start server.js --name fulltext-search` 或 systemd 守护；前置 Nginx 反向代理与 HTTPS 终结。

## 3. 接口约定

### 3.1 检索 `GET /api/search`

查询参数：

| 参数 | 说明 | 示例 |
| --- | --- | --- |
| `q` | 查询串，支持布尔 / 短语 / 字段限定 | `title:索引 AND "全文检索"` |
| `page` | 页码，从 1 开始 | `1` |
| `pageSize` | 每页条数，1–50，默认 10 | `20` |
| `type` | 文档类型过滤 | `article` |
| `author` | 作者过滤 | `张伟` |
| `from` / `to` | 创建时间范围（ISO 日期） | `2026-01-01` |

响应：

```json
{
  "query": "全文检索",
  "total": 2384,
  "page": 1,
  "pageSize": 10,
  "totalPages": 239,
  "tookMs": 12.5,
  "cached": false,
  "facets": { "types": [{ "type": "article", "count": 1200 }] },
  "results": [
    {
      "id": 5480,
      "type": "article",
      "author": "张伟",
      "tags": "全文检索,搜索引擎",
      "created_at": "2026-09-11T06:52:41.238Z",
      "score": 42.9173,
      "title": "性能<em>全文</em><em>检索</em>……",
      "snippet": "……命中词以 <em> 标签包裹……"
    }
  ]
}
```

分页与过滤一致性：过滤在分页之前应用于同一候选集，翻页过程中若索引发生变更（增删改文档），索引代次递增、缓存自动失效，结果以最新索引为准。

### 3.2 文档采集 `POST /api/documents`

单条：

```json
{ "title": "标题", "content": "正文", "type": "article", "author": "张三", "tags": "搜索,引擎" }
```

批量（数组，单批 ≤ 1000 条，整体在一个事务中写入）：

```json
[{ "title": "…", "content": "…" }, { "title": "…", "content": "…" }]
```

### 3.3 文档维护

- `GET /api/documents?page=1&pageSize=20`：分页列表
- `GET /api/documents/:id`：详情
- `PUT /api/documents/:id`：更新（重建该文档的倒排记录）
- `DELETE /api/documents/:id`：删除（同步清除倒排记录）

### 3.4 统计与运维

- `GET /api/stats`：文档总数、不同词项数、倒排记录数、平均文档词数、索引代次、类型分布
- `POST /api/admin/reindex`：全量重建索引（不清文档，只重建倒排）

## 4. 评分模型说明

采用 TF-IDF 加权：

```
score(doc) = Σ_term fieldWeight(field) × (1 + ln tf) × ln(1 + N / df)
```

- `fieldWeight`：标题 3、正文 1（`src/config.js` 可调）
- 短语命中额外乘以 `phraseBoost`（默认 2）
- 得分相同时按创建时间倒序，保证分页顺序稳定

## 5. 性能设计

- **批量写入**：批量采集在单个事务内完成，预编译语句复用，实测吞吐约 500 篇/秒（WSL 挂载盘环境）
- **连接复用**：全进程共享单个 SQLite 连接，WAL 模式提升并发读写能力
- **缓存**：检索结果 LRU 缓存（200 条）与 IDF 缓存，均以索引代次失效，保证写后读一致
- **分页回表**：候选集只取 `id/type/created_at` 参与过滤排序，正文仅在分页后按页回表，避免大字段传输
- **实测**：1 万文档 / 1.6 万词项 / 128 万倒排记录下，热查询耗时约 3–15 ms；进程冷启动首次查询受磁盘 IO 影响约 200–350 ms，随后进入页缓存

## 6. 常见问题（FAQ）

**Q：`npm install` 时 better-sqlite3 编译失败？**
A：包内已附带 Linux x64（Node ABI 115）预编译二进制；其他平台需安装 `python3 make g++` 后重新 `npm rebuild better-sqlite3`。

**Q：数据库文件很大？**
A：倒排记录含位置信息（用于短语匹配），1 万文档约 100 MB。删除 `data/search.db*` 后运行 `npm run seed` 可重建。

**Q：如何接入自己的数据源？**
A：调用 `POST /api/documents`（支持批量）即可；或在 `src/indexer.js` 的 `addDocumentsBatch` 之上编写自定义采集器。

**Q：想替换底层存储引擎？**
A：存储访问集中在 `src/db.js` 与 `src/indexer.js` / `src/search.js` 的预编译语句中，替换时保持 `postings` 与 `documents` 的读写接口语义即可。

**Q：WSL 下查询慢？**
A：数据库文件放在 Windows 挂载盘（`/mnt/*`）时 IO 较慢，建议将 `DB_PATH` 指向 Linux 原生文件系统（如 `~/data/search.db`）。
