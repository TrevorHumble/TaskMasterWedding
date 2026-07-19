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
  {
    code: 'MOSTPHOTOS',
    name: 'Most Photos',
    type: 'transferable',
    threshold: null,
    art_path: '/badges/mostphotos.svg',
    description:
      'Holds the most visible photo submissions right now. Steal-able — catch up to take it.',
  },
  {
    code: 'MOSTLIKED',
    name: 'Most Liked',
    type: 'transferable',
    threshold: null,
    art_path: '/badges/most-liked.svg',
    description:
      'Holds the most likes across their photos right now. Steal-able — earn more likes to take it.',
  },
];

/**
 * Insert the catalog insert-only: `INSERT OR IGNORE` keyed on the badges.code
 * UNIQUE constraint (see src/db.js's CREATE TABLE), so a row already present
 * — whether seeded earlier or admin-edited — is never overwritten (#314 AC3).
 * better-sqlite3's RunResult.changes is 0 when a row is ignored on conflict
 * and 1 when it inserts, so the per-row change count doubles as the
 * inserted/skipped tally with no separate SELECT needed.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ inserted: number, skipped: number }}
 */
function ensureBadgeCatalog(db) {
  const insertBadge = db.prepare(`
    INSERT OR IGNORE INTO badges (code, name, type, threshold, art_path, description)
    VALUES (@code, @name, @type, @threshold, @art_path, @description)
  `);

  let inserted = 0;
  let skipped = 0;
  for (const b of BADGES) {
    const { changes } = insertBadge.run(b);
    if (changes > 0) {
      inserted += 1;
    } else {
      skipped += 1;
    }
  }
  return { inserted, skipped };
}

module.exports = { BADGES, ensureBadgeCatalog };
