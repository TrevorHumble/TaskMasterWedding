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
    avatar_point_awarded INTEGER NOT NULL DEFAULT 0,
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

  -- Host-scoped favorite marker on a submission (issue #259). This app has
  -- exactly one shared admin login (no per-admin identity — requireAdmin
  -- checks a single signed cookie, see src/middleware/session.js), so "host-
  -- scoped" means one shared flag per photo, not one row per admin user.
  -- Presence of a row IS the favorite (no boolean column needed); the UNIQUE
  -- constraint on submission_id makes a repeat favorite a plain INSERT OR
  -- IGNORE no-op (see src/services/favorites.js).
  CREATE TABLE IF NOT EXISTS admin_favorites (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER NOT NULL UNIQUE REFERENCES submissions(id) ON DELETE CASCADE,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- "Photo is a winner of badge X" records for the give-a-badge screen (issue
  -- #259). Distinct from the guest-award badges/guest_badges tables (a
  -- DIFFERENT concept: those hand a badge to a GUEST via POST
  -- /admin/guests/:id/badge; these mark a PHOTO as a category winner). badge_code
  -- is one of the five fixed codes in src/services/photo-badges.js — not a
  -- foreign key, since that catalog is a code constant, not a DB table (no
  -- host-facing CRUD for it in this issue). UNIQUE(badge_code, submission_id)
  -- makes a repeat award idempotent (INSERT OR IGNORE, src/services/photo-badges.js)
  -- and is what a badge's "N/5" count derives from (COUNT of rows per code).
  -- No points column: points/ranking are issue #661, which reads this table.
  CREATE TABLE IF NOT EXISTS badge_winners (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    badge_code    TEXT    NOT NULL,
    submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    CONSTRAINT uq_badge_winner UNIQUE (badge_code, submission_id)
  );

  CREATE INDEX IF NOT EXISTS idx_badge_winners_code
    ON badge_winners(badge_code);

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

// --- Guarded migration: badges.task_id (issue #483) ---
/**
 * Add badges.task_id if it is not already present, then (re)create the
 * partial unique index that gives a task at most one badge row.
 *
 * Same guard shape as ensurePhotoBonusColumn above: the badges CREATE TABLE
 * above deliberately omits task_id, so the column is absent on BOTH a fresh
 * DB and an existing pre-#483 app.db; the ALTER TABLE ... ADD COLUMN adds it
 * on the first boot, gated on PRAGMA table_info so a repeat call (or a later
 * boot) is a no-op and never throws "duplicate column" (AC9). No DEFAULT is
 * given, so the column is NULL for every pre-existing row — SQLite's ALTER
 * TABLE ADD COLUMN refuses a REFERENCES clause unless the new column's
 * default is NULL, which this satisfies.
 *
 * MUST run AFTER ensureBadgeTypeCheckWidened() above: that function REBUILDS
 * the whole `badges` table on an old-vocabulary DB (drop + recreate + copy),
 * and if task_id already existed by then the rebuild's explicit column list
 * would silently drop it. The call order below (widen-check, then this) is
 * load-bearing, not incidental.
 *
 * The index is partial (WHERE task_id IS NOT NULL) so the many system rows
 * (task_id NULL: auto/special/metric/transferable, plus any custom badge not
 * tied to a task) never collide with each other or with a NULL under a plain
 * UNIQUE constraint — only two badges rows naming the SAME task collide,
 * enforcing "a task has at most one badge row" (issue #483's foundation
 * rule) at the schema layer rather than in application code.
 *
 * Exported so tests bind to this real guard rather than an inline copy.
 */
function ensureBadgeTaskIdColumn() {
  const cols = db.prepare(`PRAGMA table_info(badges)`).all();
  if (!cols.some((col) => col.name === 'task_id')) {
    db.exec(`ALTER TABLE badges ADD COLUMN task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE`);
  }
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_badges_task_id ON badges(task_id) WHERE task_id IS NOT NULL`
  );
}

ensureBadgeTaskIdColumn();

// --- Guarded migration: guest_badges award columns (issue #483) ---
/**
 * Add guest_badges.points/note/submission_id if any is not already present.
 *
 * Same guard shape as ensureGuestIdentityColumns above: the guest_badges
 * CREATE TABLE deliberately omits all three, so they are absent on BOTH a
 * fresh DB and an existing pre-#483 app.db; each ALTER TABLE runs once per
 * column, gated on PRAGMA table_info, so a repeat call (or a later boot) is a
 * no-op and never throws "duplicate column" (AC9).
 *
 * points defaults to 0 and note/submission_id default to NULL — the ADD
 * COLUMN itself is what gives every PRE-EXISTING row (every system/auto/
 * metric/transferable/special grant ever written through stmtGrantBadge,
 * which never sets these) exactly those defaults, with no separate backfill
 * UPDATE needed (AC7).
 *
 * submission_id's FK is ON DELETE CASCADE (issue #713) — a fresh DB gets
 * this action directly here, so ensureGuestBadgeSubmissionCascade() below
 * (which rebuilds an existing pre-#713 table whose FK was ON DELETE SET
 * NULL) is a no-op on a fresh DB.
 *
 * Exported so tests bind to this real guard rather than an inline copy.
 */
function ensureGuestBadgeAwardColumns() {
  const cols = db.prepare(`PRAGMA table_info(guest_badges)`).all();
  const names = new Set(cols.map((col) => col.name));
  if (!names.has('points')) {
    db.exec(`ALTER TABLE guest_badges ADD COLUMN points INTEGER NOT NULL DEFAULT 0`);
  }
  if (!names.has('note')) {
    db.exec(`ALTER TABLE guest_badges ADD COLUMN note TEXT`);
  }
  if (!names.has('submission_id')) {
    db.exec(
      `ALTER TABLE guest_badges ADD COLUMN submission_id INTEGER REFERENCES submissions(id) ON DELETE CASCADE`
    );
  }
}

ensureGuestBadgeAwardColumns();

// --- Guarded migration: guest_badges.submission_id ON DELETE CASCADE (issue #713) ---
/**
 * Rebuild guest_badges so submission_id's FK action is ON DELETE CASCADE
 * instead of the original ON DELETE SET NULL, so a hard-deleted photo takes
 * its award row (and points) with it instead of surviving as a NULL-linked
 * row that stmtAwardPointsSum (src/services/scoring.js) always counts.
 *
 * Detection: PRAGMA foreign_key_list(guest_badges), reading the submission_id
 * FK's on_delete action directly rather than re-deriving it from column
 * shape. No-op if guest_badges doesn't exist yet (fresh DB not yet booted),
 * if submission_id carries no FK at all, or if the FK's on_delete is already
 * CASCADE — which covers a fresh DB, since ensureGuestBadgeAwardColumns above
 * now creates submission_id with ON DELETE CASCADE directly, and covers every
 * later boot of an already-migrated DB.
 *
 * SQLite cannot ALTER a foreign key's ON DELETE action in place, so on an
 * old-shape table (pre-#713) we rebuild it — same recipe as
 * ensureTaskIdNullable above: create a new table with the corrected FK, copy
 * every row across by explicit column list (preserving id so nothing that
 * might reference guest_badges elsewhere goes stale, and preserving every
 * other column byte-for-byte, including a NULL submission_id for a
 * system/auto/special grant), drop the old table, rename the new one into
 * place, all inside one transaction so a mid-migration crash cannot leave the
 * database half-migrated. guest_badges has no inbound foreign keys and no
 * secondary indexes beyond the uq_gb UNIQUE constraint, so the rebuild only
 * needs to restore that constraint.
 *
 * Runs AFTER ensureGuestBadgeAwardColumns() above so points/note/
 * submission_id are already guaranteed to exist on the source table before
 * this migration reads and copies them.
 *
 * Exported so tests bind to this real guard rather than an inline copy.
 */
function ensureGuestBadgeSubmissionCascade() {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'guest_badges'`)
    .all();
  if (tables.length === 0) {
    // No guest_badges table yet — nothing to migrate.
    return;
  }

  const cols = db.prepare(`PRAGMA table_info(guest_badges)`).all();
  if (!cols.some((col) => col.name === 'submission_id')) {
    // Pre-#483 shape, submission_id doesn't exist yet — nothing to do; the
    // ensureGuestBadgeAwardColumns() guard above always runs first and would
    // have already added it with ON DELETE CASCADE, so this branch is
    // unreachable in practice but kept as a defensive no-op.
    return;
  }

  const fks = db.prepare(`PRAGMA foreign_key_list(guest_badges)`).all();
  const submissionFk = fks.find((fk) => fk.from === 'submission_id');
  if (!submissionFk || submissionFk.on_delete === 'CASCADE') {
    // Already CASCADE (fresh DB, or a previously-migrated DB), or
    // submission_id somehow carries no FK — nothing to do.
    return;
  }

  // Same reasoning as ensureTaskIdNullable above: dropping guest_badges
  // mid-rebuild would trip FK enforcement on any inbound reference, so
  // foreign_keys is turned off for the duration of the rebuild only, and
  // turned back on immediately after.
  db.pragma('foreign_keys = OFF');
  try {
    const migrate = db.transaction(() => {
      db.exec(`
        CREATE TABLE guest_badges_new (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          guest_id      INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
          badge_id      INTEGER NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
          awarded_by    TEXT    NOT NULL CHECK (awarded_by IN ('system','admin')),
          created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
          points        INTEGER NOT NULL DEFAULT 0,
          note          TEXT,
          submission_id INTEGER REFERENCES submissions(id) ON DELETE CASCADE,
          CONSTRAINT uq_gb UNIQUE (guest_id, badge_id)
        );

        INSERT INTO guest_badges_new
          (id, guest_id, badge_id, awarded_by, created_at, points, note, submission_id)
          SELECT id, guest_id, badge_id, awarded_by, created_at, points, note, submission_id
            FROM guest_badges;

        DROP TABLE guest_badges;
        ALTER TABLE guest_badges_new RENAME TO guest_badges;
      `);
    });
    migrate();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

ensureGuestBadgeSubmissionCascade();

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
 * first seeded (e.g. #193's COMPLETIONIST), and re-sync any
 * existing catalog row's display fields to the current catalog (e.g. #354's
 * "Wedding Master's Choice" rename reaching a database seeded before that
 * merge, #655) — the boot path that already owns "make an old database
 * current". Delegates to the one shared catalog + upsert function in
 * scripts/badge-catalog.js (consolidated #314) so scripts/seed.js,
 * scripts/seed-event.js, and this boot path can never drift into separate
 * catalogs (#193 AC4's guarantee).
 *
 * Upsert keyed on badges.code (#655): a catalog code's `name`, `description`,
 * and `art_path` re-sync to the module every boot; a non-catalog row (a
 * task badge or admin-created custom badge) is never touched, because no
 * admin route can rename a catalog code (see badge-catalog.js's
 * ensureBadgeCatalog doc comment). Runs AFTER ensureBadgeTypeCheckWidened()
 * (badges' CHECK already accepts every type the catalog uses) and after
 * ensureTaskIdNullable() (the last of the guarded shape migrations),
 * following the same define-call-export pattern as every migration above.
 * Exported so tests can bind to this real guard rather than an inline copy
 * of it.
 *
 * @returns {{ inserted: number, updated: number, unchanged: number }}
 */
function ensureBadgeCatalog() {
  return ensureBadgeCatalogRows(db);
}

ensureBadgeCatalog();

// --- Guarded migration: retire MOSTPHOTOS/MOSTLIKED (issue #711) ---
/**
 * Delete the MOSTPHOTOS and MOSTLIKED catalog rows and any held guest_badges
 * rows for them. Both codes were removed from the engine registry
 * (src/services/badges.js's TRANSFERABLE_BADGES) and from
 * scripts/badge-catalog.js's BADGES, but ensureBadgeCatalog() above only
 * upserts codes still present in that list — it never deletes a row for a
 * code that's gone, so an existing database needs this explicit DELETE to
 * catch up. Deletes guest_badges first (its badge_id foreign-keys to
 * badges.id), then the two catalog rows themselves. Safe on a database that
 * never had either code: both DELETEs simply match zero rows. Runs after
 * ensureBadgeCatalog() above, same PRAGMA-guarded-migration idiom (defined,
 * called once at module load, exported for tests) as every other migration
 * in this file, though this one is unconditional rather than PRAGMA-gated
 * since a DELETE ... WHERE is already naturally idempotent.
 */
function ensureRetiredBadgesRemoved() {
  const retiredCodes = ['MOSTPHOTOS', 'MOSTLIKED'];
  const deleteHeld = db.prepare(
    `DELETE FROM guest_badges WHERE badge_id IN (SELECT id FROM badges WHERE code = ?)`
  );
  const deleteCatalogRow = db.prepare(`DELETE FROM badges WHERE code = ?`);
  for (const code of retiredCodes) {
    deleteHeld.run(code);
    deleteCatalogRow.run(code);
  }
}

ensureRetiredBadgesRemoved();

// --- Guarded migration: submissions.resubmitted (issue #190) ---
/**
 * Add submissions.resubmitted if it is not already present.
 *
 * Same guard shape as ensurePhotoBonusColumn above: the submissions CREATE
 * TABLE deliberately omits resubmitted, so the column is absent on BOTH a
 * fresh DB and an existing pre-change app.db; ALTER TABLE ... ADD COLUMN adds
 * it on the first boot, gated on PRAGMA table_info so a repeat call (or a
 * later boot) is a no-op and never throws "duplicate column".
 *
 * Meaning of the flag: set to 1 when a guest replaces a submission that is
 * currently taken_down (submissions.js's sticky-takedown replace path,
 * issue #190) — the host takedown stays sticky, but this flag tells
 * /admin/photos a new photo is waiting behind it. Cleared back to 0 only by
 * photos.restoreSubmission, in the same transaction as the taken_down flip.
 * Exported so tests bind to this real guard rather than an inline copy.
 */
function ensureResubmittedColumn() {
  const cols = db.prepare(`PRAGMA table_info(submissions)`).all();
  if (!cols.some((col) => col.name === 'resubmitted')) {
    db.exec(`ALTER TABLE submissions ADD COLUMN resubmitted INTEGER NOT NULL DEFAULT 0`);
  }
}

// Run once at module load, before submissions.js/admin.js prepare any
// statement that reads/writes resubmitted — db.js fully evaluates this
// module-load code before any other module's `require('../db')` call returns.
ensureResubmittedColumn();

// --- Guarded migration: guests.avatar_point_awarded (issue #409) ---
/**
 * Add guests.avatar_point_awarded if it is not already present.
 *
 * Same PRAGMA-guarded conditional-ALTER shape as ensurePinnedColumn above —
 * but unlike pinned (which the guests CREATE TABLE deliberately omits), this
 * column IS in the guests CREATE TABLE above, so on a fresh DB the column
 * already exists and this migration is a no-op. It exists only to upgrade an
 * existing pre-#409 app.db in place: there the column does not exist yet;
 * PRAGMA table_info detects the absence and the ALTER TABLE runs once, gated
 * so a repeat call (or a later boot) is a no-op and never throws
 * "duplicate column".
 *
 * Meaning of the flag: flips from 0 to 1 the first time scoring.js's
 * awardProfilePhotoPoint() grants the one-time starter "Upload your profile
 * photo" bonus point for this guest (POST /join, POST /me/edit). It never
 * resets — the point is awarded once, ever, even if the guest later replaces
 * their avatar — so DEFAULT 0 on ADD COLUMN correctly treats every
 * pre-existing row (avatar or not) as not-yet-awarded; the next avatar save
 * for a guest who already had one before this migration ran simply awards
 * the point once, same as any other guest. Exported so tests bind to this
 * real guard rather than an inline copy.
 */
function ensureAvatarPointAwardedColumn() {
  const cols = db.prepare(`PRAGMA table_info(guests)`).all();
  if (!cols.some((col) => col.name === 'avatar_point_awarded')) {
    db.exec(`ALTER TABLE guests ADD COLUMN avatar_point_awarded INTEGER NOT NULL DEFAULT 0`);
  }
}

// Run once at module load, before scoring.js prepares any statement that
// reads/writes avatar_point_awarded — db.js fully evaluates this module-load
// code before any other module's `require('../db')` call returns.
ensureAvatarPointAwardedColumn();

// --- Guarded migration: settings table (issue #283) ---
/**
 * Create the `settings` key/value table if it does not already exist.
 *
 * Shape coordinated with #253's planned settings table (two columns,
 * IF NOT EXISTS) — whichever change lands first wins and the other's
 * migration is a no-op. src/services/lockout.js uses this table to persist
 * admin-lockout state (failedAttempts / lockedUntil) across a process
 * restart, replacing the module-scoped scalars src/routes/auth.js used to
 * carry before #283. Exported so tests bind to this real guard rather than
 * an inline copy.
 */
function ensureSettingsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}

// Run at module load, before lockout.js prepares any statement against
// settings -- db.js fully evaluates this module-load code before any other
// module's `require('../db')` call returns.
ensureSettingsTable();

// --- Event configuration: timezone + wedding dates (issue #681) ---
/**
 * Reader/writer pair owning the settings-table keys that hold the event's
 * timezone and wedding date range, so every date-aware consumer (day chips,
 * daily challenges, the dashboard checklist) reads the same facts from one
 * place instead of each hard-coding its own copy. Same settings table +
 * INSERT...ON CONFLICT shape as src/services/lockout.js's readInt/writeInt,
 * just for strings instead of parsed integers -- no separate migration
 * needed, ensureSettingsTable() above already guarantees the table exists.
 */
const KEY_EVENT_TIMEZONE = 'event_timezone';
const KEY_EVENT_START_DATE = 'event_start_date';
const KEY_EVENT_END_DATE = 'event_end_date';

function readSetting(key, fallback) {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
  return row ? row.value : fallback;
}

function writeSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

/**
 * The event's configured timezone and wedding date range. Defaults
 * (America/Boise, 2026-08-07..2026-08-09) are the venue's real values, so a
 * fresh DB -- or an existing DB from before this issue, which has never
 * written these keys -- reads sensible values with no backfill migration.
 * @returns {{ timezone: string, startDate: string, endDate: string }}
 */
function getEventConfig() {
  return {
    timezone: readSetting(KEY_EVENT_TIMEZONE, 'America/Boise'),
    startDate: readSetting(KEY_EVENT_START_DATE, '2026-08-07'),
    endDate: readSetting(KEY_EVENT_END_DATE, '2026-08-09'),
  };
}

/**
 * Persist the event's timezone and wedding date range. This function trusts
 * its caller -- POST /admin/config (src/routes/admin.js) is the single
 * validator (known IANA name, start <= end) and only calls this once every
 * field has already passed.
 * @param {{ timezone: string, startDate: string, endDate: string }} cfg
 */
function setEventConfig({ timezone, startDate, endDate }) {
  writeSetting(KEY_EVENT_TIMEZONE, timezone);
  writeSetting(KEY_EVENT_START_DATE, startDate);
  writeSetting(KEY_EVENT_END_DATE, endDate);
}

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

// Flip a guest's onboarded flag to 1 (issue #564). The single writer of this
// column outside its own schema default — GET /how-to-play (src/routes/
// guest.js) is the only caller, invoked on the RENDER of the rules card, not
// on arrival at the route, so a guest who never actually sees the page keeps
// onboarded = 0 and is shown the rules again next login/signup (the intended
// "shown once ever, only after they've actually seen it" behavior).
//
// `UPDATE ... SET onboarded = 1 WHERE id = ?` is naturally idempotent — a
// guest refreshing the rules page twice writes the same value twice, not an
// error — so no read-before-write guard is needed for correctness. The
// falsy-id guard below is defensive only: GET /how-to-play runs behind
// requireGuest, so res.locals.guest is never null there in practice, but a
// no-op on a bad id is cheap insurance against ever handing this a stray
// undefined instead of throwing.
const stmtMarkGuestOnboarded = db.prepare('UPDATE guests SET onboarded = 1 WHERE id = ?');

/**
 * Mark a guest as having seen the how-to-play rules. No-ops (no statement
 * run) if `guestId` is falsy rather than letting a bad id reach the prepared
 * statement.
 * @param {number} guestId
 */
function markGuestOnboarded(guestId) {
  if (!guestId) {
    return;
  }
  stmtMarkGuestOnboarded.run(guestId);
}

// One-time data correction (issue #712): POST /p/:id/like had no ownership
// check before this issue's route fix, so a guest could like their own
// photo and inflate their own like counts / today's-likes standing. This
// deletes every existing self-like row — a like whose guest_id equals the
// owner (submissions.guest_id) of the submission it targets — so the route
// fix and this cleanup close both the going-forward and the already-in-the-
// database halves of the same bug. (This originally also protected the
// MOSTLIKED badge, retired by issue #711; the cleanup still matters for like
// counts and any future like-driven feature such as crowd favorites.)
//
// Deliberately NOT self-invoked here (contrast every other guarded migration
// above, which calls itself immediately after its definition): db.js runs
// its migrations at module load and never requires scoring, so an
// in-db.js call to scoring.recomputeTransferableBadges() would re-enter the
// db -> scoring -> db require cycle before this module finishes evaluating
// (module.exports below) and crash the app at boot — scoring.js's
// `const { db } = require('../db')` would see `undefined`. src/app.js's
// composition root calls this AFTER every router (and therefore scoring) is
// already required, and only recomputes badges if this returns > 0. Once
// the route-level fix above stops new self-likes, this DELETE is naturally
// idempotent: a later boot always removes zero rows. Exported so tests bind
// to this real guard rather than an inline copy, per the repo's migration
// idiom.
//
// @returns {number} the number of self-like rows removed.
function cleanupSelfLikes() {
  return db
    .prepare(
      `DELETE FROM likes
        WHERE guest_id = (
          SELECT submissions.guest_id FROM submissions
           WHERE submissions.id = likes.submission_id
        )`
    )
    .run().changes;
}

module.exports = {
  db,
  ensurePhotoBonusColumn,
  ensureBadgeTypeCheckWidened,
  ensureBadgeTaskIdColumn,
  ensureGuestBadgeAwardColumns,
  ensureGuestBadgeSubmissionCascade,
  ensurePinnedColumn,
  ensureGuestIdentityColumns,
  ensureTaskIdNullable,
  ensureBadgeCatalog,
  ensureRetiredBadgesRemoved,
  ensureResubmittedColumn,
  ensureAvatarPointAwardedColumn,
  ensureSettingsTable,
  getEventConfig,
  setEventConfig,
  getGuestByToken,
  getGuestById,
  getGuestByContact,
  markGuestOnboarded,
  cleanupSelfLikes,
};
