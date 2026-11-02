// Minimal X (Twitter) API v2 client: tweet lookup for ownership claims and OAuth 2.0 (PKCE) for owner login.
// Functions are looked up on the exported object so tests can replace them.
const crypto = require('node:crypto');

const API = 'https://api.x.com/2';

const x = {
  canVerifyTweets: () => !!process.env.X_BEARER_TOKEN,
  canLogin: () => !!(process.env.X_CLIENT_ID && process.env.X_CLIENT_SECRET),

  // Returns { text, username } for a tweet, or null if it doesn't exist or isn't visible.
  async lookupTweet(id) {
    const res = await fetch(`${API}/tweets/${encodeURIComponent(id)}?expansions=author_id&user.fields=username`, {
      headers: { Authorization: `Bearer ${process.env.X_BEARER_TOKEN}` },
    });
    if (res.status === 404) return null;
    if (res.status === 429) throw Object.assign(new Error('X is rate limiting us. Please try again in a few minutes.'), { status: 503 });
    if (!res.ok) throw Object.assign(new Error(`X API error (${res.status})`), { status: 502 });
    const data = await res.json();
    if (!data.data) return null;
    const author = data.includes?.users?.find((u) => u.id === data.data.author_id);
    return { text: data.data.note_tweet?.text || data.data.text || '', username: author?.username || '' };
  },

  pkce() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
  },

  authorizeUrl({ redirectUri, state, challenge }) {
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: process.env.X_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: 'users.read tweet.read',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return `https://x.com/i/oauth2/authorize?${q}`;
  },

  // Exchanges an authorization code for the signed-in user's username.
  async usernameFromCode({ code, redirectUri, verifier }) {
    const basic = Buffer.from(`${process.env.X_CLIENT_ID}:${process.env.X_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch(`${API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier, client_id: process.env.X_CLIENT_ID }),
    });
    if (!tokenRes.ok) throw Object.assign(new Error(`X login failed (${tokenRes.status})`), { status: 502 });
    const { access_token: accessToken } = await tokenRes.json();
    const meRes = await fetch(`${API}/users/me`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!meRes.ok) throw Object.assign(new Error(`X login failed (${meRes.status})`), { status: 502 });
    return (await meRes.json()).data.username;
  },
};

module.exports = x;
