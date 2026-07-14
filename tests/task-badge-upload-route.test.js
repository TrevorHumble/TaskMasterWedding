// tests/task-badge-upload-route.test.js
//
// Issue #502: POST /admin/tasks/:id/badge (src/routes/admin.js) wires
// photos.uploadBadgeArt (multer) -> photos.saveBadgeArt -> taskBadges.setTaskBadge,
// but #483's own tests only ever drove setTaskBadge directly — the multipart
// route itself was never exercised end-to-end. This file closes that gap by
// posting real multipart requests at the route (not calling setTaskBadge
// in-process) and asserting the resulting badges row and on-disk file.
//
//   AC1 — a valid image + name sets the task's badge: resolveTaskBadge()
//         returns the new name, an art_path under the /uploads mount (not
//         DEFAULT_RIBBON_ART_PATH), and a file exists on disk at that path.
//   AC2 — a disallowed file type is rejected: the redirect lands on a page
//         whose flash message contains photos.ALLOWED_LABEL (the exported
//         single-source-of-truth copy fragment — see
//         tests/heic-conversion.test.js:390 for the same assertion pattern),
//         and the task's badge is unchanged (still the default ribbon).
//
// REQUIRE ORDER: loadApp() must run before any require of config, db,
// ../src/services/photos, or ../src/services/task-badges (see
// tests/helpers/testApp.js "REQUIRE ORDER MATTERS").
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { loadApp, makeAdminAgent } = require('./helpers/testApp');

let app;
let db;
let adminAgent;
let config;
let photos;
let taskBadges;
let validJpeg;

beforeAll(async () => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
  adminAgent = await makeAdminAgent(app);

  // Required AFTER loadApp() so these bind to the temp DATA_DIR, not the real
  // project database (see tests/helpers/testApp.js "REQUIRE ORDER MATTERS").
  config = require('../config');
  photos = require('../src/services/photos');
  taskBadges = require('../src/services/task-badges');

  // A tiny, real, sharp-decodable JPEG. Unlike avatar-upload-limit.test.js's
  // buildPaddedJpeg, this route has no exact byte-size boundary to hit — just
  // "a valid image" — so no padding is needed.
  validJpeg = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 150, b: 50 } },
  })
    .jpeg()
    .toBuffer();
});

function insertTask(title) {
  return db.prepare('INSERT INTO tasks (title) VALUES (?)').run(title).lastInsertRowid;
}

describe('POST /admin/tasks/:id/badge — issue #502', () => {
  it('AC1: a valid image + name sets the badge and writes a real file under /uploads', async () => {
    const taskId = insertTask('Selfie with the officiant');

    const res = await adminAgent
      .post(`/admin/tasks/${taskId}/badge`)
      .field('name', 'Golden Move')
      .attach('badge_art', validJpeg, { filename: 'ribbon.jpg', contentType: 'image/jpeg' });

    expect([301, 302, 303]).toContain(res.status);

    const badge = taskBadges.resolveTaskBadge(taskId);
    expect(badge.name).toBe('Golden Move');
    expect(badge.art_path).not.toBe(taskBadges.DEFAULT_RIBBON_ART_PATH);
    // Stored under the /uploads mount (photos.urlForOriginal's shape), not a
    // hand-built path — the route builds it the same way.
    expect(badge.art_path.startsWith('/uploads/')).toBe(true);

    // The uploaded bytes actually landed on disk at that path.
    const storedFilename = badge.art_path.slice('/uploads/'.length);
    const absPath = path.join(config.UPLOADS_DIR, storedFilename);
    expect(fs.existsSync(absPath)).toBe(true);
  });

  it('AC2: a disallowed file type is rejected — flash shows photos.ALLOWED_LABEL, badge unchanged', async () => {
    const taskId = insertTask('Group photo by the arch');

    const res = await adminAgent
      .post(`/admin/tasks/${taskId}/badge`)
      .field('name', 'Should Not Apply')
      .attach('badge_art', Buffer.from('not an image, just plain text bytes'), {
        filename: 'notes.txt',
        contentType: 'text/plain',
      });

    expect([301, 302, 303]).toContain(res.status);

    // redirectWithMsg (src/routes/admin.js) puts the flash text in the
    // redirect Location's ?msg= query, rendered only on that exact GET — a
    // plain GET /admin/tasks would not carry it (matches the pattern at
    // tests/submission-intake.test.js:344).
    const page = await adminAgent.get(res.headers.location);
    expect(page.status).toBe(200);
    expect(page.text).toContain(photos.ALLOWED_LABEL);

    const badge = taskBadges.resolveTaskBadge(taskId);
    expect(badge.name).not.toBe('Should Not Apply');
    expect(badge.art_path).toBe(taskBadges.DEFAULT_RIBBON_ART_PATH);
  });
});
