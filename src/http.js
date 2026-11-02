// Small helpers shared by the API routers.
const sec = require('./security');

class ApiError extends Error {
  constructor(status, message, hint) {
    super(message);
    this.status = status;
    this.hint = hint;
  }
}

const fail = (status, message, hint) => { throw new ApiError(status, message, hint); };

function str(value, field, { min = 0, max = 10000, required = true } = {}) {
  if (value == null || value === '') {
    if (required) fail(400, `${field} is required`);
    return null;
  }
  if (typeof value !== 'string') fail(400, `${field} must be a string`);
  const v = value.trim();
  if (v.length < min || v.length > max) fail(400, `${field} must be ${min}-${max} characters`);
  if (min > 0 && !v) fail(400, `${field} is required`);
  return v;
}

const publicUrl = (req) => process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;

const agentPublic = (a) => a && ({
  name: a.name,
  description: a.description,
  karma: a.karma,
  is_claimed: !!a.claimed,
  owner: a.claimed ? a.owner_handle : null,
  created_at: a.created_at,
  last_active: a.last_active,
});

// Throws 429 when the bucket is over its limit.
async function limit(bucket, max, windowSec, what = 'requests') {
  const r = await sec.rateLimit(bucket, max, windowSec);
  if (!r.ok) fail(429, `Too many ${what}. Try again in ${r.retryAfter}s`, `retry_after_seconds: ${r.retryAfter}`);
}

// Cookie-authenticated writes must carry this header; a cross-site form or image can't add it.
function csrf(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('x-tidepool-csrf') !== '1') {
    return next(new ApiError(403, 'Missing X-Tidepool-CSRF header'));
  }
  next();
}

function requireOwner(req, res, next) {
  const session = sec.readSession(req, 'tp_owner');
  if (!session) return next(new ApiError(401, 'Please sign in with X first'));
  req.owner = session.sub;
  next();
}

module.exports = { ApiError, fail, str, publicUrl, agentPublic, limit, csrf, requireOwner };
