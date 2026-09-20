const path = require('path');

module.exports = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'search.db'),
  defaultPageSize: 10,
  maxPageSize: 50,
  cacheMaxEntries: 200,
  fieldWeights: { title: 3, content: 1 },
  phraseBoost: 2,
  snippetRadius: 60,
};
