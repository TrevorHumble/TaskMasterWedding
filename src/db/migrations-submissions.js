// src/db/migrations-submissions.js
// Guarded schema migrations for `submissions` only (issue #969 PR review
// fix, domain regroup): photo_bonus, task_id widened to nullable, the
// bonus_amount/bonus_reason pair, resubmitted, and taken_down_by. Each
// function takes the open `db` handle as its first parameter (never a
// module-load capture of its own — see src/db/connection.js's own comment on
// why) and is invoked, in this exact source order, from the entry's
// (src/db.js) load-bearing boot sequence.
'use strict';

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
function ensurePhotoBonusColumn(db) {
  const cols = db.prepare(`PRAGMA table_info(submissions)`).all();
  if (!cols.some((col) => col.name === 'photo_bonus')) {
    db.exec(`ALTER TABLE submissions ADD COLUMN photo_bonus INTEGER NOT NULL DEFAULT 0`);
  }
}

// --- Guarded migration: submissions.task_id nullable (issue #247) ---
/**
 * Widen submissions.task_id from NOT NULL to nullable, if it is not already,
 * so a "memory" (a guest photo with no matching task) can be stored as a
 * submissions row with task_id = NULL instead of needing a second table.
 *
 * SQLite cannot ALTER a column's NOT NULL constraint in place, so on an
 * old-shape table (pre-#247) we rebuild it — same recipe as
 * ensureBadgeTypeCheckWidened (src/db/migrations-badges.js): create a new
 * table with the widened column, copy every row across (explicit column
 * list, preserving id so likes/comments foreign keys on submission_id stay
 * valid), drop the old table, rename the new one into place, all inside one
 * transaction so a mid-migration crash cannot leave the database
 * half-migrated. Runs AFTER ensurePhotoBonusColumn() above so photo_bonus
 * already exists on the source table and is carried across by the copy.
 *
 * Detection: PRAGMA table_info's `notnull` flag for the task_id column. A
 * fresh DB's CREATE TABLE IF NOT EXISTS above already declares task_id
 * nullable, so this is a no-op there (and a no-op on every later boot once an
 * existing DB has been migrated once). Exported so tests can bind to this
 * real guard rather than an inline copy of it.
 */
function ensureTaskIdNullable(db) {
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

// --- Guarded migration: submissions.bonus_amount/bonus_reason (issue #753) ---
/**
 * Add submissions.bonus_amount/bonus_reason if either is not already
 * present.
 *
 * Same guard shape as ensurePhotoBonusColumn/ensureResubmittedColumn above:
 * the submissions CREATE TABLE deliberately omits both, so they are absent
 * on BOTH a fresh DB and an existing pre-#753 app.db; each ALTER TABLE runs
 * once per column, gated on PRAGMA table_info, so a repeat call (or a later
 * boot) is a no-op and never throws "duplicate column".
 *
 * bonus_amount banks the one-day-only on-day bonus AT SUBMIT TIME (never
 * derived at read time — a photo replace resets created_at, so a derived
 * bonus would silently vanish when a guest swapped in a better photo the
 * next day); it defaults to 0, meaning "no banked bonus", which is exactly
 * right for every pre-existing row (none of them could have banked one) and
 * for an ordinary/off-day submission going forward. bonus_reason records
 * which rule banked it ('oneday' for this issue; #649/#650 will write their
 * own literals into this same shared column) and defaults to NULL. Deliberately
 * a NEW pair of columns, not a reuse of submissions.photo_bonus — that
 * column's write path was retired by #684 and it carries unrelated legacy
 * admin-set values.
 *
 * MUST run AFTER ensureTaskIdNullable() above: that function rebuilds
 * `submissions` from an explicit nine-column list, so a bonus_amount column
 * added before it runs would be silently dropped on any database still
 * needing that migration. ensureResubmittedColumn() below sits after
 * ensureTaskIdNullable() for the identical reason; this migration follows
 * the same call-order rule.
 *
 * Exported so tests bind to this real guard rather than an inline copy.
 */
function ensureSubmissionsBonusColumns(db) {
  const cols = db.prepare(`PRAGMA table_info(submissions)`).all();
  const names = new Set(cols.map((col) => col.name));
  if (!names.has('bonus_amount')) {
    db.exec(`ALTER TABLE submissions ADD COLUMN bonus_amount INTEGER NOT NULL DEFAULT 0`);
  }
  if (!names.has('bonus_reason')) {
    db.exec(`ALTER TABLE submissions ADD COLUMN bonus_reason TEXT`);
  }
}

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
function ensureResubmittedColumn(db) {
  const cols = db.prepare(`PRAGMA table_info(submissions)`).all();
  if (!cols.some((col) => col.name === 'resubmitted')) {
    db.exec(`ALTER TABLE submissions ADD COLUMN resubmitted INTEGER NOT NULL DEFAULT 0`);
  }
}

// --- Guarded migration: submissions.taken_down_by (issue #886) ---
/**
 * Add submissions.taken_down_by if it is not already present.
 *
 * Same guard shape as ensureResubmittedColumn above: the submissions CREATE
 * TABLE deliberately omits taken_down_by, so it is absent on BOTH a fresh DB
 * and an existing pre-#886 app.db; ALTER TABLE ... ADD COLUMN adds it on the
 * first boot, gated on PRAGMA table_info so a repeat call (or a later boot)
 * is a no-op and never throws "duplicate column".
 *
 * Attribution convention (binding — issue #886's own "Attribution
 * convention" section). taken_down_by is NULL when a row is visible
 * (taken_down = 0). When taken_down = 1:
 *   - 'guest' — the owning guest took it down themselves (src/routes/
 *     community.js's POST /p/:submissionId/delete). Only this value is
 *     non-sticky: src/services/submissions.js lets a guest's own resubmit
 *     onto a 'guest'-attributed row come back visible.
 *   - 'admin' — a host took it down (src/routes/admin.js's POST
 *     /photos/:id/takedown). Sticky, per #190.
 *   - NULL    — treated EXACTLY as 'admin'. A hidden row with no attribution
 *     is read as a host takedown, never a guest one. Every gate this issue
 *     adds is written as "is it 'guest'?", never as "is it 'admin'?" — so a
 *     legacy row, or a row a future write path adds without setting this
 *     column, stays sticky by default instead of silently losing moderation.
 *
 * Backfill (AC7): every row already hidden (taken_down = 1) at migration
 * time is set to 'admin' in the SAME guarded block — conservative, because
 * every takedown that predates this column was written before the guest/host
 * distinction existed, so it is treated as a host takedown. A visible row
 * (taken_down = 0) is left NULL, matching a fresh insert's implicit default.
 * Runs once, inside the ALTER TABLE guard, so a later boot against an
 * already-migrated database never re-touches a row a guest or host has since
 * taken down or restored.
 *
 * Call-order constraint (restored PR review fix — this rationale lived at
 * the call site in bd70cff's db.js, not in this function's own doc comment,
 * until the #969 PR review flagged the gap): MUST run AFTER
 * ensureTaskIdNullable() above — the real constraint, not "matches
 * convention". ensureTaskIdNullable() rebuilds `submissions` from an
 * explicit column-copy list, so a taken_down_by column added before it runs
 * would be silently DROPPED on any database still needing that rebuild — the
 * same reasoning ensureSubmissionsBonusColumns' own comment states for the
 * identical hazard. This migration is ordered after ensureResubmittedColumn()
 * only because that migration was introduced first in this file, not because
 * either migration depends on the other's column.
 *
 * Exported so tests bind to this real guard rather than an inline copy.
 */
function ensureTakenDownByColumn(db) {
  const cols = db.prepare(`PRAGMA table_info(submissions)`).all();
  if (!cols.some((col) => col.name === 'taken_down_by')) {
    // Both statements run as ONE transaction (#886) — two
    // separate db.exec() calls left a crash landing between them able to
    // leave the column present with the backfill permanently skipped: a
    // later boot's PRAGMA table_info guard above would see the column
    // already exists and never re-run the UPDATE, silently leaving every
    // pre-#886 hidden row with taken_down_by NULL forever (read as a host
    // takedown per the Attribution convention, so not unsafe, but AC7's
    // "every row already hidden backfills to 'admin'" promise would be
    // broken). Matches the other multi-statement migrations in this file
    // (e.g. ensureTaskIdNullable above).
    const migrate = db.transaction(() => {
      db.exec(
        `ALTER TABLE submissions ADD COLUMN taken_down_by TEXT
           CHECK (taken_down_by IS NULL OR taken_down_by IN ('admin','guest'))`
      );
      db.exec(`UPDATE submissions SET taken_down_by = 'admin' WHERE taken_down = 1`);
    });
    migrate();
  }
}

module.exports = {
  ensurePhotoBonusColumn,
  ensureTaskIdNullable,
  ensureSubmissionsBonusColumns,
  ensureResubmittedColumn,
  ensureTakenDownByColumn,
};
