/**
 * indexer.js — 索引构建与增量维护。
 *
 * 职责：
 * - 文档入库的同时建立倒排索引（terms / postings / doc_lengths）；
 * - 更新、删除文档时同步维护索引与全局统计（meta 表）；
 * - 批量写入包裹在单个事务中，保证吞吐与一致性；
 * - 支持全量重建（rebuild）与清空（clear）。
 */
const { db, getMeta, bumpMeta } = require('./db');
const { analyze } = require('./tokenizer');

const FIELDS = ['title', 'content'];

// ---- 预编译语句（连接复用 + 语句复用，降低热路径开销） ----
const stmt = {
  insertDoc: db.prepare(`
    INSERT INTO documents (title, content, doc_type, source, created_at, indexed_at)
    VALUES (@title, @content, @doc_type, @source, @created_at, datetime('now'))`),
  updateDoc: db.prepare(`
    UPDATE documents SET title=@title, content=@content, doc_type=@doc_type,
      source=@source, created_at=@created_at, indexed_at=datetime('now')
    WHERE id=@id`),
  getDoc: db.prepare('SELECT * FROM documents WHERE id = ?'),
  deleteDoc: db.prepare('DELETE FROM documents WHERE id = ?'),
  deletePostingsByDoc: db.prepare('DELETE FROM postings WHERE doc_id = ?'),
  deleteLength: db.prepare('DELETE FROM doc_lengths WHERE doc_id = ?'),
  insertTerm: db.prepare('INSERT OR IGNORE INTO terms (term) VALUES (?)'),
  getTermId: db.prepare('SELECT id FROM terms WHERE term = ?'),
  insertPosting: db.prepare(`
    INSERT INTO postings (term_id, doc_id, field, tf, positions)
    VALUES (?, ?, ?, ?, ?)`),
  insertLength: db.prepare(`
    INSERT INTO doc_lengths (doc_id, title_len, content_len) VALUES (?, ?, ?)`),
  allDocs: db.prepare('SELECT * FROM documents ORDER BY id'),
};

function termId(term) {
  stmt.insertTerm.run(term);
  return stmt.getTermId.get(term).id;
}

/** 为单篇文档写入倒排记录（调用方需处于事务中）。 */
function indexFields(docId, title, content) {
  const titleTokens = analyze(title);
  const contentTokens = analyze(content);
  for (const [term, { tf, positions }] of titleTokens) {
    stmt.insertPosting.run(termId(term), docId, 'title', tf, JSON.stringify(positions));
  }
  for (const [term, { tf, positions }] of contentTokens) {
    stmt.insertPosting.run(termId(term), docId, 'content', tf, JSON.stringify(positions));
  }
  const titleLen = title.length;
  const contentLen = content.length;
  stmt.insertLength.run(docId, titleLen, contentLen);
  bumpMeta('doc_count', 1);
  bumpMeta('sum_title_len', titleLen);
  bumpMeta('sum_content_len', contentLen);
}

/** 移除单篇文档的倒排记录（调用方需处于事务中）。 */
function unindexDoc(docId) {
  const len = db.prepare('SELECT * FROM doc_lengths WHERE doc_id = ?').get(docId);
  if (len) {
    bumpMeta('doc_count', -1);
    bumpMeta('sum_title_len', -len.title_len);
    bumpMeta('sum_content_len', -len.content_len);
  }
  stmt.deletePostingsByDoc.run(docId);
  stmt.deleteLength.run(docId);
}

const normalizeDoc = (d) => ({
  title: String(d.title || '').slice(0, 500),
  content: String(d.content || ''),
  doc_type: String(d.doc_type || 'article').slice(0, 50),
  source: String(d.source || '').slice(0, 200),
  created_at: d.created_at || new Date().toISOString().replace('T', ' ').slice(0, 19),
});

/** 批量新增文档并建立索引，单事务提交。 */
const addDocuments = db.transaction((docs) => {
  const ids = [];
  for (const raw of docs) {
    const d = normalizeDoc(raw);
    if (!d.title && !d.content) continue;
    const { lastInsertRowid } = stmt.insertDoc.run(d);
    const id = Number(lastInsertRowid);
    indexFields(id, d.title, d.content);
    ids.push(id);
  }
  return ids;
});

/** 更新文档：先删旧索引再建新索引。 */
const updateDocument = db.transaction((id, raw) => {
  const existing = stmt.getDoc.get(id);
  if (!existing) return false;
  const d = normalizeDoc({ ...existing, ...raw });
  d.created_at = raw.created_at || existing.created_at;
  unindexDoc(id);
  stmt.updateDoc.run({ ...d, id });
  indexFields(id, d.title, d.content);
  return true;
});

/** 删除文档及其索引记录。 */
const deleteDocument = db.transaction((id) => {
  const existing = stmt.getDoc.get(id);
  if (!existing) return false;
  unindexDoc(id);
  stmt.deleteDoc.run(id);
  return true;
});

/** 清空全部索引与文档。 */
const clearAll = db.transaction(() => {
  db.exec('DELETE FROM postings; DELETE FROM terms; DELETE FROM doc_lengths; DELETE FROM documents;');
  db.exec("UPDATE meta SET value = 0 WHERE key IN ('doc_count','sum_title_len','sum_content_len')");
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('documents','terms')");
});

/** 全量重建索引（保留 documents 表，重建倒排部分）。 */
const rebuild = db.transaction(() => {
  db.exec('DELETE FROM postings; DELETE FROM terms; DELETE FROM doc_lengths;');
  db.exec("UPDATE meta SET value = 0 WHERE key IN ('doc_count','sum_title_len','sum_content_len')");
  let count = 0;
  // 先物化文档列表：迭代器未关闭时同连接不允许执行其他语句
  for (const doc of stmt.allDocs.all()) {
    indexFields(doc.id, doc.title, doc.content);
    count++;
  }
  db.prepare("UPDATE documents SET indexed_at = datetime('now')").run();
  return count;
});

function stats() {
  const docCount = getMeta('doc_count');
  return {
    documents: docCount,
    terms: db.prepare('SELECT COUNT(*) AS c FROM terms').get().c,
    postings: db.prepare('SELECT COUNT(*) AS c FROM postings').get().c,
    avgTitleLen: docCount ? +(getMeta('sum_title_len') / docCount).toFixed(1) : 0,
    avgContentLen: docCount ? +(getMeta('sum_content_len') / docCount).toFixed(1) : 0,
  };
}

module.exports = { addDocuments, updateDocument, deleteDocument, clearAll, rebuild, stats, FIELDS };
