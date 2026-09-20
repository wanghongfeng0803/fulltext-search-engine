'use strict';

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const WORD = /[a-zA-Z0-9]+/g;

/**
 * 将文本切分为带位置信息的词项序列。
 * - 英文/数字：按连续字母数字切词并转小写；
 * - 中文（CJK）：按二元组（bigram）切分，单字兜底为一元组；
 * - 其余字符（标点、空白）作为分隔符。
 * 返回 [{ term, position }]，position 在字段内递增。
 */
function tokenize(text) {
  const tokens = [];
  if (!text) return tokens;
  let position = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (CJK.test(ch)) {
      let j = i;
      while (j < n && CJK.test(text[j])) j++;
      const run = text.slice(i, j);
      if (run.length === 1) {
        tokens.push({ term: run, position: position++ });
      } else {
        for (let k = 0; k + 2 <= run.length; k++) {
          tokens.push({ term: run.slice(k, k + 2), position: position++ });
        }
      }
      i = j;
    } else if (/[a-zA-Z0-9]/.test(ch)) {
      let j = i;
      while (j < n && /[a-zA-Z0-9]/.test(text[j])) j++;
      tokens.push({ term: text.slice(i, j).toLowerCase(), position: position++ });
      i = j;
    } else {
      i++;
    }
  }
  return tokens;
}

/** 统计词频：{ term: { tf, positions[] } } */
function termStats(text) {
  const stats = new Map();
  for (const { term, position } of tokenize(text)) {
    let entry = stats.get(term);
    if (!entry) {
      entry = { tf: 0, positions: [] };
      stats.set(term, entry);
    }
    entry.tf++;
    entry.positions.push(position);
  }
  return stats;
}

module.exports = { tokenize, termStats };
