// src/db.js
// Database entry (issue #969 split). Internals live under src/db/:
// connection.js owns the `db` handle (mkdir -> open -> pragmas, the only
// module-load DB side effect in src/db/); schema.js applies the table DDL;
// migrations-tasks.js/migrations-submissions.js/migrations-badges.js/
// migrations-guests.js/migrations-ops.js hold the guarded migrations, one
// file per domain — grouped by the table each migrates, so a maintainer
// looking for a table's shape history opens exactly one file (#969);
// bug-reports.js holds the one read (openBugCount) that isn't a migration;
// event-config.js and
// guest-lookups.js hold the runtime-called helpers. This file's own require
// path (`require('../db')` from src/routes/, `require('./db')` from src/)
// and its full public API are unchanged.
'use strict';

const { db } = require('./db/connection');
const schema = require('./db/schema');
const migrationsTasks = require('./db/migrations-tasks');
const migrationsSubmissions = require('./db/migrations-submissions');
const migrationsBadges = require('./db/migrations-badges');
const migrationsGuests = require('./db/migrations-guests');
const migrationsOps = require('./db/migrations-ops');
const bugReports = require('./db/bug-reports');
const eventConfig = require('./db/event-config');
const guestLookups = require('./db/guest-lookups');

// --- Schema: create every table if it does not already exist. -------------
schema.applySchema(db);

// --- Guarded migrations: LOAD-BEARING ORDER. -------------------------------
// Every ensure*() call below must run in exactly this source order — several
// migrations rebuild a table from an explicit column-copy list, and a column
// added by a LATER migration in the wrong order would be silently dropped by
// an EARLIER migration's rebuild (see e.g. migrations-badges.js's own
// ensureGuestBadgeSubmissionCascade and migrations-submissions.js's
// ensureTakenDownByColumn doc comments for concrete cases). This order is
// unchanged from bd70cff's db.js — the split (and the later domain regroup)
// moved function definitions only, never reordered them.
migrationsTasks.ensureTaskWorthAndMode(db);
migrationsTasks.ensureTaskSpecialDayColumns(db);
migrationsTasks.ensureTaskFlashColumns(db);
migrationsTasks.ensureTaskLuckyColumns(db);
migrationsTasks.ensureTaskLiveSinceColumn(db);
migrationsTasks.ensureTaskWorthRange(db);
migrationsSubmissions.ensurePhotoBonusColumn(db);
migrationsBadges.ensureBadgeTypeCheckWidened(db);
migrationsBadges.ensureBadgeTaskIdColumn(db);
migrationsBadges.ensureGuestBadgeAwardColumns(db);
migrationsBadges.ensureGuestBadgeSubmissionCascade(db);
migrationsBadges.ensureGuestBadgeCelebratedAtColumn(db);
migrationsBadges.ensureGuestBadgeRankColumn(db);
migrationsGuests.ensurePinnedColumn(db);
migrationsGuests.ensureGuestIdentityColumns(db);
migrationsSubmissions.ensureTaskIdNullable(db);
migrationsSubmissions.ensureSubmissionsBonusColumns(db);
migrationsBadges.ensureBadgeCatalog(db);
migrationsBadges.ensureRetiredBadgesRemoved(db);
migrationsBadges.ensureSpecialBadgeCollisionsRemoved(db);
migrationsBadges.ensureBadgeWinnersTableDropped(db);
migrationsBadges.ensureAutoMetricBadgePointsBackfilled(db);
migrationsSubmissions.ensureResubmittedColumn(db);
migrationsSubmissions.ensureTakenDownByColumn(db);
migrationsGuests.ensureAvatarPointAwardedRetired(db);
migrationsGuests.ensureRecapCheckedAtColumn(db);
migrationsGuests.ensureIsCoupleColumn(db);
migrationsGuests.ensureBlockedColumn(db);
migrationsOps.ensureBugReportStatusColumn(db);
// ensureBugReportGuestIdNullable imposes no ordering constraint of its own
// (see its own comment in migrations-ops.js) -- it runs here, next to the
// other bug_reports migration, only to keep the two adjacent in this file.
migrationsOps.ensureBugReportGuestIdNullable(db);
migrationsOps.ensureSettingsTable(db);

// --- Public API: identical names/shapes to bd70cff's db.js, each a thin ----
// wrapper closing over this module's own `db` (captured once, above — safe
// here because this entry is always re-executed together with
// src/db/connection.js on a fresh require after eviction; see
// src/db/connection.js's own comment for why an INTERNAL may not do this).
module.exports = {
  db,
  ensureTaskWorthAndMode: () => migrationsTasks.ensureTaskWorthAndMode(db),
  ensureTaskSpecialDayColumns: () => migrationsTasks.ensureTaskSpecialDayColumns(db),
  ensureTaskFlashColumns: () => migrationsTasks.ensureTaskFlashColumns(db),
  ensureTaskLuckyColumns: () => migrationsTasks.ensureTaskLuckyColumns(db),
  ensureTaskLiveSinceColumn: () => migrationsTasks.ensureTaskLiveSinceColumn(db),
  ensureTaskWorthRange: () => migrationsTasks.ensureTaskWorthRange(db),
  ensurePhotoBonusColumn: () => migrationsSubmissions.ensurePhotoBonusColumn(db),
  ensureBadgeTypeCheckWidened: () => migrationsBadges.ensureBadgeTypeCheckWidened(db),
  ensureBadgeTaskIdColumn: () => migrationsBadges.ensureBadgeTaskIdColumn(db),
  ensureGuestBadgeAwardColumns: () => migrationsBadges.ensureGuestBadgeAwardColumns(db),
  ensureGuestBadgeSubmissionCascade: () => migrationsBadges.ensureGuestBadgeSubmissionCascade(db),
  ensurePinnedColumn: () => migrationsGuests.ensurePinnedColumn(db),
  ensureGuestIdentityColumns: () => migrationsGuests.ensureGuestIdentityColumns(db),
  ensureTaskIdNullable: () => migrationsSubmissions.ensureTaskIdNullable(db),
  ensureSubmissionsBonusColumns: () => migrationsSubmissions.ensureSubmissionsBonusColumns(db),
  ensureBadgeCatalog: () => migrationsBadges.ensureBadgeCatalog(db),
  ensureRetiredBadgesRemoved: () => migrationsBadges.ensureRetiredBadgesRemoved(db),
  ensureSpecialBadgeCollisionsRemoved: () =>
    migrationsBadges.ensureSpecialBadgeCollisionsRemoved(db),
  ensureBadgeWinnersTableDropped: () => migrationsBadges.ensureBadgeWinnersTableDropped(db),
  ensureGuestBadgeRankColumn: () => migrationsBadges.ensureGuestBadgeRankColumn(db),
  AUTO_METRIC_BADGE_POINTS: migrationsBadges.AUTO_METRIC_BADGE_POINTS,
  CLEAN_SWEEP_BADGE_POINTS: migrationsBadges.CLEAN_SWEEP_BADGE_POINTS,
  ensureAutoMetricBadgePointsBackfilled: () =>
    migrationsBadges.ensureAutoMetricBadgePointsBackfilled(db),
  ensureResubmittedColumn: () => migrationsSubmissions.ensureResubmittedColumn(db),
  ensureTakenDownByColumn: () => migrationsSubmissions.ensureTakenDownByColumn(db),
  ensureAvatarPointAwardedRetired: () => migrationsGuests.ensureAvatarPointAwardedRetired(db),
  ensureGuestBadgeCelebratedAtColumn: () => migrationsBadges.ensureGuestBadgeCelebratedAtColumn(db),
  ensureRecapCheckedAtColumn: () => migrationsGuests.ensureRecapCheckedAtColumn(db),
  ensureIsCoupleColumn: () => migrationsGuests.ensureIsCoupleColumn(db),
  ensureBlockedColumn: () => migrationsGuests.ensureBlockedColumn(db),
  ensureBugReportStatusColumn: () => migrationsOps.ensureBugReportStatusColumn(db),
  ensureBugReportGuestIdNullable: () => migrationsOps.ensureBugReportGuestIdNullable(db),
  openBugCount: () => bugReports.openBugCount(db),
  insertBugReportOnce: (report) => bugReports.insertBugReportOnce(db, report),
  // Test-only accessors: not used by any route, exist so tests can assert
  // against the body/page caps POST /bug-report and POST /error-report share
  // (issue #1020) without restating them.
  BUG_REPORT_BODY_MAX: bugReports.BUG_REPORT_BODY_MAX,
  BUG_REPORT_PAGE_MAX: bugReports.BUG_REPORT_PAGE_MAX,
  ensureSettingsTable: () => migrationsOps.ensureSettingsTable(db),
  getEventConfig: () => eventConfig.getEventConfig(db),
  setEventConfig: (cfg) => eventConfig.setEventConfig(db, cfg),
  getPrizes: () => eventConfig.getPrizes(db),
  setPrizes: (text) => eventConfig.setPrizes(db, text),
  // Pure string/constant, no db handle needed — re-exported as-is rather than
  // wrapped in a closure like the db-bound functions above.
  normalizePrizes: eventConfig.normalizePrizes,
  PRIZES_MAX_LENGTH: eventConfig.PRIZES_MAX_LENGTH,
  isCeremonyNoticeLive: eventConfig.isCeremonyNoticeLive,
  getGuestByToken: (token) => guestLookups.getGuestByToken(db, token),
  getGuestById: (guestId) => guestLookups.getGuestById(db, guestId),
  getGuestByContact: (contact) => guestLookups.getGuestByContact(db, contact),
  markGuestOnboarded: (guestId) => guestLookups.markGuestOnboarded(db, guestId),
  cleanupSelfLikes: () => guestLookups.cleanupSelfLikes(db),
};
