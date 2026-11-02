const crypto = require('node:crypto');
const { db } = require('./db');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

// One secret signs owner/admin sessions and agent identity tokens; each use gets its own derived key
// so a token minted for one purpose can never be replayed as another.
function secretFor(purpose) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) return null;
  return crypto.createHmac('sha256', secret).update(purpose).digest();
}

const hasSecret = () => !!secretFor('check');

// Compact HS256 JWT, so identity tokens look familiar to developers.
function signJwt(payload, purpose) {
  const key = secretFor(purpose);
  if (!key) throw Object.assign(new Error('SESSION_SECRET is not configured on the server'), { status: 503 });
  const body = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}`;
  return `${body}.${crypto.createHmac('sha256', key).update(body).digest('base64url')}`;
}

function verifyJwt(token, purpose) {
  const key = secretFor(purpose);
  if (!key || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = crypto.createHmac('sha256', key).update(`${parts[0]}.${parts[1]}`).digest();
  const given = Buffer.from(parts[2], 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------- cookies ----------

function parseCookies(req) {
  const out = {};
  for (const part of (req.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(req, res, name, value, maxAgeSec) {
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  res.append('Set-Cookie', [
    `${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`, secure && 'Secure',
  ].filter(Boolean).join('; '));
}

const clearCookie = (req, res, name) => setCookie(req, res, name, '', 0);

// Session cookies: kb_owner (signed in with X) and kb_admin.
const SESSION_DAYS = 7;
function startSession(req, res, cookie, payload) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  setCookie(req, res, cookie, signJwt({ ...payload, exp }, `session:${cookie}`), SESSION_DAYS * 86400);
}
const readSession = (req, cookie) => verifyJwt(parseCookies(req)[cookie], `session:${cookie}`);

// ---------- client identity & rate limits ----------

function clientIp(req) {
  return (req.get('x-real-ip') || req.ip || '').trim();
}
const ipHash = (req) => sha256('ip:' + clientIp(req)).slice(0, 32);

// Fixed-window counter stored in the database, so limits hold across serverless instances.
async function rateLimit(bucket, limit, windowSec) {
  if (!limit) return { ok: true };
  const now = Date.now();
  const resetAt = now + windowSec * 1000;
  const row = await db.get(`
    INSERT INTO rate_limits (bucket, count, reset_at) VALUES (?, 1, ?)
    ON CONFLICT (bucket) DO UPDATE SET
      count = CASE WHEN reset_at <= ? THEN 1 ELSE count + 1 END,
      reset_at = CASE WHEN reset_at <= ? THEN excluded.reset_at ELSE reset_at END
    RETURNING count, reset_at`, [bucket, resetAt, now, now]);
  if (row.count <= limit) return { ok: true };
  return { ok: false, retryAfter: Math.max(1, Math.ceil((row.reset_at - now) / 1000)) };
}

module.exports = {
  sha256, randomToken, hasSecret, signJwt, verifyJwt,
  parseCookies, setCookie, clearCookie, startSession, readSession,
  clientIp, ipHash, rateLimit,
};
