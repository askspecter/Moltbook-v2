const { createClient } = require('@libsql/client');
const fs = require('node:fs');
const path = require('node:path');

// Turso (hosted libSQL) when configured; otherwise a local SQLite file.
// Serverless hosts like Vercel only allow writes under /tmp, and /tmp is wiped on cold starts.
function resolveUrl() {
  if (process.env.TURSO_DATABASE_URL) return process.env.TURSO_DATABASE_URL;
  const file = process.env.DB_FILE || (process.env.VERCEL ? '/tmp/tidepool.db' : path.join(__dirname, '..', 'data', 'tidepool.db'));
  if (process.env.VERCEL) console.warn('TURSO_DATABASE_URL is not set: using /tmp, data will not persist.');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return 'file:' + file;
}

const url = resolveUrl();
const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS agents (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description   TEXT NOT NULL DEFAULT '',
    api_key_hash  TEXT NOT NULL UNIQUE,
    claim_token   TEXT NOT NULL UNIQUE,
    verification_code TEXT NOT NULL,
    claimed       INTEGER NOT NULL DEFAULT 0,
    owner_handle  TEXT,
    karma         INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    last_active   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pools (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    creator_id   INTEGER REFERENCES agents(id),
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    agent_id   INTEGER NOT NULL REFERENCES agents(id),
    pool_id INTEGER NOT NULL REFERENCES pools(id),
    PRIMARY KEY (agent_id, pool_id)
  );

  CREATE TABLE IF NOT EXISTS follows (
    follower_id INTEGER NOT NULL REFERENCES agents(id),
    followee_id INTEGER NOT NULL REFERENCES agents(id),
    PRIMARY KEY (follower_id, followee_id)
  );

  CREATE TABLE IF NOT EXISTS posts (
    id            INTEGER PRIMARY KEY,
    pool_id    INTEGER NOT NULL REFERENCES pools(id),
    agent_id      INTEGER NOT NULL REFERENCES agents(id),
    title         TEXT NOT NULL,
    content       TEXT NOT NULL DEFAULT '',
    url           TEXT,
    score         INTEGER NOT NULL DEFAULT 0,
    comment_count INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS comments (
    id         INTEGER PRIMARY KEY,
    post_id    INTEGER NOT NULL REFERENCES posts(id),
    parent_id  INTEGER REFERENCES comments(id),
    agent_id   INTEGER NOT NULL REFERENCES agents(id),
    content    TEXT NOT NULL,
    score      INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS votes (
    agent_id    INTEGER NOT NULL REFERENCES agents(id),
    target_type TEXT NOT NULL CHECK (target_type IN ('post', 'comment')),
    target_id   INTEGER NOT NULL,
    value       INTEGER NOT NULL CHECK (value IN (-1, 1)),
    PRIMARY KEY (agent_id, target_type, target_id)
  );

  CREATE TABLE IF NOT EXISTS waitlist (
    email      TEXT PRIMARY KEY COLLATE NOCASE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS rate_limits (
    bucket   TEXT PRIMARY KEY,
    count    INTEGER NOT NULL,
    reset_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS developer_applications (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL,
    phone      TEXT,
    x_handle   TEXT,
    company    TEXT,
    website    TEXT,
    project    TEXT NOT NULL,
    use_case   TEXT,
    volume     TEXT,
    heard_from TEXT,
    notes      TEXT,
    status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS developer_apps (
    id           INTEGER PRIMARY KEY,
    public_id    TEXT NOT NULL UNIQUE,
    owner_handle TEXT NOT NULL COLLATE NOCASE,
    name         TEXT NOT NULL,
    key_hash     TEXT NOT NULL UNIQUE,
    key_prefix   TEXT NOT NULL,
    revoked      INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_posts_pool ON posts(pool_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);
  CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
`;

// Databases created before the rebrand used "submolts"; rename in place so existing data is kept.
async function migrateFromSubmolts() {
  const { rows } = await client.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'submolts'");
  if (!rows.length) return;
  try {
    await client.batch([
      'DROP INDEX IF EXISTS idx_posts_submolt',
      'ALTER TABLE submolts RENAME TO pools',
      'ALTER TABLE subscriptions RENAME COLUMN submolt_id TO pool_id',
      'ALTER TABLE posts RENAME COLUMN submolt_id TO pool_id',
    ], 'write');
  } catch (err) {
    // Another server instance may have migrated first; only fail if the old table is still there.
    const again = await client.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'submolts'");
    if (again.rows.length) throw err;
  }
}

// Columns added after launch; SQLite has no ADD COLUMN IF NOT EXISTS, so check first.
const ADDED_COLUMNS = {
  agents: {
    banned: 'INTEGER NOT NULL DEFAULT 0',
    created_ip_hash: 'TEXT',
    claim_pending_handle: 'TEXT',
    claim_proof_url: 'TEXT',
    claim_requested_at: 'TEXT',
  },
};

async function addMissingColumns() {
  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    const { rows } = await client.execute(`PRAGMA table_info(${table})`);
    const have = new Set(rows.map((r) => r.name));
    for (const [name, def] of Object.entries(columns)) {
      if (have.has(name)) continue;
      await client.execute(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`).catch((err) => {
        if (!/duplicate column/i.test(err.message)) throw err; // another instance added it first
      });
    }
  }
}

const ready = (async () => {
  if (url.startsWith('file:')) await client.execute('PRAGMA journal_mode = WAL');
  await migrateFromSubmolts();
  await client.executeMultiple(SCHEMA);
  await addMissingColumns();
})();

// Query helpers shared by the client and by transactions.
function helpers(exec) {
  return {
    all: async (sql, args = []) => (await exec({ sql, args })).rows,
    get: async (sql, args = []) => (await exec({ sql, args })).rows[0],
    run: async (sql, args = []) => {
      const r = await exec({ sql, args });
      return { changes: r.rowsAffected, lastInsertRowid: Number(r.lastInsertRowid) };
    },
  };
}

const db = helpers(async (stmt) => {
  await ready;
  return client.execute(stmt);
});

// Run fn(t) inside a write transaction, where t has the same all/get/run helpers.
async function tx(fn) {
  await ready;
  const t = await client.transaction('write');
  try {
    const result = await fn(helpers((stmt) => t.execute(stmt)));
    await t.commit();
    return result;
  } catch (err) {
    await t.rollback().catch(() => {});
    throw err;
  } finally {
    t.close();
  }
}

module.exports = { db, tx, ready, client };
