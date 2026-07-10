// src/db.js
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');
const { ensureBadgeCatalog: ensureBadgeCatalogRows } = require('../scripts/badge-catalog');

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
    contact       TEXT,
    contact_type  TEXT,
    pin           TEXT,
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
    -- task_id is nullable (issue #247): a NULL task_id marks a "memory" — a
    -- guest photo shared straight to the gallery with no matching task. A
    -- fresh DB gets the nullable column directly here; ensureTaskIdNullable()
    -- below is the guarded rebuild that widens an existing pre-#247 app.db
    -- (which has task_id NOT NULL) to match.
    task_id     INTEGER REFERENCES tasks(id)  ON DELETE CASCADE,
    photo_path  TEXT    NOT NULL,
    thumb_path  TEXT    NOT NULL,
    caption     TEXT    NOT NULL DEFAULT '',
    taken_down  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    -- UNIQUE(guest_id, task_id) still holds: SQLite treats every NULL as
    -- distinct from every other value (including other NULLs) under a UNIQUE
    -- constraint, so a guest may have any number of task_id=NULL memory rows
    -- alongside at most one row per real task — do not "fix" this constraint.
    CONSTRAINT uq_sub UNIQUE (guest_id, task_id)
  );

  CREATE TABLE IF NOT EXISTS badges (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    code         TEXT    NOT NULL UNIQUE,
    name         TEXT    NOT NULL,
    type         TEXT    NOT NULL CHECK (type IN ('auto','special','metric','transferable','custom')),
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

  CREATE TABLE IF NOT EXISTS bug_reports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guest_id    INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
    body        TEXT    NOT NULL,
    page        TEXT,
    user_agent  TEXT,
    resolved    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_bug_reports_resolved
    ON bug_reports(resolved, created_at DESC);

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

// --- Guarded migration: widen badges.type CHECK (issue #80) ---
/**
 * Widen the `badges.type` CHECK to accept 'metric'/'transferable'/'custom'
 * alongside the existing 'auto'/'special', if it does not already.
 *
 * SQLite cannot ALTER a CHECK constraint in place, so on an old-vocabulary
 * table we rebuild it: create a new table with the widened CHECK, copy every
 * row across (preserving id via INSERT ... SELECT with explicit columns so
 * guest_badges.badge_id foreign keys stay valid), drop the old table, and
 * rename the new one into place — all inside one transaction so a mid-migration
 * crash cannot leave the database half-migrated.
 *
 * Detection: read sqlite_master's stored CREATE TABLE SQL for `badges` and
 * check whether it mentions 'metric'. A fresh DB's CREATE TABLE IF NOT EXISTS
 * above already carries the widened CHECK, so this is a no-op there too.
 * Exported so tests can bind to this real guard rather than an inline copy.
 */
function ensureBadgeTypeCheckWidened() {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'badges'`)
    .get();
  if (!row || row.sql.includes("'metric'")) {
    // No badges table yet, or already widened — nothing to do.
    return;
  }

  // guest_badges.badge_id REFERENCES badges(id): dropping `badges` mid-rebuild
  // trips FK enforcement even though the replacement table restores the same
  // ids, so foreign_keys is turned off for the duration of the rebuild only,
  // exactly as SQLite's own documented "12 steps" ALTER-TABLE recipe requires,
  // and turned back on immediately after (this is NOT the app's steady-state
  // pragma, which stays ON at every other point in this file).
  db.pragma('foreign_keys = OFF');
  try {
    const migrate = db.transaction(() => {
      db.exec(`
        CREATE TABLE badges_new (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          code         TEXT    NOT NULL UNIQUE,
          name         TEXT    NOT NULL,
          type         TEXT    NOT NULL CHECK (type IN ('auto','special','metric','transferable','custom')),
          threshold    INTEGER,
          art_path     TEXT    NOT NULL,
          description  TEXT    NOT NULL DEFAULT ''
        );

        INSERT INTO badges_new (id, code, name, type, threshold, art_path, description)
          SELECT id, code, name, type, threshold, art_path, description FROM badges;

        DROP TABLE badges;
        ALTER TABLE badges_new RENAME TO badges;
      `);
    });
    migrate();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

ensureBadgeTypeCheckWidened();

// --- Guarded migration: guests.pinned (issue #251) ---
/**
 * Add guests.pinned if it is not already present.
 *
 * pinned = 1 hoists a guest's section to the top of the gallery's By-person
 * view regardless of recency (the hosts' own section leads). Same pattern as
 * ensurePhotoBonusColumn above: the guests CREATE TABLE deliberately omits
 * the column, PRAGMA table_info detects absence, and the ALTER TABLE runs at
 * most once — so both a fresh DB and an existing pre-change app.db gain the
 * column on first boot, and every later boot is a no-op. Exported so tests
 * bind to this real guard rather than an inline copy of it.
 */
function ensurePinnedColumn() {
  const cols = db.prepare(`PRAGMA table_info(guests)`).all();
  if (!cols.some((col) => col.name === 'pinned')) {
    db.exec(`ALTER TABLE guests ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
  }
}

// Run at module load, before feed.js prepares any statement that reads
// g.pinned — db.js fully evaluates this module-load code before any other
// module's `require('../db')` call returns.
ensurePinnedColumn();

// --- Guarded migration: guests.contact / contact_type / pin (issue #239) ---
/**
 * Add guests.contact, guests.contact_type, and guests.pin if any is not
 * already present, then (re)create the partial unique index on contact.
 *
 * Same pattern as ensurePhotoBonusColumn/ensurePinnedColumn above: the guests
 * CREATE TABLE above already carries all three columns, so this is a no-op on
 * a fresh DB. On an existing pre-#239 app.db none of the three columns exist
 * yet, so PRAGMA table_info detects each absence and the ALTER TABLE runs
 * once per column; every later boot (or repeat call) is a no-op and never
 * throws "duplicate column" (AC1).
 *
 * The unique index is created here — AFTER the columns are guaranteed to
 * exist — rather than in the top-level CREATE TABLE/INDEX block above,
 * because on a pre-#239 DB that block runs BEFORE this migration and
 * `guests.contact` would not exist yet for CREATE INDEX to reference. The
 * index is partial (WHERE contact IS NOT NULL) so the many contact-less rows
 * a legacy or seeded DB carries don't collide with each other under a
 * plain UNIQUE constraint — only two rows that both set a real contact value
 * can collide (AC6).
 *
 * Exported so tests bind to this real guard rather than an inline copy of it.
 */
function ensureGuestIdentityColumns() {
  const cols = db.prepare(`PRAGMA table_info(guests)`).all();
  const names = new Set(cols.map((col) => col.name));
  if (!names.has('contact')) {
    db.exec(`ALTER TABLE guests ADD COLUMN contact TEXT`);
  }
  if (!names.has('contact_type')) {
    db.exec(`ALTER TABLE guests ADD COLUMN contact_type TEXT`);
  }
  if (!names.has('pin')) {
    db.exec(`ALTER TABLE guests ADD COLUMN pin TEXT`);
  }
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_guests_contact ON guests(contact) WHERE contact IS NOT NULL`
  );
}

// Run at module load, before any signup/re-entry route (#240, #241) prepares
// a statement that reads or writes contact/contact_type/pin — db.js fully
// evaluates this module-load code before any other module's
// `require('../db')` call returns.
ensureGuestIdentityColumns();

// --- Guarded migration: submissions.task_id nullable (issue #247) ---
/**
 * Widen submissions.task_id from NOT NULL to nullable, if it is not already,
 * so a "memory" (a guest photo with no matching task) can be stored as a
 * submissions row with task_id = NULL instead of needing a second table.
 *
 * SQLite cannot ALTER a column's NOT NULL constraint in place, so on an
 * old-shape table (pre-#247) we rebuild it — same recipe as
 * ensureBadgeTypeCheckWidened above: create a new table with the widened
 * column, copy every row across (explicit column list, preserving id so
 * likes/comments foreign keys on submission_id stay valid), drop the old
 * table, rename the new one into place, all inside one transaction so a
 * mid-migration crash cannot leave the database half-migrated. Runs AFTER
 * ensurePhotoBonusColumn() above so photo_bonus already exists on the source
 * table and is carried across by the copy.
 *
 * Detection: PRAGMA table_info's `notnull` flag for the task_id column. A
 * fresh DB's CREATE TABLE IF NOT EXISTS above already declares task_id
 * nullable, so this is a no-op there (and a no-op on every later boot once an
 * existing DB has been migrated once). Exported so tests can bind to this
 * real guard rather than an inline copy of it.
 */
function ensureTaskIdNullable() {
  const cols = db.prepare(`PRAGMA table_info(submissions)`).all();
  const taskCol = cols.find((col) => col.name === 'task_id');
  if (!taskCol || taskCol.notnull === 0) {
    // No submissions table yet, or task_id is already nullable — nothing to do.
    return;
  }

  // likes/comments both REFERENCE submissions(id) ON DELETE CASCADE: dropping
  // `submissions` mid-rebuild trips FK enforcement even though the
  // replacement table restores the same ids, so foreign_keys is turned off
  // for the duration of the rebuild only (SQLite's documented 12-step
  // ALTER-TABLE recipe), and turned back on immediately after.
  db.pragma('foreign_keys = OFF');
  try {
    const migrate = db.transaction(() => {
      db.exec(`
        CREATE TABLE submissions_new (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          guest_id    INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
          task_id     INTEGER REFERENCES tasks(id)  ON DELETE CASCADE,
          photo_path  TEXT    NOT NULL,
          thumb_path  TEXT    NOT NULL,
          caption     TEXT    NOT NULL DEFAULT '',
          taken_down  INTEGER NOT NULL DEFAULT 0,
          photo_bonus INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
          CONSTRAINT uq_sub UNIQUE (guest_id, task_id)
        );

        INSERT INTO submissions_new
          (id, guest_id, task_id, photo_path, thumb_path, caption, taken_down, photo_bonus, created_at)
          SELECT id, guest_id, task_id, photo_path, thumb_path, caption, taken_down, photo_bonus, created_at
            FROM submissions;

        DROP TABLE submissions;
        ALTER TABLE submissions_new RENAME TO submissions;

        CREATE INDEX IF NOT EXISTS idx_submissions_photo_path
          ON submissions(photo_path COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_submissions_thumb_path
          ON submissions(thumb_path COLLATE NOCASE);
      `);
    });
    migrate();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

ensureTaskIdNullable();

// --- Guarded migration: badge catalog boot-heal (issue #314) ---
/**
 * Heal the badges table with any catalog rows added since this database was
 * first seeded (e.g. #193's COMPLETIONIST/MOSTPHOTOS) — the boot path that
 * already owns "make an old database current", extended to cover a played-in
 * database that was never re-seeded. Delegates to the one shared catalog +
 * insert function in scripts/badge-catalog.js (consolidated #314) so
 * scripts/seed.js, scripts/seed-event.js, and this boot path can never drift
 * into separate catalogs (#193 AC4's guarantee).
 *
 * Insert-only (INSERT OR IGNORE keyed on badges.code), so an existing row —
 * including one an admin has hand-edited — is never overwritten. Runs AFTER
 * ensureBadgeTypeCheckWidened() (badges' CHECK already accepts every type
 * the catalog uses) and after ensureTaskIdNullable() (the last of the
 * guarded shape migrations), following the same define-call-export pattern
 * as every migration above. Exported so tests can bind to this real guard
 * rather than an inline copy of it.
 *
 * @returns {{ inserted: number, skipped: number }}
 */
function ensureBadgeCatalog() {
  return ensureBadgeCatalogRows(db);
}

ensureBadgeCatalog();

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

/**
 * Load a single guest row by its normalized contact key (email or phone), or
 * undefined if none. Used by the signup (#240) and re-entry (#241) routes to
 * look up an existing account before creating a new one.
 * @param {string} contact
 * @returns {object|undefined}
 */
function getGuestByContact(contact) {
  return db.prepare(`SELECT * FROM guests WHERE contact = ?`).get(contact);
}

module.exports = {
  db,
  ensurePhotoBonusColumn,
  ensureBadgeTypeCheckWidened,
  ensurePinnedColumn,
  ensureGuestIdentityColumns,
  ensureTaskIdNullable,
  ensureBadgeCatalog,
  getGuestByToken,
  getGuestById,
  getGuestByContact,
};
