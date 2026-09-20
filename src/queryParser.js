/**
 * queryParser.js — 检索查询语法解析。
 *
 * 支持的语法：
 *   全文检索                多个词项，默认 AND 组合
 *   索引 AND 引擎           显式 AND
 *   索引 OR 引擎            显式 OR
 *   引擎 -倒排 / NOT 倒排   排除（NOT 一元前缀 / - 前缀）
 *   "全文检索"              短语匹配（按字符偏移精确相邻）
 *   title:索引              字段限定（title / content）
 *   (索引 OR 分词) AND 引擎  括号分组
 *
 * 输出 AST：
 *   { type: 'and'|'or', children: [...] }
 *   { type: 'not', child: {...} }
 *   { type: 'term',   term, field? }
 *   { type: 'phrase', terms: [{term, delta}], field? }
 */
const { tokenize } = require('./tokenizer');

const FIELDS = new Set(['title', 'content']);

// ---- 词法分析 ----
function lex(input) {
  const tokens = [];
  const s = String(input || '');
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '(' || ch === ')') { tokens.push({ t: ch }); i++; continue; }
    if (ch === '"') {
      const end = s.indexOf('"', i + 1);
      const text = end === -1 ? s.slice(i + 1) : s.slice(i + 1, end);
      tokens.push({ t: 'phrase', text });
      i = end === -1 ? s.length : end + 1;
      continue;
    }
    if (ch === '-') { tokens.push({ t: 'not' }); i++; continue; }
    // 普通词（读到空白/括号/引号为止）
    let j = i;
    while (j < s.length && !/[\s()"]/.test(s[j])) j++;
    tokens.push({ t: 'word', text: s.slice(i, j) });
    i = j;
  }
  return tokens;
}

// ---- 递归下降语法分析 ----
function parse(input) {
  const tokens = lex(input);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseExpr() {
    // 隐式 AND：相邻子表达式无显式运算符时按 AND 组合
    const parts = [parseOr()];
    while (peek() && peek().t !== ')') {
      parts.push(parseOr());
    }
    return parts.length === 1 ? parts[0] : { type: 'and', children: parts };
  }

  function parseOr() {
    const parts = [parseAnd()];
    while (peek() && peek().t === 'word' && /^or$/i.test(peek().text)) {
      next();
      parts.push(parseAnd());
    }
    return parts.length === 1 ? parts[0] : { type: 'or', children: parts };
  }

  function parseAnd() {
    const parts = [parseUnary()];
    while (peek() && peek().t === 'word' && /^and$/i.test(peek().text)) {
      next();
      parts.push(parseUnary());
    }
    return parts.length === 1 ? parts[0] : { type: 'and', children: parts };
  }

  function parseUnary() {
    const tk = peek();
    if (tk && (tk.t === 'not' || (tk.t === 'word' && /^not$/i.test(tk.text)))) {
      next();
      return { type: 'not', child: parseUnary() };
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const tk = next();
    if (!tk) return null;
    if (tk.t === '(') {
      const expr = parseExpr();
      if (peek() && peek().t === ')') next();
      return expr;
    }
    if (tk.t === 'phrase') return phraseNode(tk.text, null);
    if (tk.t === 'word') {
      // field:value 语法
      const m = tk.text.match(/^([a-zA-Z_]+):(.*)$/);
      if (m && FIELDS.has(m[1].toLowerCase())) {
        const field = m[1].toLowerCase();
        const rest = m[2];
        if (rest === '' && peek() && peek().t === 'phrase') {
          return phraseNode(next().text, field);   // title:"短语"
        }
        return termNodes(rest, field);
      }
      return termNodes(tk.text, null);
    }
    return null;
  }

  // 普通词 → 分词后按 AND 组合（中文词会被拆成 bigram）
  function termNodes(text, field) {
    const terms = tokenize(text).map((x) => x.term);
    if (terms.length === 0) return null;
    const nodes = terms.map((term) => ({ type: 'term', term, field }));
    return nodes.length === 1 ? nodes[0] : { type: 'and', children: nodes };
  }

  // 短语 → 记录每个 token 相对首个 token 的字符偏移差
  function phraseNode(text, field) {
    const toks = tokenize(text);
    if (toks.length === 0) return null;
    const base = toks[0].offset;
    return {
      type: 'phrase',
      terms: toks.map((x) => ({ term: x.term, delta: x.offset - base })),
      field,
    };
  }

  const ast = parseExpr();
  return ast;
}

module.exports = { parse };
