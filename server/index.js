// ---------------------------------------------------------------------------
// API + static file server. Node built-ins only (http, node:sqlite, crypto).
//
// Server-side access rules enforced on every route:
//   - teachers manage only classes they own
//   - pupils read/write only their own pupil_assignment rows
//   - pupils can never set proficiency or claim an already-linked pupil
//   - registration needs the selected pupil's unique six-digit PIN
// ---------------------------------------------------------------------------
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { q, one, run, tx, flushCloud, cloudStoreEnabled, LEVELS, LEVEL_LABELS } from './db.js';
import { hashPassword, verifyPassword } from './passwords.js';
import {
  createSession, destroySession, parseCookies, sessionCookie, clearSessionCookie, attachUser,
} from './sessions.js';
import {
  markSnapshot, recurringErrors, countQuestions, sanitizeSnapshotForPupil, validateTemplateContent,
} from './marking.js';
import { seedDemo, ensureDemoPupil, relabelDemoTemplates, removeDemoData } from './seed.js';
import { generateHomework } from '../public/js/ai.js';
import QRCode from 'qrcode';
import { zipSync, strToU8 } from 'fflate';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// --- small helpers -----------------------------------------------------------
function send(res, status, data, headers = {}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      data += c;
      if (data.length > 256 * 1024) {
        done = true;
        data = '';
        req.resume(); // drain the rest so the 413 response can be delivered
        reject(new ApiError(413, 'Request too large'));
      }
    });
    req.on('end', () => {
      if (done) return;
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new ApiError(400, 'Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// Raw binary body reader for image uploads (no multipart, zero dependencies —
// the client POSTs the file bytes directly with its MIME type).
function readRawBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > cap) {
        done = true;
        chunks.length = 0;
        req.resume(); // drain the rest so the 413 response can be delivered
        reject(new ApiError(413, 'Image too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

function requireRole(req, role) {
  if (!req.user) throw new ApiError(401, 'Please sign in');
  if (req.user.role !== role) throw new ApiError(403, 'Not allowed');
  return req.user;
}

function ownClass(user, classId) {
  const c = one('SELECT * FROM classes WHERE id = ?', classId);
  if (!c) throw new ApiError(404, 'Class not found');
  if (c.teacher_id !== user.id) throw new ApiError(403, 'This class belongs to another teacher');
  return c;
}

function ownPupil(user, pupilId) {
  const p = one('SELECT * FROM pupils WHERE id = ?', pupilId);
  if (!p) throw new ApiError(404, 'Pupil not found');
  const c = one('SELECT * FROM classes WHERE id = ?', p.class_id);
  if (!c || c.teacher_id !== user.id) throw new ApiError(403, 'This pupil belongs to another class');
  return p;
}

function isOverdue(pa, assignment) {
  return pa.status !== 'submitted' && new Date(assignment.due_date) < startOfToday();
}
function startOfToday() { return new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z'); }
function paStatus(pa, assignment) {
  return isOverdue(pa, assignment) ? 'overdue' : pa.status;
}

const publicPupil = (p) => ({
  id: p.id,
  name: p.name,
  studentNo: p.student_no,
  proficiency: p.proficiency,
  registered: !!p.account_id,
  isDemo: !!p.is_demo,
});

// --- route registry ------------------------------------------------------------
const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
  routes.push({ method, regex, keys, handler });
}

function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = pathname.match(r.regex);
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { handler: r.handler, params };
    }
  }
  return null;
}

// =============================================================================
// AUTH
// =============================================================================
route('POST', '/api/auth/login', async (req, res) => {
  const { username, password } = await readBody(req);
  if (!username || !password) throw new ApiError(400, 'Username and password are required');
  const account = one('SELECT * FROM accounts WHERE username = ?', String(username).trim().toLowerCase());
  if (!account || !verifyPassword(password, account.pass_hash)) {
    throw new ApiError(401, 'Wrong username or password');
  }
  const { token } = createSession(account.id);
  send(res, 200, {
    ok: true,
    role: account.role,
    displayName: account.display_name || account.username,
    isDemo: !!account.is_demo,
  }, { 'Set-Cookie': sessionCookie(token) });
});

route('POST', '/api/auth/logout', async (req, res) => {
  destroySession(parseCookies(req).sid);
  send(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
});

route('GET', '/api/auth/me', async (req, res) => {
  if (!req.user) return send(res, 200, { signedIn: false });
  const base = {
    signedIn: true,
    role: req.user.role,
    username: req.user.username,
    displayName: req.user.display_name,
    isDemo: !!req.user.is_demo,
  };
  if (req.user.role === 'pupil' && req.user.pupil) {
    base.pupil = {
      name: req.user.pupil.name,
      studentNo: req.user.pupil.student_no,
      proficiency: req.user.pupil.proficiency,
    };
  }
  send(res, 200, base);
});

// --- teacher access-code login ----------------------------------------------
// The teacher page logs in with a shared access code (default 0000, override
// with the TEACHER_CODE environment variable). The code grants the first
// teacher account; pupils have their own username logins.
const TEACHER_CODE = process.env.TEACHER_CODE || '0000';

route('POST', '/api/auth/code-login', async (req, res) => {
  const { code } = await readBody(req);
  if (String(code ?? '').trim() !== TEACHER_CODE) throw new ApiError(401, 'Wrong access code');
  const account = one("SELECT * FROM accounts WHERE role = 'teacher' ORDER BY id LIMIT 1");
  if (!account) throw new ApiError(404, 'No teacher account exists yet');
  const { token } = createSession(account.id);
  send(res, 200, {
    ok: true,
    role: 'teacher',
    displayName: account.display_name || account.username,
    isDemo: !!account.is_demo,
  }, { 'Set-Cookie': sessionCookie(token) });
});

// --- temporary demo access -------------------------------------------------
// One-click login to the seeded demo teacher. Sessions are short-lived
// (2 hours) and the routes only work when a demo account actually exists,
// so a real deployment without seeded demo data never exposes them.
const DEMO_TTL_MS = 2 * 60 * 60 * 1000;

route('GET', '/api/demo-status', async (req, res) => {
  const teacher = one("SELECT id FROM accounts WHERE is_demo = 1 AND role = 'teacher' LIMIT 1");
  const pupil = one("SELECT id FROM accounts WHERE is_demo = 1 AND role = 'pupil' AND username = 'ryan' LIMIT 1");
  send(res, 200, { demo: !!teacher, teacher: !!teacher, pupil: !!pupil });
});

route('POST', '/api/auth/demo-login', async (req, res) => {
  const { as } = await readBody(req);
  let demo = one("SELECT * FROM accounts WHERE is_demo = 1 AND role = 'teacher' LIMIT 1");
  if (as === 'pupil') {
    demo = one("SELECT * FROM accounts WHERE is_demo = 1 AND role = 'pupil' AND username = 'ryan' LIMIT 1");
  }
  if (!demo) throw new ApiError(404, 'No demo account available');
  const { token, expires } = createSession(demo.id, DEMO_TTL_MS);
  send(res, 200, {
    ok: true,
    role: demo.role,
    displayName: demo.display_name,
    temporary: true,
    expiresAt: expires,
  }, { 'Set-Cookie': sessionCookie(token, DEMO_TTL_MS / 1000) });
});

// =============================================================================
// REGISTRATION (public, pre-auth)
// =============================================================================
// Namelist for a class registration page. Shows only name/student_no and
// registration state — no account details are ever exposed.
route('GET', '/api/register/:classCode', async (req, res, { classCode }) => {
  const cls = one('SELECT * FROM classes WHERE code = ?', classCode);
  if (!cls) throw new ApiError(404, 'Class not found. Check the link or code with your teacher.');
  const rows = q(
    'SELECT id, name, student_no, account_id FROM pupils WHERE class_id = ? ORDER BY name COLLATE NOCASE, student_no',
    cls.id
  );
  // Pupils sharing a name get their student number shown so they can be told apart.
  const nameCounts = {};
  for (const r of rows) nameCounts[r.name.toLowerCase()] = (nameCounts[r.name.toLowerCase()] || 0) + 1;
  send(res, 200, {
    className: cls.name,
    classCode: cls.code,
    pupils: rows.map((p) => ({
      id: p.id,
      name: p.name,
      studentNo: p.student_no,
      sameName: nameCounts[p.name.toLowerCase()] > 1,
      registered: !!p.account_id,
    })),
  });
});

// Claim a pupil record. Safe against races: the UPDATE ... WHERE account_id IS NULL
// inside a transaction means exactly one concurrent registration can win; the
// UNIQUE(account_id) constraint backstops everything else.
const pinAttempts = new Map();

function verifyPupilPin(pupil, pin) {
  const now = Date.now();
  for (const [key, value] of pinAttempts) if (value.until <= now) pinAttempts.delete(key);
  const attempt = pinAttempts.get(pupil.id) || { count: 0, until: now + 15 * 60 * 1000 };
  if (attempt.count >= 10) throw new ApiError(429, 'Too many incorrect PIN attempts. Try again in 15 minutes.');
  if (!/^\d{6}$/.test(String(pin).trim()) || String(pin).trim() !== pupil.registration_pin) {
    attempt.count++;
    pinAttempts.set(pupil.id, attempt);
    throw new ApiError(403, 'Incorrect student PIN. Ask your teacher for your own QR card.');
  }
  pinAttempts.delete(pupil.id);
}

// A personal QR card is the pupil credential. The PIN stays in the URL
// fragment (never in the HTTP request URL) and the page exchanges it for an
// HttpOnly session. First scan creates the internal pupil account; later scans
// sign into that same account on any device without a username or password.
route('POST', '/api/auth/qr-login', async (req, res) => {
  const { classCode, pupilId, pin } = await readBody(req);
  if (!pupilId || !pin) throw new ApiError(400, 'This QR card is incomplete');

  const accountId = tx(() => {
    const pupil = one('SELECT * FROM pupils WHERE id = ?', Number(pupilId));
    if (!pupil) throw new ApiError(404, 'Pupil not found');
    if (classCode) {
      const cls = one('SELECT id FROM classes WHERE code = ?', String(classCode).trim().toUpperCase());
      if (!cls || cls.id !== pupil.class_id) throw new ApiError(404, 'Pupil not found in this class');
    }
    verifyPupilPin(pupil, pin);
    if (pupil.account_id) return pupil.account_id;

    let username;
    do { username = `qr_${pupil.id}_${randomBytes(5).toString('hex')}`; }
    while (one('SELECT id FROM accounts WHERE username = ?', username));
    const id = run(
      'INSERT INTO accounts (username, pass_hash, role, display_name, is_demo) VALUES (?,?,?,?,?)',
      username, hashPassword(randomBytes(32).toString('hex')), 'pupil', pupil.name, pupil.is_demo
    ).lastInsertRowid;
    const linked = run('UPDATE pupils SET account_id = ? WHERE id = ? AND account_id IS NULL', id, pupil.id);
    if (linked.changes) return id;

    // Another scan won the race. Reuse its account and remove this orphan.
    run('DELETE FROM accounts WHERE id = ?', id);
    const current = one('SELECT account_id FROM pupils WHERE id = ?', pupil.id);
    if (!current?.account_id) throw new ApiError(409, 'Please scan the QR card again');
    return current.account_id;
  });

  const { token } = createSession(accountId);
  send(res, 200, { ok: true, role: 'pupil', displayName: pupilName(accountId) }, {
    'Set-Cookie': sessionCookie(token),
    'Cache-Control': 'no-store',
  });
});

route('POST', '/api/register', async (req, res) => {
  const { classCode, regCode, pupilId, username, password } = await readBody(req);
  if (!classCode || !regCode || !pupilId || !username || !password) {
    throw new ApiError(400, 'All fields are required');
  }
  if (String(password).length < 6) throw new ApiError(400, 'Password must be at least 6 characters');
  const uname = String(username).trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(uname)) {
    throw new ApiError(400, 'Username: use 3-30 letters or numbers (no spaces)');
  }

  const accountId = tx(() => {
    const cls = one('SELECT * FROM classes WHERE code = ?', String(classCode).trim().toUpperCase());
    if (!cls) throw new ApiError(404, 'Class not found');
    const pupil = one('SELECT * FROM pupils WHERE id = ? AND class_id = ?', Number(pupilId), cls.id);
    if (!pupil) throw new ApiError(404, 'Pupil not found in this class');
    verifyPupilPin(pupil, regCode);
    if (pupil.account_id) throw new ApiError(409, 'This name is already registered');
    const exists = one('SELECT id FROM accounts WHERE username = ?', uname);
    if (exists) throw new ApiError(409, 'That username is taken. Try another one.');

    const id = run(
      'INSERT INTO accounts (username, pass_hash, role, display_name, is_demo) VALUES (?,?,?,?,?)',
      uname, hashPassword(password), 'pupil', pupil.name, pupil.is_demo
    ).lastInsertRowid;
    const upd = run('UPDATE pupils SET account_id = ? WHERE id = ? AND account_id IS NULL', id, pupil.id);
    if (upd.changes === 0) {
      // Lost the race — the account row must not be left behind claiming nothing.
      run('DELETE FROM accounts WHERE id = ?', id);
      throw new ApiError(409, 'This name was just registered by someone else. Please choose again.');
    }
    return id;
  });

  const { token } = createSession(accountId);
  send(res, 201, { ok: true, displayName: pupilName(accountId) }, { 'Set-Cookie': sessionCookie(token) });
});

function pupilName(accountId) {
  const p = one('SELECT name FROM pupils WHERE account_id = ?', accountId);
  return p ? p.name : 'Pupil';
}

// =============================================================================
// TEACHER: classes & students
// =============================================================================
async function registrationCards(req) {
  const user = requireRole(req, 'teacher');
  const classId = new URL(req.url, 'http://x').searchParams.get('classId');
  if (classId) ownClass(user, Number(classId));
  const rows = q(`SELECT p.*, c.name AS class_name, c.code AS class_code
    FROM pupils p JOIN classes c ON c.id = p.class_id
    WHERE c.teacher_id = ? ${classId ? 'AND c.id = ?' : ''}
    ORDER BY c.name, p.name COLLATE NOCASE, p.student_no`,
    ...[user.id, ...(classId ? [Number(classId)] : [])]);
  const origin = process.env.RENDER_EXTERNAL_URL || `http://${req.headers.host}`;
  const cards = [];
  for (const p of rows) {
    const url = new URL('/student-access.html', origin);
    // The fragment keeps the PIN out of HTTP request URLs and referrers.
    url.hash = new URLSearchParams({ pupil: String(p.id), pin: p.registration_pin }).toString();
    const qr = await QRCode.toString(url.href, { type: 'svg', width: 600, margin: 4, errorCorrectionLevel: 'M' });
    const xml = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;' }[c]));
    const nameLines = p.name.match(/.{1,28}(?:\s|$)|.{1,28}/g) || [p.name];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="940" viewBox="0 0 720 940"><rect width="720" height="940" rx="24" fill="white"/>${qr.replace('<svg ', '<svg x="60" y="20" ')}<g text-anchor="middle" fill="#172c40" font-family="Arial, sans-serif">${nameLines.map((line,i) => `<text x="360" y="${650+i*36}" font-size="30" font-weight="700">${xml(line.trim())}</text>`).join('')}<text x="360" y="790" font-size="22">${xml(p.class_name)} · No. ${xml(p.student_no)}</text><text x="360" y="841" font-size="30" letter-spacing="5">PIN: ${p.registration_pin}</text><text x="360" y="895" font-size="20">Scan to sign in · Imbas untuk log masuk</text></g></svg>`;
    cards.push({ id: p.id, name: p.name, studentNo: p.student_no,
      className: p.class_name, classCode: p.class_code, pin: p.registration_pin,
      registered: !!p.account_id, url: url.href, svg });
  }
  return cards;
}

route('GET', '/api/teacher/registration-cards', async (req, res) => {
  const cards = await registrationCards(req);
  send(res, 200, { cards: cards.map(({ svg, ...card }) => ({ ...card, qr: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64') })) });
});

route('GET', '/api/teacher/registration-cards.zip', async (req, res) => {
  const cards = await registrationCards(req);
  const files = {};
  const escape = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const html = [];
  for (const card of cards) {
    const filename = `${card.classCode}-${card.id}-${card.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.svg`;
    files[filename] = strToU8(card.svg);
    html.push(`<article><img src="${filename}" alt="${escape(card.name)} — sign-in card"></article>`);
  }
  files['print-cards.html'] = strToU8(`<!doctype html><html><meta charset="utf-8"><title>Student sign-in cards</title><style>body{font:16px system-ui;display:grid;grid-template-columns:repeat(2,1fr);gap:20px}article{text-align:center;border:1px dashed #777;padding:8px;break-inside:avoid}img{width:100%;max-width:300px;height:auto}@media print{body{gap:8mm}}</style><body>${html.join('')}</body></html>`);
  res.writeHead(200, { 'Content-Type': 'application/zip', 'Cache-Control': 'no-store',
    'Content-Disposition': 'attachment; filename="student-qr-codes.zip"' });
  res.end(Buffer.from(zipSync(files)));
});

route('GET', '/api/teacher/classes', async (req, res) => {
  const user = requireRole(req, 'teacher');
  const classes = q('SELECT * FROM classes WHERE teacher_id = ? ORDER BY name', user.id);
  send(res, 200, {
    classes: classes.map((c) => ({
      id: c.id, name: c.name, code: c.code, regCode: c.reg_code, isDemo: !!c.is_demo,
    })),
  });
});

// Create a real class. The public class code is generated server-side. The
// legacy reg_code is retained for compatibility but registration uses each
// pupil's unique PIN. Codes avoid ambiguous characters when read aloud.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomCode(len, alphabet = CODE_ALPHABET) {
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

route('POST', '/api/teacher/classes', async (req, res) => {
  const user = requireRole(req, 'teacher');
  const { name } = await readBody(req);
  const clean = String(name ?? '').trim();
  if (!clean || clean.length > 80) throw new ApiError(400, 'Class name is required (max 80 characters)');
  let code, regCode;
  do {
    code = randomCode(6);
    regCode = randomCode(6, '0123456789');
  } while (one('SELECT 1 FROM classes WHERE code = ? OR reg_code = ?', code, regCode));
  const id = run(
    'INSERT INTO classes (name, code, reg_code, teacher_id) VALUES (?, ?, ?, ?)',
    clean, code, regCode, user.id,
  ).lastInsertRowid;
  const c = one('SELECT * FROM classes WHERE id = ?', id);
  send(res, 201, {
    class: { id: c.id, name: c.name, code: c.code, regCode: c.reg_code, isDemo: !!c.is_demo },
  });
});

// Rename a class. Codes are deliberately immutable — the registration link
// and pupil code keep working across a rename.
route('PATCH', '/api/teacher/classes/:id', async (req, res, { id }) => {
  const user = requireRole(req, 'teacher');
  const cls = ownClass(user, Number(id));
  const { name } = await readBody(req);
  const clean = String(name ?? '').trim();
  if (!clean || clean.length > 80) throw new ApiError(400, 'Class name is required (max 80 characters)');
  run('UPDATE classes SET name = ? WHERE id = ?', clean, cls.id);
  send(res, 200, {
    class: { id: cls.id, name: clean, code: cls.code, regCode: cls.reg_code, isDemo: !!cls.is_demo },
  });
});

// Delete a class and everything that belongs to it, in FK-safe order:
// pupil homework snapshots, then pupils, then their linked accounts
// (sessions go with them via ON DELETE CASCADE), then assignments, then
// the class. Homework history is not recoverable — this is intentional.
route('DELETE', '/api/teacher/classes/:id', async (req, res, { id }) => {
  const user = requireRole(req, 'teacher');
  const cls = ownClass(user, Number(id));
  tx(() => {
    // capture linked pupil accounts before the pupil rows are gone
    const accountIds = q(
      'SELECT account_id FROM pupils WHERE class_id = ? AND account_id IS NOT NULL', cls.id,
    ).map((r) => r.account_id);
    run('DELETE FROM pupil_assignments WHERE pupil_id IN (SELECT id FROM pupils WHERE class_id = ?)', cls.id);
    run('DELETE FROM pupils WHERE class_id = ?', cls.id);
    // sessions go with the accounts via ON DELETE CASCADE
    for (const accountId of accountIds) {
      run("DELETE FROM accounts WHERE id = ? AND role = 'pupil'", accountId);
    }
    run('DELETE FROM assignments WHERE class_id = ?', cls.id);
    run('DELETE FROM classes WHERE id = ?', cls.id);
  });
  send(res, 200, { ok: true });
});

// Students page: one summary per pupil with real homework numbers only.
function classOverview(classId) {
  const pupils = q('SELECT * FROM pupils WHERE class_id = ? ORDER BY name COLLATE NOCASE, student_no', classId);
  const stats = q(
    `SELECT pupil_id,
            COUNT(*) AS assigned,
            SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) AS completed
       FROM pupil_assignments
      WHERE pupil_id IN (SELECT id FROM pupils WHERE class_id = ?)
      GROUP BY pupil_id`,
    classId
  );
  const latestRows = q(
    `SELECT pa.pupil_id, a.title, pa.level, pa.objective_score, pa.submitted_at
       FROM pupil_assignments pa JOIN assignments a ON a.id = pa.assignment_id
      WHERE pa.pupil_id IN (SELECT id FROM pupils WHERE class_id = ?) AND pa.submitted_at IS NOT NULL
      ORDER BY pa.submitted_at DESC`,
    classId
  );
  const statsMap = new Map(stats.map((s) => [s.pupil_id, s]));
  const latestMap = new Map();
  for (const l of latestRows) if (!latestMap.has(l.pupil_id)) latestMap.set(l.pupil_id, l);
  return pupils.map((p) => {
    const s = statsMap.get(p.id) || { assigned: 0, completed: 0 };
    const l = latestMap.get(p.id);
    return {
      ...publicPupil(p),
      assigned: s.assigned,
      completed: s.completed,
      latest: l ? { title: l.title, score: l.objective_score, level: l.level, submittedAt: l.submitted_at } : null,
    };
  });
}

route('GET', '/api/teacher/students', async (req, res) => {
  const user = requireRole(req, 'teacher');
  const classId = Number(new URL(req.url, 'http://x').searchParams.get('classId'));
  const cls = ownClass(user, classId);
  send(res, 200, { className: cls.name, isDemo: !!cls.is_demo, students: classOverview(cls.id) });
});

// Proficiency is teacher-only. Pupil routes never touch this table column.
route('POST', '/api/teacher/pupils/:id/proficiency', async (req, res, { id }) => {
  const user = requireRole(req, 'teacher');
  const { proficiency } = await readBody(req);
  if (!LEVELS.includes(proficiency)) throw new ApiError(400, 'Unknown level');
  const pupil = ownPupil(user, Number(id));
  run('UPDATE pupils SET proficiency = ? WHERE id = ?', proficiency, pupil.id);
  send(res, 200, { ok: true, proficiency, levelLabel: LEVEL_LABELS[proficiency] });
});

// Bulk add pupils from a pasted namelist (JSON produced via ChatGPT).
const PROF_MAP = {
  weak: 'words', lemah: 'words', words: 'words',
  intermediate: 'sentences', sederhana: 'sentences', sentences: 'sentences',
  advance: 'paragraphs', advanced: 'paragraphs', mahir: 'paragraphs', paragraphs: 'paragraphs',
};

route('POST', '/api/teacher/pupils/bulk', async (req, res) => {
  const user = requireRole(req, 'teacher');
  const { classId, pupils } = await readBody(req);
  const cls = ownClass(user, Number(classId));
  if (!Array.isArray(pupils) || pupils.length === 0) throw new ApiError(400, 'No pupils in the request');
  if (pupils.length > 300) throw new ApiError(400, 'Maximum 300 pupils per import');
  const existing = new Set(q('SELECT student_no FROM pupils WHERE class_id = ?', cls.id).map((r) => r.student_no));
  let created = 0;
  const skipped = [];
  tx(() => {
    for (const raw of pupils) {
      const name = String(raw?.name ?? '').trim();
      const studentNo = String(raw?.studentNo ?? raw?.student_no ?? '').trim();
      if (!name || name.length > 80 || !studentNo || studentNo.length > 20) {
        skipped.push({ name, studentNo, reason: 'missing name or student number' });
        continue;
      }
      if (existing.has(studentNo)) {
        skipped.push({ name, studentNo, reason: 'duplicate student number' });
        continue;
      }
      existing.add(studentNo);
      const level = PROF_MAP[String(raw?.proficiency ?? '').toLowerCase()] || null;
      run('INSERT INTO pupils (class_id, name, student_no, proficiency, is_demo) VALUES (?,?,?,?,?)',
        cls.id, name, studentNo, level, cls.is_demo);
      created++;
    }
  });
  send(res, 201, { ok: true, created, skipped: skipped.length, skippedRows: skipped });
});

// Add a new pupil to a class namelist. Their personal QR card signs them into
// this record; the manual registration flow remains available as a fallback.
route('POST', '/api/teacher/pupils', async (req, res) => {
  const user = requireRole(req, 'teacher');
  const { classId, name, studentNo, proficiency } = await readBody(req);
  const cls = ownClass(user, Number(classId));
  const cleanName = String(name ?? '').trim();
  const cleanNo = String(studentNo ?? '').trim();
  if (!cleanName || cleanName.length > 80) throw new ApiError(400, 'Name is required (max 80 characters)');
  if (!cleanNo || cleanNo.length > 20) throw new ApiError(400, 'Student number is required (max 20 characters)');
  const clash = one('SELECT id FROM pupils WHERE class_id = ? AND student_no = ?', cls.id, cleanNo);
  if (clash) throw new ApiError(409, 'That student number is already used in this class');
  const level = LEVELS.includes(proficiency) ? proficiency : null;
  const pid = run('INSERT INTO pupils (class_id, name, student_no, proficiency, is_demo) VALUES (?,?,?,?,?)',
    cls.id, cleanName, cleanNo, level, cls.is_demo).lastInsertRowid;
  send(res, 201, { ok: true, id: pid });
});

// Edit a pupil's record (name / student number).
route('PATCH', '/api/teacher/pupils/:id', async (req, res, { id }) => {
  const user = requireRole(req, 'teacher');
  const pupil = ownPupil(user, Number(id));
  const { name, studentNo } = await readBody(req);
  const cleanName = String(name ?? '').trim();
  const cleanNo = String(studentNo ?? '').trim();
  if (!cleanName || cleanName.length > 80) throw new ApiError(400, 'Name is required (max 80 characters)');
  if (!cleanNo || cleanNo.length > 20) throw new ApiError(400, 'Student number is required (max 20 characters)');
  const clash = one('SELECT id FROM pupils WHERE class_id = ? AND student_no = ? AND id != ?', pupil.class_id, cleanNo, pupil.id);
  if (clash) throw new ApiError(409, 'That student number is already used in this class');
  run('UPDATE pupils SET name = ?, student_no = ? WHERE id = ?', cleanName, cleanNo, pupil.id);
  send(res, 200, { ok: true });
});

// Edit a homework template. Existing assignments keep their frozen snapshots;
// only homework assigned after the edit uses the new content.
route('PATCH', '/api/teacher/templates/:id', async (req, res, { id }) => {
  requireRole(req, 'teacher');
  const t = one('SELECT * FROM templates WHERE id = ?', Number(id));
  if (!t) throw new ApiError(404, 'Template not found');
  const { title, activityType, minutes, content } = await readBody(req);
  const cleanTitle = String(title ?? '').trim();
  if (!cleanTitle || cleanTitle.length > 120) throw new ApiError(400, 'Title is required');
  const cleanType = String(activityType ?? '').trim() || t.activity_type;
  const cleanMinutes = Math.min(180, Math.max(1, Number(minutes) || t.estimated_minutes));
  const contentError = validateTemplateContent(content);
  if (contentError) throw new ApiError(400, contentError);
  run('UPDATE templates SET title = ?, activity_type = ?, estimated_minutes = ?, content = ? WHERE id = ?',
    cleanTitle, cleanType, cleanMinutes, JSON.stringify(content), t.id);
  send(res, 200, { ok: true });
});

// Recovery for an incorrectly claimed name: unlink the account so the pupil
// record can be registered again. Homework history on the pupil record is kept.
route('POST', '/api/teacher/pupils/:id/unlink', async (req, res, { id }) => {
  const user = requireRole(req, 'teacher');
  const pupil = ownPupil(user, Number(id));
  if (!pupil.account_id) throw new ApiError(400, 'This pupil has no linked account');
  tx(() => {
    run('DELETE FROM sessions WHERE account_id = ?', pupil.account_id);
    run('UPDATE pupils SET account_id = NULL WHERE id = ?', pupil.id);
    run('DELETE FROM accounts WHERE id = ? AND role = ?', pupil.account_id, 'pupil');
  });
  send(res, 200, { ok: true, message: 'Account unlinked. The name can be registered again.' });
});

// =============================================================================
// TEACHER: templates
// =============================================================================
function templateCards() {
  const sets = q('SELECT * FROM template_sets ORDER BY id');
  const templates = q('SELECT * FROM templates ORDER BY id');
  return sets.map((s) => ({
    id: s.id,
    topic: s.topic,
    icon: s.icon,
    isDemo: !!s.is_demo,
    templates: templates
      .filter((t) => t.set_id === s.id)
      .map((t) => {
        const content = JSON.parse(t.content);
        return {
          id: t.id,
          level: t.level,
          levelLabel: LEVEL_LABELS[t.level],
          title: t.title,
          activityType: t.activity_type,
          minutes: t.estimated_minutes,
          questionCount: countQuestions(content),
          isDemo: !!t.is_demo,
        };
      }),
  }));
}

route('GET', '/api/teacher/templates', async (req, res) => {
  requireRole(req, 'teacher');
  send(res, 200, { sets: templateCards() });
});

// Create a brand-new topic set (no templates yet). Teachers build the set out
// in the Studio — one template per band via the manual editor or the AI chat.
route('POST', '/api/teacher/template-sets', async (req, res) => {
  requireRole(req, 'teacher');
  const { topic, icon } = await readBody(req);
  const cleanTopic = String(topic ?? '').trim();
  if (!cleanTopic || cleanTopic.length > 80) throw new ApiError(400, 'Topic is required (max 80 characters)');
  if (one('SELECT id FROM template_sets WHERE topic = ? COLLATE NOCASE', cleanTopic)) {
    throw new ApiError(409, 'A topic with this name already exists');
  }
  const cleanIcon = String(icon ?? '').trim().slice(0, 8) || '📚';
  const id = run('INSERT INTO template_sets (topic, icon, is_demo) VALUES (?,?,0)', cleanTopic, cleanIcon).lastInsertRowid;
  send(res, 201, { ok: true, id, topic: cleanTopic, icon: cleanIcon });
});

// Create (or replace) one band's template for a teacher-owned topic set.
route('POST', '/api/teacher/templates', async (req, res) => {
  requireRole(req, 'teacher');
  const { setId, level, title, activityType, minutes, content } = await readBody(req);
  const set = one('SELECT * FROM template_sets WHERE id = ?', Number(setId));
  if (!set) throw new ApiError(404, 'Template set not found');
  if (!LEVELS.includes(level)) throw new ApiError(400, 'Level must be words, sentences or paragraphs');
  const cleanTitle = String(title ?? '').trim();
  if (!cleanTitle || cleanTitle.length > 120) throw new ApiError(400, 'Title is required');
  const cleanType = String(activityType ?? '').trim() || 'Homework';
  const cleanMinutes = Math.min(180, Math.max(1, Number(minutes) || 10));
  const contentError = validateTemplateContent(content);
  if (contentError) throw new ApiError(400, contentError);
  const existing = one('SELECT id FROM templates WHERE set_id = ? AND level = ?', set.id, level);
  if (existing) {
    run('UPDATE templates SET title = ?, activity_type = ?, estimated_minutes = ?, content = ? WHERE id = ?',
      cleanTitle, cleanType, cleanMinutes, JSON.stringify(content), existing.id);
    send(res, 200, { ok: true, id: existing.id, replaced: true });
  } else {
    const id = run(
      'INSERT INTO templates (set_id, level, title, activity_type, estimated_minutes, content, is_demo) VALUES (?,?,?,?,?,?,0)',
      set.id, level, cleanTitle, cleanType, cleanMinutes, JSON.stringify(content)
    ).lastInsertRowid;
    send(res, 201, { ok: true, id });
  }
});

// Delete one band template so it can be rebuilt from scratch in the Studio.
route('DELETE', '/api/teacher/templates/:id', async (req, res, { id }) => {
  requireRole(req, 'teacher');
  const t = one('SELECT * FROM templates WHERE id = ?', Number(id));
  if (!t) throw new ApiError(404, 'Template not found');
  run('DELETE FROM templates WHERE id = ?', t.id);
  send(res, 200, { ok: true });
});

route('GET', '/api/teacher/templates/:id/preview', async (req, res, { id }) => {
  requireRole(req, 'teacher');
  const t = one('SELECT * FROM templates WHERE id = ?', Number(id));
  if (!t) throw new ApiError(404, 'Template not found');
  send(res, 200, {
    id: t.id,
    title: t.title,
    level: t.level,
    levelLabel: LEVEL_LABELS[t.level],
    activityType: t.activity_type,
    minutes: t.estimated_minutes,
    content: JSON.parse(t.content),
  });
});

// =============================================================================
// TEACHER: assignment workflow
// =============================================================================
// Preview which template each pupil would receive for a topic set.
route('GET', '/api/teacher/classes/:id/match', async (req, res, { id }) => {
  const user = requireRole(req, 'teacher');
  const cls = ownClass(user, Number(id));
  const url = new URL(req.url, 'http://x');
  const setId = Number(url.searchParams.get('setId'));
  const set = one('SELECT * FROM template_sets WHERE id = ?', setId);
  if (!set) throw new ApiError(404, 'Template set not found');
  const tmap = new Map(q('SELECT * FROM templates WHERE set_id = ?', setId).map((t) => [t.level, t]));
  const pupils = q('SELECT * FROM pupils WHERE class_id = ? ORDER BY name COLLATE NOCASE, student_no', cls.id);
  send(res, 200, {
    topic: set.topic,
    icon: set.icon,
    matches: pupils.map((p) => {
      const t = p.proficiency ? tmap.get(p.proficiency) : null;
      return {
        pupil: publicPupil(p),
        template: t
          ? { id: t.id, title: t.title, level: t.level, levelLabel: LEVEL_LABELS[t.level], minutes: t.estimated_minutes }
          : null,
      };
    }),
  });
});

// Create the assignment. Snapshots are stored per pupil assignment, so later
// template edits never change homework that has already been assigned.
route('POST', '/api/teacher/assign', async (req, res) => {
  const user = requireRole(req, 'teacher');
  const { setId, classId, dueDate, pupils: pupilSelection } = await readBody(req);
  if (!setId || !classId || !dueDate) throw new ApiError(400, 'Missing assignment details');
  if (!Array.isArray(pupilSelection) || pupilSelection.length === 0) {
    throw new ApiError(400, 'Select at least one pupil');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dueDate))) throw new ApiError(400, 'Due date is required');

  const cls = ownClass(user, classId);
  const set = one('SELECT * FROM template_sets WHERE id = ?', setId);
  if (!set) throw new ApiError(404, 'Template set not found');

  const { assignmentId, assigned } = tx(() => {
    const aid = run(
      'INSERT INTO assignments (class_id, teacher_id, set_id, title, due_date) VALUES (?,?,?,?,?)',
      cls.id, user.id, set.id, set.topic, dueDate
    ).lastInsertRowid;
    const tmap = new Map(q('SELECT * FROM templates WHERE set_id = ?', set.id).map((t) => [t.level, t]));
    let n = 0;
    for (const sel of pupilSelection) {
      const pid = Number(sel.pupilId);
      const level = LEVELS.includes(sel.level) ? sel.level : null;
      if (!level) continue;
      const pupil = one('SELECT id FROM pupils WHERE id = ? AND class_id = ?', pid, cls.id);
      if (!pupil) continue;
      const t = tmap.get(level);
      if (!t) continue;
      run(
        'INSERT INTO pupil_assignments (assignment_id, pupil_id, level, snapshot) VALUES (?,?,?,?)',
        aid, pid, t.level, t.content
      );
      n++;
    }
    if (n === 0) throw new ApiError(400, 'No pupils were assignable. Set a level for them first.');
    return { assignmentId: aid, assigned: n };
  });
  send(res, 201, { ok: true, assignmentId, assigned });
});

// =============================================================================
// TEACHER: homework manager
// =============================================================================
route('GET', '/api/teacher/assignments', async (req, res) => {
  const user = requireRole(req, 'teacher');
  const classId = Number(new URL(req.url, 'http://x').searchParams.get('classId')) || null;
  const rows = q(
    `SELECT a.id, a.title, a.due_date, a.class_id,
            COUNT(pa.id) AS assigned,
            SUM(CASE WHEN pa.status = 'submitted' THEN 1 ELSE 0 END) AS submitted,
            SUM(CASE WHEN pa.needs_review = 1 AND pa.reviewed = 0 THEN 1 ELSE 0 END) AS awaiting_review
       FROM assignments a
       LEFT JOIN pupil_assignments pa ON pa.assignment_id = a.id
      WHERE a.teacher_id = ? ${classId ? 'AND a.class_id = ?' : ''}
      GROUP BY a.id
      ORDER BY a.due_date DESC, a.id DESC`,
    ...(classId ? [user.id, classId] : [user.id])
  );
  send(res, 200, {
    assignments: rows.map((a) => ({
      id: a.id,
      title: a.title,
      dueDate: a.due_date,
      assigned: a.assigned,
      submitted: a.submitted,
      awaitingReview: a.awaiting_review,
    })),
  });
});

route('GET', '/api/teacher/assignments/:id', async (req, res, { id }) => {
  const user = requireRole(req, 'teacher');
  const a = one('SELECT * FROM assignments WHERE id = ?', Number(id));
  if (!a || a.teacher_id !== user.id) throw new ApiError(404, 'Assignment not found');
  const pas = q(
    `SELECT pa.*, p.name, p.student_no
       FROM pupil_assignments pa JOIN pupils p ON p.id = pa.pupil_id
      WHERE pa.assignment_id = ?
      ORDER BY p.name COLLATE NOCASE, p.student_no`,
    a.id
  );
  send(res, 200, {
    id: a.id,
    title: a.title,
    dueDate: a.due_date,
    pupils: pas.map((pa) => ({
      id: pa.id,
      pupilId: pa.pupil_id,
      name: pa.name,
      studentNo: pa.student_no,
      level: pa.level,
      levelLabel: LEVEL_LABELS[pa.level],
      status: paStatus(pa, a),
      score: pa.objective_score,
      firstAttemptScore: pa.first_attempt_score,
      needsReview: !!pa.needs_review,
      reviewed: !!pa.reviewed,
      hints: pa.hints_used,
      retries: pa.retries_used,
      submittedAt: pa.submitted_at,
    })),
  });
});

route('GET', '/api/teacher/pupil-assignments/:id', async (req, res, { id }) => {
  const user = requireRole(req, 'teacher');
  const pa = one('SELECT * FROM pupil_assignments WHERE id = ?', Number(id));
  if (!pa) throw new ApiError(404, 'Pupil assignment not found');
  const a = one('SELECT * FROM assignments WHERE id = ?', pa.assignment_id);
  if (!a || a.teacher_id !== user.id) throw new ApiError(404, 'Assignment not found');
  const pupil = one('SELECT * FROM pupils WHERE id = ?', pa.pupil_id);
  const snapshot = JSON.parse(pa.snapshot);
  const marking = markSnapshot(snapshot, JSON.parse(pa.answers || '{}'));
  send(res, 200, {
    id: pa.id,
    pupil: publicPupil(pupil),
    assignment: { id: a.id, title: a.title, dueDate: a.due_date },
    level: pa.level,
    levelLabel: LEVEL_LABELS[pa.level],
    status: paStatus(pa, a),
    score: pa.objective_score,
    firstAttemptScore: pa.first_attempt_score,
    hints: pa.hints_used,
    retries: pa.retries_used,
    submittedAt: pa.submitted_at,
    feedback: pa.teacher_feedback,
    reviewed: !!pa.reviewed,
    snapshot,
    marking: { detail: marking.detail, needsReview: marking.needsReview, written: marking.written },
  });
});

// Teacher feedback on written answers. Saving feedback marks the work reviewed.
route('POST', '/api/teacher/pupil-assignments/:id/feedback', async (req, res, { id }) => {
  const user = requireRole(req, 'teacher');
  const pa = one('SELECT * FROM pupil_assignments WHERE id = ?', Number(id));
  if (!pa) throw new ApiError(404, 'Pupil assignment not found');
  const a = one('SELECT * FROM assignments WHERE id = ?', pa.assignment_id);
  if (!a || a.teacher_id !== user.id) throw new ApiError(404, 'Assignment not found');
  const { feedback } = await readBody(req);
  run(
    'UPDATE pupil_assignments SET teacher_feedback = ?, reviewed = 1 WHERE id = ?',
    String(feedback ?? '').slice(0, 1000), pa.id
  );
  send(res, 200, { ok: true });
});

// =============================================================================
// TEACHER: pupil progress
// =============================================================================
route('GET', '/api/teacher/pupils/:id/progress', async (req, res, { id }) => {
  const user = requireRole(req, 'teacher');
  const pupil = ownPupil(user, Number(id));
  const cls = one('SELECT * FROM classes WHERE id = ?', pupil.class_id);
  const pas = q(
    `SELECT pa.*, a.title, a.due_date
       FROM pupil_assignments pa JOIN assignments a ON a.id = pa.assignment_id
      WHERE pa.pupil_id = ?
      ORDER BY a.due_date DESC, a.id DESC`,
    pupil.id
  );

  const allDetails = [];
  const homework = pas.map((pa) => {
    const snapshot = JSON.parse(pa.snapshot);
    const marking = markSnapshot(snapshot, JSON.parse(pa.answers || '{}'));
    allDetails.push(...marking.detail);
    return {
      id: pa.id,
      assignmentId: pa.assignment_id,
      title: pa.title,
      dueDate: pa.due_date,
      level: pa.level,
      levelLabel: LEVEL_LABELS[pa.level],
      status: paStatus(pa, pa), // pa carries due_date from the join
      score: pa.objective_score,
      firstAttemptScore: pa.first_attempt_score,
      hints: pa.hints_used,
      retries: pa.retries_used,
      submittedAt: pa.submitted_at,
      feedback: pa.teacher_feedback,
      reviewed: !!pa.reviewed,
      written: marking.written,
    };
  });

  // Honest, basic analytics: real units answered, real units correct. Written
  // work counts reviews, not auto-scores. Nothing invented, no labels.
  const analytics = { words: emptyStats(), sentences: emptyStats(), paragraphs: emptyStats() };
  const snapshotById = new Map(pas.map((pa) => [pa.id, pa]));
  for (const h of homework) {
    if (h.status !== 'submitted') continue;
    const st = analytics[h.level];
    const snapshot = JSON.parse(snapshotById.get(h.id).snapshot);
    st.units += objectiveUnitCount(snapshot);
    st.correct += Math.round((h.score ?? 0) * objectiveUnitCount(snapshot));
    if (h.firstAttemptScore != null) {
      st.firstUnits += objectiveUnitCount(snapshot);
      st.firstCorrect += Math.round(h.firstAttemptScore * objectiveUnitCount(snapshot));
    }
    if (h.written.length) {
      st.writtenTotal += h.written.length;
      if (h.reviewed) st.writtenReviewed += h.written.length;
    }
  }

  send(res, 200, {
    pupil: publicPupil(pupil),
    className: cls.name,
    proficiency: pupil.proficiency,
    levelLabel: pupil.proficiency ? LEVEL_LABELS[pupil.proficiency] : null,
    homework,
    analytics,
    recurringErrors: recurringErrors(allDetails),
  });
});

function emptyStats() {
  return { units: 0, correct: 0, firstUnits: 0, firstCorrect: 0, writtenTotal: 0, writtenReviewed: 0 };
}
function objectiveUnitCount(snapshot) {
  let n = 0;
  for (const q of snapshot.questions) {
    if (q.kind === 'choice' || q.kind === 'choicePic') n += q.items.length;
    else if (q.kind === 'match') n += q.pairs.length;
    else if (q.kind === 'arrange') n += 1;
  }
  return n;
}

// =============================================================================
// PUPIL: own homework only
// =============================================================================
route('GET', '/api/pupil/homework', async (req, res) => {
  const user = requireRole(req, 'pupil');
  const p = one('SELECT * FROM pupils WHERE account_id = ?', user.id);
  if (!p) throw new ApiError(403, 'No pupil profile linked to this account');
  const rows = q(
    `SELECT pa.*, a.title, a.due_date
       FROM pupil_assignments pa JOIN assignments a ON a.id = pa.assignment_id
      WHERE pa.pupil_id = ?
      ORDER BY a.due_date ASC, a.id ASC`,
    p.id
  );
  send(res, 200, {
    pupil: { name: p.name, studentNo: p.student_no, proficiency: p.proficiency },
    homework: rows.map((pa) => ({
      id: pa.id,
      title: pa.title,
      dueDate: pa.due_date,
      status: paStatus(pa, pa),
      hasFeedback: !!pa.teacher_feedback,
      submittedAt: pa.submitted_at,
    })),
  });
});

route('GET', '/api/pupil/pupil-assignments/:id', async (req, res, { id }) => {
  const user = requireRole(req, 'pupil');
  const pa = one('SELECT * FROM pupil_assignments WHERE id = ?', Number(id));
  const p = one('SELECT * FROM pupils WHERE account_id = ?', user.id);
  if (!pa || !p || pa.pupil_id !== p.id) throw new ApiError(404, 'Homework not found');
  const a = one('SELECT * FROM assignments WHERE id = ?', pa.assignment_id);
  send(res, 200, {
    id: pa.id,
    title: a.title,
    dueDate: a.due_date,
    status: paStatus(pa, a),
    answers: JSON.parse(pa.answers || '{}'),
    hintsUsed: pa.hints_used,
    retriesUsed: pa.retries_used,
    submitted: pa.status === 'submitted',
    feedback: pa.teacher_feedback || null,
    reviewed: !!pa.reviewed,
    snapshot: sanitizeSnapshotForPupil(JSON.parse(pa.snapshot)),
  });
});

// Autosave progress so pupils can continue later. Never marks anything.
route('POST', '/api/pupil/pupil-assignments/:id/save', async (req, res, { id }) => {
  const user = requireRole(req, 'pupil');
  const pa = one('SELECT * FROM pupil_assignments WHERE id = ?', Number(id));
  const p = one('SELECT * FROM pupils WHERE account_id = ?', user.id);
  if (!pa || !p || pa.pupil_id !== p.id) throw new ApiError(404, 'Homework not found');
  if (pa.status === 'submitted') throw new ApiError(400, 'This homework is already submitted');
  const { answers, hintsUsed, retriesUsed } = await readBody(req);
  const merged = { ...(JSON.parse(pa.answers || '{}')), ...(answers || {}) };
  run(
    `UPDATE pupil_assignments
        SET answers = ?, status = 'in_progress',
            hints_used = hints_used + ?, retries_used = retries_used + ?
      WHERE id = ?`,
    JSON.stringify(merged), Number(hintsUsed) || 0, Number(retriesUsed) || 0, pa.id
  );
  send(res, 200, { ok: true, saved: true });
});

// Submit: auto-mark objective units, flag written answers for review.
route('POST', '/api/pupil/pupil-assignments/:id/submit', async (req, res, {
  id,
}) => {
  const user = requireRole(req, 'pupil');
  const pa = one('SELECT * FROM pupil_assignments WHERE id = ?', Number(id));
  const p = one('SELECT * FROM pupils WHERE account_id = ?', user.id);
  if (!pa || !p || pa.pupil_id !== p.id) throw new ApiError(404, 'Homework not found');
  if (pa.status === 'submitted') throw new ApiError(400, 'This homework is already submitted');
  const { answers, hintsUsed, retriesUsed, attemptsLog } = await readBody(req);
  const merged = { ...(JSON.parse(pa.answers || '{}')), ...(answers || {}) };
  const snapshot = JSON.parse(pa.snapshot);
  const marking = markSnapshot(snapshot, merged);
  const firstAttempt = firstAttemptScore(snapshot, merged, attemptsLog || []);
  run(
    `UPDATE pupil_assignments
        SET answers = ?, status = 'submitted', submitted_at = datetime('now'),
            objective_score = ?, first_attempt_score = ?, needs_review = ?,
            hints_used = hints_used + ?, retries_used = retries_used + ?
      WHERE id = ?`,
    JSON.stringify(merged), marking.score, firstAttempt, marking.needsReview ? 1 : 0,
    Number(hintsUsed) || 0, Number(retriesUsed) || 0, pa.id
  );
  send(res, 200, { ok: true, score: marking.score, needsReview: marking.needsReview });
});

// First-attempt accuracy: replace final answers with the recorded first
// answers, then mark. Only units the pupil actually attempted first count.
function firstAttemptScore(snapshot, finalAnswers, attemptsLog) {
  if (!Array.isArray(attemptsLog) || attemptsLog.length === 0) return null;
  const byQid = new Map();
  for (const entry of attemptsLog) {
    if (!entry || entry.qid == null) continue;
    if (!byQid.has(entry.qid)) byQid.set(entry.qid, []);
    byQid.get(entry.qid).push(entry);
  }
  const firstAnswers = JSON.parse(JSON.stringify(finalAnswers));
  for (const [qid, entries] of byQid) {
    const q = snapshot.questions.find((x) => x.id === qid);
    if (!q) continue;
    if (q.kind === 'arrange' || q.kind === 'written') {
      const withAnswer = entries.find((e) => e.firstAnswer != null);
      if (withAnswer) firstAnswers[qid] = withAnswer.firstAnswer;
    } else {
      firstAnswers[qid] = { ...(firstAnswers[qid] || {}) };
      for (const e of entries) {
        if (e.sub != null && e.firstAnswer != null) firstAnswers[qid][e.sub] = e.firstAnswer;
      }
    }
  }
  const m = markSnapshot(snapshot, firstAnswers);
  return m.score;
}

// =============================================================================
// homework pictures
// =============================================================================
// The `picture` field on target words / question items / match pairs stays a
// plain string: an emoji, a /img/<id> reference to an uploaded image, or an
// external https link. Uploads are stored as blobs and served publicly from
// /img/:id (ids are unguessable) so pupils can render them without a teacher
// session. Blobs are never deleted — frozen assignment snapshots keep working.
const IMAGE_MAX_BYTES = 2 * 1024 * 1024;

// Sniff real content instead of trusting the client-declared MIME type.
function sniffImageMime(buf) {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 6 && buf.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

route('POST', '/api/teacher/images', async (req, res) => {
  requireRole(req, 'teacher');
  const buf = await readRawBody(req, IMAGE_MAX_BYTES);
  if (!buf.length) throw new ApiError(400, 'Empty image');
  const mime = sniffImageMime(buf);
  if (!mime) throw new ApiError(415, 'Only PNG, JPEG, GIF or WebP images are allowed');
  const id = randomBytes(8).toString('hex');
  run('INSERT INTO images (id, mime, data, size) VALUES (?, ?, ?, ?)', id, mime, buf, buf.length);
  send(res, 200, { url: `/img/${id}` });
});

route('GET', '/img/:id', async (req, res, { id }) => {
  if (!/^[0-9a-f]{16}$/.test(id)) throw new ApiError(404, 'Not found');
  const img = one('SELECT mime, data FROM images WHERE id = ?', id);
  if (!img) throw new ApiError(404, 'Not found');
  const body = Buffer.from(img.data);
  res.writeHead(200, {
    'Content-Type': img.mime,
    'Content-Length': body.length,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
});

// =============================================================================
// server bootstrap + static files
// =============================================================================
const server = http.createServer(async (req, res) => {
  try {
    attachUser(req);
    const url = new URL(req.url, 'http://x');
    const pathname = decodeURIComponent(url.pathname);

    if (pathname.startsWith('/api/')) {
      const m = matchRoute(req.method, pathname);
      if (m) {
        if (!cloudStoreEnabled()) return await m.handler(req, res, m.params);
        let status = 200;
        let headers = {};
        let body;
        const buffered = {
          writeHead(code, nextHeaders = {}) { status = code; headers = nextHeaders; },
          end(data) { body = data; },
        };
        await m.handler(req, buffered, m.params);
        await flushCloud();
        res.writeHead(status, headers);
        return res.end(body);
      }
      return send(res, 404, { error: 'Not found' });
    }

    // uploaded picture blobs live in the route registry but outside /api/
    if (pathname.startsWith('/img/')) {
      const m = matchRoute('GET', pathname);
      if (m) return await m.handler(req, res, m.params);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }

    // static files with directory-traversal protection
    const safePath = path.normalize(pathname).replace(/^([/\\])+/, '');
    let filePath = path.join(PUBLIC_DIR, safePath);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403); return res.end('Forbidden');
    }
    if (pathname === '/') filePath = path.join(PUBLIC_DIR, 'index.html');
    try {
      const data = fs.readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>404 · page not found</h1><p><a href="/">Back to home</a></p>');
    }
  } catch (e) {
    const status = e instanceof ApiError ? e.status : 500;
    if (status === 500) console.error(e);
    send(res, status, { error: e.message || 'Server error' });
  }
});

export async function startServer({ port = PORT, seed = false } = {}) {
  if (seed) {
    const r = seedDemo();
    if (r.seeded) console.log('Demo data seeded (labelled is_demo=1, separate from real records).');
    const rp = ensureDemoPupil();
    if (rp.seeded) console.log('Demo pupil access account created (labelled is_demo=1).');
    relabelDemoTemplates();
    await flushCloud();
  } else {
    const cleaned = removeDemoData();
    if (Object.values(cleaned).some(Boolean)) {
      console.log(`Demo data removed; preserved 6 Mawar and renamed the teacher to Ms Falisha (${JSON.stringify(cleaned)}).`);
    }
    await flushCloud();
  }
  return new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`Year 6 English intervention platform running at http://localhost:${port}`);
      resolve(server);
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
