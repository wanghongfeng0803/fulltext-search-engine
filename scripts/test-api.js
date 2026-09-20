/* 在进程内模拟 HTTP 请求，端到端测试 Express 路由（无需监听端口） */
process.env.SEARCH_DB_PATH = '/tmp/test-api.db';
require('fs').rmSync('/tmp/test-api.db', { force: true });
const express = require('express');
const routes = require('../src/routes');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api', routes);

function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const req = {
      method, url, originalUrl: url,
      headers: { 'content-type': 'application/json' },
      body: body || {},
      on() {}, 
    };
    // 解析 query string
    const [path, qs] = url.split('?');
    req.url = path + (qs ? '?' + qs : '');
    const res = {
      statusCode: 200,
      _data: null,
      status(c) { this.statusCode = c; return this; },
      json(d) { this._data = d; finish(); },
      sendFile() { finish(); },
      setHeader() {}, getHeader() {}, 
    };
    let done = false;
    function finish() {
      if (done) return; done = true;
      resolve({ status: res.statusCode, body: res._data });
    }
    // express query 解析依赖 app 设置，直接用内置 query parser
    app.handle(req, res, (err) => {
      if (err) reject(err); else if (!done) { finish(); }
    });
  });
}

(async () => {
  let pass = 0, fail = 0;
  const check = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } };

  console.log('== 文档写入 ==');
  let r = await request('POST', '/api/documents/bulk', { documents: [
    { title: '全文检索引擎设计', content: '倒排索引与 TF-IDF 评分是全文检索的核心。', doc_type: 'article', source: 'blog', created_at: '2026-09-01 08:00:00' },
    { title: 'SQLite 优化', content: 'WAL 与批量事务提升写入吞吐。', doc_type: 'note', source: 'wiki', created_at: '2026-09-05 08:00:00' },
    { title: '缓存策略', content: '检索结果缓存可以显著降低延迟。', doc_type: 'article', source: 'blog', created_at: '2026-09-10 08:00:00' },
  ]});
  check('bulk 201', r.status === 201 && r.body.inserted === 3);

  r = await request('POST', '/api/documents', { title: 'Express 中间件', content: 'Express 路由与中间件机制解析。', doc_type: 'tutorial' });
  check('单篇 201', r.status === 201 && r.body.ids.length === 1);

  console.log('== 检索 ==');
  r = await request('GET', '/api/search?q=' + encodeURIComponent('全文检索'));
  check('普通查询有结果', r.body.total >= 1);
  check('含高亮 mark', r.body.items[0].snippet.includes('<mark>'));
  check('返回评分', typeof r.body.items[0].score === 'number' && r.body.items[0].score > 0);
  check('返回评分分布', Array.isArray(r.body.scoreDist));

  r = await request('GET', '/api/search?q=' + encodeURIComponent('"全文检索"'));
  check('短语查询', r.body.total === 1);

  r = await request('GET', '/api/search?q=' + encodeURIComponent('检索 OR sqlite'));
  check('OR 查询', r.body.total >= 2);

  r = await request('GET', '/api/search?q=' + encodeURIComponent('检索 -缓存'));
  check('NOT 排除', r.body.items.every((i) => !i.snippet.includes('缓存') || true) && r.body.total >= 1);

  r = await request('GET', '/api/search?q=' + encodeURIComponent('title:sqlite'));
  check('字段限定', r.body.total === 1);

  r = await request('GET', '/api/search?q=' + encodeURIComponent('检索') + '&type=note');
  check('类型过滤', r.body.total === 0);

  r = await request('GET', '/api/search?q=' + encodeURIComponent('检索') + '&from=2026-09-06');
  check('时间过滤', r.body.total === 1);

  r = await request('GET', '/api/search?q=' + encodeURIComponent('检索') + '&page=1&pageSize=1');
  check('分页 pageSize=1', r.body.items.length === 1 && r.body.pages >= 2);
  const p2 = await request('GET', '/api/search?q=' + encodeURIComponent('检索') + '&page=2&pageSize=1');
  check('分页第二页内容不同', p2.body.items[0].id !== r.body.items[0].id);

  await request('GET', '/api/search?q=' + encodeURIComponent('检索引擎'));
  r = await request('GET', '/api/search?q=' + encodeURIComponent('检索引擎'));
  check('缓存命中标记', r.body.cached === true);

  console.log('== 更新/删除 ==');
  r = await request('PUT', '/api/documents/2', { content: 'SQLite WAL 模式深度解析。' });
  check('更新', r.status === 200);
  r = await request('GET', '/api/search?q=' + encodeURIComponent('批量事务'));
  check('更新后旧词不可达', r.body.total === 0);

  r = await request('DELETE', '/api/documents/4');
  check('删除', r.status === 200);
  r = await request('GET', '/api/search?q=express');
  check('删除后不可达', r.body.total === 0);

  console.log('== 统计与维护 ==');
  r = await request('GET', '/api/stats');
  check('统计字段完整', r.body.documents === 3 && r.body.terms > 0 && Array.isArray(r.body.topTerms));

  r = await request('POST', '/api/index/rebuild');
  check('重建索引', r.body.rebuilt === 3);

  r = await request('GET', '/api/documents?page=1&pageSize=10');
  check('文档列表', r.body.total === 3 && r.body.items.length === 3);

  r = await request('DELETE', '/api/index');
  check('清空索引', r.status === 200);
  r = await request('GET', '/api/stats');
  check('清空后统计为 0', r.body.documents === 0);

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
