// scripts/badge-catalog.js
//
// Single source of truth for the seeded badge catalog (#193 AC4), plus the
// one shared ensureBadgeCatalog(db) that inserts it (#314). Callers — the
// seed scripts and src/db.js's boot path — pass their own `db` in; this
// module never touches a database on its own. This file's only require is
// the pure, zero-dependency src/services/badge-copy.js (issue #1094) — no
// require of src/db, no file I/O, no require-time side effects. Any future
// require added here must stay equally pure. Keep it that way.
//
// 'auto' badges are granted automatically at a completed-task threshold.
// 'special' badges have threshold = null and are hand-awarded by the admin.
// 'metric' and 'transferable' badges are computed by the badge engine (#80).
'use strict';

// The single composer of an auto badge's "Completed N tasks." description
// (issue #1094) — the same function src/services/scoring/badge-engine.js's
// setAutoBadgeThresholds (the admin save path) uses, so this boot re-sync
// path and that admin-save path can never diverge on wording (AC6).
const { autoBadgeDescription } = require('../src/services/badge-copy');

const BADGES = [
  {
    code: 'BLOOM',
    name: 'First Bloom',
    type: 'auto',
    threshold: 5,
    art_path: '/badges/bloom.svg',
    description: 'Completed 5 tasks.',
  },
  {
    code: 'BOUQUET',
    name: 'Bouquet Builder',
    type: 'auto',
    threshold: 10,
    art_path: '/badges/bouquet.svg',
    description: 'Completed 10 tasks.',
  },
  {
    code: 'GARDEN',
    name: 'Full Garden',
    type: 'auto',
    threshold: 15,
    art_path: '/badges/garden.svg',
    description: 'Completed 15 tasks.',
  },
  {
    code: 'EARLYBIRD',
    name: 'Early Bird',
    type: 'special',
    threshold: null,
    art_path: '/badges/earlybird.svg',
    description: 'Awarded by the Wedding Master for early arrival.',
  },
  {
    code: 'COMPLETIONIST',
    name: 'Completionist',
    type: 'metric',
    threshold: null,
    art_path: '/badges/completionist.svg',
    description: 'Completed every active task. One-time; auto-revokes if a new task is added.',
  },
  {
    code: 'TOPLIKED',
    name: 'Crowd Favorite',
    type: 'transferable',
    threshold: null,
    art_path: '/badges/most-liked.svg',
    description: 'Owns a top-five most-liked photo. Keep the likes coming to hold on.',
  },
];

// Bachelor-party "Stag Master" second-instance catalog (issue #640). Same
// upsert, keyed on the same badges.code values, but a different
// display/art set: the milestone badges rename to the bar-themed tier the
// bachelor party actually runs (First Round / Second Round / Last Call) and
// wear the bundled Material bar icons in the gold medallion instead of the
// composed flower art. There is deliberately NO GARDEN entry — the event
// runs 10 challenges, no 15-task tier. Auto-badge thresholds are read live
// off each 'auto' row's own `threshold` column (issue #1094's
// autoBadgeThresholds()), so a stag boot simply never sees a GARDEN entry at
// all — recomputeBadges' `if (!badge) continue` guard remains a defensive
// backstop, not what makes this safe (AC5). Every
// art_path here points under src/public/badges/stag/, a gold-on-dark
// recolor of the wedding files that leaves them byte-unchanged (AC4).
const STAG_BADGES = [
  {
    code: 'BLOOM',
    name: 'First Round',
    type: 'auto',
    threshold: 5,
    art_path: '/badges/stag/icons/sports-bar.svg',
    description: 'Completed 5 tasks.',
  },
  {
    code: 'BOUQUET',
    name: 'Second Round',
    type: 'auto',
    threshold: 10,
    art_path: '/badges/stag/icons/liquor.svg',
    description: 'Completed 10 tasks.',
  },
  {
    code: 'EARLYBIRD',
    name: 'Early Bird',
    type: 'special',
    threshold: null,
    art_path: '/badges/stag/earlybird.svg',
    description: 'Awarded by the Stag Master for early arrival.',
  },
  {
    code: 'COMPLETIONIST',
    name: 'Last Call',
    type: 'metric',
    threshold: null,
    art_path: '/badges/stag/icons/nightlife.svg',
    description: 'Completed every active task. One-time; auto-revokes if a new task is added.',
  },
  {
    code: 'TOPLIKED',
    name: 'Crowd Favorite',
    type: 'transferable',
    threshold: null,
    art_path: '/badges/stag/most-liked.svg',
    description: 'Owns a top-five most-liked photo. Keep the likes coming to hold on.',
  },
];

/**
 * Resolve which catalog array a boot/seed should upsert, keyed on the
 * VARIANT flag (issue #640). Any value other than the exact literal 'stag'
 * — including undefined/unset — resolves to the wedding catalog, matching
 * config.js's own "anything but the literal 'stag' behaves like unset"
 * contract (AC1).
 *
 * @param {string} [variant]
 * @returns {object[]}
 */
function catalogForVariant(variant) {
  return variant === 'stag' ? STAG_BADGES : BADGES;
}

/**
 * Upsert the catalog keyed on the badges.code UNIQUE constraint (see
 * src/db.js's CREATE TABLE): a code not yet present is inserted; a code
 * already present has its display fields (`name`, `description`, `art_path`)
 * re-synced (#655 — a catalog rename like #354's "Wedding Master's Choice"
 * must reach an existing database, not just a fresh one). For an 'auto' row,
 * `description` is not re-synced to this module's own literal — it is
 * composed from the row's LIVE `threshold` column (syncedDescriptionFor
 * below); the module's literal only supplies the initial value on a fresh
 * insert, when no live threshold exists yet. `type` and `threshold`
 * themselves are deliberately left untouched on conflict — the
 * `badges.threshold` column is the single runtime source of truth for an
 * auto badge's threshold (issue #1094), written on an EXISTING row only by
 * the admin Configuration page (src/routes/admin/config.js via
 * scoring.setAutoBadgeThresholds), and a type flip on a live row is out of
 * scope here.
 *
 * This is safe for admin-edited rows because no admin route can rename a
 * catalog badge: admin badge editing only ever touches a task badge (code
 * `TASK-<id>`) or a freeform custom badge the admin creates with its own
 * non-catalog code (see src/services/task-badges.js and
 * scoring.createCustomBadge, which both refuse the catalog's codes). A code
 * absent from BADGES above is therefore never touched by this upsert.
 *
 * better-sqlite3's RunResult.changes is 1 for both a fresh insert and a
 * conflict-triggered update, so it cannot distinguish the two on its own
 * (#655 AC5). Classify each code by reading its existing row (if any) before
 * running the upsert, and compare its display fields to the catalog values.
 *
 * Issue #640: takes an optional `variant` second argument — `catalogForVariant`
 * above resolves it to STAG_BADGES or BADGES, and the loop below upserts
 * exactly that array, so the "no GARDEN row on a stag boot" and "a stag
 * restart re-asserts stag values, never wedding ones" guarantees (AC1, AC5)
 * fall out of which array this call receives rather than a second code path.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} [variant] - config.VARIANT ('' or 'stag'). Omitted/anything
 *   other than 'stag' upserts the wedding BADGES array, unchanged from before
 *   this parameter existed — every pre-#640 caller (this module's own tests,
 *   any script that has not been updated) keeps its exact prior behavior.
 * @returns {{ inserted: number, updated: number, unchanged: number }}
 */
// The catalog display fields re-synced to an existing row on conflict. This
// array is the single owner of "which fields the upsert re-syncs": the
// SELECT below reads exactly these (plus `threshold`, read but never
// compared here — see syncedDescriptionFor below), the ON CONFLICT DO UPDATE
// SET clause writes exactly these, and the drift check compares exactly
// these — so a future added field is added in one place, not three. Every
// entry is a hard-coded, known-safe column identifier (never user input), so
// interpolating them into the SQL text carries no injection risk.
const SYNCED_FIELDS = ['name', 'description', 'art_path'];

/**
 * The description an 'auto' row's re-sync targets (issue #1094): NOT the
 * catalog literal, but the SAME composer (autoBadgeDescription, imported
 * above) badge-engine.js's setAutoBadgeThresholds uses for the admin save
 * path — the one shared function both writers of an auto row's description
 * consume, so the two can never diverge on plural/singular wording (AC6). A
 * live, admin-set threshold on an EXISTING row therefore keeps its OWN
 * matching description on re-sync, rather than the catalog re-asserting its
 * seeded literal over an admin's edit. A fresh insert (`existing` undefined)
 * has no live threshold yet, so it composes off the catalog's own
 * `b.threshold` — which, for every entry in BADGES/STAG_BADGES above,
 * produces the exact literal already written there (both were authored to
 * match), so a first-ever seed is unaffected by this change. Every non-
 * 'auto' type (special/metric/transferable/custom) keeps its catalog
 * description untouched, exactly as before this issue — thresholds, and the
 * descriptions built from them, are an 'auto'-only concept.
 * @param {object} b - one BADGES/STAG_BADGES entry.
 * @param {{threshold: number}|undefined} existing - the row's current DB
 *   state (from selectExisting below), or undefined for a fresh insert.
 * @returns {string}
 */
function syncedDescriptionFor(b, existing) {
  if (b.type !== 'auto') {
    return b.description;
  }
  // existing.threshold is null/undefined only in a state this upsert never
  // itself produces (an 'auto' row whose threshold was cleared out from
  // under it) — fall back to the catalog entry's own threshold rather than
  // composing "Completed null tasks." from a row that lost its live value.
  const liveThreshold = existing && existing.threshold != null ? existing.threshold : b.threshold;
  return autoBadgeDescription(liveThreshold);
}

function ensureBadgeCatalog(db, variant) {
  const catalog = catalogForVariant(variant);
  const selectExisting = db.prepare(
    `SELECT ${SYNCED_FIELDS.join(', ')}, threshold FROM badges WHERE code = ?`
  );
  const upsertBadge = db.prepare(`
    INSERT INTO badges (code, name, type, threshold, art_path, description)
    VALUES (@code, @name, @type, @threshold, @art_path, @description)
    ON CONFLICT(code) DO UPDATE SET
      ${SYNCED_FIELDS.map((f) => `${f} = excluded.${f}`).join(',\n      ')}
  `);

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  for (const b of catalog) {
    const existing = selectExisting.get(b.code);
    // `row` is what actually gets upserted: every field of `b` except
    // `description`, which is overridden to the synced target above so the
    // ON CONFLICT clause's `excluded.description` (and the drift check just
    // below) both see the composed value, not the raw catalog literal.
    const row = { ...b, description: syncedDescriptionFor(b, existing) };
    if (!existing) {
      inserted += 1;
    } else if (SYNCED_FIELDS.some((f) => existing[f] !== row[f])) {
      updated += 1;
    } else {
      unchanged += 1;
    }
    upsertBadge.run(row);
  }
  return { inserted, updated, unchanged };
}

module.exports = { BADGES, STAG_BADGES, catalogForVariant, ensureBadgeCatalog };
