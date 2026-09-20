'use strict';

const express = require('express');
const indexer = require('./indexer');
const { search } = require('./search');
const { db } = require('./db');

const router = express.Router();

function validateDoc(body) {
  if (!body || typeof body !== 'object') return '请求体必须为 JSON 对象';
  if (!body.title || !String(body.title).trim()) return 'title 不能为空';
  if (!body.content || !String(body.content).trim()) return 'content 不能为空';
  return null;
}

// 检索
router.get('/search', (req, res) => {
  const { q, page, pageSize, type, author, from, to } = req.query;
  res.json(search({ q, page, pageSize, type, author, from, to }));
});

// 文档采集：单条或批量（数组）
router.post('/documents', (req, res) => {
  if (Array.isArray(req.body)) {
    if (!req.body.length) return res.status(400).json({ error: '批量数组不能为空' });
    if (req.body.length > 1000) return res.status(400).json({ error: '单批最多 1000 条' });
    for (const item of req.body) {
      const err = validateDoc(item);
      if (err) return res.status(400).json({ error: err });
    }
    const ids = indexer.addDocumentsBatch(req.body);
    return res.status(201).json({ inserted: ids.length, ids });
  }
  const err = validateDoc(req.body);
  if (err) return res.status(400).json({ error: err });
  const id = indexer.addDocument(req.body);
  res.status(201).json({ id });
});

// 文档列表（管理后台用）
router.get('/documents', (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
  const total = db.prepare('SELECT COUNT(*) AS c FROM documents').get().c;
  const rows = db.prepare(
    'SELECT id, title, type, author, tags, created_at, updated_at, doc_len FROM documents ORDER BY id DESC LIMIT ? OFFSET ?'
  ).all(pageSize, (page - 1) * pageSize);
  res.json({ total, page, pageSize, results: rows });
});

router.get('/documents/:id', (req, res) => {
  const doc = indexer.getDocument(Number(req.params.id));
  if (!doc) return res.status(404).json({ error: '文档不存在' });
  res.json(doc);
});

router.put('/documents/:id', (req, res) => {
  const ok = indexer.updateDocument(Number(req.params.id), req.body || {});
  if (!ok) return res.status(404).json({ error: '文档不存在' });
  res.json({ updated: true });
});

router.delete('/documents/:id', (req, res) => {
  const ok = indexer.deleteDocument(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: '文档不存在' });
  res.json({ deleted: true });
});

// 索引统计
router.get('/stats', (req, res) => {
  res.json(indexer.getStats());
});

// 全量重建索引
router.post('/admin/reindex', (req, res) => {
  const started = Date.now();
  const count = indexer.rebuildIndex();
  res.json({ reindexed: count, tookMs: Date.now() - started });
});

module.exports = router;
