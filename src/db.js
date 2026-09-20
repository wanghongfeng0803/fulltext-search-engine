'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS documents (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'article',
  author     TEXT NOT NULL DEFAULT '',
  tags       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  doc_len    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(type);
CREATE INDEX IF NOT EXISTS idx_documents_created ON documents(created_at);

CREATE TABLE IF NOT EXISTS postings (
  term      TEXT NOT NULL,
  field     TEXT NOT NULL,
  doc_id    INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tf        INTEGER NOT NULL,
  positions TEXT NOT NULL,
  PRIMARY KEY (term, field, doc_id)
);
CREATE INDEX IF NOT EXISTS idx_postings_doc ON postings(doc_id);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

const getMetaStmt = db.prepare('SELECT value FROM meta WHERE key = ?');
const setMetaStmt = db.prepare(
  'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

function getMeta(key, fallback = '0') {
  const row = getMetaStmt.get(key);
  return row ? row.value : fallback;
}

function setMeta(key, value) {
  setMetaStmt.run(key, String(value));
}

function getGeneration() {
  return Number(getMeta('generation', '0'));
}

function bumpGeneration() {
  setMeta('generation', getGeneration() + 1);
}

module.exports = { db, getMeta, setMeta, getGeneration, bumpGeneration };
