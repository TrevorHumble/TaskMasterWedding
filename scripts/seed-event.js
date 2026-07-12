// scripts/seed-event.js
//
// Installs bundled sample photos/avatars into the real UPLOADS_DIR/THUMBS_DIR
// under the event fixture's conforming filenames, ensures the badge catalog
// exists, then seeds a realistic ~100-guest event on top of them. Model:
// scripts/seed-demo.js, at wedding scale instead of 10 guests, so the manual
// test-plan and load-test can exercise the app "full" before the wedding.
//
// Usage:
//   node scripts/seed-event.js [--guests N] [--seed S] [--force]
//     --guests N   number of guests to generate (default 100)
//     --seed S     LCG seed for deterministic generation (default 1)
//     --force      skip the AC6 safety guard (see below) and clobber anyway
//
// Requiring this module has NO side effects — it only exports parseArgs()
// and installSamplePhotos(). Side effects (installing files, checking the
// safety guard, and seeding the DB) happen only when the script is run
// directly: `node scripts/seed-event.js`.
'use strict';

const fs = require('fs');
const path = require('path');

const config = require('../config');
const { EVENT_GUEST_TOKEN_PREFIX } = require('../tests/helpers/event-fixture');
const photos = require('../src/services/photos');
const { resolveSamplePool } = require('./sample-photo-pool');

// ---------------------------------------------------------------------------
// Badge catalog. ensureBadgeCatalog is the one shared insert function (#193
// AC4, consolidated #314) — the same function scripts/seed.js and src/db.js's
// boot path call, so all three can never drift into separate catalogs.
// Insert-only (INSERT OR IGNORE keyed on code), so this script never
// duplicates or overwrites a row scripts/seed.js or an earlier boot already
// inserted, and works standalone if neither has run yet. Not a problem to
// require() here even though this module also gets require()'d for its
// side-effect-free exports (parseArgs, installSamplePhotos) — badge-catalog.js
// itself is data-only and takes no action until called with a `db`.
// ---------------------------------------------------------------------------
const { ensureBadgeCatalog } = require('./badge-catalog');

/**
 * Parse a `--flag <value>` numeric argument, rejecting anything that is not a
 * clean integer (e.g. "5x", "-5", "", or a missing value) so a bad flag fails
 * loudly instead of silently coercing. Returns the parsed integer.
 * @param {string} flag - the flag name, for the error message
 * @param {string|undefined} raw - the raw next-token value
 * @returns {number}
 */
function parseIntArg(flag, raw) {
  // Number(...) (unlike parseInt) rejects trailing garbage like "5x" -> NaN,
  // and Number.isInteger rejects fractions and NaN in one check.
  const value = Number(raw);
  if (raw === undefined || raw.trim() === '' || !Number.isInteger(value)) {
    throw new Error(`${flag} requires an integer value, got "${raw === undefined ? '' : raw}"`);
  }
  return value;
}

/**
 * Parse `--guests N`, `--seed S`, and `--force` from an argv-style array.
 * Throws on an invalid `--guests` (< 1 or non-integer) or a non-integer
 * `--seed`, so scripts/seed-event.js's require.main handler can print the
 * message and exit non-zero rather than seeding garbage.
 * @param {string[]} argv - e.g. process.argv.slice(2)
 * @returns {{ guests: number, seed: number, force: boolean }}
 */
function parseArgs(argv) {
  let guests = 100;
  let seed = 1;
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--guests') {
      guests = parseIntArg('--guests', argv[++i]);
      if (guests < 1) {
        throw new Error(`--guests must be >= 1, got ${guests}`);
      }
    } else if (arg === '--seed') {
      seed = parseIntArg('--seed', argv[++i]);
    } else if (arg === '--force') {
      force = true;
    } else {
      throw new Error(
        `Unknown argument "${arg}". Usage: seed-event.js [--guests N] [--seed S] [--force]`
      );
    }
  }

  return { guests, seed, force };
}

/**
 * Copy one sample photo into UPLOADS_DIR under `destName`, then generate its
 * thumbnail via photos.makeThumb so THUMBS_DIR/<destName>.jpg exists too.
 * Mirrors scripts/seed-demo.js's installOne, including its fail-fast
 * thumb-name assertion.
 *
 * @param {string} sourceDir - directory `sourceFile` lives under (the
 *   bundled fixtures/sample-photos/, or LOCAL_PHOTOS_DIR — see
 *   scripts/sample-photo-pool.js's resolveSamplePool()).
 * @param {string} sourceFile - filename under `sourceDir`.
 * @param {string} destName - conforming original filename to write under UPLOADS_DIR
 * @param {string} [expectedThumbName] - when given (photo pairs only; avatars
 *   have no thumb_path), asserted against makeThumb's actual return value.
 * @returns {Promise<void>}
 */
async function installOne(sourceDir, sourceFile, destName, expectedThumbName) {
  const src = path.join(sourceDir, sourceFile);
  if (!fs.existsSync(src)) {
    throw new Error(
      `Event seed source photo missing: expected sample file at "${src}" ` +
        `(source directory renamed, moved, or emptied?)`
    );
  }
  const dest = path.join(config.UPLOADS_DIR, destName);
  fs.mkdirSync(config.UPLOADS_DIR, { recursive: true });
  fs.mkdirSync(config.THUMBS_DIR, { recursive: true });
  fs.copyFileSync(src, dest);
  const actualThumbName = await photos.makeThumb(dest); // writes THUMBS_DIR/<destName>.jpg
  if (expectedThumbName !== undefined && actualThumbName !== expectedThumbName) {
    throw new Error(
      `Event fixture / photos.js thumb-naming mismatch: photos.makeThumb returned ` +
        `"${actualThumbName}" but the manifest expects thumb_path "${expectedThumbName}" ` +
        `for original "${destName}". photos.js's thumb-naming rule has likely changed ` +
        `without updating tests/helpers/event-fixture.js.`
    );
  }
}

/**
 * Install every manifest photo pair (round-robin over resolveSamplePool()'s
 * sample pool — the bundled CC0 photos, or LOCAL_PHOTOS_DIR when set) plus
 * the manifest's avatar files (always the bundled pool), into
 * config.UPLOADS_DIR / config.THUMBS_DIR. Idempotent: re-running with the
 * same {guests, seed} overwrites the same conforming filenames.
 *
 * @param {{ photos: Array<{photo_path: string, thumb_path: string}>, avatars: string[] }} manifest
 * @returns {Promise<{ installedPhotos: number, installedAvatars: number }>}
 */
async function installSamplePhotos(manifest) {
  const pool = resolveSamplePool();

  let installedPhotos = 0;
  for (let i = 0; i < manifest.photos.length; i++) {
    const { photo_path, thumb_path } = manifest.photos[i];
    const sourceFile = pool.sampleFiles[i % pool.sampleFiles.length];
    await installOne(pool.samplesDir, sourceFile, photo_path, thumb_path);
    installedPhotos += 1;
  }

  let installedAvatars = 0;
  for (let i = 0; i < manifest.avatars.length; i++) {
    const avatarName = manifest.avatars[i];
    const sourceFile = pool.avatarFiles[i % pool.avatarFiles.length];
    await installOne(pool.avatarsDir, sourceFile, avatarName);
    installedAvatars += 1;
  }

  return { installedPhotos, installedAvatars };
}

/**
 * AC6 safety guard: refuse to run against a data dir that looks like a real
 * event (any guest whose token does NOT carry EVENT_GUEST_TOKEN_PREFIX)
 * unless --force is passed. Checked BEFORE any DELETE runs, so a refusal
 * deletes no rows.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {boolean} force
 * @returns {{ ok: boolean, message?: string }}
 */
function checkClobberGuard(db, force) {
  if (force) return { ok: true };

  const foreignGuest = db
    .prepare(`SELECT token FROM guests WHERE token NOT LIKE ? LIMIT 1`)
    .get(`${EVENT_GUEST_TOKEN_PREFIX}%`);

  if (foreignGuest) {
    return {
      ok: false,
      message:
        `refusing to clobber: found guest token "${foreignGuest.token}" that does not start ` +
        `with "${EVENT_GUEST_TOKEN_PREFIX}". This data dir looks like it holds real event data, ` +
        `not just this fixture. Re-run with --force if you are certain you want to replace it.`,
    };
  }

  return { ok: true };
}

// Only run install + guard + seed when this file is executed directly, never on require.
if (require.main === module) {
  main();
}

function main() {
  let guests, seed, force;
  try {
    ({ guests, seed, force } = parseArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  const { db } = require('../src/db');
  const { seedEvent } = require('../tests/helpers/event-fixture');

  const guard = checkClobberGuard(db, force);
  if (!guard.ok) {
    console.error(guard.message);
    process.exitCode = 1;
  } else {
    const badgeResult = ensureBadgeCatalog(db);

    // Seed the DB rows FIRST. seedEvent's completion spread depends on the
    // engineered per-guest counts (not a fixed formula), so the exact set of
    // {photo_path, thumb_path} pairs it needs is only known once it has run —
    // seedEvent returns the very manifest it used, and we install exactly
    // that (AC7 requires every referenced file to exist on disk; installing
    // a differently-sized guessed manifest before seeding could under- or
    // over-provision filenames relative to what got inserted).
    const { taskIds, guestIds, manifest } = seedEvent(db, { guests, seed });

    installSamplePhotos(manifest)
      .then(() => {
        console.log('Event seed complete.');
        console.log(`  Guests:  ${guestIds.length}`);
        console.log(`  Tasks:   ${taskIds.length}`);
        console.log(
          `  Badges:  ${badgeResult.inserted} inserted, ${badgeResult.skipped} already existed.`
        );
        console.log(`  Seed:    ${seed}`);
        console.log(`  Photos installed into ${config.UPLOADS_DIR}`);
      })
      .catch((err) => {
        console.error('Event seed failed:', err);
        process.exitCode = 1;
      });
  }
}

module.exports = { parseArgs, installSamplePhotos, ensureBadgeCatalog, checkClobberGuard };
