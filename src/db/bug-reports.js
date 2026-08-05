// src/db/bug-reports.js
// A small queries module (issue #969 PR review fix): openBugCount() is a
// READ, not a migration, so it does not belong in migrations-ops.js beside
// ensureBugReportStatusColumn() even though both concern bug_reports — this
// file is that one query's home instead. Takes the open `db` handle as its
// parameter, same discipline as every other src/db/ internal (see
// src/db/connection.js's own comment on why none of them captures `db` at
// module load).
'use strict';

/**
 * The single owner of "how many bug reports are currently open" (issue #686
 * AC4) — the admin dashboard's stat grid and the "Today" checklist's bug pin
 * (both src/services/host-checklist.js) read this instead of each running
 * its own `WHERE status = 'open'` COUNT, so the two can never silently drift
 * apart on what "open" means.
 * @returns {number}
 */
function openBugCount(db) {
  return db.prepare(`SELECT COUNT(*) AS n FROM bug_reports WHERE status = 'open'`).get().n;
}

// A stored bug body is capped at this many characters (issue #245 AC6): long
// enough for a real description. This bounds only the per-request body
// length, not the number of reports a guest can file. Moved here from
// src/routes/guest/bug-report.js (issue #1020) so both POST /bug-report and
// POST /error-report cap through the one owner instead of each carrying its
// own copy of `1000`. insertBugReportOnce below is the one place this cap is
// actually applied -- neither caller truncates its own body any more.
const BUG_REPORT_BODY_MAX = 1000;

// bug_reports.page is guest-influenced (a Referer header a guest's own
// browser sends) and otherwise unbounded -- POST /error-report (issue #1020)
// is the first unauthenticated writer into this table, so an oversized
// Referer path is now a reachable way to grow a row without a signed-in
// account. Short: a real page path (e.g. '/tasks/some-long-slug') never
// approaches this; it exists to bound the column, not to fit real traffic.
const BUG_REPORT_PAGE_MAX = 500;

// Same-guest (or, since issue #1020, same-NULL-guest), same-stored-body
// reposts inside this window are double-taps or refresh-resubmits, not new
// reports (issue #889); a deliberate repeat filed later than this always
// lands.
const BUG_REPORT_DUPLICATE_WINDOW_SECONDS = 30;

/**
 * Insert a bug_reports row unless an identical one (same guest, same STORED
 * body) was already inserted within BUG_REPORT_DUPLICATE_WINDOW_SECONDS
 * (issue #889's double-submit guard, moved here by issue #1020 so
 * POST /bug-report and POST /error-report share one guard and one INSERT
 * instead of each hand-rolling a copy).
 *
 * `guestId IS ?` (not `= ?`) is deliberate (issue #1020): SQLite's `=` is
 * never true when either side is NULL, so a signed-out guest's (guest_id
 * NULL) identical repeat tap would otherwise never match its own prior row
 * and would insert a second one every time. `IS` treats NULL = NULL as a
 * match, same as every non-NULL guest_id comparison, so the guard now covers
 * both cases with one predicate.
 *
 * `body` and `page` are clamped to BUG_REPORT_BODY_MAX/BUG_REPORT_PAGE_MAX
 * HERE, once, before the dedupe SELECT runs -- not by the caller. The two
 * callers compose their bodies differently (a guest's freeform text vs. an
 * app-filed report's generated summary), so leaving truncation to each of
 * them risks one caller forgetting it: the dedupe SELECT would then compare
 * an untruncated body against truncated rows and never match, silently
 * defeating the double-tap guard for that caller.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{guestId: number|null, body: string, page: string|null, userAgent: string|null}} report
 */
function insertBugReportOnce(db, { guestId, body, page, userAgent }) {
  const clampedBody = body.slice(0, BUG_REPORT_BODY_MAX);
  const clampedPage = typeof page === 'string' ? page.slice(0, BUG_REPORT_PAGE_MAX) : page;

  const recentDuplicate = db
    .prepare(
      `SELECT 1 FROM bug_reports
        WHERE guest_id IS ? AND body = ?
          AND created_at >= datetime('now', '-' || ? || ' seconds')
        LIMIT 1`
    )
    .get(guestId, clampedBody, BUG_REPORT_DUPLICATE_WINDOW_SECONDS);

  if (recentDuplicate) {
    return;
  }

  // status defaults to 'open' (bug_reports.status, issue #686). Every new
  // report starts open, so this INSERT relies on the column's own DEFAULT
  // instead of naming it.
  db.prepare(
    `INSERT INTO bug_reports (guest_id, body, page, user_agent)
     VALUES (?, ?, ?, ?)`
  ).run(guestId, clampedBody, clampedPage, userAgent);
}

module.exports = {
  openBugCount,
  BUG_REPORT_BODY_MAX,
  BUG_REPORT_PAGE_MAX,
  insertBugReportOnce,
};
