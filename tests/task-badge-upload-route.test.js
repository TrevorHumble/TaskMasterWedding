// tests/task-badge-upload-route.test.js
//
// Issue #410: the badge-icon picker replaced the file-upload badge-art path
// entirely. POST /admin/tasks/:id/badge no longer accepts a multipart file —
// it accepts a catalog icon id (src/services/badge-icons.js) and stores the
// bundled SVG's path. This file replaces #502's multipart-upload coverage
// with coverage of the new pick-an-icon flow (AC2) and confirms the old
// multipart path is rejected (AC4).
//
// REQUIRE ORDER: loadApp() must run before any require of config, db,
// ../src/services/photos, or ../src/services/task-badges (see
// tests/helpers/testApp.js "REQUIRE ORDER MATTERS").
'use strict';

const { loadApp, makeAdminAgent } = require('./helpers/testApp');

let app;
let db;
let adminAgent;
let taskBadges;
let badgeIcons;

beforeAll(async () => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
  adminAgent = await makeAdminAgent(app);

  // Required AFTER loadApp() so these bind to the temp DATA_DIR, not the real
  // project database (see tests/helpers/testApp.js "REQUIRE ORDER MATTERS").
  taskBadges = require('../src/services/task-badges');
  badgeIcons = require('../src/services/badge-icons');
});

function insertTask(title) {
  return db.prepare('INSERT INTO tasks (title) VALUES (?)').run(title).lastInsertRowid;
}

describe('POST /admin/tasks/:id/badge — issue #410 (icon picker)', () => {
  it('AC2: picking a valid catalog icon + name sets the badge to the bundled path', async () => {
    const taskId = insertTask('Selfie with the officiant');
    const [icon] = badgeIcons.listIcons();

    const res = await adminAgent
      .post(`/admin/tasks/${taskId}/badge`)
      .type('form')
      .send({ name: 'Golden Move', icon: icon.id });

    expect([301, 302, 303]).toContain(res.status);

    const badge = taskBadges.resolveTaskBadge(taskId);
    expect(badge.name).toBe('Golden Move');
    expect(badge.art_path).toBe(badgeIcons.resolveIconPath(icon.id));
    expect(badge.art_path).not.toBe(taskBadges.DEFAULT_RIBBON_ART_PATH);
  });

  it('AC5/validation: an unknown icon id is rejected — flash shown, badge unchanged', async () => {
    const taskId = insertTask('Group photo by the arch');

    const res = await adminAgent
      .post(`/admin/tasks/${taskId}/badge`)
      .type('form')
      .send({ name: 'Should Not Apply', icon: 'not-a-real-catalog-id' });

    expect([301, 302, 303]).toContain(res.status);

    const page = await adminAgent.get(res.headers.location);
    expect(page.status).toBe(200);
    expect(page.text).toContain('not recognized');

    const badge = taskBadges.resolveTaskBadge(taskId);
    expect(badge.name).not.toBe('Should Not Apply');
    expect(badge.art_path).toBe(taskBadges.DEFAULT_RIBBON_ART_PATH);
  });

  it('AC4: a multipart POST (the old upload path) is rejected, badge unchanged', async () => {
    const taskId = insertTask('Cake cutting');

    const res = await adminAgent
      .post(`/admin/tasks/${taskId}/badge`)
      .field('name', 'Should Not Apply')
      .attach('badge_art', Buffer.from('not an image, just plain text bytes'), {
        filename: 'notes.txt',
        contentType: 'text/plain',
      });

    expect([301, 302, 303]).toContain(res.status);

    const badge = taskBadges.resolveTaskBadge(taskId);
    expect(badge.name).not.toBe('Should Not Apply');
    expect(badge.art_path).toBe(taskBadges.DEFAULT_RIBBON_ART_PATH);
  });
});
