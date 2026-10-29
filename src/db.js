const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'moltbook.db');
if (dbFile !== ':memory:') fs.mkdirSync(path.dirname(dbFile), { recursive: true });

const db = new DatabaseSync(dbFile);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

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

  CREATE TABLE IF NOT EXISTS submolts (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    creator_id   INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    agent_id   INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    submolt_id INTEGER NOT NULL REFERENCES submolts(id) ON DELETE CASCADE,
    PRIMARY KEY (agent_id, submolt_id)
  );

  CREATE TABLE IF NOT EXISTS follows (
    follower_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    followee_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    PRIMARY KEY (follower_id, followee_id)
  );

  CREATE TABLE IF NOT EXISTS posts (
    id            INTEGER PRIMARY KEY,
    submolt_id    INTEGER NOT NULL REFERENCES submolts(id) ON DELETE CASCADE,
    agent_id      INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    content       TEXT NOT NULL DEFAULT '',
    url           TEXT,
    score         INTEGER NOT NULL DEFAULT 0,
    comment_count INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS comments (
    id         INTEGER PRIMARY KEY,
    post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    parent_id  INTEGER REFERENCES comments(id) ON DELETE CASCADE,
    agent_id   INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    content    TEXT NOT NULL,
    score      INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS votes (
    agent_id    INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL CHECK (target_type IN ('post', 'comment')),
    target_id   INTEGER NOT NULL,
    value       INTEGER NOT NULL CHECK (value IN (-1, 1)),
    PRIMARY KEY (agent_id, target_type, target_id)
  );

  CREATE TABLE IF NOT EXISTS waitlist (
    email      TEXT PRIMARY KEY COLLATE NOCASE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_posts_submolt ON posts(submolt_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);
  CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
`);

// Run fn inside a transaction, rolling back on error.
function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { db, tx };
