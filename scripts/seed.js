/**
 * scripts/seed.js — 示例数据生成。
 *
 * 用法：node scripts/seed.js [文档数量，默认 2000]
 * 通过词库组合生成中英文混合文档，覆盖多种文档类型与来源，
 * 词频分布遵循“少量高频词 + 大量低频词”，便于观察 TF-IDF 评分差异。
 */
const indexer = require('../src/indexer');
const { db } = require('../src/db');

const COUNT = Math.max(1, parseInt(process.argv[2], 10) || 2000);
const BATCH = 500;

// 简单可复现的伪随机数
let seed = 42;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const pickN = (arr, n) => {
  const copy = [...arr];
  const out = [];
  while (out.length < n && copy.length) out.push(copy.splice(Math.floor(rand() * copy.length), 1)[0]);
  return out;
};

const HOT = ['检索', '引擎', '索引', '搜索', '查询', '文档', '数据', '系统', '服务', '性能'];
const TECH = ['倒排', '分词', '评分', '排序', '缓存', '事务', '并发', '压缩', '跳表', '位图',
  '召回', '准确率', '高亮', '分页', '过滤', '聚合', '分片', '副本', '吞吐', '延迟'];
const STACK = ['SQLite', 'Express', 'Node.js', 'Redis', 'Lucene', 'Elasticsearch', 'MySQL',
  'PostgreSQL', 'Kafka', 'Docker', 'Nginx', 'JavaScript', 'Python', 'Rust', 'Go'];
const SCENE = ['全文检索', '日志分析', '电商搜索', '知识库', '内容推荐', '站内搜索', '舆情监控', '文档管理'];
const TAIL = ['实践', '指南', '原理', '优化', '踩坑记录', '最佳实践', '源码解析', '入门教程', '架构设计', '性能测试'];
const TYPES = ['article', 'article', 'article', 'note', 'note', 'tutorial', 'news'];
const SOURCES = ['tech-blog', 'wiki', 'docs', 'forum', 'newsletter'];

function makeDoc(i) {
  const scene = pick(SCENE);
  const stack = pickN(STACK, 1 + Math.floor(rand() * 3));
  const tech = pickN(TECH, 3 + Math.floor(rand() * 5));
  const hot = pickN(HOT, 2 + Math.floor(rand() * 3));
  const title = `${scene}中的${stack[0]}${pick(TAIL)}`;
  const sentences = [];
  const nSent = 4 + Math.floor(rand() * 6);
  for (let s = 0; s < nSent; s++) {
    const words = [...pickN(hot, 2), ...pickN(tech, 2), pick(stack)];
    sentences.push(
      `在${scene}场景下，${words[0]}与${words[1]}是${pick(['关键', '核心', '基础'])}能力，` +
      `结合 ${words[2]} 可以${pick(['显著提升', '有效改善', '大幅降低'])}${pick(TECH)}表现，` +
      `同时需要关注${words[3] || pick(TECH)}与${pick(TECH)}的权衡。`
    );
  }
  // 让部分文档重复包含高频词，制造 TF 差异
  if (rand() < 0.3) sentences.push(`再次强调，${hot[0]}和${hot[1] || hot[0]}是本文重点。`);
  const day = 1 + Math.floor(rand() * 364);
  const date = new Date(2025, 0, day);
  const created = date.toISOString().slice(0, 10) + ' ' +
    String(Math.floor(rand() * 24)).padStart(2, '0') + ':00:00';
  return {
    title: `${title}（第${i + 1}期）`,
    content: sentences.join(''),
    doc_type: pick(TYPES),
    source: pick(SOURCES),
    created_at: created,
  };
}

console.log(`开始生成 ${COUNT} 篇示例文档…`);
const t0 = Date.now();
let inserted = 0;
while (inserted < COUNT) {
  const batch = [];
  for (let i = 0; i < BATCH && inserted + i < COUNT; i++) batch.push(makeDoc(inserted + i));
  indexer.addDocuments(batch);
  inserted += batch.length;
  process.stdout.write(`\r已索引 ${inserted}/${COUNT}`);
}
console.log(`\n完成，耗时 ${Date.now() - t0} ms`);
console.log(indexer.stats());
db.close();
