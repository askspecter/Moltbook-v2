// Moderation API. Sign in with ADMIN_TOKEN; the session lives in the tp_admin cookie.
const express = require('express');
const crypto = require('node:crypto');
const { db } = require('./db');
const sec = require('./security');
const { deletePost } = require('./content');
const { fail, str, agentPublic, limit, csrf } = require('./http');

const router = express.Router();
router.use(csrf);

const sameSecret = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

router.post('/login', async (req, res) => {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected || expected.length < 12 || !sec.hasSecret()) fail(503, 'Admin login needs ADMIN_TOKEN (12+ chars) and SESSION_SECRET on the server');
  await limit(`admin-login:${sec.ipHash(req)}`, 10, 900, 'login attempts');
  if (!sameSecret(str(req.body.token, 'token', { max: 500 }), expected)) fail(401, 'Wrong admin token');
  sec.startSession(req, res, 'tp_admin', { sub: 'admin' });
  res.json({ success: true });
});

router.post('/logout', (req, res) => {
  sec.clearCookie(req, res, 'tp_admin');
  res.json({ success: true });
});

router.use((req, res, next) => {
  if (!sec.readSession(req, 'tp_admin')) fail(401, 'Admin login required');
  next();
});

const agentByName = async (name) =>
  (await db.get('SELECT * FROM agents WHERE name = ?', [String(name)])) || fail(404, 'Agent not found');

router.get('/overview', async (req, res) => {
  const counts = await db.get(`SELECT
    (SELECT COUNT(*) FROM agents) AS agents,
    (SELECT COUNT(*) FROM agents WHERE banned = 1) AS suspended,
    (SELECT COUNT(*) FROM agents WHERE claimed = 0 AND claim_pending_handle IS NOT NULL) AS pending_claims,
    (SELECT COUNT(*) FROM developer_applications WHERE status = 'pending') AS pending_applications,
    (SELECT COUNT(*) FROM posts) AS posts,
    (SELECT COUNT(*) FROM comments) AS comments,
    (SELECT COUNT(*) FROM waitlist) AS waitlist`);
  res.json({ success: true, counts });
});

// ---------- claims awaiting manual review ----------

router.get('/claims', async (req, res) => {
  const claims = await db.all(`SELECT name, verification_code, claim_pending_handle AS handle, claim_proof_url AS proof_url, claim_requested_at AS requested_at
    FROM agents WHERE claimed = 0 AND claim_pending_handle IS NOT NULL ORDER BY claim_requested_at`);
  res.json({ success: true, claims });
});

router.post('/claims/:name/approve', async (req, res) => {
  const a = await agentByName(req.params.name);
  if (!a.claim_pending_handle) fail(400, 'No pending claim for this agent');
  await db.run('UPDATE agents SET claimed = 1, owner_handle = claim_pending_handle, claim_pending_handle = NULL WHERE id = ?', [a.id]);
  res.json({ success: true, message: `${a.name} is now owned by @${a.claim_pending_handle}` });
});

router.post('/claims/:name/reject', async (req, res) => {
  const a = await agentByName(req.params.name);
  await db.run('UPDATE agents SET claim_pending_handle = NULL, claim_proof_url = NULL, claim_requested_at = NULL WHERE id = ?', [a.id]);
  res.json({ success: true, message: 'Claim rejected' });
});

// ---------- agents ----------

router.get('/agents', async (req, res) => {
  const q = `%${String(req.query.q || '').replace(/[%_\\]/g, (m) => '\\' + m)}%`;
  const agents = await db.all(`SELECT * FROM agents WHERE name LIKE ? ESCAPE '\\' OR owner_handle LIKE ? ESCAPE '\\'
    ORDER BY banned DESC, created_at DESC LIMIT 100`, [q, q]);
  res.json({ success: true, agents: agents.map((a) => ({ ...agentPublic(a), suspended: !!a.banned })) });
});

router.post('/agents/:name/suspend', async (req, res) => {
  const a = await agentByName(req.params.name);
  const suspended = req.body.suspended !== false;
  await db.run('UPDATE agents SET banned = ? WHERE id = ?', [suspended ? 1 : 0, a.id]);
  res.json({ success: true, message: `${a.name} ${suspended ? 'suspended' : 'restored'}` });
});

// ---------- content ----------

router.get('/posts', async (req, res) => {
  const posts = await db.all(`SELECT p.id, p.title, p.content, p.score, p.comment_count, p.created_at, a.name AS author, s.name AS pool
    FROM posts p JOIN agents a ON a.id = p.agent_id JOIN pools s ON s.id = p.pool_id ORDER BY p.id DESC LIMIT 100`);
  res.json({ success: true, posts });
});

router.delete('/posts/:id', async (req, res) => {
  const post = await db.get('SELECT id FROM posts WHERE id = ?', [Number(req.params.id) || 0]);
  if (!post) fail(404, 'Post not found');
  await deletePost(post.id);
  res.json({ success: true, message: 'Post deleted' });
});

router.get('/comments', async (req, res) => {
  const comments = await db.all(`SELECT c.id, c.post_id, c.content, c.created_at, a.name AS author
    FROM comments c JOIN agents a ON a.id = c.agent_id ORDER BY c.id DESC LIMIT 100`);
  res.json({ success: true, comments });
});

// Comments are blanked rather than deleted so reply threads stay intact.
router.delete('/comments/:id', async (req, res) => {
  const r = await db.run("UPDATE comments SET content = '[removed by a moderator]' WHERE id = ?", [Number(req.params.id) || 0]);
  if (!r.changes) fail(404, 'Comment not found');
  res.json({ success: true, message: 'Comment removed' });
});

// ---------- developers & waitlist ----------

router.get('/applications', async (req, res) => {
  const applications = await db.all('SELECT * FROM developer_applications ORDER BY status = \'pending\' DESC, id DESC LIMIT 200');
  res.json({ success: true, applications });
});

router.post('/applications/:id', async (req, res) => {
  const status = req.body.status;
  if (!['approved', 'rejected', 'pending'].includes(status)) fail(400, 'status must be approved, rejected or pending');
  const r = await db.run('UPDATE developer_applications SET status = ? WHERE id = ?', [status, Number(req.params.id) || 0]);
  if (!r.changes) fail(404, 'Application not found');
  res.json({ success: true, message: `Application ${status}` });
});

router.get('/waitlist', async (req, res) => {
  res.json({ success: true, waitlist: await db.all('SELECT email, created_at FROM waitlist ORDER BY created_at DESC LIMIT 500') });
});

module.exports = router;
