// scripts/seed.js
'use strict';

const config = require('../config');
const { db } = require('../src/db');

// ---------------------------------------------------------------------------
// 1) Canonical badge catalog — one shared module (#193 AC4, consolidated
//    #314). scripts/seed.js, scripts/seed-event.js, and src/db.js's boot path
//    all insert via this same function so the catalogs can never drift apart.
//    Passes config.VARIANT through (issue #640) so re-running this script
//    against a stag DATA_DIR keeps upserting the black-tie catalog, not the
//    wedding one.
// ---------------------------------------------------------------------------
const { ensureBadgeCatalog } = require('./badge-catalog');

// ---------------------------------------------------------------------------
// 2) Sample photo tasks for the wedding.
//    The admin can edit/add/remove these later; these just seed a starting set.
//    sort_order controls display order (0 first). docs/deploy.md forbids
//    running this script against real event data (real tasks come from the
//    admin UI) — but a developer previewing the stag look locally can still
//    run `VARIANT=stag node scripts/seed.js`, and this description would
//    then render as real guest/admin-facing task copy on that instance
//    (issue #640 AC3), so the one "Lilly" mention is variant-aware too.
// ---------------------------------------------------------------------------
const TASKS = [
  {
    title: 'Snap the happy couple',
    description:
      config.VARIANT === 'stag'
        ? 'Get a photo with Axel and the crew together. Bonus charm for a candid one.'
        : 'Get a photo with Axel and Lilly together. Bonus charm for a candid one.',
  },
  {
    title: 'Catch someone on the dance floor',
    description: 'Photograph a guest mid-dance move. Blurry feet are encouraged.',
  },
  {
    title: 'The prettiest bloom',
    description: 'Track down the bloom you think steals the show and photograph it.',
  },
  {
    title: 'Toast with a stranger',
    description: 'Clink glasses with someone you have not met yet and capture the cheers.',
  },
  {
    title: 'Best-dressed guest',
    description: 'Find the guest most dressed to impress and snap their look.',
  },
  {
    title: 'Sweet treat selfie',
    description: 'Take a selfie with something delicious from the dessert table.',
  },
];

// ---------------------------------------------------------------------------
// 3) Upsert badges: insert a missing code, re-sync an existing catalog
//    code's display fields to the module (#655).
// ---------------------------------------------------------------------------
const {
  inserted: badgesInserted,
  updated: badgesUpdated,
  unchanged: badgesUnchanged,
} = ensureBadgeCatalog(db, config.VARIANT);

// ---------------------------------------------------------------------------
// 4) Insert sample tasks ONLY if the tasks table is currently empty,
//    so re-running the seed never duplicates or overwrites admin edits.
// ---------------------------------------------------------------------------
const taskCount = db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get().n;
// No worth/special_mode named here (issue #727) — the tasks table's own
// defaults (worth 1, special_mode 'none') apply, same as the retired
// is_active column's DEFAULT 1 did before it.
const insertTask = db.prepare(`
  INSERT INTO tasks (title, description, sort_order)
  VALUES (@title, @description, @sort_order)
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
console.log(
  `  Badges: ${badgesInserted} inserted, ${badgesUpdated} updated, ${badgesUnchanged} unchanged.`
);
if (taskCount === 0) {
  console.log(`  Tasks:  ${tasksInserted} inserted.`);
} else {
  console.log(`  Tasks:  skipped (${taskCount} already present).`);
}
