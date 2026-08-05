// src/db/migrations-ops.js
// Guarded schema migrations for operational bookkeeping tables that belong
// to neither a guest-facing domain nor another domain file (issue #969 PR
// review fix, domain regroup): bug_reports.status (the report lifecycle) and
// the generic `settings` key/value store. Grouped together because both are
// host/ops-only concerns with no guest-visible row of their own, not because
// they share a table — contrast migrations-tasks.js/-submissions.js/-badges.js/
// -guests.js, each scoped to one real table family. Each function takes the
// open `db` handle as its first parameter (never a module-load capture of
// its own — see src/db/connection.js's own comment on why) and is invoked,
// in this exact source order, from the entry's (src/db.js) load-bearing boot
// sequence. openBugCount() — a read, not a migration — lives in the sibling
// src/db/bug-reports.js instead of here; see that file's own header for why.
'use strict';

// --- Guarded migration: bug_reports.status (issue #686) ---
/**
 * Add bug_reports.status if it is not already present, backfill it from the
 * retired `resolved` boolean, then (re)point the lifecycle index at `status`
 * instead of `resolved`.
 *
 * status replaces the old two-state resolved boolean with the three-state
 * open/tracked/closed lifecycle the admin Bugs page needs (issue #686): a
 * report handed to GitHub ("tracked") must stay distinguishable from one
 * dismissed outright ("closed"), which a single boolean cannot encode.
 *
 * Same guard shape as ensurePhotoBonusColumn/ensureResubmittedColumn
 * (src/db/migrations-submissions.js): the bug_reports CREATE TABLE above
 * already declares `status` (with its CHECK), so this is a no-op there; on
 * an existing pre-#686 app.db the column is absent, so PRAGMA table_info
 * detects that and the ALTER TABLE + backfill run once. A literal string
 * DEFAULT ('open') is a constant default, not the datetime('now')-style
 * non-constant default that forces a separate backfill UPDATE elsewhere
 * (see migrations-guests.js's ensureRecapCheckedAtColumn comment) — SQLite
 * accepts `ADD COLUMN ... DEFAULT 'open' CHECK (...)` in one statement,
 * verified against this tree's better-sqlite3/SQLite build, and the CHECK is
 * enforced on every write from that point on (including this migration's own
 * backfill UPDATE, which only ever writes 'closed').
 *
 * Backfill: every pre-existing resolved=1 row becomes 'closed' (matching the
 * old "resolved" meaning); every resolved=0 row is already 'open' from the
 * column's own DEFAULT, so no separate UPDATE is needed for that half.
 * `resolved` itself is left in place, unread from this point on — a purely
 * additive column is lower-risk than a table rebuild here, and nothing in
 * this codebase still queries it (see the column's own comment above).
 *
 * The index swap (drop idx_bug_reports_resolved, create
 * idx_bug_reports_status) runs UNCONDITIONALLY, every boot, outside the
 * column-presence guard above: a fresh DB never had the old index to drop
 * (DROP INDEX IF EXISTS is a no-op there) and needs the new one created since
 * the top CREATE TABLE/INDEX block above deliberately does NOT create it
 * (that block runs before this migration on an existing pre-#686 database,
 * where `status` does not exist yet — an unconditional `CREATE INDEX ... ON
 * bug_reports(status, ...)` there would throw "no such column: status" on
 * that exact database, the same hazard migrations-tasks.js's
 * ensureTaskSpecialDayColumns' own comment warns about for a
 * column-referencing index created too early).
 *
 * Exported so tests bind to this real guard rather than an inline copy.
 */
function ensureBugReportStatusColumn(db) {
  const cols = db.prepare(`PRAGMA table_info(bug_reports)`).all();
  if (!cols.some((col) => col.name === 'status')) {
    db.exec(`ALTER TABLE bug_reports ADD COLUMN status TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','tracked','closed'))`);
    db.exec(`UPDATE bug_reports SET status = 'closed' WHERE resolved = 1`);
  }
  db.exec(`DROP INDEX IF EXISTS idx_bug_reports_resolved`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_bug_reports_status ON bug_reports(status, created_at DESC)`
  );
}

// --- Guarded migration: settings table (issue #283) ---
/**
 * Create the `settings` key/value table if it does not already exist.
 *
 * Shape coordinated with #253's planned settings table (two columns,
 * IF NOT EXISTS) — whichever change lands first wins and the other's
 * migration is a no-op. src/services/lockout.js uses this table to persist
 * admin-lockout state (failedAttempts / lockedUntil) across a process
 * restart, replacing the module-scoped scalars src/routes/auth.js carried
 * before #283. src/db/event-config.js also reads/writes this table (the
 * event timezone + wedding date range), a second consumer this migration's
 * IF NOT EXISTS shape serves equally without change. Exported so tests bind
 * to this real guard rather than an inline copy.
 */
function ensureSettingsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}

// --- Guarded migration: bug_reports.guest_id nullable (issue #1102) ---
/**
 * Drop NOT NULL from bug_reports.guest_id so a bug report filed by someone
 * who is not signed in (before they ever join, on /join, on /login, or on an
 * error page reached before joining) can be stored at all.
 *
 * Unlike ensureTaskIdNullable (migrations-submissions.js), this is not a
 * 12-step rebuild. This tree's better-sqlite3 (12.11.1) ships SQLite 3.53.2,
 * which supports `ALTER TABLE ... ALTER COLUMN ... DROP NOT NULL` directly —
 * verified against a replica of the real bug_reports shape to preserve the
 * guests(id) ON DELETE CASCADE foreign key, the status CHECK,
 * idx_bug_reports_status, and every existing row, and to be idempotent (a
 * second run succeeds and changes nothing). So there is no `foreign_keys`
 * pragma, no transaction, and no explicit column-copy list here: an explicit
 * copy list is the one thing that can permanently diverge a migrated
 * database from a fresh one, and this single ALTER cannot produce that
 * failure. The guard below exists for clarity and an early exit on an
 * already-migrated database, not because the ALTER is unsafe to repeat.
 *
 * This migration never mentions `status`, so — unlike the rebuilds in
 * migrations-submissions.js — it carries no ordering dependency on
 * ensureBugReportStatusColumn(): it cannot throw `no such column: status` on
 * a pre-#686 database, and running it before or after that migration in the
 * db.js chain makes no difference. It is exported so tests bind to this real
 * guard rather than an inline copy.
 */
function ensureBugReportGuestIdNullable(db) {
  const cols = db.prepare(`PRAGMA table_info(bug_reports)`).all();
  const guestIdCol = cols.find((col) => col.name === 'guest_id');
  if (!guestIdCol || guestIdCol.notnull === 0) {
    // No bug_reports table yet, or guest_id is already nullable — nothing to do.
    return;
  }
  db.exec(`ALTER TABLE bug_reports ALTER COLUMN guest_id DROP NOT NULL`);
}

module.exports = {
  ensureBugReportStatusColumn,
  ensureSettingsTable,
  ensureBugReportGuestIdNullable,
};
