'use strict';

const { tokenize } = require('./tokenizer');

/**
 * 查询语法：
 *   全文检索              —— 相邻词项默认 AND
 *   sqlite AND 索引       —— 显式与
 *   搜索 OR 检索          —— 或
 *   NOT 广告 / -广告      —— 非
 *   "全文 检索"           —— 短语（按序相邻）
 *   title:索引            —— 字段限定（title / content）
 *   (搜索 OR 检索) AND 引擎 —— 括号分组
 */

function lex(input) {
  const tokens = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '(' || ch === ')') { tokens.push({ t: ch }); i++; continue; }
    if (ch === '-') { tokens.push({ t: 'NOT' }); i++; continue; }
    if (ch === '"') {
      const end = input.indexOf('"', i + 1);
      const text = end === -1 ? input.slice(i + 1) : input.slice(i + 1, end);
      tokens.push({ t: 'PHRASE', value: text });
      i = end === -1 ? n : end + 1;
      continue;
    }
    let j = i;
    while (j < n && !/[\s()"]/.test(input[j])) j++;
    let word = input.slice(i, j);
    i = j;
    let field = null;
    const colon = word.indexOf(':');
    if (colon > 0) {
      field = word.slice(0, colon).toLowerCase();
      word = word.slice(colon + 1);
      if (word.startsWith('"') && word.endsWith('"') && word.length >= 2) {
        tokens.push({ t: 'PHRASE', value: word.slice(1, -1), field });
        continue;
      }
    }
    const upper = word.toUpperCase();
    if (!field && (upper === 'AND' || upper === 'OR' || upper === 'NOT')) {
      tokens.push({ t: upper });
    } else if (word) {
      tokens.push({ t: 'TERM', value: word, field });
    }
  }
  return tokens;
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }
  peek() { return this.tokens[this.pos]; }
  next() { return this.tokens[this.pos++]; }

  parse() {
    if (!this.tokens.length) return null;
    const node = this.parseOr();
    return node;
  }

  parseOr() {
    let left = this.parseAnd();
    while (this.peek() && this.peek().t === 'OR') {
      this.next();
      const right = this.parseAnd();
      left = { type: 'or', children: [left, right] };
    }
    return left;
  }

  parseAnd() {
    let left = this.parseUnary();
    for (;;) {
      const tok = this.peek();
      if (tok && tok.t === 'AND') {
        this.next();
        left = { type: 'and', children: [left, this.parseUnary()] };
      } else if (tok && (tok.t === 'TERM' || tok.t === 'PHRASE' || tok.t === 'NOT' || tok.t === '(')) {
        left = { type: 'and', children: [left, this.parseUnary()] };
      } else {
        break;
      }
    }
    return left;
  }

  parseUnary() {
    const tok = this.peek();
    if (tok && tok.t === 'NOT') {
      this.next();
      return { type: 'not', child: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  parsePrimary() {
    const tok = this.next();
    if (!tok) return { type: 'term', terms: [] };
    if (tok.t === '(') {
      const node = this.parseOr();
      if (this.peek() && this.peek().t === ')') this.next();
      return node;
    }
    if (tok.t === 'PHRASE') {
      return { type: 'phrase', terms: tokenize(tok.value).map((x) => x.term), field: tok.field || null };
    }
    if (tok.t === 'TERM') {
      return { type: 'term', terms: tokenize(tok.value).map((x) => x.term), field: tok.field || null };
    }
    return { type: 'term', terms: [] };
  }
}

function parseQuery(input) {
  return new Parser(lex(String(input || ''))).parse();
}

module.exports = { parseQuery };
