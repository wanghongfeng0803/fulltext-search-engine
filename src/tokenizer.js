/**
 * tokenizer.js — 轻量中英文分词器。
 *
 * 规则：
 * - 拉丁字母 / 数字：按连续字符切分为完整单词，统一小写；
 * - CJK 汉字：以滑动窗口生成二元组（bigram），单字孤立时退化为单字；
 * - 其余字符（标点、空白、emoji 等）视为分隔符。
 *
 * 每个 token 记录其在原文中的字符偏移（offset），
 * 倒排索引据此支持短语位置匹配与命中高亮。
 */

const CJK_RE = /[㐀-䶿一-鿿豈-﫿]/;
const WORD_RE = /[a-z0-9]/;

function isCjk(ch) {
  return CJK_RE.test(ch);
}

/**
 * 将文本切分为 token 序列。
 * @param {string} text
 * @returns {Array<{term: string, offset: number}>}
 */
function tokenize(text) {
  const tokens = [];
  const s = String(text || '').toLowerCase();
  let i = 0;
  const n = s.length;

  while (i < n) {
    const ch = s[i];
    if (WORD_RE.test(ch)) {
      // 拉丁/数字单词
      let j = i + 1;
      while (j < n && WORD_RE.test(s[j])) j++;
      tokens.push({ term: s.slice(i, j), offset: i });
      i = j;
    } else if (isCjk(ch)) {
      // 连续 CJK 片段 → bigram 序列
      let j = i;
      while (j < n && isCjk(s[j])) j++;
      const runLen = j - i;
      if (runLen === 1) {
        tokens.push({ term: s[i], offset: i });
      } else {
        for (let k = i; k < j - 1; k++) {
          tokens.push({ term: s.slice(k, k + 2), offset: k });
        }
      }
      i = j;
    } else {
      i++;
    }
  }
  return tokens;
}

/**
 * 从 token 序列聚合倒排记录：term -> { tf, positions }
 * @param {string} text
 * @returns {Map<string, {tf: number, positions: number[]}>}
 */
function analyze(text) {
  const map = new Map();
  for (const { term, offset } of tokenize(text)) {
    const entry = map.get(term);
    if (entry) {
      entry.tf++;
      entry.positions.push(offset);
    } else {
      map.set(term, { tf: 1, positions: [offset] });
    }
  }
  return map;
}

module.exports = { tokenize, analyze, isCjk };
