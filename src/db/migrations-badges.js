// src/db/migrations-badges.js
// Guarded schema migrations for `badges` and `guest_badges` only (issue #969
// PR review fix, domain regroup): the widened badges.type CHECK,
// badges.task_id + its partial unique index, guest_badges' award columns
// (points/note/submission_id) and the submission_id ON DELETE CASCADE
// rebuild, guest_badges.celebrated_at, guest_badges.rank, the badge-catalog
// boot-heal, the two catalog-row retirements, the dropped badge_winners
// table, and the auto/metric points backfill (plus the
// AUTO_METRIC_BADGE_POINTS and CLEAN_SWEEP_BADGE_POINTS constants it and
// scoring.js both read). Each
// function takes the open `db` handle as its first parameter (never a
// module-load capture of its own — see src/db/connection.js's own comment on
// why) and is invoked, in this exact source order, from the entry's
// (src/db.js) load-bearing boot sequence.
'use strict';

const config = require('../../config');
const { ensureBadgeCatalog: ensureBadgeCatalogRows } = require('../../scripts/badge-catalog');

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
function ensureBadgeTypeCheckWidened(db) {
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

// --- Guarded migration: badges.task_id (issue #483) ---
/**
 * Add badges.task_id if it is not already present, then (re)create the
 * partial unique index that gives a task at most one badge row.
 *
 * Same guard shape as ensurePhotoBonusColumn (src/db/migrations-submissions.js):
 * the badges CREATE TABLE above deliberately omits task_id, so the column is
 * absent on BOTH a fresh DB and an existing pre-#483 app.db; the ALTER TABLE
 * ... ADD COLUMN adds it on the first boot, gated on PRAGMA table_info so a
 * repeat call (or a later boot) is a no-op and never throws "duplicate
 * column" (AC9). No DEFAULT is given, so the column is NULL for every
 * pre-existing row — SQLite's ALTER TABLE ADD COLUMN refuses a REFERENCES
 * clause unless the new column's default is NULL, which this satisfies.
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
function ensureBadgeTaskIdColumn(db) {
  const cols = db.prepare(`PRAGMA table_info(badges)`).all();
  if (!cols.some((col) => col.name === 'task_id')) {
    db.exec(`ALTER TABLE badges ADD COLUMN task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE`);
  }
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_badges_task_id ON badges(task_id) WHERE task_id IS NOT NULL`
  );
}

// --- Guarded migration: guest_badges award columns (issue #483) ---
/**
 * Add guest_badges.points/note/submission_id if any is not already present.
 *
 * Same guard shape as ensureGuestIdentityColumns (src/db/migrations-guests.js):
 * the guest_badges CREATE TABLE deliberately omits all three, so they are
 * absent on BOTH a fresh DB and an existing pre-#483 app.db; each ALTER TABLE
 * runs once per column, gated on PRAGMA table_info, so a repeat call (or a
 * later boot) is a no-op and never throws "duplicate column" (AC9).
 *
 * points defaults to 0 and note/submission_id default to NULL — the ADD
 * COLUMN itself is what gives every PRE-EXISTING row (every system/auto/
 * metric/transferable/special grant ever written through stmtGrantBadge)
 * exactly those defaults, with no separate backfill UPDATE needed (AC7).
 * stmtGrantBadge never sets note/submission_id (those stay NULL for every
 * grant it writes; only task-badges.awardTaskBadge sets them). It DOES set
 * points as of issue #709 — AUTO_METRIC_BADGE_POINTS for an auto grant
 * (CLEAN_SWEEP_BADGE_POINTS for the metric COMPLETIONIST grant since issue
 * #1105 split it out of that flat value), 0 for a transferable/admin-special
 * grant — which is exactly why a SEPARATE one-time backfill
 * (ensureAutoMetricBadgePointsBackfilled, below) exists: to catch up a row a
 * PRE-#709 database already granted under the old points = 0 default, which
 * this ADD COLUMN's default cannot reach.
 *
 * submission_id's FK is ON DELETE CASCADE (issue #713) — a fresh DB gets
 * this action directly here, so ensureGuestBadgeSubmissionCascade() below
 * (which rebuilds an existing pre-#713 table whose FK was ON DELETE SET
 * NULL) is a no-op on a fresh DB.
 *
 * Exported so tests bind to this real guard rather than an inline copy.
 */
function ensureGuestBadgeAwardColumns(db) {
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

// --- Guarded migration: guest_badges.submission_id ON DELETE CASCADE (issue #713) ---
/**
 * Rebuild guest_badges so submission_id's FK action is ON DELETE CASCADE
 * instead of the original ON DELETE SET NULL, so a hard-deleted photo takes
 * its award row (and points) with it instead of surviving as a NULL-linked
 * row that stmtAwardPointsSum (src/services/scoring/points.js) always counts.
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
 * ensureTaskIdNullable (src/db/migrations-submissions.js): create a new table
 * with the corrected FK, copy every row across by explicit column list
 * (preserving id so nothing that might reference guest_badges elsewhere goes
 * stale, and preserving every other column byte-for-byte, including a NULL
 * submission_id for a system/auto/special grant), drop the old table, rename
 * the new one into place, all inside one transaction so a mid-migration crash
 * cannot leave the database half-migrated. guest_badges has no inbound
 * foreign keys and no secondary indexes beyond the uq_gb UNIQUE constraint,
 * so the rebuild only needs to restore that constraint.
 *
 * Runs AFTER ensureGuestBadgeAwardColumns() above so points/note/
 * submission_id are already guaranteed to exist on the source table before
 * this migration reads and copies them.
 *
 * Exported so tests bind to this real guard rather than an inline copy.
 */
function ensureGuestBadgeSubmissionCascade(db) {
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

// --- Guarded migration: guest_badges.celebrated_at (issue #644) ---
/**
 * Add guest_badges.celebrated_at if it is not already present, then backfill
 * every PRE-EXISTING row to celebrated_at = created_at.
 *
 * celebrated_at marks the moment a badge's #255 celebration dialog was shown
 * to the guest — NULL means "owed": src/services/render-locals.js's shared
 * resolveBadgeMoment() helper auto-opens the dialog for the guest's oldest
 * owed badge on the next page render and stamps this column the instant it
 * does, so a badge is celebrated exactly once no matter which page happens
 * to render first (plan step 4). Going forward, every NEW grant — recompute-
 * driven (scoring's recomputeBadges/recomputeTransferableBadges) or
 * host-awarded (awardSpecialBadge) — leaves this column NULL by passing 0
 * for stmtGrantBadge's alreadyAnnounced flag, so a freshly granted badge is
 * owed by construction. EXCEPTION (issue #894): recomputeTransferableBadges' grant
 * branch writes celebrated_at non-NULL at grant time when notifications.
 * grantWasAnnounced(guestId, badgeId) is true — a re-grant of a transferable
 * badge this guest was already told about (a flap: revoked and re-granted as
 * a side effect of another guest's like) restores the row already-celebrated
 * instead of re-arming the dialog. Every OTHER grant path is unaffected.
 *
 * The backfill is what keeps AC8 honest: without it, EVERY badge a guest
 * already held before this migration ran would read celebrated_at = NULL
 * and the very next page load would auto-open a "celebration" for a badge
 * they may have earned days ago — a flood of stale popups, not a recap.
 * Backfilling to the row's own created_at (not to 'now') is deliberate: it
 * keeps each pre-existing award's own timestamp for the recap list's
 * ordering, while still marking it "already celebrated" (non-NULL) so no
 * dialog fires for it.
 *
 * Same guard shape as ensurePhotoBonusColumn (src/db/migrations-submissions.js):
 * the guest_badges CREATE TABLE deliberately omits celebrated_at, so it is
 * absent on BOTH a fresh DB and an existing pre-#644 app.db; the ALTER TABLE
 * + backfill run together, gated on column-absence, so a repeat call (or a
 * later boot) is a no-op — critically, the backfill does NOT re-run on every
 * boot, which would otherwise stamp a genuinely-still-owed badge
 * (celebrated_at NULL on a row granted after this migration already ran)
 * back to non-NULL and silently swallow its celebration.
 *
 * Exported so tests bind to this real guard rather than an inline copy.
 */
function ensureGuestBadgeCelebratedAtColumn(db) {
  const cols = db.prepare(`PRAGMA table_info(guest_badges)`).all();
  if (cols.some((col) => col.name === 'celebrated_at')) {
    // Fresh DB, or an already-migrated DB — nothing to do (see the file
    // comment above for why the backfill must NOT re-run here).
    return;
  }
  db.exec(`ALTER TABLE guest_badges ADD COLUMN celebrated_at TEXT`);
  db.exec(`UPDATE guest_badges SET celebrated_at = created_at WHERE celebrated_at IS NULL`);
}

// --- Guarded migration: guest_badges.rank (issue #661) ---
/**
 * Add guest_badges.rank if it is not already present. NULL by default and
 * for every row this column's guard adds retroactively — "not part of a
 * ranked award". Only `src/services/task-badges.js`'s `releaseRanking`
 * (issue #661) ever writes a non-NULL value here: 1..5, the placement a
 * ranked task-badge award holds within its badge's current winner set. Every
 * other award path (system auto/metric/transferable grants via
 * `scoring/badge-engine.js`'s `stmtGrantBadge`, an admin special/custom award
 * via `awardSpecialBadge`, a single-photo task-badge award via this file's
 * own pre-existing `awardTaskBadge`) never names this column in its INSERT,
 * so it stays NULL for all of them — "does this guest_badges row carry a
 * rank" is therefore a complete, structural test for "was this a ranked
 * release award," not a convention a caller could forget to honor.
 *
 * Same guard shape as ensureGuestBadgeCelebratedAtColumn immediately above:
 * the guest_badges CREATE TABLE deliberately omits `rank`, so it is absent on
 * both a fresh DB and an existing pre-#661 app.db; a repeat call (or a later
 * boot) is a no-op. Exported so tests bind to this real guard rather than an
 * inline copy.
 */
function ensureGuestBadgeRankColumn(db) {
  const cols = db.prepare(`PRAGMA table_info(guest_badges)`).all();
  if (cols.some((col) => col.name === 'rank')) {
    return;
  }
  db.exec(`ALTER TABLE guest_badges ADD COLUMN rank INTEGER`);
}

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
 * ensureTaskIdNullable() (src/db/migrations-submissions.js — the last of the
 * guarded shape migrations run before this one in the entry's boot sequence),
 * following the same define-call-export pattern as every migration above.
 * Exported so tests can bind to this real guard rather than an inline copy
 * of it.
 *
 * @returns {{ inserted: number, updated: number, unchanged: number }}
 */
// Passes config.VARIANT through so a stag instance's own DATA_DIR boots (and
// re-syncs on every restart) to the black-tie catalog instead of the wedding
// one (issue #640 AC5) — the wedding instance (VARIANT unset) passes '' here,
// unchanged from before this argument existed.
function ensureBadgeCatalog(db) {
  return ensureBadgeCatalogRows(db, config.VARIANT);
}

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
function ensureRetiredBadgesRemoved(db) {
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

// --- Guarded migration: retire the give-a-badge photo-winner catalog collision (issue #661) ---
/**
 * Delete the three `badges` catalog rows that collided in NAME ONLY with
 * `src/services/photo-badges.js`'s (now-deleted) five-code give-a-badge
 * catalog — SHUTTERBUG, CROWDFAV, CHOICE — plus any `guest_badges` rows held
 * on them, exactly the same shape as `ensureRetiredBadgesRemoved` immediately
 * above (issue #711). BESTDANCE and GOLDEN, the OTHER two give-a-badge codes,
 * were never `badges` catalog rows in the first place (see
 * `scripts/badge-catalog.js`'s `BADGES` array, which never listed them), so
 * there is nothing here for those two to delete.
 *
 * These three codes were a genuine, if confusing, collision: `photo-badges.js`
 * used them to mark a PHOTO as a category winner (`badge_winners`, a
 * different table with no relation to `guest_badges`), while these `badges`
 * catalog rows independently let an admin hand-award a same-named badge to a
 * GUEST via `POST /admin/guests/:id/badge` (`scoring.awardSpecialBadge`) — two
 * unrelated concepts sharing a display name. Issue #661's one-badge-system
 * consolidation retires the give-a-badge picker entirely (its whole module,
 * `badge_winners`, and its admin-photos.ejs dialog), and takes these three
 * catalog rows with it rather than leaving them as a hand-awardable special
 * badge whose name now describes a picker that no longer exists.
 *
 * Runs after `ensureBadgeCatalog()`/`ensureRetiredBadgesRemoved()` immediately
 * above, same reasoning as that function: `ensureBadgeCatalog()` only upserts
 * codes still present in `scripts/badge-catalog.js`'s `BADGES` array, never
 * deletes a row for a code that has been removed from it, so an existing
 * database needs this explicit DELETE to catch up. Exported so tests bind to
 * this real guard rather than an inline copy.
 */
function ensureSpecialBadgeCollisionsRemoved(db) {
  const retiredCodes = ['SHUTTERBUG', 'CROWDFAV', 'CHOICE'];
  const deleteHeld = db.prepare(
    `DELETE FROM guest_badges WHERE badge_id IN (SELECT id FROM badges WHERE code = ?)`
  );
  const deleteCatalogRow = db.prepare(`DELETE FROM badges WHERE code = ?`);
  for (const code of retiredCodes) {
    deleteHeld.run(code);
    deleteCatalogRow.run(code);
  }
}

// --- Guarded migration: drop the retired badge_winners table (issue #661) ---
/**
 * Drop `badge_winners` (and, implicitly, its `idx_badge_winners_code` index —
 * SQLite drops a table's own indexes automatically when the table itself is
 * dropped) on an existing pre-#661 database. The CREATE TABLE block above no
 * longer declares this table at all, so a fresh database never has it.
 *
 * Implementer's call, recorded here rather than left to drift (issue #661's
 * own plan named two options — "repoint `badge_winners` at task badges, or
 * replace it with a per-task worksheet" — and left the choice to whoever
 * built it): neither. `badge_winners` had exactly one reader/writer,
 * `src/services/photo-badges.js`, and that whole module is deleted by this
 * same change (the give-a-badge picker it drove is retired outright, not
 * repointed at a new concept). The real ranking screen this issue ships
 * needs no "worksheet" table of its own either: a host's in-progress pick/
 * drag-reorder is held entirely in the browser (see
 * `src/public/js/admin-badge-rank.js`) until Release writes the real
 * `guest_badges` award rows in one transaction — there is deliberately no
 * per-drop persistence endpoint (matching the mock's own prior-art note) and
 * therefore nothing left for a worksheet table to hold. Keeping
 * `badge_winners` around unread, or repointing it at a concept nothing
 * queries, would just be a second, silently-driftable source of "who won"
 * behind the real one — `guest_badges` — this issue makes canonical.
 *
 * `DROP TABLE IF EXISTS` is naturally idempotent (same reasoning
 * `ensureRetiredBadgesRemoved` gives for its own unconditional DELETEs), so
 * this needs no PRAGMA table_info guard. Exported so tests bind to this real
 * guard rather than an inline copy.
 */
function ensureBadgeWinnersTableDropped(db) {
  db.exec(`DROP TABLE IF EXISTS badge_winners`);
}

// --- Points values + guarded one-time backfill: auto/metric badges (issues #709, #1105) ---

/**
 * The single owner of "how many points a held MILESTONE (type 'auto') badge
 * is worth" (issue #709 — a badge is a point event, not just wall art).
 * Until issue #1105 this constant also covered the metric badge
 * (COMPLETIONIST); that value now lives in CLEAN_SWEEP_BADGE_POINTS below,
 * so a second metric badge must NOT be paid from here. BOTH this
 * file's backfill immediately below AND src/services/scoring/badge-engine.js's
 * recomputeBadges grant call sites need this number, and badge-engine.js
 * already imports `db` from the entry (src/db.js), which cannot import
 * scoring back (that would re-enter the db -> scoring -> db require cycle
 * before this module finishes evaluating; see src/db/guest-lookups.js's
 * cleanupSelfLikes comment for the same hazard) — so this file, part of the
 * lowest module both reach, is where it has to live. It is also the paid
 * counterpart to `guest_badges.points`'s own `DEFAULT 0`
 * (ensureGuestBadgeAwardColumns above), a fact this file already owns.
 *
 * scoring/badge-engine.js imports this constant rather than re-declaring it;
 * nowhere else writes a bare `1` for this purpose.
 */
const AUTO_METRIC_BADGE_POINTS = 1;

/**
 * The single owner of "how many points the Completionist/clean-sweep badge
 * (COMPLETIONIST) is worth while held" (issue #1105, point-system
 * rebalance). Split out of AUTO_METRIC_BADGE_POINTS above so the clean sweep
 * (finishing every live task) reads as a bigger reward than a milestone
 * badge (BLOOM/BOUQUET/GARDEN, still AUTO_METRIC_BADGE_POINTS): those three
 * stay flat at 1, COMPLETIONIST alone moves to 3. Same reasoning as
 * AUTO_METRIC_BADGE_POINTS's own doc comment for why this lives here rather
 * than in scoring/badge-engine.js: badge-engine.js's recomputeBadges grant
 * call site and this file's own backfill immediately below both need this
 * number, and badge-engine.js already imports `db` from the entry
 * (src/db.js), which cannot import scoring back without re-entering the
 * db -> scoring -> db require cycle. scoring/badge-engine.js imports this
 * constant rather than re-declaring it, and nowhere else writes a bare `3`
 * for this purpose.
 */
const CLEAN_SWEEP_BADGE_POINTS = 3;

/**
 * Two guarded UPDATEs that catch up held badge rows written under an older
 * points rule: currently-held type 'auto' (milestone) rows still at the
 * pre-#709 default of 0 advance to AUTO_METRIC_BADGE_POINTS, and
 * currently-held COMPLETIONIST rows still at an old-era value (0 or 1)
 * advance to CLEAN_SWEEP_BADGE_POINTS. Both pay through the existing
 * award-points sum (stmtAwardPointsSum / the leaderboard subquery,
 * src/services/scoring/points.js) with no new scoring term. Going forward,
 * badge-engine.js's recomputeBadges grant call sites write
 * AUTO_METRIC_BADGE_POINTS on a NEW auto grant directly (COMPLETIONIST now
 * writes CLEAN_SWEEP_BADGE_POINTS instead, issue #1105: see this
 * function's own COMPLETIONIST branch below); this backfill exists only to
 * catch up a row a pre-#709 database already granted under the old points =
 * 0 default.
 *
 * The filter joins badges.type = 'auto', NOT awarded_by = 'system'. A
 * transferable grant (recomputeTransferableBadges) is also awarded_by =
 * 'system', so filtering on awarded_by alone would mis-pay it; joining on
 * the badge's own type is what correctly excludes it (and excludes an
 * admin-special/custom grant too) regardless of whether issue #711's
 * transferable-badge retirement has landed on this database. Metric badges
 * (COMPLETIONIST) are excluded from THIS update: issue #1105 split them
 * into their own CLEAN_SWEEP_BADGE_POINTS backfill below, since the two no
 * longer share a paid value.
 *
 * The WHERE also requires the row's CURRENT points = 0. This is a
 * different concept from AUTO_METRIC_BADGE_POINTS above (it's the "still at
 * the old default" sentinel, not the paid value), so it stays a literal: a
 * re-run (or a row some other future writer already set a non-zero value on)
 * is never clobbered back: this only advances a row still sitting at the
 * old default.
 *
 * Issue #1105 split this backfill in two: the UPDATE below now excludes
 * COMPLETIONIST (type = 'auto' only, flat AUTO_METRIC_BADGE_POINTS), and a
 * second UPDATE follows it that carries COMPLETIONIST's own row up to
 * CLEAN_SWEEP_BADGE_POINTS. That second UPDATE's WHERE is `points IN (0,
 * 1)`, not just 0: 0 is the pre-#709 old-default sentinel (same meaning as
 * above), and 1 is the pre-#1105 paid value every COMPLETIONIST row already
 * held under the old flat AUTO_METRIC_BADGE_POINTS rule. Both are old-era
 * sentinels this backfill catches up, never the paid value (3) itself, so a
 * re-run (or a row already sitting at 3) is never clobbered back.
 *
 * Runs AFTER ensureGuestBadgeAwardColumns() above (the points column must
 * exist before this UPDATE can reference it) and after the badge-catalog
 * migrations including ensureRetiredBadgesRemoved() immediately above (so
 * `badges.type` reflects the settled catalog this backfill joins against,
 * not a mid-migration shape). Naturally idempotent: once every held
 * auto/metric row already carries its own paid value, a later boot's
 * UPDATEs match zero rows. Exported so tests bind to this real guard rather
 * than an inline copy.
 *
 * @returns {number} the number of guest_badges rows updated (both UPDATEs combined).
 */
function ensureAutoMetricBadgePointsBackfilled(db) {
  const autoChanges = db
    .prepare(
      `UPDATE guest_badges
          SET points = ?
        WHERE points = 0
          AND badge_id IN (SELECT id FROM badges WHERE type = 'auto')`
    )
    .run(AUTO_METRIC_BADGE_POINTS).changes;

  // 'COMPLETIONIST' here is the same badge identity badge-engine.js owns as
  // CLEAN_SWEEP_CODE; this file cannot import it (the db -> scoring -> db
  // require cycle documented on AUTO_METRIC_BADGE_POINTS above), so a rename
  // there must update this literal too. Joining on code alone (no type or
  // awarded_by guard) is sufficient because badges.code is UNIQUE
  // (schema.js) and ADMIN_AWARDABLE_TYPES is special/custom only, so no
  // hand-awarded display-only row can carry this code; if admin awarding
  // ever widens to metric badges, this WHERE needs the type guard the first
  // UPDATE's comment argues for.
  const cleanSweepChanges = db
    .prepare(
      `UPDATE guest_badges
          SET points = ?
        WHERE points IN (0, 1)
          AND badge_id IN (SELECT id FROM badges WHERE code = 'COMPLETIONIST')`
    )
    .run(CLEAN_SWEEP_BADGE_POINTS).changes;

  return autoChanges + cleanSweepChanges;
}

module.exports = {
  ensureBadgeTypeCheckWidened,
  ensureBadgeTaskIdColumn,
  ensureGuestBadgeAwardColumns,
  ensureGuestBadgeSubmissionCascade,
  ensureGuestBadgeCelebratedAtColumn,
  ensureGuestBadgeRankColumn,
  ensureBadgeCatalog,
  ensureRetiredBadgesRemoved,
  ensureSpecialBadgeCollisionsRemoved,
  ensureBadgeWinnersTableDropped,
  AUTO_METRIC_BADGE_POINTS,
  CLEAN_SWEEP_BADGE_POINTS,
  ensureAutoMetricBadgePointsBackfilled,
};
