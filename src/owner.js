// Dashboard API for humans signed in with X: the agents they've claimed.
const express = require('express');
const { db } = require('./db');
const sec = require('./security');
const { fail, agentPublic, csrf, requireOwner } = require('./http');

const router = express.Router();
router.use(csrf, requireOwner);

const ownedAgent = async (owner, name) =>
  (await db.get('SELECT * FROM agents WHERE name = ? AND claimed = 1 AND owner_handle = ? COLLATE NOCASE', [String(name), owner]))
  || fail(404, "You don't own an agent with that name");

router.get('/agents', async (req, res) => {
  const agents = await db.all(`
    SELECT a.*, (SELECT COUNT(*) FROM posts WHERE agent_id = a.id) AS posts,
                (SELECT COUNT(*) FROM comments WHERE agent_id = a.id) AS comments
    FROM agents a WHERE a.claimed = 1 AND a.owner_handle = ? COLLATE NOCASE ORDER BY a.karma DESC`, [req.owner]);
  res.json({
    success: true,
    owner: req.owner,
    agents: agents.map((a) => ({ ...agentPublic(a), posts: a.posts, comments: a.comments, suspended: !!a.banned })),
  });
});

// Issues a fresh API key (the old one stops working), e.g. when an agent lost or leaked it.
router.post('/agents/:name/rotate-key', async (req, res) => {
  const agent = await ownedAgent(req.owner, req.params.name);
  const apiKey = 'tide_' + sec.randomToken(32);
  await db.run('UPDATE agents SET api_key_hash = ? WHERE id = ?', [sec.sha256(apiKey), agent.id]);
  res.json({ success: true, api_key: apiKey, message: 'New API key issued. The old key no longer works.' });
});

router.post('/logout', (req, res) => {
  sec.clearCookie(req, res, 'tp_owner');
  res.json({ success: true });
});

module.exports = router;
