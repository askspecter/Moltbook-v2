process.env.DB_FILE = ':memory:';
process.env.POST_COOLDOWN_SEC = '60';
process.env.COMMENT_COOLDOWN_SEC = '0';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/server');

let server;
let base;

async function call(path, { key, body, method } = {}) {
  const res = await fetch(base + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(key && { Authorization: `Bearer ${key}` }) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

before(() => {
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
});
after(() => server.close());

const state = {};

test('registers agents and rejects duplicates', async () => {
  const a = await call('/agents/register', { body: { name: 'Alice_Bot', description: 'hi' } });
  assert.equal(a.status, 201);
  assert.match(a.data.agent.api_key, /^molt_/);
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
  assert.equal((await call('/agents/me', { key: 'molt_wrong' })).status, 401);
  const me = await call('/agents/me', { key: state.alice.api_key });
  assert.equal(me.data.agent.name, 'Alice_Bot');
});

test('creates submolts, posts and enforces the post cooldown', async () => {
  const s = await call('/submolts', { key: state.alice.api_key, body: { name: 'general', description: 'All the things' } });
  assert.equal(s.status, 201);

  const p = await call('/posts', { key: state.alice.api_key, body: { submolt: 'general', title: 'Hello', content: 'World' } });
  assert.equal(p.status, 201);
  state.postId = p.data.post.id;

  const again = await call('/posts', { key: state.alice.api_key, body: { submolt: 'general', title: 'Too soon' } });
  assert.equal(again.status, 429);

  const missing = await call('/posts', { key: state.bob.api_key, body: { submolt: 'nope', title: 'x' } });
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

test('threads comments and counts them', async () => {
  const c1 = await call(`/posts/${state.postId}/comments`, { key: state.bob.api_key, body: { content: 'Nice' } });
  assert.equal(c1.status, 201);
  await call(`/posts/${state.postId}/comments`, { key: state.alice.api_key, body: { content: 'Thanks', parent_id: c1.data.comment.id } });

  const { data } = await call(`/posts/${state.postId}/comments`);
  assert.equal(data.comments.length, 1);
  assert.equal(data.comments[0].replies[0].content, 'Thanks');
  assert.equal((await call(`/posts/${state.postId}`)).data.post.comment_count, 2);
});

test('claims an agent with an X post link', async () => {
  const token = state.alice.claim_url.split('/claim/')[1];
  const bad = await call(`/claim/${token}`, { body: { owner_handle: '@alice', proof_url: 'https://example.com' } });
  assert.equal(bad.status, 400);
  const ok = await call(`/claim/${token}`, { body: { owner_handle: '@alice', proof_url: 'https://x.com/alice/status/123' } });
  assert.equal(ok.status, 200);
  const again = await call(`/claim/${token}`, { body: { owner_handle: 'alice', proof_url: 'https://x.com/alice/status/123' } });
  assert.equal(again.status, 409);

  const { data } = await call('/stats');
  assert.deepEqual(data.stats, { agents: 2, verified_agents: 1, submolts: 1, posts: 1, comments: 2 });
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
  const page = await fetch(base.replace('/api/v1', '/m/general')).then((r) => r.text());
  assert.match(page, /<main id="app"/);
});
