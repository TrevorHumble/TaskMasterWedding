// scripts/seed-demo.js
//
// Installs bundled sample photos/avatars into the real UPLOADS_DIR/THUMBS_DIR
// under the fixture's conforming filenames, then (when run directly) seeds
// the demo DB rows on top of them. Separate from scripts/seed.js (badges +
// real tasks, idempotent) so demo data never pollutes a real event's DB.
//
// Requiring this module has NO side effects — it only exports
// installSamplePhotos(). Side effects (installing files + seeding the DB)
// happen only when the script is run directly: `node scripts/seed-demo.js`.
'use strict';

const fs = require('fs');
const path = require('path');

const config = require('../config');
const { MANIFEST } = require('../tests/helpers/demo-fixture');
const photos = require('../src/services/photos');
const { resolveSamplePool } = require('./sample-photo-pool');

/**
 * Copy one sample photo into UPLOADS_DIR under `destName`, then generate its
 * thumbnail via photos.makeThumb so THUMBS_DIR/<destName>.jpg exists too
 * (makeThumb derives the thumb name from the copied original's filename, so
 * thumb_path = photo_path + '.jpg' always matches what the MANIFEST expects).
 *
 * @param {string} sourceDir - directory `sourceFile` lives under (the
 *   bundled fixtures/sample-photos/, or LOCAL_PHOTOS_DIR — see
 *   scripts/sample-photo-pool.js's resolveSamplePool()).
 * @param {string} sourceFile - filename under `sourceDir`.
 * @param {string} destName - conforming original filename to write under UPLOADS_DIR
 * @param {string} [expectedThumbName] - when given (photo pairs only; avatars
 *   have no thumb_path), the MANIFEST's thumb_path for this pair. Asserted
 *   fail-fast against makeThumb's actual return value so a future change to
 *   makeThumb's naming rule is caught here at install time, not silently.
 * @returns {Promise<void>}
 */
async function installOne(sourceDir, sourceFile, destName, expectedThumbName) {
  const src = path.join(sourceDir, sourceFile);
  if (!fs.existsSync(src)) {
    throw new Error(
      `Demo seed source photo missing: expected sample file at "${src}" ` +
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
      `Demo fixture / photos.js thumb-naming mismatch: photos.makeThumb returned ` +
        `"${actualThumbName}" but the MANIFEST expects thumb_path "${expectedThumbName}" ` +
        `for original "${destName}". photos.js's thumb-naming rule has likely changed ` +
        `without updating tests/helpers/demo-fixture.js.`
    );
  }
}

/**
 * Install every MANIFEST photo pair (round-robin over resolveSamplePool()'s
 * sample pool — the bundled CC0 photos, or LOCAL_PHOTOS_DIR when set) plus
 * the manifest's avatar files (always the bundled pool), into
 * config.UPLOADS_DIR / config.THUMBS_DIR. Idempotent: re-running simply
 * overwrites the same conforming filenames.
 *
 * @returns {Promise<{ installedPhotos: number, installedAvatars: number }>}
 */
async function installSamplePhotos() {
  const pool = resolveSamplePool();

  let installedPhotos = 0;
  for (let i = 0; i < MANIFEST.photos.length; i++) {
    const { photo_path, thumb_path } = MANIFEST.photos[i];
    const sourceFile = pool.sampleFiles[i % pool.sampleFiles.length];
    await installOne(pool.samplesDir, sourceFile, photo_path, thumb_path);
    installedPhotos += 1;
  }

  let installedAvatars = 0;
  for (let i = 0; i < MANIFEST.avatars.length; i++) {
    const avatarName = MANIFEST.avatars[i];
    const sourceFile = pool.avatarFiles[i % pool.avatarFiles.length];
    await installOne(pool.avatarsDir, sourceFile, avatarName);
    installedAvatars += 1;
  }

  return { installedPhotos, installedAvatars };
}

// Only run install + seed when this file is executed directly, never on require.
if (require.main === module) {
  const { db } = require('../src/db');
  const { seedDemo } = require('../tests/helpers/demo-fixture');

  installSamplePhotos()
    .then(() => {
      const { taskIds, guestIds } = seedDemo(db);
      console.log('Demo seed complete.');
      console.log(`  Tasks:  ${taskIds.length}`);
      console.log(`  Guests: ${guestIds.length}`);
      console.log(`  Photos installed into ${config.UPLOADS_DIR}`);
    })
    .catch((err) => {
      console.error('Demo seed failed:', err);
      process.exitCode = 1;
    });
}

module.exports = { installSamplePhotos };
