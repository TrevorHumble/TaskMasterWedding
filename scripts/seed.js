// scripts/seed.js
'use strict';

const { db } = require('../src/db');

// ---------------------------------------------------------------------------
// 1) Canonical badge catalog. These 7 rows are fixed by the project spec.
//    'auto' badges are granted automatically at a completed-task threshold.
//    'special' badges have threshold = null and are hand-awarded by the admin.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// 2) Sample scavenger-hunt tasks for a garden-party wedding.
//    The admin can edit/add/remove these later; these just seed a starting set.
//    sort_order controls display order (0 first).
// ---------------------------------------------------------------------------
const TASKS = [
  {
    title: 'Snap the happy couple',
    description: 'Get a photo with Axel and Lily together. Bonus charm for a candid one.',
  },
  {
    title: 'Catch someone on the dance floor',
    description: 'Photograph a guest mid-dance move. Blurry feet are encouraged.',
  },
  {
    title: 'Find the prettiest flower',
    description: 'Hunt the garden for the bloom you think is the most beautiful and photograph it.',
  },
  {
    title: 'Toast with a stranger',
    description: 'Clink glasses with someone you have not met yet and capture the cheers.',
  },
  {
    title: 'Pastel outfit spotting',
    description: 'Find a guest dressed in our garden-party pastels and snap their look.',
  },
  {
    title: 'Sweet treat selfie',
    description: 'Take a selfie with something delicious from the dessert table.',
  },
];

// ---------------------------------------------------------------------------
// 3) Insert badges idempotently (only if the code is not already present).
// ---------------------------------------------------------------------------
const findBadge = db.prepare(`SELECT id FROM badges WHERE code = ?`);
const insertBadge = db.prepare(`
  INSERT INTO badges (code, name, type, threshold, art_path, description)
  VALUES (@code, @name, @type, @threshold, @art_path, @description)
`);

let badgesInserted = 0;
let badgesSkipped = 0;
for (const b of BADGES) {
  if (findBadge.get(b.code)) {
    badgesSkipped += 1;
  } else {
    insertBadge.run(b);
    badgesInserted += 1;
  }
}

// ---------------------------------------------------------------------------
// 4) Insert sample tasks ONLY if the tasks table is currently empty,
//    so re-running the seed never duplicates or overwrites admin edits.
// ---------------------------------------------------------------------------
const taskCount = db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get().n;
const insertTask = db.prepare(`
  INSERT INTO tasks (title, description, sort_order, is_active)
  VALUES (@title, @description, @sort_order, 1)
`);

let tasksInserted = 0;
if (taskCount === 0) {
  // better-sqlite3 transaction: all inserts succeed together or none do.
  const insertAll = db.transaction((rows) => {
    rows.forEach((t, index) => {
      insertTask.run({
        title: t.title,
        description: t.description,
        sort_order: index, // 0, 1, 2, ... preserves the listed order
      });
      tasksInserted += 1;
    });
  });
  insertAll(TASKS);
}

// ---------------------------------------------------------------------------
// 5) Report what happened.
// ---------------------------------------------------------------------------
console.log('Seed complete.');
console.log(`  Badges: ${badgesInserted} inserted, ${badgesSkipped} already existed.`);
if (taskCount === 0) {
  console.log(`  Tasks:  ${tasksInserted} inserted.`);
} else {
  console.log(`  Tasks:  skipped (${taskCount} already present).`);
}
