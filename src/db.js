// src/db.js
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

// --- Make sure the data directory exists before we try to open the DB file. ---
// (Section 01-setup also does this on boot, but we do it here too so that
//  running scripts/seed.js or this file directly never fails on a fresh clone.)
fs.mkdirSync(config.DATA_DIR, { recursive: true });

// --- Open the single SQLite database file (created automatically if missing). ---
const db = new Database(config.DB_PATH);

// --- Pragmas: safety + speed settings, applied every time the DB is opened. ---
// WAL = Write-Ahead Logging: better read/write concurrency and durability.
db.pragma('journal_mode = WAL');
// Foreign keys are OFF by default in SQLite; turn them ON so the
// REFERENCES ... ON DELETE CASCADE constraints below are enforced.
db.pragma('foreign_keys = ON');

// --- Schema: create every table if it does not already exist. ---
// exec() runs multiple statements in one call. Running this repeatedly is safe
// because of the "IF NOT EXISTS" guards.
db.exec(`
  CREATE TABLE IF NOT EXISTS guests (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    token         TEXT    NOT NULL UNIQUE,
    name          TEXT    NOT NULL DEFAULT '',
    avatar_path   TEXT,
    social_links  TEXT    NOT NULL DEFAULT '{}',
    bonus_points  INTEGER NOT NULL DEFAULT 0,
    onboarded     INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title        TEXT    NOT NULL,
    description  TEXT    NOT NULL DEFAULT '',
    sort_order   INTEGER NOT NULL DEFAULT 0,
    is_active    INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS submissions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guest_id    INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
    task_id     INTEGER NOT NULL REFERENCES tasks(id)  ON DELETE CASCADE,
    photo_path  TEXT    NOT NULL,
    thumb_path  TEXT    NOT NULL,
    caption     TEXT    NOT NULL DEFAULT '',
    taken_down  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    CONSTRAINT uq_sub UNIQUE (guest_id, task_id)
  );

  CREATE TABLE IF NOT EXISTS badges (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    code         TEXT    NOT NULL UNIQUE,
    name         TEXT    NOT NULL,
    type         TEXT    NOT NULL CHECK (type IN ('auto','special')),
    threshold    INTEGER,
    art_path     TEXT    NOT NULL,
    description  TEXT    NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS guest_badges (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guest_id    INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
    badge_id    INTEGER NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
    awarded_by  TEXT    NOT NULL CHECK (awarded_by IN ('system','admin')),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    CONSTRAINT uq_gb UNIQUE (guest_id, badge_id)
  );

  CREATE TABLE IF NOT EXISTS likes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    guest_id      INTEGER NOT NULL REFERENCES guests(id)      ON DELETE CASCADE,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (submission_id, guest_id)
  );

  CREATE TABLE IF NOT EXISTS comments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    guest_id      INTEGER NOT NULL REFERENCES guests(id)      ON DELETE CASCADE,
    body          TEXT    NOT NULL,
    taken_down    INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_submissions_photo_path
    ON submissions(photo_path COLLATE NOCASE);

  CREATE INDEX IF NOT EXISTS idx_submissions_thumb_path
    ON submissions(thumb_path COLLATE NOCASE);

  CREATE INDEX IF NOT EXISTS idx_likes_submission
    ON likes(submission_id);

  CREATE INDEX IF NOT EXISTS idx_comments_submission
    ON comments(submission_id, taken_down);
`);

// --- Guarded migration: submissions.photo_bonus (issue #89) ---
/**
 * Add submissions.photo_bonus if it is not already present.
 *
 * The submissions CREATE TABLE above deliberately omits photo_bonus, so the
 * column is absent on BOTH a fresh DB and an existing pre-change app.db; on
 * either, the ALTER TABLE ... ADD COLUMN adds it on the first boot. PRAGMA
 * table_info lists the table's current columns; we run ADD COLUMN only when
 * photo_bonus is absent, so every later boot (or a repeat call) is a no-op and
 * never throws "duplicate column" (AC1). Exported so tests bind to this real
 * guard rather than an inline copy of it.
 */
function ensurePhotoBonusColumn() {
  const cols = db.prepare(`PRAGMA table_info(submissions)`).all();
  if (!cols.some((col) => col.name === 'photo_bonus')) {
    db.exec(`ALTER TABLE submissions ADD COLUMN photo_bonus INTEGER NOT NULL DEFAULT 0`);
  }
}

// Run once at module load, before scoring.js prepares any statement that reads
// photo_bonus — db.js fully evaluates this module-load code before any other
// module's `require('../db')` call returns.
ensurePhotoBonusColumn();

// --- Shared helpers used by other sections (scoring, profiles, gallery, etc.). ---

/**
 * Load a single guest row by its sign-in token, or undefined if none.
 * Used by the auth/session middleware in section 03.
 * @param {string} token
 * @returns {object|undefined}
 */
function getGuestByToken(token) {
  return db.prepare(`SELECT * FROM guests WHERE token = ?`).get(token);
}

/**
 * Load a single guest row by numeric id, or undefined if none.
 * @param {number} guestId
 * @returns {object|undefined}
 */
function getGuestById(guestId) {
  return db.prepare(`SELECT * FROM guests WHERE id = ?`).get(guestId);
}

module.exports = {
  db,
  ensurePhotoBonusColumn,
  getGuestByToken,
  getGuestById,
};
