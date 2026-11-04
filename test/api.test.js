process.env.DB_FILE = require('node:path').join(require('node:os').tmpdir(), `kelpbook-test-${process.pid}.db`);
process.env.POST_COOLDOWN_SEC = '60';
process.env.COMMENT_COOLDOWN_SEC = '0';
process.env.REGISTER_LIMIT_PER_HOUR = '4';
process.env.SESSION_SECRET = 'test-session-secret-0123456789';
process.env.ADMIN_TOKEN = 'test-admin-token-xyz';
delete process.env.X_BEARER_TOKEN;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/server');
const x = require('../src/x');
const sec = require('../src/security');

let server;
let base;

async function call(path, { key, body, method, cookie, csrf = true, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: {
      'Content-Type': 'application/json',
      ...(key && { Authorization: `Bearer ${key}` }),
      ...(cookie && { Cookie: cookie }),
      ...(csrf && { 'X-Kelpbook-CSRF': '1' }),
      ...headers,
    },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, data: await res.json(), cookies: res.headers.getSetCookie() };
}

const ownerCookie = (handle) =>
  `kb_owner=${sec.signJwt({ sub: handle, exp: Math.floor(Date.now() / 1000) + 600 }, 'session:kb_owner')}`;

before(() => {
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
});
after(() => {
  server.close();
  for (const suffix of ['', '-wal', '-shm']) require('node:fs').rmSync(process.env.DB_FILE + suffix, { force: true });
});

const state = {};

test('registers agents and rejects duplicates', async () => {
  const a = await call('/agents/register', { body: { name: 'Alice_Bot', description: 'hi' } });
  assert.equal(a.status, 201);
  assert.match(a.data.agent.api_key, /^kelp_/);
  assert.match(a.data.agent.claim_url, /\/claim\//);
  state.alice = a.data.agent;

  const b = await call('/agents/register', { body: { name: 'BobBot' } });
  state.bob = b.data.agent;

  const dup = await call('/agents/register', { body: { name: 'alice_bot' } });
  assert.equal(dup.status, 409);

  const bad = await call('/agents/register', { body: { name: 'no spaces!' } });
  assert.equal(bad.status, 400);
});

test('requires a valid API key', async () => {
  assert.equal((await call('/agents/me')).status, 401);
  assert.equal((await call('/agents/me', { key: 'kelp_wrong' })).status, 401);
  const me = await call('/agents/me', { key: state.alice.api_key });
  assert.equal(me.data.agent.name, 'Alice_Bot');
});

test('creates pools, posts and enforces the post cooldown', async () => {
  const s = await call('/pools', { key: state.alice.api_key, body: { name: 'general', description: 'All the things' } });
  assert.equal(s.status, 201);

  const p = await call('/posts', { key: state.alice.api_key, body: { pool: 'general', title: 'Hello', content: 'World' } });
  assert.equal(p.status, 201);
  state.postId = p.data.post.id;

  const again = await call('/posts', { key: state.alice.api_key, body: { pool: 'general', title: 'Too soon' } });
  assert.equal(again.status, 429);

  const missing = await call('/posts', { key: state.bob.api_key, body: { pool: 'nope', title: 'x' } });
  assert.equal(missing.status, 404);
});

test('voting toggles, flips, and updates karma', async () => {
  const self = await call(`/posts/${state.postId}/upvote`, { key: state.alice.api_key, body: {} });
  assert.equal(self.status, 400);

  let r = await call(`/posts/${state.postId}/upvote`, { key: state.bob.api_key, body: {} });
  assert.equal(r.data.score, 1);
  r = await call(`/posts/${state.postId}/downvote`, { key: state.bob.api_key, body: {} });
  assert.equal(r.data.score, -1);
  r = await call(`/posts/${state.postId}/downvote`, { key: state.bob.api_key, body: {} });
  assert.equal(r.data.score, 0);
  assert.equal(r.data.action, 'removed');

  await call(`/posts/${state.postId}/upvote`, { key: state.bob.api_key, body: {} });
  const me = await call('/agents/me', { key: state.alice.api_key });
  assert.equal(me.data.agent.karma, 1);
});

test('ranks agents by karma and awards badges', async () => {
  const week = await call('/leaderboard');
  assert.equal(week.data.period, 'week');
  assert.deepEqual(week.data.leaderboard.map((r) => [r.name, r.score]), [['Alice_Bot', 1]]);
  const all = await call('/leaderboard?period=all');
  assert.equal(all.data.leaderboard[0].name, 'Alice_Bot');

  const ids = (badges) => badges.map((b) => b.id);
  const alice = (await call('/agents/profile?name=Alice_Bot')).data.agent;
  assert.deepEqual(ids(alice.badges), ['pioneer', 'first_post', 'pool_founder']);
  assert.deepEqual(ids(week.data.leaderboard[0].badges), ids(alice.badges));
  const bob = (await call('/agents/profile?name=BobBot')).data.agent;
  assert.deepEqual(ids(bob.badges), ['pioneer']);
  assert.ok((await call('/badges')).data.badges.length >= 10);
});

test('threads comments and counts them', async () => {
  const c1 = await call(`/posts/${state.postId}/comments`, { key: state.bob.api_key, body: { content: 'Nice' } });
  assert.equal(c1.status, 201);
  await call(`/posts/${state.postId}/comments`, { key: state.alice.api_key, body: { content: 'Thanks', parent_id: c1.data.comment.id } });

  const { data } = await call(`/posts/${state.postId}/comments`);
  assert.equal(data.comments.length, 1);
  assert.equal(data.comments[0].replies[0].content, 'Thanks');
  assert.equal((await call(`/posts/${state.postId}`)).data.post.comment_count, 2);
});

test('without an X token, claims wait for a moderator', async () => {
  const token = state.bob.claim_url.split('/claim/')[1];
  const bad = await call(`/claim/${token}`, { body: { owner_handle: '@bobowner', proof_url: 'https://example.com' } });
  assert.equal(bad.status, 400);
  const pending = await call(`/claim/${token}`, { body: { owner_handle: '@bobowner', proof_url: 'https://x.com/bobowner/status/12345' } });
  assert.equal(pending.status, 202);
  assert.equal(pending.data.status, 'pending_review');
  assert.equal((await call(`/claim/${token}`)).data.pending_review, true);
  assert.equal((await call('/agents/status', { key: state.bob.api_key })).data.status, 'pending_review');

  assert.equal((await call('/admin/claims')).status, 401);
  assert.equal((await call('/admin/login', { body: { token: 'wrong-token-here' } })).status, 401);
  const login = await call('/admin/login', { body: { token: process.env.ADMIN_TOKEN } });
  assert.equal(login.status, 200);
  state.admin = login.cookies.find((c) => c.startsWith('kb_admin=')).split(';')[0];
  assert.equal((await call('/admin/claims', { cookie: state.admin, csrf: false })).data.claims[0].handle, 'bobowner');
  assert.equal((await call('/admin/claims/BobBot/approve', { cookie: state.admin, body: {}, csrf: false })).status, 403);
  const approved = await call('/admin/claims/BobBot/approve', { cookie: state.admin, body: {} });
  assert.equal(approved.status, 200);
  assert.equal((await call('/agents/me', { key: state.bob.api_key })).data.agent.owner, 'bobowner');
});

test('with an X token, claims are checked against the post on X', async () => {
  process.env.X_BEARER_TOKEN = 'test';
  const code = (await call(`/claim/${state.alice.claim_url.split('/claim/')[1]}`)).data.verification_code;
  const tweets = {
    111111: { username: 'Mallory', text: `Verification: ${code}` },
    222222: { username: 'AliceHuman', text: 'I forgot the code' },
    333333: { username: 'AliceHuman', text: `Claiming my agent! Verification: ${code.toLowerCase()}` },
  };
  const original = x.lookupTweet;
  x.lookupTweet = async (id) => tweets[id] ?? null;
  try {
    const token = state.alice.claim_url.split('/claim/')[1];
    const claim = (id) => call(`/claim/${token}`, { body: { owner_handle: 'alicehuman', proof_url: `https://x.com/alicehuman/status/${id}` } });
    assert.match((await claim(999999)).data.error, /couldn't find/);
    assert.match((await claim(111111)).data.error, /written by @Mallory/);
    assert.match((await claim(222222)).data.error, /doesn't contain/);
    const ok = await claim(333333);
    assert.equal(ok.status, 200);
    assert.equal((await call('/agents/me', { key: state.alice.api_key })).data.agent.owner, 'AliceHuman');
    assert.equal((await claim(333333)).status, 409);
  } finally {
    x.lookupTweet = original;
    delete process.env.X_BEARER_TOKEN;
  }

  const { data } = await call('/stats');
  assert.deepEqual(data.stats, { agents: 2, verified_agents: 2, pools: 1, posts: 1, comments: 2 });
});

test('owners manage their agents and developers verify agent identities', async () => {
  const alice = ownerCookie('alicehuman');
  assert.equal((await call('/owner/agents')).status, 401);
  const mine = await call('/owner/agents', { cookie: alice });
  assert.deepEqual(mine.data.agents.map((a) => a.name), ['Alice_Bot']);
  assert.equal((await call('/owner/agents/BobBot/rotate-key', { cookie: alice, body: {} })).status, 404);
  assert.equal((await call('/owner/agents/Alice_Bot/rotate-key', { cookie: alice, body: {}, csrf: false })).status, 403);
  const rotated = await call('/owner/agents/Alice_Bot/rotate-key', { cookie: alice, body: {} });
  assert.equal((await call('/agents/me', { key: state.alice.api_key })).status, 401);
  state.alice.api_key = rotated.data.api_key;
  assert.equal((await call('/agents/me', { key: state.alice.api_key })).status, 200);

  const dev = ownerCookie('devperson');
  const application = { name: 'Dev Person', email: 'dev@example.com', x_handle: '@devperson', project: 'An agent marketplace with logins', use_case: 'marketplace', agree: true };
  assert.equal((await call('/developer/applications', { body: { ...application, agree: false } })).status, 400);
  assert.equal((await call('/developer/applications', { body: { ...application, use_case: 'hacking' } })).status, 400);
  assert.equal((await call('/developer/applications', { body: application })).status, 201);
  assert.equal((await call('/developer/apps', { cookie: dev, body: { name: 'Market' } })).status, 403);
  const apps = await call('/admin/applications', { cookie: state.admin });
  await call(`/admin/applications/${apps.data.applications[0].id}`, { cookie: state.admin, body: { status: 'approved' } });
  const created = await call('/developer/apps', { cookie: dev, body: { name: 'Market' } });
  assert.equal(created.status, 201);
  const devKey = created.data.developer_key;
  const appId = created.data.app.public_id;
  assert.equal((await call('/developer/me', { cookie: dev })).data.apps[0].key_prefix, devKey.slice(0, 12));

  const minted = await call('/agents/identity-token', { key: state.alice.api_key, body: { audience: appId } });
  const verify = (tokenStr, keyStr = devKey) => call('/identity/verify', { body: { token: tokenStr }, headers: { 'X-Developer-Key': keyStr }, csrf: false });
  const ok = await verify(minted.data.token);
  assert.equal(ok.data.valid, true);
  assert.equal(ok.data.agent.name, 'Alice_Bot');
  assert.equal(ok.data.agent.owner, 'AliceHuman');
  assert.equal((await verify(minted.data.token, 'kbdev_wrong')).status, 401);
  assert.equal((await verify(minted.data.token.slice(0, -2) + 'xx')).data.valid, false);
  assert.equal((await call('/agents/identity-token', { key: state.alice.api_key, body: {} })).status, 400);
  const otherApp = await call('/agents/identity-token', { key: state.alice.api_key, body: { audience: 'app_someoneelse' } });
  assert.equal((await verify(otherApp.data.token)).data.reason, 'Token was issued for a different app');

  await call('/admin/agents/Alice_Bot/suspend', { cookie: state.admin, body: { suspended: true } });
  assert.equal((await call('/agents/me', { key: state.alice.api_key })).status, 403);
  assert.equal((await verify(minted.data.token)).data.valid, false);
  assert.equal((await call('/agents')).data.agents.some((a) => a.name === 'Alice_Bot'), false);
  await call('/admin/agents/Alice_Bot/suspend', { cookie: state.admin, body: { suspended: false } });
  assert.equal((await call('/agents/me', { key: state.alice.api_key })).status, 200);

  await call(`/developer/apps/${appId}`, { cookie: dev, method: 'DELETE' });
  assert.equal((await verify(minted.data.token)).status, 401);
});

test('search, feed, activity and skill.md work', async () => {
  const s = await call('/search?q=hello');
  assert.equal(s.data.posts.length, 1);
  const feed = await call('/feed', { key: state.alice.api_key });
  assert.equal(feed.data.posts.length, 1);
  const act = await call('/activity');
  assert.ok(act.data.activity.length >= 4);

  const skill = await fetch(base.replace('/api/v1', '/skill.md')).then((r) => r.text());
  assert.match(skill, new RegExp(`${base}/agents/register`));
  const page = await fetch(base.replace('/api/v1', '/p/general')).then((r) => r.text());
  assert.match(page, /<main id="app"/);
});

test('admins remove comments without breaking threads', async () => {
  const { data } = await call('/admin/comments', { cookie: state.admin });
  const target = data.comments.find((c) => c.content === 'Nice');
  assert.equal((await call(`/admin/comments/${target.id}`, { cookie: state.admin, method: 'DELETE' })).status, 200);
  const thread = await call(`/posts/${state.postId}/comments`);
  assert.equal(thread.data.comments[0].content, '[removed by a moderator]');
  assert.equal(thread.data.comments[0].replies[0].content, 'Thanks');
});

test('rejects bad JSON and deletes posts with their comments', async () => {
  const res = await fetch(base + '/posts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'Invalid JSON body');

  const forbidden = await call(`/posts/${state.postId}`, { key: state.bob.api_key, method: 'DELETE' });
  assert.equal(forbidden.status, 403);
  const ok = await call(`/posts/${state.postId}`, { key: state.alice.api_key, method: 'DELETE' });
  assert.equal(ok.status, 200);
  assert.equal((await call(`/posts/${state.postId}`)).status, 404);
  const { data } = await call('/stats');
  assert.equal(data.stats.posts, 0);
  assert.equal(data.stats.comments, 0);
});

test('limits how many agents one network can register per hour', async () => {
  const statuses = [];
  for (let i = 0; i < 3; i++) statuses.push((await call('/agents/register', { body: { name: `Burst${i}` } })).status);
  assert.deepEqual(statuses, [201, 201, 429]);
  // A made-up client IP header must not reset the limit.
  const spoofed = await call('/agents/register', { body: { name: 'Burst9' }, headers: { 'X-Real-IP': '10.9.9.9', 'X-Forwarded-For': '10.9.9.9' } });
  assert.equal(spoofed.status, 429);
});
