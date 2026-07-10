// scripts/seed.js
'use strict';

const { db } = require('../src/db');

// ---------------------------------------------------------------------------
// 1) Canonical badge catalog — one shared module (#193 AC4, consolidated
//    #314). scripts/seed.js, scripts/seed-event.js, and src/db.js's boot path
//    all insert via this same function so the catalogs can never drift apart.
// ---------------------------------------------------------------------------
const { ensureBadgeCatalog } = require('./badge-catalog');

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
const { inserted: badgesInserted, skipped: badgesSkipped } = ensureBadgeCatalog(db);

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
