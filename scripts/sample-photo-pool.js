// scripts/sample-photo-pool.js
//
// Single owner of "where do sample photos come from" for every seed script
// (scripts/seed-demo.js, scripts/seed-event.js, and therefore
// scripts/seed-story.js, which reuses seed-event.js's installSamplePhotos).
//
// Issue #457: an operator who wants realistic photos in a local demo has no
// sanctioned way to get them without risking a real photo landing in this
// PUBLIC repo's git history if dropped into the committed
// fixtures/sample-photos/ directory. Setting LOCAL_PHOTOS_DIR to a directory
// anywhere on disk (never inside this repo's tracked tree -- nothing here
// adds a path under the repo) makes every seed script use that directory's
// image files instead of the bundled CC0 placeholders.
//
// Avatars are NOT covered by LOCAL_PHOTOS_DIR -- they always come from the
// bundled CC0 pool, since this override is scoped to gallery/submission
// photos only (issue #457 AC5).
'use strict';

const fs = require('fs');
const path = require('path');

const config = require('../config');

const BUNDLED_SAMPLES_DIR = path.join(config.ROOT, 'fixtures', 'sample-photos');
const BUNDLED_SAMPLE_FILES = [
  'sample-01.jpg',
  'sample-02.jpg',
  'sample-03.jpg',
  'sample-04.jpg',
  'sample-05.jpg',
  'sample-06.jpg',
  'sample-07.jpg',
];
const BUNDLED_AVATAR_FILES = ['avatar-01.jpg', 'avatar-02.jpg'];

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/**
 * List the image files (by extension) directly inside `dir`, sorted for
 * deterministic round-robin order.
 * @param {string} dir
 * @returns {string[]}
 */
function listImageFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort();
}

/**
 * Resolve the directory + filenames every seed script round-robins gallery/
 * submission photos from. Reads config.LOCAL_PHOTOS_DIR fresh on every call
 * (not cached), so a caller may set it directly for the current process:
 *   - unset/empty -> the bundled CC0 pool (fixtures/sample-photos/, the 7
 *     sample-0N.jpg files).
 *   - set to a path that does not exist or is not a directory -> throws.
 *   - set to an existing directory with >= 1 image file -> that directory +
 *     its image files (sorted), instead of the bundled pool.
 *   - set to an existing directory with zero image files -> falls back to
 *     the bundled pool rather than seeding zero submissions.
 * Avatars are always the bundled pool (see module header) regardless.
 *
 * @returns {{ samplesDir: string, sampleFiles: string[], avatarsDir: string, avatarFiles: string[] }}
 */
function resolveSamplePool() {
  const localDir = config.LOCAL_PHOTOS_DIR;

  if (localDir) {
    if (!fs.existsSync(localDir) || !fs.statSync(localDir).isDirectory()) {
      throw new Error(
        `LOCAL_PHOTOS_DIR is set to "${localDir}" but that path does not exist or is not a directory.`
      );
    }
    const files = listImageFiles(localDir);
    if (files.length > 0) {
      return {
        samplesDir: localDir,
        sampleFiles: files,
        avatarsDir: BUNDLED_SAMPLES_DIR,
        avatarFiles: BUNDLED_AVATAR_FILES,
      };
    }
  }

  return {
    samplesDir: BUNDLED_SAMPLES_DIR,
    sampleFiles: BUNDLED_SAMPLE_FILES,
    avatarsDir: BUNDLED_SAMPLES_DIR,
    avatarFiles: BUNDLED_AVATAR_FILES,
  };
}

module.exports = {
  resolveSamplePool,
  BUNDLED_SAMPLES_DIR,
  BUNDLED_SAMPLE_FILES,
  BUNDLED_AVATAR_FILES,
};
