// tests/sample-photo-pool.test.js
// Issue #457: LOCAL_PHOTOS_DIR override for every seed script's photo pool.
//   AC1 — unset: returns the bundled 7-name pool + the bundled absolute dir.
//   AC2 — set to a directory with images + a non-image: returns exactly the
//         image files, sorted, non-image excluded.
//   AC3 — set to a path that does not exist: throws with "does not exist".
//   AC4 — set to an existing but empty (of images) directory: falls back to
//         the bundled pool.
//
// config.js requires only fs/path/crypto (no src/db), so requiring it here
// directly — unlike tests that use tests/helpers/event-fixture.js — never
// opens the live app.db (see #450's REQUIRE ORDER note in
// tests/event-fixture.test.js for why that distinction matters).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config');
const {
  resolveSamplePool,
  BUNDLED_SAMPLES_DIR,
  BUNDLED_SAMPLE_FILES,
} = require('../scripts/sample-photo-pool');

const ORIGINAL_LOCAL_PHOTOS_DIR = config.LOCAL_PHOTOS_DIR;

afterEach(() => {
  config.LOCAL_PHOTOS_DIR = ORIGINAL_LOCAL_PHOTOS_DIR;
});

describe('#457 AC1: LOCAL_PHOTOS_DIR unset falls back to the bundled pool', () => {
  it('returns the 7 bundled sample filenames and the bundled absolute directory', () => {
    config.LOCAL_PHOTOS_DIR = '';
    const pool = resolveSamplePool();
    expect(pool.sampleFiles).toEqual(BUNDLED_SAMPLE_FILES);
    expect(pool.samplesDir).toBe(BUNDLED_SAMPLES_DIR);
    expect(pool.samplesDir).toBe(path.join(config.ROOT, 'fixtures', 'sample-photos'));
  });
});

describe('#457 AC2: LOCAL_PHOTOS_DIR set to a directory with images + a non-image', () => {
  it('returns only the image files, sorted, non-image excluded', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-local-photos-ac2-'));
    fs.writeFileSync(path.join(tmp, 'b.png'), 'fake-png-bytes');
    fs.writeFileSync(path.join(tmp, 'a.jpg'), 'fake-jpg-bytes');
    fs.writeFileSync(path.join(tmp, 'notes.txt'), 'not an image');

    config.LOCAL_PHOTOS_DIR = tmp;
    const pool = resolveSamplePool();

    expect(pool.sampleFiles).toHaveLength(2);
    expect(pool.sampleFiles).toEqual(['a.jpg', 'b.png']);
    expect(pool.samplesDir).toBe(tmp);
  });
});

describe('#457 AC3: LOCAL_PHOTOS_DIR set to a path that does not exist', () => {
  it('throws an Error whose message contains "does not exist"', () => {
    const missing = path.join(os.tmpdir(), 'gpp-local-photos-does-not-exist-xyz');
    config.LOCAL_PHOTOS_DIR = missing;
    expect(() => resolveSamplePool()).toThrow(/does not exist/);
  });
});

describe('#457 AC4: LOCAL_PHOTOS_DIR set to an existing but empty directory', () => {
  it('falls back to the bundled pool instead of throwing or returning an empty list', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-local-photos-ac4-'));
    config.LOCAL_PHOTOS_DIR = tmp;
    const pool = resolveSamplePool();
    expect(pool.sampleFiles).toEqual(BUNDLED_SAMPLE_FILES);
    expect(pool.samplesDir).toBe(BUNDLED_SAMPLES_DIR);
  });
});
