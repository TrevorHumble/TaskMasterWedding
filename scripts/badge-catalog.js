// scripts/badge-catalog.js
//
// Single source of truth for the seeded badge catalog (#193 AC4), plus the
// one shared ensureBadgeCatalog(db) that inserts it (#314). Callers — the
// seed scripts and src/db.js's boot path — pass their own `db` in; this
// module never touches a database on its own. No require of src/db, no file
// I/O, no require-time side effects. Keep it that way.
//
// 'auto' badges are granted automatically at a completed-task threshold.
// 'special' badges have threshold = null and are hand-awarded by the admin.
// 'metric' and 'transferable' badges are computed by the badge engine (#80).
'use strict';

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
    code: 'SHUTTERBUG',
    name: 'Shutterbug',
    type: 'special',
    threshold: null,
    art_path: '/badges/shutterbug.svg',
    description: 'Awarded by the Wedding Master for great photography.',
  },
  {
    code: 'CROWDFAV',
    name: 'Crowd Favorite',
    type: 'special',
    threshold: null,
    art_path: '/badges/crowdfav.svg',
    description: 'Awarded by the Wedding Master as the crowd favorite.',
  },
  {
    code: 'CHOICE',
    name: "Wedding Master's Choice",
    type: 'special',
    threshold: null,
    art_path: '/badges/choice.svg',
    description: 'Awarded by the Wedding Master as their personal pick.',
  },
  {
    code: 'COMPLETIONIST',
    name: 'Completionist',
    type: 'metric',
    threshold: null,
    art_path: '/badges/completionist.svg',
    description: 'Completed every active task. One-time; auto-revokes if a new task is added.',
  },
];

/**
 * Upsert the catalog keyed on the badges.code UNIQUE constraint (see
 * src/db.js's CREATE TABLE): a code not yet present is inserted; a code
 * already present has its display fields (`name`, `description`, `art_path`)
 * re-synced to match this module (#655 — a catalog rename like #354's
 * "Wedding Master's Choice" must reach an existing database, not just a
 * fresh one). `type` and `threshold` are deliberately left untouched on
 * conflict — auto-badge thresholds are owned by src/services/scoring.js and
 * a type flip on a live row is out of scope here.
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
 * @param {import('better-sqlite3').Database} db
 * @returns {{ inserted: number, updated: number, unchanged: number }}
 */
// The catalog display fields re-synced to an existing row on conflict. This
// array is the single owner of "which fields the upsert re-syncs": the
// SELECT below reads exactly these, the ON CONFLICT DO UPDATE SET clause
// writes exactly these, and the drift check compares exactly these — so a
// future added field is added in one place, not three. Every entry is a
// hard-coded, known-safe column identifier (never user input), so
// interpolating them into the SQL text carries no injection risk.
const SYNCED_FIELDS = ['name', 'description', 'art_path'];

function ensureBadgeCatalog(db) {
  const selectExisting = db.prepare(
    `SELECT ${SYNCED_FIELDS.join(', ')} FROM badges WHERE code = ?`
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
  for (const b of BADGES) {
    const existing = selectExisting.get(b.code);
    if (!existing) {
      inserted += 1;
    } else if (SYNCED_FIELDS.some((f) => existing[f] !== b[f])) {
      updated += 1;
    } else {
      unchanged += 1;
    }
    upsertBadge.run(b);
  }
  return { inserted, updated, unchanged };
}

module.exports = { BADGES, ensureBadgeCatalog };
