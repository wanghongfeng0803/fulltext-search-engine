'use strict';

/**
 * 生成示例文档并批量建索引。
 * 用法：node scripts/seed.js [文档数量]   （默认 5000）
 */

const indexer = require('../src/indexer');

const COUNT = Math.max(1, Number(process.argv[2]) || 5000);
const BATCH = 500;

const TOPICS = [
  { type: 'article', words: ['全文检索', '搜索引擎', '倒排索引', '分词算法', '相关性评分', '检索', '索引', '查询', '文档', '词频', '排序', '数据库', '性能', '缓存'] },
  { type: 'note', words: ['学习笔记', '算法', '数据结构', '二叉树', '哈希表', '动态规划', '复杂度', '递归', '排序算法', '链表'] },
  { type: 'report', words: ['季度报告', '市场分析', '用户增长', '营收', '转化率', '留存率', '渠道', '竞品', '趋势', '指标'] },
  { type: 'article', words: ['Node.js', 'Express', 'SQLite', 'JavaScript', 'middleware', 'backend', 'server', 'API', 'database', 'performance'] },
];
const AUTHORS = ['张伟', '李娜', '王芳', '刘洋', '陈杰', 'Alice', 'Bob'];
const FILLER = ['的', '了', '和', '是', '在', '我们', '可以', '通过', '进行', '实现', '一个', '系统', '功能', '数据', '服务', '支持', '需要', '设计', '方案', '模块'];

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }

function makeSentence(topic) {
  const len = randInt(6, 14);
  const parts = [];
  for (let i = 0; i < len; i++) {
    parts.push(Math.random() < 0.45 ? rand(topic.words) : rand(FILLER));
  }
  return parts.join('') + '。';
}

function makeDoc(i) {
  const topic = rand(TOPICS);
  const titleWords = Array.from({ length: randInt(2, 5) }, () => rand(topic.words));
  const paraCount = randInt(2, 5);
  const paragraphs = [];
  for (let p = 0; p < paraCount; p++) {
    const sentCount = randInt(2, 5);
    paragraphs.push(Array.from({ length: sentCount }, () => makeSentence(topic)).join(''));
  }
  const day = randInt(0, 364);
  const created = new Date(Date.now() - day * 86400000 - randInt(0, 86399999));
  return {
    title: titleWords.join('') + `（第${i}篇）`,
    content: paragraphs.join('\n'),
    type: topic.type,
    author: rand(AUTHORS),
    tags: topic.words.slice(0, 3).join(','),
    created_at: created.toISOString(),
  };
}

const started = Date.now();
let inserted = 0;
for (let offset = 0; offset < COUNT; offset += BATCH) {
  const batch = [];
  for (let i = 0; i < BATCH && offset + i < COUNT; i++) {
    batch.push(makeDoc(offset + i));
  }
  indexer.addDocumentsBatch(batch);
  inserted += batch.length;
  process.stdout.write(`\r已索引 ${inserted}/${COUNT}`);
}
const elapsed = Date.now() - started;
console.log(`\n完成：${inserted} 篇文档，耗时 ${elapsed} ms，吞吐 ${Math.round(inserted / (elapsed / 1000))} 篇/秒`);
console.log('统计：', indexer.getStats());
