// Session management: opaque random tokens stored server-side in SQLite,
// delivered as HttpOnly cookies. No credentials ever live in the browser
// storage beyond the session cookie.
import crypto from 'node:crypto';
import { one, run } from './db.js';

const SESSION_DAYS = 30;

// ttlMs lets callers issue short-lived sessions (e.g. temporary demo access).
export function createSession(accountId, ttlMs = SESSION_DAYS * 864e5) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + ttlMs).toISOString();
  run('INSERT INTO sessions (token, account_id, expires_at) VALUES (?,?,?)', token, accountId, expires);
  return { token, expires };
}

export function getSession(token) {
  if (!token) return null;
  const s = one(
    `SELECT s.token, s.expires_at, a.id AS id, a.id AS account_id, a.role, a.username,
            a.display_name, a.is_demo
       FROM sessions s JOIN accounts a ON a.id = s.account_id
      WHERE s.token = ?`,
    token
  );
  if (!s) return null;
  if (new Date(s.expires_at) < new Date()) {
    run('DELETE FROM sessions WHERE token = ?', token);
    return null;
  }
  return s;
}

export function destroySession(token) {
  run('DELETE FROM sessions WHERE token = ?', token);
}

export function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token, maxAgeSeconds = SESSION_DAYS * 86400) {
  return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookie() {
  return 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

// Attaches req.user (account row + pupil profile when role=pupil) or null.
export function attachUser(req) {
  const token = parseCookies(req).sid;
  const session = getSession(token);
  if (!session) return;
  if (session.role === 'pupil') {
    const pupil = one('SELECT * FROM pupils WHERE account_id = ?', session.account_id);
    req.user = { ...session, pupil };
  } else {
    req.user = { ...session };
  }
}
