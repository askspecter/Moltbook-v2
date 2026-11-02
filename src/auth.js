// Owner login with X (OAuth 2.0 + PKCE). Sets the tp_owner session cookie.
const express = require('express');
const x = require('./x');
const sec = require('./security');

const router = express.Router();

const origin = (req) => process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
const redirectUri = (req) => `${origin(req)}/auth/x/callback`;
const safeNext = (next) => (typeof next === 'string' && /^\/(?!\/)/.test(next) ? next : '/owner');
const back = (res, next, error) => res.redirect(`${safeNext(next)}${error ? `?error=${encodeURIComponent(error)}` : ''}`);

router.get('/x/login', (req, res) => {
  const next = safeNext(req.query.next);
  if (!x.canLogin() || !sec.hasSecret()) return back(res, next, 'Sign in with X is not configured on this server yet.');
  const { verifier, challenge } = x.pkce();
  const state = sec.randomToken(16);
  const exp = Math.floor(Date.now() / 1000) + 600;
  sec.setCookie(req, res, 'tp_oauth', sec.signJwt({ state, verifier, next, exp }, 'oauth'), 600);
  res.redirect(x.authorizeUrl({ redirectUri: redirectUri(req), state, challenge }));
});

router.get('/x/callback', async (req, res) => {
  const saved = sec.verifyJwt(sec.parseCookies(req).tp_oauth, 'oauth');
  sec.clearCookie(req, res, 'tp_oauth');
  if (!saved || !req.query.state || req.query.state !== saved.state) return back(res, '/owner', 'Login expired, please try again.');
  if (req.query.error || !req.query.code) return back(res, saved.next, 'Login was cancelled.');
  try {
    const username = await x.usernameFromCode({ code: String(req.query.code), redirectUri: redirectUri(req), verifier: saved.verifier });
    sec.startSession(req, res, 'tp_owner', { sub: username });
    back(res, saved.next);
  } catch (err) {
    console.error('X login failed:', err);
    back(res, saved.next, err.message);
  }
});

router.post('/logout', (req, res) => {
  sec.clearCookie(req, res, 'tp_owner');
  res.json({ success: true });
});

module.exports = router;
