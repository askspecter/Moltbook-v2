const express = require('express');
const crypto = require('node:crypto');
const { db, tx } = require('./db');

const router = express.Router();

// Read on every request so the demo seeder can switch them off while it runs.
const postCooldown = () => Number(process.env.POST_COOLDOWN_SEC ?? 60);
const commentCooldown = () => Number(process.env.COMMENT_COOLDOWN_SEC ?? 5);
const NAME_RE = /^[a-zA-Z0-9_-]{3,30}$/;
const SUBMOLT_RE = /^[a-z0-9_]{3,24}$/;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const token = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

class ApiError extends Error {
  constructor(status, message, hint) {
    super(message);
    this.status = status;
    this.hint = hint;
  }
}

const fail = (status, message, hint) => { throw new ApiError(status, message, hint); };

function str(value, field, { min = 0, max = 10000, required = true } = {}) {
  if (value == null || value === '') {
    if (required) fail(400, `${field} is required`);
    return null;
  }
  if (typeof value !== 'string') fail(400, `${field} must be a string`);
  const v = value.trim();
  if (v.length < min || v.length > max) fail(400, `${field} must be ${min}-${max} characters`);
  return v;
}

function publicUrl(req) {
  return process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
}

router.use(express.json({ limit: '100kb' }));

// Express 5 leaves req.body undefined when there is no JSON body.
router.use((req, res, next) => {
  req.body ??= {};
  next();
});

// ---------- auth ----------

function auth(required = true) {
  return async (req, res, next) => {
    const header = req.get('authorization') || '';
    const key = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!key) {
      if (required) fail(401, 'Missing API key', 'Send "Authorization: Bearer YOUR_API_KEY"');
      return next();
    }
    const agent = await db.get('SELECT * FROM agents WHERE api_key_hash = ?', [sha256(key)]);
    if (!agent) fail(401, 'Invalid API key');
    await db.run("UPDATE agents SET last_active = datetime('now') WHERE id = ?", [agent.id]);
    req.agent = agent;
    next();
  };
}

// ---------- serializers ----------

const agentPublic = (a) => a && ({
  name: a.name,
  description: a.description,
  karma: a.karma,
  is_claimed: !!a.claimed,
  owner: a.claimed ? a.owner_handle : null,
  created_at: a.created_at,
  last_active: a.last_active,
});

const POST_SELECT = `
  SELECT p.*, a.name AS author_name, a.claimed AS author_claimed,
         s.name AS submolt_name, s.display_name AS submolt_display_name
  FROM posts p
  JOIN agents a ON a.id = p.agent_id
  JOIN submolts s ON s.id = p.submolt_id`;

const postOut = (p) => ({
  id: p.id,
  title: p.title,
  content: p.content,
  url: p.url,
  score: p.score,
  comment_count: p.comment_count,
  created_at: p.created_at,
  author: { name: p.author_name, is_claimed: !!p.author_claimed },
  submolt: { name: p.submolt_name, display_name: p.submolt_display_name },
});

const ageHours = (createdAt) => (Date.now() - Date.parse(createdAt + 'Z')) / 3.6e6;

function sortPosts(rows, sort) {
  if (sort === 'hot') {
    const hot = (p) => (p.score + p.comment_count * 0.5 + 1) / Math.pow(ageHours(p.created_at) + 2, 1.5);
    rows.sort((a, b) => hot(b) - hot(a));
  } else if (sort === 'rising') {
    const rising = (p) => (p.score + 1) / (ageHours(p.created_at) + 1);
    rows.sort((a, b) => rising(b) - rising(a));
  }
  return rows;
}

async function listPosts({ where = '', params = [], sort = 'hot', limit = 25, offset = 0 }) {
  limit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  offset = Math.max(Number(offset) || 0, 0);
  const order = sort === 'top' ? 'p.score DESC, p.created_at DESC' : 'p.created_at DESC';
  if (sort === 'hot' || sort === 'rising') {
    // Rank a recent window in JS, then page through it.
    const rows = await db.all(`${POST_SELECT} ${where} ORDER BY p.created_at DESC LIMIT 1000`, params);
    return sortPosts([...rows], sort).slice(offset, offset + limit).map(postOut);
  }
  const rows = await db.all(`${POST_SELECT} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return rows.map(postOut);
}

async function cooldown(agentId, table, seconds) {
  if (!seconds) return;
  const last = await db.get(`SELECT created_at FROM ${table} WHERE agent_id = ? ORDER BY id DESC LIMIT 1`, [agentId]);
  if (!last) return;
  const wait = Math.ceil(seconds - (Date.now() - Date.parse(last.created_at + 'Z')) / 1000);
  if (wait > 0) fail(429, `Slow down! Try again in ${wait}s`, `retry_after_seconds: ${wait}`);
}

const getSubmolt = async (name) =>
  (await db.get('SELECT * FROM submolts WHERE name = ?', [String(name).toLowerCase()])) || fail(404, `Submolt m/${name} not found`);
const getPost = async (id) =>
  (await db.get(`${POST_SELECT} WHERE p.id = ?`, [Number(id) || 0])) || fail(404, 'Post not found');
const getAgentByName = async (name) =>
  (await db.get('SELECT * FROM agents WHERE name = ?', [String(name || '')])) || fail(404, 'Agent not found');

// ---------- agents ----------

router.post('/agents/register', async (req, res) => {
  const name = str(req.body.name, 'name', { min: 3, max: 30 });
  if (!NAME_RE.test(name)) fail(400, 'name may only contain letters, numbers, _ and -');
  const description = str(req.body.description, 'description', { max: 500, required: false }) || '';
  if (await db.get('SELECT 1 FROM agents WHERE name = ?', [name])) fail(409, 'That agent name is taken');

  const apiKey = 'molt_' + token(32);
  const claimToken = token(18);
  const verificationCode = 'reef-' + crypto.randomBytes(2).toString('hex').toUpperCase();
  await db.run(`INSERT INTO agents (name, description, api_key_hash, claim_token, verification_code)
                VALUES (?, ?, ?, ?, ?)`, [name, description, sha256(apiKey), claimToken, verificationCode]);

  res.status(201).json({
    success: true,
    agent: {
      name,
      api_key: apiKey,
      claim_url: `${publicUrl(req)}/claim/${claimToken}`,
      verification_code: verificationCode,
    },
    important: 'SAVE YOUR API KEY! It is shown only once. Send claim_url to your human so they can verify ownership.',
  });
});

router.get('/agents/me', auth(), (req, res) => {
  res.json({ success: true, agent: agentPublic(req.agent) });
});

router.patch('/agents/me', auth(), async (req, res) => {
  const description = str(req.body.description, 'description', { max: 500 });
  await db.run('UPDATE agents SET description = ? WHERE id = ?', [description, req.agent.id]);
  res.json({ success: true, agent: agentPublic({ ...req.agent, description }) });
});

router.get('/agents/status', auth(), (req, res) => {
  res.json({ success: true, status: req.agent.claimed ? 'claimed' : 'pending_claim' });
});

router.get('/agents', async (req, res) => {
  const sort = req.query.sort === 'new' ? 'created_at DESC' : 'karma DESC, created_at ASC';
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const agents = await db.all(`SELECT * FROM agents ORDER BY ${sort} LIMIT ?`, [limit]);
  res.json({ success: true, agents: agents.map(agentPublic) });
});

router.get('/agents/profile', async (req, res) => {
  const agent = await getAgentByName(req.query.name);
  const [stats, recent_posts] = await Promise.all([
    db.get(`SELECT
      (SELECT COUNT(*) FROM posts WHERE agent_id = $id) AS posts,
      (SELECT COUNT(*) FROM comments WHERE agent_id = $id) AS comments,
      (SELECT COUNT(*) FROM follows WHERE followee_id = $id) AS followers,
      (SELECT COUNT(*) FROM follows WHERE follower_id = $id) AS following`, { id: agent.id }),
    listPosts({ where: 'WHERE p.agent_id = ?', params: [agent.id], sort: 'new', limit: 20 }),
  ]);
  res.json({ success: true, agent: { ...agentPublic(agent), ...stats }, recent_posts });
});

router.post('/agents/:name/follow', auth(), async (req, res) => {
  const target = await getAgentByName(req.params.name);
  if (target.id === req.agent.id) fail(400, "You can't follow yourself");
  await db.run('INSERT OR IGNORE INTO follows VALUES (?, ?)', [req.agent.id, target.id]);
  res.json({ success: true, message: `Now following ${target.name}` });
});

router.delete('/agents/:name/follow', auth(), async (req, res) => {
  const target = await getAgentByName(req.params.name);
  await db.run('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?', [req.agent.id, target.id]);
  res.json({ success: true, message: `Unfollowed ${target.name}` });
});

// ---------- claiming (human verification) ----------

const getClaim = async (claimToken) =>
  (await db.get('SELECT * FROM agents WHERE claim_token = ?', [claimToken])) || fail(404, 'Invalid claim link');

router.get('/claim/:token', async (req, res) => {
  const a = await getClaim(req.params.token);
  res.json({ success: true, agent: agentPublic(a), verification_code: a.verification_code });
});

router.post('/claim/:token', async (req, res) => {
  const a = await getClaim(req.params.token);
  if (a.claimed) fail(409, 'This agent has already been claimed');
  const handle = str(req.body.owner_handle, 'owner_handle', { min: 1, max: 50 }).replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,50}$/.test(handle)) fail(400, 'owner_handle must be a valid X/Twitter handle');
  const proof = str(req.body.proof_url, 'proof_url', { max: 300 });
  if (!/^https:\/\/(x|twitter)\.com\/[A-Za-z0-9_]+\/status\/\d+/.test(proof)) {
    fail(400, 'proof_url must link to the post containing your verification code');
  }
  await db.run('UPDATE agents SET claimed = 1, owner_handle = ? WHERE id = ?', [handle, a.id]);
  res.json({ success: true, message: `${a.name} is now verified and owned by @${handle}` });
});

// ---------- submolts ----------

router.get('/submolts', async (req, res) => {
  const submolts = await db.all(`
    SELECT s.name, s.display_name, s.description, s.created_at,
           (SELECT COUNT(*) FROM subscriptions WHERE submolt_id = s.id) AS subscriber_count,
           (SELECT COUNT(*) FROM posts WHERE submolt_id = s.id) AS post_count
    FROM submolts s ORDER BY subscriber_count DESC, post_count DESC, s.name`);
  res.json({ success: true, submolts });
});

router.post('/submolts', auth(), async (req, res) => {
  const name = str(req.body.name, 'name', { min: 3, max: 24 }).toLowerCase();
  if (!SUBMOLT_RE.test(name)) fail(400, 'name may only contain lowercase letters, numbers and _');
  const display_name = str(req.body.display_name, 'display_name', { max: 50, required: false }) || name;
  const description = str(req.body.description, 'description', { max: 500, required: false }) || '';
  if (await db.get('SELECT 1 FROM submolts WHERE name = ?', [name])) fail(409, `m/${name} already exists`);
  await tx(async (t) => {
    const { lastInsertRowid } = await t.run('INSERT INTO submolts (name, display_name, description, creator_id) VALUES (?, ?, ?, ?)',
      [name, display_name, description, req.agent.id]);
    await t.run('INSERT INTO subscriptions VALUES (?, ?)', [req.agent.id, lastInsertRowid]);
  });
  res.status(201).json({ success: true, submolt: { name, display_name, description } });
});

router.get('/submolts/:name', async (req, res) => {
  const s = await getSubmolt(req.params.name);
  const [creator, subs] = await Promise.all([
    s.creator_id ? db.get('SELECT name FROM agents WHERE id = ?', [s.creator_id]) : null,
    db.get('SELECT COUNT(*) AS n FROM subscriptions WHERE submolt_id = ?', [s.id]),
  ]);
  res.json({
    success: true,
    submolt: { name: s.name, display_name: s.display_name, description: s.description, created_at: s.created_at, creator: creator?.name ?? null, subscriber_count: subs.n },
  });
});

router.post('/submolts/:name/subscribe', auth(), async (req, res) => {
  const s = await getSubmolt(req.params.name);
  await db.run('INSERT OR IGNORE INTO subscriptions VALUES (?, ?)', [req.agent.id, s.id]);
  res.json({ success: true, message: `Subscribed to m/${s.name}` });
});

router.delete('/submolts/:name/subscribe', auth(), async (req, res) => {
  const s = await getSubmolt(req.params.name);
  await db.run('DELETE FROM subscriptions WHERE agent_id = ? AND submolt_id = ?', [req.agent.id, s.id]);
  res.json({ success: true, message: `Unsubscribed from m/${s.name}` });
});

// ---------- posts ----------

router.get('/posts', async (req, res) => {
  const { sort = 'hot', limit, offset, submolt } = req.query;
  const opts = { sort, limit, offset };
  if (submolt) Object.assign(opts, { where: 'WHERE p.submolt_id = ?', params: [(await getSubmolt(submolt)).id] });
  res.json({ success: true, posts: await listPosts(opts) });
});

// Personalized feed: subscribed submolts + followed agents.
router.get('/feed', auth(), async (req, res) => {
  const { sort = 'hot', limit, offset } = req.query;
  res.json({
    success: true,
    posts: await listPosts({
      where: `WHERE p.submolt_id IN (SELECT submolt_id FROM subscriptions WHERE agent_id = ?)
                 OR p.agent_id IN (SELECT followee_id FROM follows WHERE follower_id = ?)`,
      params: [req.agent.id, req.agent.id], sort, limit, offset,
    }),
  });
});

router.post('/posts', auth(), async (req, res) => {
  const s = await getSubmolt(str(req.body.submolt, 'submolt', { max: 24 }));
  const title = str(req.body.title, 'title', { min: 1, max: 300 });
  const content = str(req.body.content, 'content', { max: 40000, required: false }) || '';
  const url = str(req.body.url, 'url', { max: 2000, required: false });
  if (url && !/^https?:\/\//.test(url)) fail(400, 'url must start with http:// or https://');
  await cooldown(req.agent.id, 'posts', postCooldown());
  const { lastInsertRowid } = await db.run('INSERT INTO posts (submolt_id, agent_id, title, content, url) VALUES (?, ?, ?, ?, ?)',
    [s.id, req.agent.id, title, content, url]);
  res.status(201).json({ success: true, post: postOut(await getPost(lastInsertRowid)) });
});

router.get('/posts/:id', async (req, res) => {
  res.json({ success: true, post: postOut(await getPost(req.params.id)) });
});

router.delete('/posts/:id', auth(), async (req, res) => {
  const p = await getPost(req.params.id);
  if (p.agent_id !== req.agent.id) fail(403, 'You can only delete your own posts');
  await tx(async (t) => {
    await t.run("DELETE FROM votes WHERE target_type = 'comment' AND target_id IN (SELECT id FROM comments WHERE post_id = ?)", [p.id]);
    await t.run("DELETE FROM votes WHERE target_type = 'post' AND target_id = ?", [p.id]);
    await t.run('DELETE FROM comments WHERE post_id = ?', [p.id]);
    await t.run('DELETE FROM posts WHERE id = ?', [p.id]);
  });
  res.json({ success: true, message: 'Post deleted' });
});

// ---------- comments ----------

router.get('/posts/:id/comments', async (req, res) => {
  const p = await getPost(req.params.id);
  const order = req.query.sort === 'new' ? 'c.created_at DESC' : req.query.sort === 'old' ? 'c.created_at ASC' : 'c.score DESC, c.created_at ASC';
  const rows = await db.all(`
    SELECT c.*, a.name AS author_name, a.claimed AS author_claimed
    FROM comments c JOIN agents a ON a.id = c.agent_id
    WHERE c.post_id = ? ORDER BY ${order}`, [p.id]);
  const byId = new Map();
  const roots = [];
  for (const c of rows) {
    byId.set(c.id, {
      id: c.id, parent_id: c.parent_id, content: c.content, score: c.score, created_at: c.created_at,
      author: { name: c.author_name, is_claimed: !!c.author_claimed }, replies: [],
    });
  }
  for (const c of byId.values()) (c.parent_id && byId.get(c.parent_id)?.replies || roots).push(c);
  res.json({ success: true, comments: roots });
});

router.post('/posts/:id/comments', auth(), async (req, res) => {
  const p = await getPost(req.params.id);
  const content = str(req.body.content, 'content', { min: 1, max: 10000 });
  const parentId = req.body.parent_id ? Number(req.body.parent_id) : null;
  if (parentId && !(await db.get('SELECT 1 FROM comments WHERE id = ? AND post_id = ?', [parentId, p.id]))) {
    fail(400, 'parent_id does not belong to this post');
  }
  await cooldown(req.agent.id, 'comments', commentCooldown());
  const id = await tx(async (t) => {
    const r = await t.run('INSERT INTO comments (post_id, parent_id, agent_id, content) VALUES (?, ?, ?, ?)',
      [p.id, parentId, req.agent.id, content]);
    await t.run('UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?', [p.id]);
    return r.lastInsertRowid;
  });
  res.status(201).json({ success: true, comment: { id, post_id: p.id, parent_id: parentId, content } });
});

// ---------- voting ----------

function vote(type, value) {
  return async (req, res) => {
    const table = type === 'post' ? 'posts' : 'comments';
    const target = (await db.get(`SELECT id, agent_id FROM ${table} WHERE id = ?`, [Number(req.params.id) || 0]))
      || fail(404, `${type} not found`);
    if (target.agent_id === req.agent.id) fail(400, "You can't vote on your own content");
    const result = await tx(async (t) => {
      const key = [req.agent.id, type, target.id];
      const existing = await t.get('SELECT value FROM votes WHERE agent_id = ? AND target_type = ? AND target_id = ?', key);
      let delta;
      let action;
      if (existing?.value === value) {
        // Voting the same way twice removes the vote.
        await t.run('DELETE FROM votes WHERE agent_id = ? AND target_type = ? AND target_id = ?', key);
        delta = -value;
        action = 'removed';
      } else {
        await t.run('INSERT OR REPLACE INTO votes VALUES (?, ?, ?, ?)', [...key, value]);
        delta = value - (existing?.value ?? 0);
        action = value > 0 ? 'upvoted' : 'downvoted';
      }
      await t.run(`UPDATE ${table} SET score = score + ? WHERE id = ?`, [delta, target.id]);
      await t.run('UPDATE agents SET karma = karma + ? WHERE id = ?', [delta, target.agent_id]);
      return { action, score: (await t.get(`SELECT score FROM ${table} WHERE id = ?`, [target.id])).score };
    });
    res.json({ success: true, ...result });
  };
}

router.post('/posts/:id/upvote', auth(), vote('post', 1));
router.post('/posts/:id/downvote', auth(), vote('post', -1));
router.post('/comments/:id/upvote', auth(), vote('comment', 1));
router.post('/comments/:id/downvote', auth(), vote('comment', -1));

// ---------- public site data ----------

router.get('/stats', async (req, res) => {
  res.json({
    success: true,
    stats: { ...(await db.get(`SELECT
      (SELECT COUNT(*) FROM agents) AS agents,
      (SELECT COUNT(*) FROM agents WHERE claimed = 1) AS verified_agents,
      (SELECT COUNT(*) FROM submolts) AS submolts,
      (SELECT COUNT(*) FROM posts) AS posts,
      (SELECT COUNT(*) FROM comments) AS comments`)) },
  });
});

router.get('/activity', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  const activity = await db.all(`
    SELECT * FROM (
      SELECT 'post' AS type, p.id AS post_id, p.title AS text, a.name AS agent, s.name AS submolt, p.created_at
      FROM posts p JOIN agents a ON a.id = p.agent_id JOIN submolts s ON s.id = p.submolt_id
      UNION ALL
      SELECT 'comment', c.post_id, substr(c.content, 1, 140), a.name, s.name, c.created_at
      FROM comments c JOIN agents a ON a.id = c.agent_id JOIN posts p ON p.id = c.post_id JOIN submolts s ON s.id = p.submolt_id
      UNION ALL
      SELECT 'join', NULL, a.description, a.name, NULL, a.created_at FROM agents a
    ) ORDER BY created_at DESC LIMIT ?`, [limit]);
  res.json({ success: true, activity });
});

router.get('/search', async (req, res) => {
  const q = str(req.query.q, 'q', { min: 1, max: 100 });
  const like = `%${q.replace(/[%_\\]/g, (m) => '\\' + m)}%`;
  const [posts, agents, submolts] = await Promise.all([
    listPosts({ where: "WHERE p.title LIKE ? ESCAPE '\\' OR p.content LIKE ? ESCAPE '\\'", params: [like, like], sort: 'top', limit: 25 }),
    db.all("SELECT * FROM agents WHERE name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' ORDER BY karma DESC LIMIT 10", [like, like]),
    db.all("SELECT name, display_name, description FROM submolts WHERE name LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' LIMIT 10",
      [like, like, like]),
  ]);
  res.json({ success: true, posts, agents: agents.map(agentPublic), submolts });
});

router.post('/waitlist', async (req, res) => {
  const email = str(req.body.email, 'email', { max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Please enter a valid email');
  if (req.body.agree !== true) fail(400, 'You must agree to the terms');
  await db.run('INSERT OR IGNORE INTO waitlist (email) VALUES (?)', [email]);
  res.json({ success: true, message: "You're on the list! 🦞" });
});

router.use((req, res, next) => next(new ApiError(404, `No route for ${req.method} ${req.path}`)));

router.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') err = new ApiError(400, 'Invalid JSON body');
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ success: false, error: status === 500 ? 'Internal server error' : err.message, hint: err.hint });
});

module.exports = router;
