'use strict';

const { db, getMeta, setMeta, bumpGeneration } = require('./db');
const { termStats } = require('./tokenizer');

const FIELDS = ['title', 'content'];

const stmts = {
  insertDoc: db.prepare(`
    INSERT INTO documents (title, content, type, author, tags, created_at, updated_at, doc_len)
    VALUES (@title, @content, @type, @author, @tags, @created_at, @updated_at, @doc_len)
  `),
  updateDoc: db.prepare(`
    UPDATE documents SET title=@title, content=@content, type=@type, author=@author,
      tags=@tags, updated_at=@updated_at, doc_len=@doc_len WHERE id=@id
  `),
  deleteDoc: db.prepare('DELETE FROM documents WHERE id = ?'),
  deletePostingsByDoc: db.prepare('DELETE FROM postings WHERE doc_id = ?'),
  insertPosting: db.prepare(
    'INSERT INTO postings (term, field, doc_id, tf, positions) VALUES (?, ?, ?, ?, ?)'
  ),
  getDoc: db.prepare('SELECT * FROM documents WHERE id = ?'),
  allDocIds: db.prepare('SELECT id FROM documents'),
  countDocs: db.prepare('SELECT COUNT(*) AS c FROM documents'),
  countTerms: db.prepare('SELECT COUNT(DISTINCT term) AS c FROM postings'),
  countPostings: db.prepare('SELECT COUNT(*) AS c FROM postings'),
  typeFacets: db.prepare('SELECT type, COUNT(*) AS count FROM documents GROUP BY type ORDER BY count DESC'),
};

function normalizeDoc(input) {
  const now = new Date().toISOString();
  return {
    title: String(input.title || '').trim(),
    content: String(input.content || '').trim(),
    type: String(input.type || 'article').trim() || 'article',
    author: String(input.author || '').trim(),
    tags: String(input.tags || '').trim(),
    created_at: input.created_at || now,
    updated_at: now,
  };
}

function indexTokens(docId, doc) {
  let docLen = 0;
  for (const field of FIELDS) {
    for (const [term, { tf, positions }] of termStats(doc[field])) {
      stmts.insertPosting.run(term, field, docId, tf, JSON.stringify(positions));
      docLen += tf;
    }
  }
  return docLen;
}

function adjustMeta(deltaDocs, deltaLen) {
  setMeta('doc_count', Number(getMeta('doc_count')) + deltaDocs);
  setMeta('total_len', Number(getMeta('total_len')) + deltaLen);
}

const addDocument = db.transaction((input) => {
  const doc = normalizeDoc(input);
  const info = stmts.insertDoc.run({ ...doc, doc_len: 0 });
  const docId = Number(info.lastInsertRowid);
  const docLen = indexTokens(docId, doc);
  db.prepare('UPDATE documents SET doc_len = ? WHERE id = ?').run(docLen, docId);
  adjustMeta(1, docLen);
  bumpGeneration();
  return docId;
});

const addDocumentsBatch = db.transaction((inputs) => {
  let totalLen = 0;
  const ids = [];
  for (const input of inputs) {
    const doc = normalizeDoc(input);
    const info = stmts.insertDoc.run({ ...doc, doc_len: 0 });
    const docId = Number(info.lastInsertRowid);
    const docLen = indexTokens(docId, doc);
    db.prepare('UPDATE documents SET doc_len = ? WHERE id = ?').run(docLen, docId);
    totalLen += docLen;
    ids.push(docId);
  }
  adjustMeta(inputs.length, totalLen);
  bumpGeneration();
  return ids;
});

const updateDocument = db.transaction((id, input) => {
  const existing = stmts.getDoc.get(id);
  if (!existing) return false;
  const doc = { ...normalizeDoc({ ...existing, ...input }), created_at: existing.created_at };
  const oldLen = existing.doc_len;
  stmts.deletePostingsByDoc.run(id);
  const docLen = indexTokens(id, doc);
  stmts.updateDoc.run({ ...doc, id, doc_len: docLen });
  adjustMeta(0, docLen - oldLen);
  bumpGeneration();
  return true;
});

const deleteDocument = db.transaction((id) => {
  const existing = stmts.getDoc.get(id);
  if (!existing) return false;
  stmts.deletePostingsByDoc.run(id);
  stmts.deleteDoc.run(id);
  adjustMeta(-1, -existing.doc_len);
  bumpGeneration();
  return true;
});

const rebuildIndex = db.transaction(() => {
  db.exec('DELETE FROM postings');
  setMeta('doc_count', 0);
  setMeta('total_len', 0);
  const docs = db.prepare('SELECT * FROM documents').all();
  let totalLen = 0;
  for (const doc of docs) {
    const docLen = indexTokens(doc.id, doc);
    db.prepare('UPDATE documents SET doc_len = ? WHERE id = ?').run(docLen, doc.id);
    totalLen += docLen;
  }
  setMeta('doc_count', docs.length);
  setMeta('total_len', totalLen);
  bumpGeneration();
  return docs.length;
});

function getStats() {
  const docCount = stmts.countDocs.get().c;
  const totalLen = Number(getMeta('total_len'));
  return {
    documents: docCount,
    distinctTerms: stmts.countTerms.get().c,
    postings: stmts.countPostings.get().c,
    avgDocLength: docCount ? Math.round(totalLen / docCount) : 0,
    generation: Number(getMeta('generation')),
    types: stmts.typeFacets.all(),
  };
}

module.exports = {
  addDocument,
  addDocumentsBatch,
  updateDocument,
  deleteDocument,
  rebuildIndex,
  getStats,
  getDocument: (id) => stmts.getDoc.get(id),
};
