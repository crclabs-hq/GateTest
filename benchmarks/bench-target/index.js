const express = require('express');
const routes = require('./src/api/routes');
const health = require('./src/api/health');
const cors = require('./src/middleware/cors');
const rateLimit = require('./src/middleware/rateLimit');
const { log } = require('./src/utils/logger');
const { slugify } = require('./src/utils/format');
const { mount } = require('./src/client');

const app = express();
app.use(express.json());
app.use(cors);
app.use(rateLimit);
app.use('/users', routes);
app.use('/health', health);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log('info', `bench-target listening on ${PORT} (${slugify('bench target')})`);
  // Server-rendered shell hydration stub — mounts the client components
  // against a plain object in this benchmark fixture (no real DOM/jsdom).
  mount({ innerHTML: '', textContent: '' });
});

module.exports = app;
