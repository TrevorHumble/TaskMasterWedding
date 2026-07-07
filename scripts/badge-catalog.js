// scripts/badge-catalog.js
//
// Single source of truth for the seeded badge catalog (#193 AC4).
// Deliberately data-only: scripts/seed.js runs its inserts at require-time
// against the real db singleton, so any module that wants the catalog without
// those side effects (scripts/seed-event.js, tests) must get it from here.
// Keep it that way — no require of src/db, no file I/O, no inserts.
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
    description: 'Awarded by the Task Master for early arrival.',
  },
  {
    code: 'SHUTTERBUG',
    name: 'Shutterbug',
    type: 'special',
    threshold: null,
    art_path: '/badges/shutterbug.svg',
    description: 'Awarded by the Task Master for great photography.',
  },
  {
    code: 'CROWDFAV',
    name: 'Crowd Favorite',
    type: 'special',
    threshold: null,
    art_path: '/badges/crowdfav.svg',
    description: 'Awarded by the Task Master as the crowd favorite.',
  },
  {
    code: 'CHOICE',
    name: "Task Master's Choice",
    type: 'special',
    threshold: null,
    art_path: '/badges/choice.svg',
    description: 'Awarded by the Task Master as their personal pick.',
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
];

module.exports = { BADGES };
