/**
 * routes.js — REST API 路由。
 *
 * 文档生命周期：POST 新增 / PUT 更新 / DELETE 删除 / 批量导入
 * 检索：GET /api/search（关键词 + 过滤 + 分页 + 高亮）
 * 索引管理：统计、热门词、重建、清空
 */
const express = require('express');
const indexer = require('./indexer');
const engine = require('./search');
const cache = require('./cache');
const { db, DB_PATH } = require('./db');
const fs = require('fs');

const router = express.Router();

/** 索引变更后的统一善后：缓存失效 + 长度缓存刷新。 */
function afterMutation() {
  cache.bumpEpoch();
  engine.invalidateCache();
}

// ---- 检索 ----
router.get('/search', (req, res) => {
  const params = {
    q: req.query.q || '',
    page: req.query.page,
    pageSize: req.query.pageSize,
    type: req.query.type || '',
    from: req.query.from || '',
    to: req.query.to || '',
    source: req.query.source || '',
    explain: req.query.explain === '1',
  };
  const cached = cache.get(params);
  if (cached) return res.json({ ...cached, cached: true });
  const result = engine.search(params);
  cache.set(params, result);
  res.json({ ...result, cached: false });
});

// ---- 文档管理 ----
router.get('/documents', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
  const type = req.query.type || '';
  const where = type ? 'WHERE doc_type = ?' : '';
  const args = type ? [type] : [];
  const total = db.prepare(`SELECT COUNT(*) AS c FROM documents ${where}`).get(...args).c;
  const rows = db.prepare(
    `SELECT id, title, doc_type, source, created_at, indexed_at, length(content) AS contentLen
     FROM documents ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(...args, pageSize, (page - 1) * pageSize);
  res.json({ total, page, pageSize, items: rows });
});

router.get('/documents/:id', (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'document not found' });
  res.json(doc);
});

router.post('/documents', (req, res) => {
  const { title, content } = req.body || {};
  if (!title && !content) return res.status(400).json({ error: 'title 与 content 至少填写一项' });
  const ids = indexer.addDocuments([req.body]);
  afterMutation();
  res.status(201).json({ ids });
});

router.post('/documents/bulk', (req, res) => {
  const docs = req.body && req.body.documents;
  if (!Array.isArray(docs) || docs.length === 0) {
    return res.status(400).json({ error: '请求体需为 { documents: [...] } 且非空' });
  }
  if (docs.length > 5000) return res.status(400).json({ error: '单批次最多 5000 篇' });
  const t0 = Date.now();
  const ids = indexer.addDocuments(docs);
  afterMutation();
  res.status(201).json({ inserted: ids.length, ids: ids.slice(0, 20), tookMs: Date.now() - t0 });
});

router.put('/documents/:id', (req, res) => {
  const ok = indexer.updateDocument(Number(req.params.id), req.body || {});
  if (!ok) return res.status(404).json({ error: 'document not found' });
  afterMutation();
  res.json({ updated: true });
});

router.delete('/documents/:id', (req, res) => {
  const ok = indexer.deleteDocument(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: 'document not found' });
  afterMutation();
  res.json({ deleted: true });
});

// ---- 索引管理 ----
router.get('/stats', (req, res) => {
  const s = indexer.stats();
  let dbSize = 0;
  try { dbSize = fs.statSync(DB_PATH).size; } catch { /* ignore */ }
  const topTerms = db.prepare(`
    SELECT t.term, COUNT(DISTINCT p.doc_id) AS df, SUM(p.tf) AS tf
    FROM postings p JOIN terms t ON t.id = p.term_id
    GROUP BY t.term ORDER BY df DESC, tf DESC LIMIT 15`).all();
  const docTypes = db.prepare(
    'SELECT doc_type AS type, COUNT(*) AS count FROM documents GROUP BY doc_type ORDER BY count DESC'
  ).all();
  res.json({ ...s, dbSizeBytes: dbSize, cache: cache.stats(), topTerms, docTypes });
});

router.post('/index/rebuild', (req, res) => {
  const t0 = Date.now();
  const count = indexer.rebuild();
  afterMutation();
  res.json({ rebuilt: count, tookMs: Date.now() - t0 });
});

router.delete('/index', (req, res) => {
  indexer.clearAll();
  afterMutation();
  res.json({ cleared: true });
});

router.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

module.exports = router;
