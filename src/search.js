'use strict';

const { db, getMeta, getGeneration } = require('./db');
const { parseQuery } = require('./queryParser');
const config = require('./config');

const stmts = {
  // 普通词项查询无需 positions，减少 IO
  postingsByTerm: db.prepare('SELECT field, doc_id, tf FROM postings WHERE term = ?'),
  postingsByTermField: db.prepare('SELECT field, doc_id, tf FROM postings WHERE term = ? AND field = ?'),
  postingsWithPos: db.prepare('SELECT field, doc_id, tf, positions FROM postings WHERE term = ?'),
  postingsWithPosField: db.prepare(
    'SELECT field, doc_id, tf, positions FROM postings WHERE term = ? AND field = ?'
  ),
  allDocIds: db.prepare('SELECT id FROM documents'),
};

// ---------- 结果缓存（按索引代次失效的简易 LRU） ----------
const cache = new Map();
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}
function cacheSet(key, value) {
  cache.set(key, value);
  if (cache.size > config.cacheMaxEntries) {
    cache.delete(cache.keys().next().value);
  }
}

// ---------- IDF 缓存（随索引代次失效） ----------
let idfCacheGen = -1;
const idfCache = new Map();
function idf(df) {
  const gen = getGeneration();
  if (gen !== idfCacheGen) {
    idfCache.clear();
    idfCacheGen = gen;
  }
  let v = idfCache.get(df);
  if (v === undefined) {
    const n = Number(getMeta('doc_count')) || 1;
    v = Math.log(1 + n / df);
    idfCache.set(df, v);
  }
  return v;
}

// ---------- 文档全集缓存（仅 NOT 运算需要，随索引代次失效） ----------
let universeCacheGen = -1;
let universeCache = [];
function getUniverse() {
  const gen = getGeneration();
  if (gen !== universeCacheGen) {
    universeCache = stmts.allDocIds.all().map((r) => r.id);
    universeCacheGen = gen;
  }
  return universeCache;
}

function hasNot(node) {
  if (!node) return false;
  if (node.type === 'not') return true;
  if (node.children) return node.children.some(hasNot);
  return node.child ? hasNot(node.child) : false;
}

// ---------- 查询求值 ----------
// 返回 Map<docId, { score, terms:Set }>
function emptyResult() {
  return new Map();
}

function evalTerm(node) {
  // 单个查询词可能被切分为多个词项（如中文 bigram），它们之间为 AND 关系
  let result = null;
  for (const term of node.terms) {
    const rows = node.field
      ? stmts.postingsByTermField.all(term, node.field)
      : stmts.postingsByTerm.all(term);
    const docSet = new Set(rows.map((r) => r.doc_id));
    if (!docSet.size) return new Map();
    const termIdf = idf(docSet.size);
    const termMap = new Map();
    for (const row of rows) {
      const weight = config.fieldWeights[row.field] || 1;
      const contribution = weight * (1 + Math.log(row.tf)) * termIdf;
      const entry = termMap.get(row.doc_id) || { score: 0, terms: new Set() };
      entry.score += contribution;
      entry.terms.add(term);
      termMap.set(row.doc_id, entry);
    }
    result = result === null ? termMap : combine('and', result, termMap);
    if (!result.size) return result;
  }
  return result || new Map();
}

function evalPhrase(node) {
  const result = new Map();
  if (!node.terms.length) return result;
  const fields = node.field ? [node.field] : Object.keys(config.fieldWeights);
  // 每个词项的倒排记录：Map<`${docId}:${field}`, positions[]>
  const perTerm = node.terms.map((term) => {
    const rows = node.field
      ? stmts.postingsWithPosField.all(term, node.field)
      : stmts.postingsWithPos.all(term);
    const map = new Map();
    for (const row of rows) map.set(`${row.doc_id}:${row.field}`, JSON.parse(row.positions));
    return { term, map, df: new Set(rows.map((r) => r.doc_id)).size };
  });
  if (perTerm.some((p) => p.df === 0)) return result;
  // 以首个词项的文档为候选做交集
  const phraseIdf = perTerm.reduce((sum, p) => sum + idf(p.df), 0);
  outer: for (const [key, firstPositions] of perTerm[0].map) {
    const [docIdStr, field] = key.split(':');
    if (!fields.includes(field)) continue;
    for (const start of firstPositions) {
      let ok = true;
      for (let k = 1; k < perTerm.length; k++) {
        const positions = perTerm[k].map.get(key);
        if (!positions || !positions.includes(start + k)) { ok = false; break; }
      }
      if (ok) {
        const docId = Number(docIdStr);
        const weight = config.fieldWeights[field] || 1;
        let entry = result.get(docId);
        if (!entry) {
          entry = { score: 0, terms: new Set() };
          result.set(docId, entry);
        }
        entry.score += weight * phraseIdf * config.phraseBoost;
        for (const p of perTerm) entry.terms.add(p.term);
        continue outer;
      }
    }
  }
  return result;
}

function evalNot(node, universe) {
  const child = evaluate(node.child, universe);
  const result = new Map();
  for (const id of universe) {
    if (!child.has(id)) result.set(id, { score: 0, terms: new Set() });
  }
  return result;
}

function combine(op, left, right) {
  const result = new Map();
  if (op === 'and') {
    for (const [id, entry] of left) {
      const other = right.get(id);
      if (other) {
        result.set(id, {
          score: entry.score + other.score,
          terms: new Set([...entry.terms, ...other.terms]),
        });
      }
    }
  } else {
    for (const [id, entry] of left) result.set(id, { score: entry.score, terms: new Set(entry.terms) });
    for (const [id, entry] of right) {
      const cur = result.get(id);
      if (cur) {
        cur.score += entry.score;
        for (const t of entry.terms) cur.terms.add(t);
      } else {
        result.set(id, { score: entry.score, terms: new Set(entry.terms) });
      }
    }
  }
  return result;
}

function evaluate(node, universe) {
  if (!node) return emptyResult();
  switch (node.type) {
    case 'term': return evalTerm(node);
    case 'phrase': return evalPhrase(node);
    case 'not': return evalNot(node, universe);
    case 'and': return combine('and', evaluate(node.children[0], universe), evaluate(node.children[1], universe));
    case 'or': return combine('or', evaluate(node.children[0], universe), evaluate(node.children[1], universe));
    default: return emptyResult();
  }
}

// ---------- 过滤 + 分页 ----------
function buildFilterClause(filters, ids) {
  const where = [];
  const params = {};
  if (ids) {
    where.push(`id IN (${ids.map((_, i) => `@id${i}`).join(',')})`);
    ids.forEach((id, i) => { params[`id${i}`] = id; });
  }
  if (filters.type) { where.push('type = @type'); params.type = filters.type; }
  if (filters.author) { where.push('author = @author'); params.author = filters.author; }
  if (filters.from) { where.push('created_at >= @from'); params.from = filters.from; }
  if (filters.to) { where.push('created_at <= @to'); params.to = filters.to + (filters.to.length === 10 ? 'T23:59:59.999Z' : ''); }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

function fetchFiltered(scored, filters) {
  const ids = [...scored.keys()];
  if (!ids.length) return { docs: [], typeFacets: [] };
  const docs = [];
  const facetMap = new Map();
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { sql, params } = buildFilterClause(filters, chunk);
    // 仅取过滤与排序所需列，正文待分页后再回表
    const rows = db.prepare(`SELECT id, type, created_at FROM documents ${sql}`).all(params);
    docs.push(...rows);
    const facetRows = db.prepare(`SELECT type, COUNT(*) AS c FROM documents ${sql} GROUP BY type`).all(params);
    for (const f of facetRows) facetMap.set(f.type, (facetMap.get(f.type) || 0) + f.c);
  }
  return {
    docs,
    typeFacets: [...facetMap.entries()].map(([type, count]) => ({ type, count })),
  };
}

function hydrateDocs(ids) {
  if (!ids.length) return new Map();
  const placeholders = ids.map((_, i) => `@id${i}`).join(',');
  const params = {};
  ids.forEach((id, i) => { params[`id${i}`] = id; });
  const rows = db.prepare(`SELECT * FROM documents WHERE id IN (${placeholders})`).all(params);
  return new Map(rows.map((r) => [r.id, r]));
}

// ---------- 高亮 ----------
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function highlightText(text, terms) {
  let out = escapeHtml(text);
  const sorted = [...terms].sort((a, b) => b.length - a.length);
  for (const term of sorted) {
    if (!term) continue;
    out = out.split(term).join(`<em>${term}</em>`);
  }
  return out;
}

function makeSnippet(content, terms) {
  const radius = config.snippetRadius;
  let first = -1;
  for (const term of terms) {
    const idx = content.indexOf(term);
    if (idx !== -1 && (first === -1 || idx < first)) first = idx;
  }
  if (first === -1) {
    return highlightText(content.slice(0, radius * 2), terms);
  }
  const start = Math.max(0, first - radius);
  const end = Math.min(content.length, first + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < content.length ? '…' : '';
  return prefix + highlightText(content.slice(start, end), terms) + suffix;
}

// ---------- 主入口 ----------
function search(options) {
  const started = process.hrtime.bigint();
  const q = String(options.q || '').trim();
  const page = Math.max(1, Number(options.page) || 1);
  const pageSize = Math.min(config.maxPageSize, Math.max(1, Number(options.pageSize) || config.defaultPageSize));
  const filters = {
    type: options.type || '',
    author: options.author || '',
    from: options.from || '',
    to: options.to || '',
  };
  const ast = parseQuery(q);
  const generation = getGeneration();
  const cacheKey = JSON.stringify({ q, page, pageSize, filters, generation });
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, cached: true };

  const needUniverse = !ast || hasNot(ast);
  const universe = needUniverse ? getUniverse() : null;
  const scored = ast ? evaluate(ast, universe) : new Map(universe.map((id) => [id, { score: 0, terms: new Set() }]));
  const { docs, typeFacets } = fetchFiltered(scored, filters);

  for (const doc of docs) doc._score = scored.get(doc.id).score;
  docs.sort((a, b) => b._score - a._score || b.created_at.localeCompare(a.created_at) || a.id - b.id);

  const total = docs.length;
  const pageSlice = docs.slice((page - 1) * pageSize, page * pageSize);
  const hydrated = hydrateDocs(pageSlice.map((d) => d.id));
  const results = pageSlice.map((doc) => {
    const full = hydrated.get(doc.id);
    const terms = scored.get(doc.id).terms;
    return {
      id: doc.id,
      type: doc.type,
      author: doc.author,
      tags: doc.tags,
      created_at: doc.created_at,
      score: Number(doc._score.toFixed(4)),
      title: highlightText(full.title, terms),
      snippet: makeSnippet(full.content, terms),
    };
  });

  const payload = {
    query: q,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    tookMs: Number(process.hrtime.bigint() - started) / 1e6,
    facets: { types: typeFacets },
    results,
    cached: false,
  };
  payload.tookMs = Number(payload.tookMs.toFixed(2));
  cacheSet(cacheKey, payload);
  return payload;
}

module.exports = { search };
