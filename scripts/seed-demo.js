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

// The bundled sample images this script round-robins across the 18 manifest
// pairs. Kept as filenames (not full paths) so the source directory is the
// single place that changes if more samples are added later.
const SAMPLE_FILES = [
  'sample-01.jpg',
  'sample-02.jpg',
  'sample-03.jpg',
  'sample-04.jpg',
  'sample-05.jpg',
  'sample-06.jpg',
  'sample-07.jpg',
];

const AVATAR_FILES = ['avatar-01.jpg', 'avatar-02.jpg'];

const SAMPLES_DIR = path.join(config.ROOT, 'fixtures', 'sample-photos');

/**
 * Copy one bundled sample into UPLOADS_DIR under `destName`, then generate
 * its thumbnail via photos.makeThumb so THUMBS_DIR/<destName>.jpg exists too
 * (makeThumb derives the thumb name from the copied original's filename, so
 * thumb_path = photo_path + '.jpg' always matches what the MANIFEST expects).
 *
 * @param {string} sourceFile - filename under fixtures/sample-photos/
 * @param {string} destName - conforming original filename to write under UPLOADS_DIR
 * @param {string} [expectedThumbName] - when given (photo pairs only; avatars
 *   have no thumb_path), the MANIFEST's thumb_path for this pair. Asserted
 *   fail-fast against makeThumb's actual return value so a future change to
 *   makeThumb's naming rule is caught here at install time, not silently.
 * @returns {Promise<void>}
 */
async function installOne(sourceFile, destName, expectedThumbName) {
  const src = path.join(SAMPLES_DIR, sourceFile);
  if (!fs.existsSync(src)) {
    throw new Error(
      `Demo seed source photo missing: expected sample file at "${src}" ` +
        `(fixtures/sample-photos/ renamed or absent?)`
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
 * Install every MANIFEST photo pair (round-robin over the bundled samples)
 * plus the manifest's avatar files, into config.UPLOADS_DIR / config.THUMBS_DIR.
 * Idempotent: re-running simply overwrites the same conforming filenames.
 *
 * @returns {Promise<{ installedPhotos: number, installedAvatars: number }>}
 */
async function installSamplePhotos() {
  let installedPhotos = 0;
  for (let i = 0; i < MANIFEST.photos.length; i++) {
    const { photo_path, thumb_path } = MANIFEST.photos[i];
    const sourceFile = SAMPLE_FILES[i % SAMPLE_FILES.length];
    await installOne(sourceFile, photo_path, thumb_path);
    installedPhotos += 1;
  }

  let installedAvatars = 0;
  for (let i = 0; i < MANIFEST.avatars.length; i++) {
    const avatarName = MANIFEST.avatars[i];
    const sourceFile = AVATAR_FILES[i % AVATAR_FILES.length];
    await installOne(sourceFile, avatarName);
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
