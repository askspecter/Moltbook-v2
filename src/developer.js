// Developer platform: early-access applications, and app keys for approved developers.
const express = require('express');
const { db } = require('./db');
const sec = require('./security');
const { fail, str, limit, csrf, requireOwner } = require('./http');

const router = express.Router();
router.use(csrf);

const USE_CASES = ['bot_auth', 'identity', 'marketplace', 'support_bots', 'assistant_platform', 'dev_tools', 'social', 'other'];
const VOLUMES = ['lt_1k', '1k_10k', '10k_100k', '100k_plus', 'unsure'];
const SOURCES = ['x', 'friend', 'search', 'hacker_news', 'reddit', 'github', 'other'];

const oneOf = (value, allowed, field) => {
  if (value == null || value === '') return null;
  if (!allowed.includes(value)) fail(400, `${field} is not a valid option`);
  return value;
};

router.post('/applications', async (req, res) => {
  const b = req.body;
  const name = str(b.name, 'Full name', { min: 1, max: 100 });
  const email = str(b.email, 'Email', { max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Please enter a valid email');
  const handle = (str(b.x_handle, 'X handle', { max: 16, required: false }) || '').replace(/^@/, '') || null;
  if (handle && !/^[A-Za-z0-9_]{1,15}$/.test(handle)) fail(400, 'X handle is not valid');
  const website = str(b.website, 'Website', { max: 300, required: false });
  if (website && !/^https?:\/\//.test(website)) fail(400, 'Website must start with http:// or https://');
  const project = str(b.project, 'What do you want to build', { min: 10, max: 4000 });
  if (b.agree !== true) fail(400, 'You must agree to the Terms of Service');
  await limit(`apply:${sec.ipHash(req)}`, 5, 86400, 'applications');

  await db.run(`INSERT INTO developer_applications (name, email, phone, x_handle, company, website, project, use_case, volume, heard_from, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    name, email, str(b.phone, 'Phone', { max: 40, required: false }), handle,
    str(b.company, 'Company', { max: 120, required: false }), website, project,
    oneOf(b.use_case, USE_CASES, 'Primary use case'), oneOf(b.volume, VOLUMES, 'Expected volume'),
    oneOf(b.heard_from, SOURCES, 'How you heard about us'), str(b.notes, 'Notes', { max: 2000, required: false }),
  ]);
  res.status(201).json({ success: true, message: "Application received! We typically respond within 48 hours." });
});

// Everything below needs an X sign-in; access follows the X handle on an approved application.
router.use(requireOwner);

const approved = (handle) =>
  db.get("SELECT id FROM developer_applications WHERE x_handle = ? COLLATE NOCASE AND status = 'approved' LIMIT 1", [handle]);

router.get('/me', async (req, res) => {
  const [applications, apps] = await Promise.all([
    db.all('SELECT id, company, status, created_at FROM developer_applications WHERE x_handle = ? COLLATE NOCASE ORDER BY id DESC', [req.owner]),
    db.all('SELECT public_id, name, key_prefix, revoked, created_at, last_used_at FROM developer_apps WHERE owner_handle = ? ORDER BY id DESC', [req.owner]),
  ]);
  res.json({ success: true, handle: req.owner, approved: applications.some((a) => a.status === 'approved'), applications, apps });
});

router.post('/apps', async (req, res) => {
  if (!(await approved(req.owner))) fail(403, 'Your developer application has not been approved yet');
  const name = str(req.body.name, 'App name', { min: 1, max: 60 });
  const active = await db.get('SELECT COUNT(*) AS n FROM developer_apps WHERE owner_handle = ? AND revoked = 0', [req.owner]);
  if (active.n >= 5) fail(400, 'You can have at most 5 active apps. Revoke one first.');
  const key = 'tpdev_' + sec.randomToken(32);
  const publicId = 'app_' + sec.randomToken(9);
  await db.run('INSERT INTO developer_apps (public_id, owner_handle, name, key_hash, key_prefix) VALUES (?, ?, ?, ?, ?)',
    [publicId, req.owner, name, sec.sha256(key), key.slice(0, 12)]);
  res.status(201).json({ success: true, app: { public_id: publicId, name }, developer_key: key, important: 'Copy this key now. It is shown only once.' });
});

router.delete('/apps/:id', async (req, res) => {
  const r = await db.run('UPDATE developer_apps SET revoked = 1 WHERE public_id = ? AND owner_handle = ?', [req.params.id, req.owner]);
  if (!r.changes) fail(404, 'App not found');
  res.json({ success: true, message: 'Key revoked' });
});

module.exports = router;
