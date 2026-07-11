// scripts/seed-story.js
//
// Seeds one of two named, disk-swappable "story" datasets (issue #450),
// built on tests/helpers/event-fixture.js's seedEvent() and
// scripts/seed-event.js's own installSamplePhotos (the single owner of the
// bundled-sample-photo install rule — reused here, not re-implemented).
// Point DATA_DIR at a scenario-specific folder before running this so each
// story keeps its own uploads/thumbs/app.db, e.g. (PowerShell):
//   $env:DATA_DIR="C:\wedding-scavenger-hunt\data-stories\normal"
//   node scripts/seed-story.js --story normal
//
//   $env:DATA_DIR="C:\wedding-scavenger-hunt\data-stories\extreme"
//   node scripts/seed-story.js --story extreme
//
// 'normal'  — a representative mid-size wedding: moderate likes/comments on
//             every photo, the fixture's existing mid-pack tie, no bonus-point
//             or engagement extremes.
// 'extreme' — a stress case: a top-of-leaderboard tie (topTie: true), one
//             submission liked by nearly every guest, one submission with a
//             50-comment thread (social: 'extreme').
//
// Requiring this module has NO side effects — it only exports parseArgs()
// and STORIES. Side effects (installing files, checking the safety guard,
// and seeding the DB) happen only when the script is run directly:
// `node scripts/seed-story.js`.
'use strict';

const config = require('../config');
const { seedEvent, EVENT_TASK_PREFIX } = require('../tests/helpers/event-fixture');
const { ensureBadgeCatalog } = require('./badge-catalog');
const { checkClobberGuard, installSamplePhotos } = require('./seed-event');

// Named story profiles. Distinct {guests, seed} per story so their manifest
// filenames never collide (buildManifest folds `seed` into every filename)
// if both were ever seeded against the same DATA_DIR by mistake.
const STORIES = {
  normal: { guests: 40, seed: 1, social: 'normal', topTie: false },
  extreme: { guests: 60, seed: 2, social: 'extreme', topTie: true },
};

/**
 * Parse `--story <name>` (required, must be a STORIES key) and `--force`
 * from an argv-style array.
 * @param {string[]} argv - e.g. process.argv.slice(2)
 * @returns {{ story: string, force: boolean }}
 */
function parseArgs(argv) {
  let story;
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--story') {
      story = argv[++i];
    } else if (arg === '--force') {
      force = true;
    } else {
      throw new Error(`Unknown argument "${arg}". Usage: seed-story.js --story <name> [--force]`);
    }
  }

  if (!story || !Object.prototype.hasOwnProperty.call(STORIES, story)) {
    throw new Error(
      `--story is required and must be one of: ${Object.keys(STORIES).join(', ')} ` +
        `(got ${JSON.stringify(story)})`
    );
  }

  return { story, force };
}

// Only run the guard + install + seed when this file is executed directly.
if (require.main === module) {
  main();
}

function main() {
  let story, force;
  try {
    ({ story, force } = parseArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  const { db } = require('../src/db');

  // Reuses scripts/seed-event.js's AC6-style guard: refuses to clobber a
  // DATA_DIR that looks like real event data (any guest token that doesn't
  // carry EVENT_GUEST_TOKEN_PREFIX) unless --force is passed. seedEvent
  // writes that same prefix regardless of which story profile is used.
  const guard = checkClobberGuard(db, force);
  if (!guard.ok) {
    console.error(guard.message);
    process.exitCode = 1;
    return;
  }

  ensureBadgeCatalog(db);
  const { guestIds, manifest } = seedEvent(db, STORIES[story]);

  installSamplePhotos(manifest)
    .then(() => {
      const likeCount = db.prepare('SELECT COUNT(*) AS n FROM likes').get().n;
      const commentCount = db.prepare('SELECT COUNT(*) AS n FROM comments').get().n;
      const maxLikes = db
        .prepare(
          'SELECT COALESCE(MAX(n), 0) AS n FROM (SELECT COUNT(*) AS n FROM likes GROUP BY submission_id)'
        )
        .get().n;
      const maxComments = db
        .prepare(
          'SELECT COALESCE(MAX(n), 0) AS n FROM (SELECT COUNT(*) AS n FROM comments GROUP BY submission_id)'
        )
        .get().n;
      const taskCount = db
        .prepare('SELECT COUNT(*) AS n FROM tasks WHERE title LIKE ?')
        .get(`${EVENT_TASK_PREFIX}%`).n;

      console.log(`Story: ${story}`);
      console.log(`  Guests:   ${guestIds.length}`);
      console.log(`  Tasks:    ${taskCount}`);
      console.log(`  Likes:    ${likeCount} (max on one photo: ${maxLikes})`);
      console.log(`  Comments: ${commentCount} (max on one photo: ${maxComments})`);
      console.log(`  Photos installed into ${config.UPLOADS_DIR}`);
    })
    .catch((err) => {
      console.error('Story seed failed:', err);
      process.exitCode = 1;
    });
}

module.exports = { parseArgs, STORIES };
