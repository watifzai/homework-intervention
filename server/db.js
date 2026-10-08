// ---------------------------------------------------------------------------
// Database layer — node:sqlite (built into Node >= 22.5), zero dependencies.
// Shared state lives here; the browser never stores homework data.
//
// Demo rows (classes, pupils, templates, demo teacher) carry is_demo = 1 so
// they can be clearly labelled and separated from real records.
// ---------------------------------------------------------------------------
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { restoreCloudDatabase, markCloudDirty, flushCloudDatabase, cloudStoreEnabled } from './cloud-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.Y6_DB_DIR || path.join(__dirname, '..', 'data');
export const DB_PATH = process.env.Y6_DB_PATH || path.join(DATA_DIR, 'intervention.db');

if (typeof DATA_DIR === 'string' && !fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

export const LEVELS = ['words', 'sentences', 'paragraphs'];
export const LEVEL_LABELS = {
  words: 'Weak',
  sentences: 'Intermediate',
  paragraphs: 'Advanced',
};

// --- schema -----------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('teacher','pupil')),
  display_name TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,              -- used on the pupil registration link
  reg_code TEXT NOT NULL UNIQUE,         -- teacher-issued pupil registration code
  teacher_id INTEGER NOT NULL REFERENCES accounts(id),
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pupils (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id),
  name TEXT NOT NULL,
  student_no TEXT NOT NULL,              -- distinguishes pupils with identical names
  proficiency TEXT CHECK (proficiency IN ('words','sentences','paragraphs') OR proficiency IS NULL),
  account_id INTEGER UNIQUE REFERENCES accounts(id),  -- one account per pupil, DB-enforced
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (class_id, student_no)
);

CREATE TABLE IF NOT EXISTS template_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL UNIQUE,
  icon TEXT NOT NULL DEFAULT '📚',
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id INTEGER NOT NULL REFERENCES template_sets(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('words','sentences','paragraphs')),
  title TEXT NOT NULL,
  activity_type TEXT NOT NULL,
  estimated_minutes INTEGER NOT NULL DEFAULT 10,
  content TEXT NOT NULL,                 -- JSON: readings, questions, answers, hints
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (set_id, level)
);

CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id),
  teacher_id INTEGER NOT NULL REFERENCES accounts(id),
  set_id INTEGER NOT NULL REFERENCES template_sets(id),
  title TEXT NOT NULL,                   -- frozen topic title
  due_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per pupil per assignment. The content snapshot lives here so that
-- later template edits never alter homework that was already assigned, and
-- so one topic assignment can serve different levels to different pupils.
CREATE TABLE IF NOT EXISTS pupil_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  pupil_id INTEGER NOT NULL REFERENCES pupils(id),
  level TEXT NOT NULL CHECK (level IN ('words','sentences','paragraphs')),
  snapshot TEXT NOT NULL,                -- JSON snapshot of the level template
  status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started','in_progress','submitted')),
  answers TEXT,                          -- JSON: { [questionId]: answer }
  hints_used INTEGER NOT NULL DEFAULT 0,
  retries_used INTEGER NOT NULL DEFAULT 0,
  attempts_log TEXT,                      -- JSON array of first attempts per question
  objective_score REAL,                 -- final auto-marked accuracy 0..1
  first_attempt_score REAL,             -- accuracy before hints/retries
  needs_review INTEGER NOT NULL DEFAULT 0,
  submitted_at TEXT,
  teacher_feedback TEXT,
  reviewed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (assignment_id, pupil_id)
);

CREATE INDEX IF NOT EXISTS idx_pupils_class ON pupils(class_id);
CREATE INDEX IF NOT EXISTS idx_pa_pupil ON pupil_assignments(pupil_id);
CREATE INDEX IF NOT EXISTS idx_pa_assignment ON pupil_assignments(assignment_id);

-- Homework pictures uploaded by teachers (PNG/JPEG/GIF/WebP). Template
-- content only stores the /img/<id> reference; blobs are never deleted so
-- frozen assignment snapshots keep rendering.
CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,                    -- 16 hex chars, unguessable
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

const cloudRestore = await restoreCloudDatabase(db);
if (cloudRestore.enabled) {
  console.log(`Firebase persistence enabled (${cloudRestore.restored} rows restored).`);
}

// --- tiny helpers -------------------------------------------------------------
export function q(sql, ...params) {
  return db.prepare(sql).all(...params);
}
export function one(sql, ...params) {
  return db.prepare(sql).get(...params);
}
export function run(sql, ...params) {
  const result = db.prepare(sql).run(...params);
  markCloudDirty();
  return result;
}
export function tx(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function flushCloud() {
  return flushCloudDatabase(db);
}

export { cloudStoreEnabled };
