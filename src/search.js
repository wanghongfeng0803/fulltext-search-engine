/**
 * search.js — 检索执行引擎。
 *
 * 链路：AST 求值（倒排集合运算）→ 多维过滤 → TF-IDF 加权评分
 *       → 相关度排序 → 分页 → 命中高亮片段生成。
 *
 * 评分模型（TF-IDF，含字段加权与长度归一）：
 *   idf(t)   = ln(1 + N / df(t))
 *   tf'(t,d) = (W_title·tf_title + W_content·tf_content) / (1 + len(d)/avgLen)
 *   score(d) = Σ_t idf(t) · tf'(t,d)
 */
const { db, getMeta } = require('./db');
const { parse } = require('./queryParser');

const W_TITLE = 3.0;    // 标题命中权重
const W_CONTENT = 1.0;  // 正文命中权重
const SNIPPET_RADIUS = 60; // 高亮片段上下文半径（字符）

const stmt = {
  postingsByTerm: db.prepare(`
    SELECT p.doc_id AS docId, p.field, p.tf, p.positions
    FROM postings p JOIN terms t ON t.id = p.term_id
    WHERE t.term = ?`),
  postingsByTermField: db.prepare(`
    SELECT p.doc_id AS docId, p.field, p.tf, p.positions
    FROM postings p JOIN terms t ON t.id = p.term_id
    WHERE t.term = ? AND p.field = ?`),
  df: db.prepare(`
    SELECT COUNT(DISTINCT p.doc_id) AS df
    FROM postings p JOIN terms t ON t.id = p.term_id WHERE t.term = ?`),
  lengths: db.prepare('SELECT doc_id AS docId, title_len AS titleLen, content_len AS contentLen FROM doc_lengths'),
};

// 文档长度缓存（索引变更时由 routes 层调用 invalidate 刷新）
let lenCache = null;
function docLengths() {
  if (!lenCache) {
    lenCache = new Map();
    for (const row of stmt.lengths.iterate()) {
      lenCache.set(row.docId, row.titleLen + row.contentLen);
    }
  }
  return lenCache;
}
function invalidateCache() { lenCache = null; }

/** 获取词项的倒排记录 Map: docId -> [{field, tf, positions}] */
function fetchPostings(term, field) {
  const rows = field ? stmt.postingsByTermField.all(term, field) : stmt.postingsByTerm.all(term);
  const map = new Map();
  for (const row of rows) {
    const rec = { field: row.field, tf: row.tf, positions: JSON.parse(row.positions) };
    const arr = map.get(row.docId);
    if (arr) arr.push(rec); else map.set(row.docId, [rec]);
  }
  return map;
}

/**
 * AST 求值。
 * @returns {{ matches: Map<number, Array<{term, field, tf, positions}>>, terms: string[] }}
 *   matches: docId -> 命中的词项记录（用于评分与高亮）
 */
function evaluate(node, acc) {
  if (!node) return new Map();
  switch (node.type) {
    case 'term': {
      const postings = fetchPostings(node.term, node.field);
      acc.terms.add(node.term);
      const out = new Map();
      for (const [docId, recs] of postings) {
        out.set(docId, recs.map((r) => ({ term: node.term, ...r })));
      }
      return out;
    }
    case 'phrase': {
      // 每个词项的倒排列表只取一次；链式位置校验后，
      // 命中文档的高亮记录直接从已取出的倒排表中汇总。
      const phraseTerms = node.terms;
      for (const t of phraseTerms) acc.terms.add(t.term);
      const postings = phraseTerms.map((t) => fetchPostings(t.term, node.field));

      let current = new Map();
      for (const [docId, recs] of postings[0]) current.set(docId, recs);
      for (let i = 1; i < phraseTerms.length; i++) {
        // 位置校验：同一字段内，后一词偏移 = 前一词偏移 + delta 差。
        // 命中后保留“当前词”的记录，作为下一轮比较的位置基准。
        const shift = phraseTerms[i].delta - phraseTerms[i - 1].delta;
        const nextCur = new Map();
        for (const [docId, recsA] of current) {
          const recsB = postings[i].get(docId);
          if (!recsB) continue;
          const okB = [];
          for (const a of recsA) {
            for (const b of recsB) {
              if (a.field !== b.field) continue;
              const hit = b.positions.some((p) => a.positions.includes(p - shift));
              if (hit) okB.push(b);
            }
          }
          if (okB.length) nextCur.set(docId, okB);
        }
        current = nextCur;
        if (current.size === 0) return new Map();
      }
      // 汇总命中文档的全部词项记录（供评分与高亮使用）
      const out = new Map();
      for (const docId of current.keys()) {
        const hits = [];
        for (let i = 0; i < phraseTerms.length; i++) {
          for (const r of postings[i].get(docId) || []) {
            hits.push({ term: phraseTerms[i].term, ...r });
          }
        }
        out.set(docId, hits);
      }
      return out;
    }
    case 'and': {
      // NOT 子节点不参与交集，仅登记排除集合
      const positives = node.children.filter((c) => c.type !== 'not');
      for (const neg of node.children.filter((c) => c.type === 'not')) {
        evaluate(neg, acc);
      }
      const sets = positives.map((c) => evaluate(c, acc));
      if (sets.some((s) => s.size === 0)) return new Map();
      sets.sort((a, b) => a.size - b.size);
      const out = new Map();
      for (const [docId, hits] of sets[0]) {
        if (sets.every((s) => s.has(docId))) {
          out.set(docId, sets.flatMap((s) => s.get(docId)));
        }
      }
      return out;
    }
    case 'or': {
      const out = new Map();
      for (const child of node.children) {
        for (const [docId, hits] of evaluate(child, acc)) {
          const arr = out.get(docId);
          if (arr) arr.push(...hits); else out.set(docId, [...hits]);
        }
      }
      return out;
    }
    case 'not': {
      // NOT 作为一元运算：在与上下文的 AND 求值中表现为排除。
      // 这里直接返回“被排除的 docId 集合”，由 and 分支处理；
      // 顶层单独出现时退化为空集（不允许纯 NOT 查询）。
      const excluded = evaluate(node.child, { terms: new Set() });
      acc.exclusions.push(excluded);
      return new Map();
    }
    default:
      return new Map();
  }
}

/** 应用排除集合（NOT 语义）。 */
function applyExclusions(matches, exclusions) {
  for (const ex of exclusions) {
    for (const docId of ex.keys()) matches.delete(docId);
  }
  return matches;
}

/** 多维过滤：文档类型 / 时间范围 / 来源（统一使用位置参数）。 */
function buildFilter({ type, from, to, source }) {
  const clauses = [];
  const params = [];
  if (type) { clauses.push('doc_type = ?'); params.push(type); }
  if (from) { clauses.push('created_at >= ?'); params.push(from); }
  if (to) { clauses.push('created_at <= ?'); params.push(to.length === 10 ? `${to} 23:59:59` : to); }
  if (source) { clauses.push('source = ?'); params.push(source); }
  return { where: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', params };
}

/** TF-IDF 评分。 */
function score(docId, hits, idfMap, avgLen) {
  const lengths = docLengths();
  const docLen = lengths.get(docId) || avgLen || 1;
  let total = 0;
  const contributions = {};
  for (const hit of hits) {
    const idf = idfMap.get(hit.term) || 0;
    const w = hit.field === 'title' ? W_TITLE : W_CONTENT;
    const norm = 1 + docLen / (avgLen || 1);
    const value = (idf * w * hit.tf) / norm;
    total += value;
    contributions[hit.term] = +((contributions[hit.term] || 0) + value).toFixed(4);
  }
  return { score: +total.toFixed(4), contributions };
}

/** 生成带 <mark> 高亮的片段。 */
function makeSnippet(doc, hits) {
  // 优先在正文中定位命中，其次标题
  const contentHits = hits.filter((h) => h.field === 'content');
  const target = contentHits.length ? doc.content : doc.title;
  const targetHits = contentHits.length ? contentHits : hits;
  let first = Infinity;
  for (const h of targetHits) {
    for (const p of h.positions) if (p < first) first = p;
  }
  if (!isFinite(first)) first = 0;
  const start = Math.max(0, first - SNIPPET_RADIUS);
  const end = Math.min(target.length, first + SNIPPET_RADIUS);
  const marks = [];
  for (const h of targetHits) {
    for (const p of h.positions) {
      if (p >= start && p + h.term.length <= end) marks.push([p, p + h.term.length]);
    }
  }
  marks.sort((a, b) => a[0] - b[0]);
  let html = '';
  let cursor = start;
  for (const [a, b] of marks) {
    if (a < cursor) continue; // 跳过重叠
    html += escapeHtml(target.slice(cursor, a)) + '<mark>' + escapeHtml(target.slice(a, b)) + '</mark>';
    cursor = b;
  }
  html += escapeHtml(target.slice(cursor, end));
  return (start > 0 ? '…' : '') + html + (end < target.length ? '…' : '');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * 执行检索。
 * @param {object} opts { q, page, pageSize, type, from, to, source, explain }
 */
function search(opts) {
  const t0 = process.hrtime.bigint();
  const page = Math.max(1, parseInt(opts.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(opts.pageSize, 10) || 10));
  const filter = buildFilter(opts);
  const docCount = getMeta('doc_count');
  const avgLen = docCount
    ? (getMeta('sum_title_len') + getMeta('sum_content_len')) / docCount
    : 1;

  const q = (opts.q || '').trim();
  let candidateIds = null; // null 表示不过滤（无查询词）
  let hitsMap = new Map();
  let queryTerms = [];

  if (q) {
    const ast = parse(q);
    const acc = { terms: new Set(), exclusions: [] };
    hitsMap = applyExclusions(evaluate(ast, acc), acc.exclusions);
    queryTerms = [...acc.terms];
    candidateIds = hitsMap;
  }

  // 组装候选文档（索引求值结果 ∩ 过滤条件），统一位置参数绑定
  const idList = candidateIds ? [...candidateIds.keys()] : null;
  if (idList && idList.length === 0) {
    return emptyResult(page, pageSize, queryTerms, t0);
  }
  let sql = 'SELECT id, title, content, doc_type, source, created_at FROM documents WHERE 1=1' + filter.where;
  const params = [...filter.params];
  if (idList) {
    sql += ` AND id IN (${idList.map(() => '?').join(',')})`;
    params.push(...idList);
  }
  const rows = db.prepare(sql).all(...params);
  return finishSearch(rows, hitsMap, queryTerms, { page, pageSize, avgLen, explain: opts.explain, t0 });
}

function finishSearch(rows, hitsMap, queryTerms, { page, pageSize, avgLen, explain, t0 }) {
  // 评分
  const idfMap = new Map();
  const N = getMeta('doc_count') || 1;
  for (const term of queryTerms) {
    const df = stmt.df.get(term).df || 1;
    idfMap.set(term, Math.log(1 + N / df));
  }
  const scored = rows.map((doc) => {
    const hits = hitsMap.get(doc.id) || [];
    const { score: s, contributions } = score(doc.id, hits, idfMap, avgLen);
    return {
      id: doc.id,
      title: doc.title,
      docType: doc.doc_type,
      source: doc.source,
      createdAt: doc.created_at,
      score: s,
      snippet: makeSnippet(doc, hits),
      ...(explain ? { explain: { contributions, idf: Object.fromEntries([...idfMap].map(([k, v]) => [k, +v.toFixed(4)])) } } : {}),
    };
  });
  scored.sort((a, b) => b.score - a.score || a.id - b.id);

  const total = scored.length;
  const items = scored.slice((page - 1) * pageSize, page * pageSize);
  const tookMs = Number(process.hrtime.bigint() - t0) / 1e6;
  return {
    total,
    page,
    pageSize,
    pages: Math.ceil(total / pageSize) || 1,
    tookMs: +tookMs.toFixed(2),
    queryTerms,
    scoreDist: scoreDistribution(scored),
    items,
  };
}

function scoreDistribution(scored) {
  if (!scored.length) return [];
  const max = scored[0].score;
  const buckets = 10;
  const dist = new Array(buckets).fill(0);
  for (const r of scored) {
    const idx = max === 0 ? 0 : Math.min(buckets - 1, Math.floor((r.score / max) * buckets));
    dist[idx]++;
  }
  return dist;
}

function emptyResult(page, pageSize, queryTerms, t0) {
  return {
    total: 0, page, pageSize, pages: 1,
    tookMs: +(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(2),
    queryTerms, scoreDist: [], items: [],
  };
}

module.exports = { search, invalidateCache, W_TITLE, W_CONTENT };
