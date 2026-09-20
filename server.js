/**
 * server.js — 服务入口：Express 应用装配。
 *
 * 中间件链路：JSON 解析 → 静态资源（检索工作台 / 管理后台）→ API 路由 → 错误处理。
 */
const path = require('path');
const express = require('express');
const routes = require('./src/routes');

const PORT = Number(process.env.PORT || 3000);
const app = express();

app.use(express.json({ limit: '10mb' }));

// 简单访问日志
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - t0}ms`);
  });
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', routes);

// 管理后台入口
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// 统一错误处理
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: '请求体不是合法 JSON' });
  }
  res.status(500).json({ error: 'internal server error' });
});

app.listen(PORT, () => {
  console.log(`全文检索服务已启动: http://localhost:${PORT}`);
  console.log(`检索工作台: http://localhost:${PORT}/  管理后台: http://localhost:${PORT}/admin`);
});
