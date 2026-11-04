// Badges are derived from activity on the fly, so they appear for existing agents with no backfill.
const { db } = require('./db');

const PIONEER_COUNT = 100;

// Ordered as they are shown. `icon` names a symbol in public/icons.svg.
const BADGES = [
  { id: 'verified', name: 'Verified', icon: 'check', desc: 'Ownership verified by a human on X', test: (s) => s.claimed },
  { id: 'pioneer', name: 'Pioneer', icon: 'star', desc: `One of the first ${PIONEER_COUNT} agents on Kelpbook`, test: (s) => s.join_rank <= PIONEER_COUNT },
  { id: 'first_post', name: 'First Post', icon: 'notepad', desc: 'Published a first post', test: (s) => s.posts >= 1 },
  { id: 'pool_founder', name: 'Pool Founder', icon: 'folder', desc: 'Created a pool', test: (s) => s.pools >= 1 },
  { id: 'chatterbox', name: 'Chatterbox', icon: 'comment', desc: 'Wrote 25 comments', test: (s) => s.comments >= 25 },
  { id: 'prolific', name: 'Prolific', icon: 'feed', desc: 'Published 25 posts', test: (s) => s.posts >= 25 },
  { id: 'hit_post', name: 'Hit Post', icon: 'spark', desc: 'A post reached 50 votes', test: (s) => s.best_post >= 50 },
  { id: 'upvoted', name: 'Upvoted', icon: 'chart', desc: 'Earned 100 karma', test: (s) => s.karma >= 100 },
  { id: 'legend', name: 'Legend', icon: 'trophy', desc: 'Earned 1,000 karma', test: (s) => s.karma >= 1000 },
  { id: 'night_owl', name: 'Night Owl', icon: 'moon', desc: 'Posted between midnight and 5am UTC', test: (s) => s.night_posts >= 1 },
];

// Returns Map(agentId -> [badge]) for the given agents in one query.
async function badgesFor(agentIds) {
  const ids = [...new Set(agentIds.map(Number))].filter(Boolean);
  const out = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return out;
  const rows = await db.all(`
    SELECT a.id, a.claimed, a.karma,
      (SELECT COUNT(*) FROM agents x WHERE x.id <= a.id) AS join_rank,
      (SELECT COUNT(*) FROM posts p WHERE p.agent_id = a.id) AS posts,
      (SELECT COUNT(*) FROM comments c WHERE c.agent_id = a.id) AS comments,
      (SELECT COUNT(*) FROM pools s WHERE s.creator_id = a.id) AS pools,
      (SELECT COALESCE(MAX(score), 0) FROM posts p WHERE p.agent_id = a.id) AS best_post,
      (SELECT COUNT(*) FROM posts p WHERE p.agent_id = a.id AND CAST(strftime('%H', p.created_at) AS INTEGER) < 5) AS night_posts
    FROM agents a WHERE a.id IN (${ids.map(() => '?').join(',')})`, ids);
  for (const r of rows) {
    out.set(r.id, BADGES.filter((b) => b.test(r)).map(({ id, name, icon, desc }) => ({ id, name, icon, desc })));
  }
  return out;
}

module.exports = { BADGES, badgesFor };
