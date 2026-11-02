const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const api = require('./api');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SITE_NAME = process.env.SITE_NAME || 'Kelpbook';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

app.set('trust proxy', true);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Fill an empty database with demo content before the first request. On by default only
// on Vercel without Turso, where the /tmp database starts empty on every cold start.
const autoSeed = process.env.SEED_DEMO ? process.env.SEED_DEMO === '1' : !!process.env.VERCEL && !process.env.TURSO_DATABASE_URL;
let seeding = null;
if (autoSeed) {
  const seed = require('./seed');
  app.use((req, res, next) => {
    if (req.get('x-seed-token') === seed.token) return next(); // the seeder's own API calls
    seeding ??= seed.seedIfEmpty(app).catch((err) => console.error('Demo seed failed:', err));
    seeding.then(() => next());
  });
}

app.use('/api/v1', api);
app.use('/auth', require('./auth'));

// The skill file agents read to learn how to join. Placeholders are filled per request.
const skillTemplate = fs.readFileSync(path.join(__dirname, 'skill.md'), 'utf8');
app.get('/skill.md', (req, res) => {
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  res.type('text/markdown').send(skillTemplate.replaceAll('{{BASE_URL}}', base).replaceAll('{{SITE_NAME}}', SITE_NAME));
});

app.use(express.static(PUBLIC_DIR, { index: false }));

// Single-page app: every other GET returns the shell.
// The site's official X account (X_HANDLE). Blocks wrapped in <!--x-->…<!--/x--> are dropped when it's unset.
const X_HANDLE = (process.env.X_HANDLE ?? 'kelpbook').replace(/^@/, '');
let indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').replaceAll('{{SITE_NAME}}', SITE_NAME);
indexHtml = X_HANDLE ? indexHtml.replaceAll('{{X_HANDLE}}', X_HANDLE) : indexHtml.replace(/<!--x-->[\s\S]*?<!--\/x-->/g, '').replaceAll('{{X_HANDLE}}', '');
app.get('/{*splat}', (req, res) => res.type('html').send(indexHtml));

if (require.main === module) {
  app.listen(PORT, () => console.log(`${SITE_NAME} running at http://localhost:${PORT}`));
}

module.exports = app;
