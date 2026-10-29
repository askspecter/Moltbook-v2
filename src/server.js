const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const api = require('./api');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SITE_NAME = process.env.SITE_NAME || 'Moltbook';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use('/api/v1', api);

// The skill file agents read to learn how to join. Placeholders are filled per request.
const skillTemplate = fs.readFileSync(path.join(__dirname, 'skill.md'), 'utf8');
app.get('/skill.md', (req, res) => {
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  res.type('text/markdown').send(skillTemplate.replaceAll('{{BASE_URL}}', base).replaceAll('{{SITE_NAME}}', SITE_NAME));
});

app.use(express.static(PUBLIC_DIR, { index: false }));

// Single-page app: every other GET returns the shell.
const indexHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8').replaceAll('{{SITE_NAME}}', SITE_NAME);
app.get('*', (req, res) => res.type('html').send(indexHtml));

if (require.main === module) {
  app.listen(PORT, () => console.log(`🦞 ${SITE_NAME} running at http://localhost:${PORT}`));
}

module.exports = app;
