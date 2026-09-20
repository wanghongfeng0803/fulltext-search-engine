/**
 * db.js — SQLite 连接管理与 schema 定义。
 *
 * 设计要点：
 * - 单连接复用（better-sqlite3 同步驱动，天然无连接池开销）；
 * - 开启 WAL 提升读写并发；
 * - postings 表即倒排索引：(term_id, doc_id, field) 为主键，
 *   positions 以 JSON 数组存储词条在原文中的字符偏移，支撑短语匹配与高亮。
 */
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.SEARCH_DB_PATH || path.join(__dirname, '..', 'data.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS documents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  doc_type    TEXT NOT NULL DEFAULT 'article',
  source      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  indexed_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(doc_type);
CREATE INDEX IF NOT EXISTS idx_documents_created ON documents(created_at);

CREATE TABLE IF NOT EXISTS terms (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  term TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS postings (
  term_id   INTEGER NOT NULL REFERENCES terms(id),
  doc_id    INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  field     TEXT NOT NULL,              -- 'title' | 'content'
  tf        INTEGER NOT NULL,           -- 该字段内词频
  positions TEXT NOT NULL,              -- JSON: 每次出现的字符偏移
  PRIMARY KEY (term_id, doc_id, field)
);
CREATE INDEX IF NOT EXISTS idx_postings_doc ON postings(doc_id);

CREATE TABLE IF NOT EXISTS doc_lengths (
  doc_id      INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  title_len   INTEGER NOT NULL,
  content_len INTEGER NOT NULL
);

-- 统计信息（文档数、字段长度总和），用于 TF-IDF 的 idf 与长度归一化
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT OR IGNORE INTO meta(key, value) VALUES
  ('doc_count', 0), ('sum_title_len', 0), ('sum_content_len', 0);
`);

function getMeta(key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key).value;
}

function bumpMeta(key, delta) {
  db.prepare('UPDATE meta SET value = value + ? WHERE key = ?').run(delta, key);
}

module.exports = { db, getMeta, bumpMeta, DB_PATH };
