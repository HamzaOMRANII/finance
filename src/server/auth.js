// Single-user login. Passwords: scrypt (memory-hard, built into Node). Sessions: random token
// in an HttpOnly + Secure + SameSite=Strict cookie, stored hashed in SQLite with its CSRF token.
// Every non-GET API call must echo that CSRF token in the X-CSRF-Token header.
const crypto = require('node:crypto');
const config = require('./config');
const db = require('./db');
const { parseCookies, HttpError } = require('./http');

const COOKIE = config.production ? '__Host-fintrack' : 'fintrack';
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
  });
  return crypto.timingSafeEqual(actual, expected);
}

// Session ids are stored as HMAC(SESSION_SECRET, token): a leaked database alone cannot be
// turned into valid cookies.
const sha256 = (s) => crypto.createHmac('sha256', config.sessionSecret || 'dev-only-secret').update(s).digest('hex');

function cookieHeader(value, maxAgeSeconds) {
  const parts = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`];
  if (config.production) parts.push('Secure');
  return parts.join('; ');
}

// Slow down password guessing from inside the app too (nginx rate-limits the route as well).
const failures = new Map(); // ip -> { count, until }
function checkThrottle(ip) {
  const f = failures.get(ip);
  if (f && f.until > Date.now()) throw new HttpError(429, 'too many attempts, wait a minute');
}
function noteFailure(ip) {
  const f = failures.get(ip) || { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= 5) {
    f.until = Date.now() + 60_000;
    f.count = 0;
  }
  failures.set(ip, f);
}

function login(req, res, { username, password }) {
  const ip = req.headers['x-real-ip'] || req.socket.remoteAddress;
  checkThrottle(ip);
  const user = db.get('SELECT * FROM users WHERE username = ?', String(username || ''));
  // compare even when the user is unknown so timing does not reveal usernames
  const ok = verifyPassword(String(password || ''), user?.password_hash || hashPassword('x'));
  if (!user || !ok) {
    noteFailure(ip);
    throw new HttpError(401, 'wrong username or password');
  }
  failures.delete(ip);
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const expires = new Date(Date.now() + config.sessionDays * 86400_000);
  db.run('DELETE FROM sessions WHERE expires_at < ?', new Date().toISOString());
  db.insert('sessions', { id: sha256(token), user_id: user.id, csrf, expires_at: expires.toISOString() });
  res.setHeader('Set-Cookie', cookieHeader(token, config.sessionDays * 86400));
  return { username: user.username, csrf };
}

function logout(req, res) {
  const token = parseCookies(req)[COOKIE];
  if (token) db.run('DELETE FROM sessions WHERE id = ?', sha256(token));
  res.setHeader('Set-Cookie', cookieHeader('', 0));
}

// Returns { user, csrf } or null.
function session(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const s = db.get(`SELECT s.csrf, s.expires_at, u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
                    WHERE s.id = ?`, sha256(token));
  if (!s || s.expires_at < new Date().toISOString()) return null;
  return { user: { id: s.id, username: s.username }, csrf: s.csrf };
}

function requireSession(req, { csrf = false } = {}) {
  const s = session(req);
  if (!s) throw new HttpError(401, 'login required');
  if (csrf) {
    const sent = String(req.headers['x-csrf-token'] || '');
    const a = Buffer.from(sent);
    const b = Buffer.from(s.csrf);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(403, 'missing or invalid CSRF token');
  }
  return s;
}

function changePassword(userId, current, next) {
  const user = db.get('SELECT * FROM users WHERE id = ?', userId);
  if (!verifyPassword(String(current || ''), user.password_hash)) throw new HttpError(400, 'current password is wrong');
  if (String(next || '').length < 12) throw new HttpError(400, 'new password must be at least 12 characters');
  db.update('users', userId, { password_hash: hashPassword(next) });
  db.run('DELETE FROM sessions WHERE user_id = ?', userId);
}

module.exports = { hashPassword, verifyPassword, login, logout, session, requireSession, changePassword };
