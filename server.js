'use strict';

const path = require('path');
const express = require('express');
const config = require('./src/config');
const routes = require('./src/routes');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', routes);

app.get('/', (req, res) => res.redirect('/index.html'));

// 统一错误处理
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON 解析失败' });
  }
  console.error(err);
  res.status(500).json({ error: '服务器内部错误' });
});

if (require.main === module) {
  app.listen(config.port, config.host, () => {
    console.log(`全文检索服务已启动: http://${config.host}:${config.port}`);
    console.log(`检索工作台: http://${config.host}:${config.port}/index.html`);
    console.log(`索引管理台: http://${config.host}:${config.port}/admin.html`);
  });
}

module.exports = app;
