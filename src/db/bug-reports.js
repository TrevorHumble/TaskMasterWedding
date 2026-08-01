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

module.exports = { openBugCount };
