// src/db/migrations-guests.js
// Guarded schema migrations for `guests` only (issue #969 PR review fix,
// domain regroup): guests.pinned, the contact/contact_type/pin identity
// trio + its partial unique index, the avatar_point_awarded retirement, and
// guests.recap_checked_at. Each function takes the open `db` handle as its
// first parameter (never a module-load capture of its own — see
// src/db/connection.js's own comment on why) and is invoked, in this exact
// source order, from the entry's (src/db.js) load-bearing boot sequence.
'use strict';

// --- Guarded migration: guests.pinned (issue #251) ---
/**
 * Add guests.pinned if it is not already present.
 *
 * pinned = 1 hoists a guest's section to the top of the gallery's By-person
 * view regardless of recency (the hosts' own section leads). Same pattern as
 * ensurePhotoBonusColumn (src/db/migrations-submissions.js): the guests
 * CREATE TABLE deliberately omits the column, PRAGMA table_info detects
 * absence, and the ALTER TABLE runs at most once — so both a fresh DB and an
 * existing pre-change app.db gain the column on first boot, and every later
 * boot is a no-op. Exported so tests bind to this real guard rather than an
 * inline copy of it.
 */
function ensurePinnedColumn(db) {
  const cols = db.prepare(`PRAGMA table_info(guests)`).all();
  if (!cols.some((col) => col.name === 'pinned')) {
    db.exec(`ALTER TABLE guests ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
  }
}

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
function ensureGuestIdentityColumns(db) {
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

// --- Guarded migration: retire guests.avatar_point_awarded (issue #716) ---
/**
 * Fold the one-time banked starter point back into the derived rule, then
 * drop the now-dead `avatar_point_awarded` flag column.
 *
 * Issue #716 supersedes #409's design: the "Upload your profile photo"
 * starter point is no longer a one-time banked award, it is DERIVED live
 * from `guests.avatar_path IS NOT NULL` (scoring/points.js's
 * starterTaskContribution/getPoints/leaderboard). A pre-#716 database may
 * still carry `avatar_point_awarded = 1` rows whose point was banked into
 * `bonus_points` by the now-retired `scoring.awardProfilePhotoPoint` — left
 * alone, that guest would double-count once the derived term also starts
 * paying. This migration moves the point from the banked term to the
 * derived one with NO NET CHANGE for a guest who still has an avatar:
 *
 *   1. UPDATE guests SET bonus_points = MAX(0, bonus_points - 1)
 *        WHERE avatar_point_awarded = 1
 *      — MAX(0, ...) matches the floor stmtAddBonus already enforces on
 *      every other bonus_points write, so this can't drive the column
 *      negative. A flagged guest who currently has an avatar loses the
 *      banked +1 here and immediately regains it from the derived term
 *      (getPoints/leaderboard), net zero. A flagged guest with NO avatar
 *      (they banked the point, then removed their photo) loses the banked
 *      point and gains nothing back — the "ghost point" the design
 *      explicitly calls out as intended to go away.
 *   2. ALTER TABLE guests DROP COLUMN avatar_point_awarded
 *      — the flag has no reader left once step 1 runs; keeping a dead
 *      column around would be a second (unread, and therefore silently
 *      driftable) source of truth for "did this guest ever have an
 *      avatar." Supported by the bundled SQLite (3.53, better-sqlite3
 *      12.11.1) with no full-table rebuild needed.
 *
 * Both steps run in one transaction so a mid-migration crash can't leave a
 * database with the point subtracted but the column still present (or vice
 * versa). Detection is column-presence, the same PRAGMA table_info guard
 * every other migration in this file uses: the guests CREATE TABLE above no
 * longer declares avatar_point_awarded, so a fresh DB never has the column
 * and this is a no-op there; an existing pre-#716 database has it exactly
 * once, so the migration (and therefore the bonus_points subtraction) runs
 * exactly once, ever, per guest row that had the flag set.
 *
 * Exported so tests bind to this real guard rather than an inline copy.
 */
function ensureAvatarPointAwardedRetired(db) {
  const cols = db.prepare(`PRAGMA table_info(guests)`).all();
  if (!cols.some((col) => col.name === 'avatar_point_awarded')) {
    // Fresh DB (CREATE TABLE above already omits the column), or an
    // already-migrated DB — nothing to do.
    return;
  }

  const migrate = db.transaction(() => {
    db.exec(
      `UPDATE guests SET bonus_points = MAX(0, bonus_points - 1) WHERE avatar_point_awarded = 1`
    );
    db.exec(`ALTER TABLE guests DROP COLUMN avatar_point_awarded`);
  });
  migrate();
}

// --- Guarded migration: guests.recap_checked_at (issue #644) ---
/**
 * Add guests.recap_checked_at if it is not already present, then backfill
 * every PRE-EXISTING guest to recap_checked_at = datetime('now').
 *
 * recap_checked_at is the guest's recap checkpoint (src/services/
 * notifications.js): NULL means "never checked" — every read in that module
 * guards with COALESCE(g.recap_checked_at, g.created_at) so a NULL checkpoint
 * never reaches a comparison directly (SQLite yields NULL, not true, so an
 * unguarded `created_at > recap_checked_at` would silently read as "nothing
 * is new" forever for that guest). POST /recap/seen (src/routes/guest.js) is
 * the only writer once this migration has run.
 *
 * MUST be added NULLABLE with NO DEFAULT, and the backfill MUST be a
 * separate UPDATE, not `ADD COLUMN ... NOT NULL DEFAULT (datetime('now'))`:
 * verified on this tree (better-sqlite3, SQLite 3.53.2) — that single-step
 * form succeeds on an empty table but throws "Cannot add a column with
 * non-constant default" the instant one guest row already exists, which
 * would crash the deployed app on boot (src/db.js runs its migrations at
 * module load) while CI stayed green (every test builds a fresh empty DB).
 *
 * The backfill is what satisfies AC8's "existing guest" half: without it, a
 * guest who already has months of likes/comments/badges would see their
 * ENTIRE history as "new since I last checked" the moment this migration
 * lands — a flood, not a recap. Backfilling to 'now' (not to some earlier
 * timestamp) makes every pre-existing guest's unread count exactly 0 right
 * after the upgrade, deliberately erring toward under- rather than
 * over-reporting on the one-time cutover.
 *
 * The backfill must NOT re-run on every boot — same reasoning as
 * ensureGuestBadgeCelebratedAtColumn's own doc comment
 * (src/db/migrations-badges.js): a guest who joins (or whose
 * recap_checked_at is legitimately still NULL) AFTER this migration already
 * ran must stay NULL, so their unread count is derived from their own
 * created_at (AC8's "never-checked guest is never treated as having no
 * checkpoint"), not silently pinned to some later server-restart instant.
 * Column-absence gating (this function returns before either statement runs
 * once the column exists) is what keeps the backfill one-shot.
 *
 * Exported so tests bind to this real guard rather than an inline copy.
 */
function ensureRecapCheckedAtColumn(db) {
  const cols = db.prepare(`PRAGMA table_info(guests)`).all();
  if (cols.some((col) => col.name === 'recap_checked_at')) {
    // Fresh DB, or an already-migrated DB — nothing to do (see the file
    // comment above for why the backfill must NOT re-run here).
    return;
  }
  db.exec(`ALTER TABLE guests ADD COLUMN recap_checked_at TEXT`);
  db.exec(`UPDATE guests SET recap_checked_at = datetime('now') WHERE recap_checked_at IS NULL`);
}

module.exports = {
  ensurePinnedColumn,
  ensureGuestIdentityColumns,
  ensureAvatarPointAwardedRetired,
  ensureRecapCheckedAtColumn,
};
