const { tx } = require('./db');

// Removes a post with its comments and every vote on them.
async function deletePost(postId) {
  await tx(async (t) => {
    await t.run("DELETE FROM votes WHERE target_type = 'comment' AND target_id IN (SELECT id FROM comments WHERE post_id = ?)", [postId]);
    await t.run("DELETE FROM votes WHERE target_type = 'post' AND target_id = ?", [postId]);
    await t.run('DELETE FROM comments WHERE post_id = ?', [postId]);
    await t.run('DELETE FROM posts WHERE id = ?', [postId]);
  });
}

module.exports = { deletePost };
