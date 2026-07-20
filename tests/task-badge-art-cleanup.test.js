// tests/task-badge-art-cleanup.test.js
// Issue #501: a task's uploaded badge-art file must be removed from disk when
// the task is deleted or its art is replaced, so stale files don't accumulate
// in data/uploads/ and stay reachable at their URL after nothing references
// them. The shared default-ribbon SVG must never be deleted.
//
// Issue #410 note: the badge-icon picker replaced file-upload badge art
// entirely — POST /admin/tasks/:id/badge no longer accepts a multipart file,
// so the end-to-end AC1/AC3 coverage below now drives the route with a
// catalog icon id instead of an attached file. The unit-level
// isUploadedArtPath/unlinkUploadedArt/setTaskBadge coverage is untouched
// (those helpers still matter for any /uploads/ art_path, and a bundled
// /badges/icons/ path is a NEW case this file adds coverage for: it must
// never be treated as uploaded-and-deletable).
//
// AC1: task delete unlinks a host-uploaded badge art file.
// AC2: task delete never touches the shared default ribbon SVG (both when a
//      badge row already resolved to it, and when no badge row exists yet).
// AC3: replacing badge art (upload A, then upload B) removes A and keeps B.
// AC-icon: task delete never unlinks a bundled /badges/icons/ SVG (#410).
//
// Covers the underlying task-badges.js helpers (isUploadedArtPath,
// unlinkUploadedArt, and setTaskBadge's replace-time unlink) directly, and
// exercises the real HTTP routes (POST /admin/tasks/:id/badge,
// POST /admin/tasks/:id/delete) for the end-to-end behavior the acceptance
// criteria describe.
//
// REQUIRE ORDER: loadApp() must run before any require that pulls in config
// or db (see tests/helpers/testApp.js).
'use strict';

const fs = require('fs');
const path = require('path');
const { loadApp, makeAdminAgent } = require('./helpers/testApp');

let app;
let db;
let config;
let photos;
let taskBadges;
let badgeIcons;
let adminAgent;

const DEFAULT_RIBBON_ABS_PATH = path.join(
  __dirname,
  '..',
  'src',
  'public',
  'badges',
  'default-ribbon.svg'
);

function makeTask(title) {
  return db.prepare('INSERT INTO tasks (title) VALUES (?)').run(title).lastInsertRowid;
}

beforeAll(async () => {
  const result = loadApp();
  app = result.app;
  db = result.db;
  config = require('../config');
  photos = require('../src/services/photos');
  taskBadges = require('../src/services/task-badges');
  badgeIcons = require('../src/services/badge-icons');
  adminAgent = await makeAdminAgent(app);
});

// ---------------------------------------------------------------------------
// Unit-level coverage of the two new helpers, independent of the HTTP layer.
// ---------------------------------------------------------------------------
describe('isUploadedArtPath', () => {
  it('is true only for a /uploads/ path; false for the shared default, a bundled icon, and absent values', () => {
    expect(taskBadges.isUploadedArtPath('/uploads/abc123.jpg')).toBe(true);
    expect(taskBadges.isUploadedArtPath(taskBadges.DEFAULT_RIBBON_ART_PATH)).toBe(false);
    expect(taskBadges.isUploadedArtPath('/badges/bloom.svg')).toBe(false);
    // #410: a picked catalog icon's bundled path is never "uploaded" — the
    // /badges/icons/ prefix does not start with /uploads/, so this is false
    // without any code change to isUploadedArtPath itself.
    expect(taskBadges.isUploadedArtPath(badgeIcons.resolveIconPath('favorite'))).toBe(false);
    expect(taskBadges.isUploadedArtPath(null)).toBe(false);
    expect(taskBadges.isUploadedArtPath(undefined)).toBe(false);
    expect(taskBadges.isUploadedArtPath('')).toBe(false);
  });
});

describe('unlinkUploadedArt', () => {
  it('deletes a real uploaded file from disk but never touches the shared default ribbon SVG', () => {
    const filename = 'unlink-direct-test.jpg';
    const absPath = path.join(config.UPLOADS_DIR, filename);
    fs.writeFileSync(absPath, 'fake-jpeg-bytes');
    expect(fs.existsSync(absPath)).toBe(true);

    taskBadges.unlinkUploadedArt(photos.urlForOriginal(filename));
    expect(fs.existsSync(absPath)).toBe(false);

    expect(fs.existsSync(DEFAULT_RIBBON_ABS_PATH)).toBe(true);
    taskBadges.unlinkUploadedArt(taskBadges.DEFAULT_RIBBON_ART_PATH);
    expect(fs.existsSync(DEFAULT_RIBBON_ABS_PATH)).toBe(true); // untouched
  });

  it('never unlinks a bundled /badges/icons/ SVG (#410)', () => {
    const iconPath = badgeIcons.resolveIconPath('favorite');
    const absIconPath = path.join(config.PUBLIC_DIR, iconPath.replace(/^\//, ''));
    expect(fs.existsSync(absIconPath)).toBe(true);

    taskBadges.unlinkUploadedArt(iconPath);
    expect(fs.existsSync(absIconPath)).toBe(true); // untouched
  });
});

// ---------------------------------------------------------------------------
// AC3 (service level): setTaskBadge unlinks the prior uploaded file on
// replacement, but not when the incoming artPath is identical to the current
// one (no accidental self-delete of the file the write is about to restore).
// ---------------------------------------------------------------------------
describe('setTaskBadge replaces art', () => {
  it('unlinks the prior uploaded file when a genuinely different artPath is set', () => {
    const taskId = makeTask('setTaskBadge replace task');
    const filenameA = 'set-task-badge-a.jpg';
    const absA = path.join(config.UPLOADS_DIR, filenameA);
    fs.writeFileSync(absA, 'fake-jpeg-a');

    taskBadges.setTaskBadge(taskId, { artPath: photos.urlForOriginal(filenameA) });
    expect(fs.existsSync(absA)).toBe(true); // first customization: nothing to unlink yet

    const filenameB = 'set-task-badge-b.jpg';
    const absB = path.join(config.UPLOADS_DIR, filenameB);
    fs.writeFileSync(absB, 'fake-jpeg-b');

    taskBadges.setTaskBadge(taskId, { artPath: photos.urlForOriginal(filenameB) });
    expect(fs.existsSync(absA)).toBe(false); // A unlinked
    expect(fs.existsSync(absB)).toBe(true); // B kept

    const badge = db.prepare('SELECT art_path FROM badges WHERE task_id = ?').get(taskId);
    expect(badge.art_path).toBe(photos.urlForOriginal(filenameB));
  });

  it('does not unlink when the posted artPath is identical to the current one', () => {
    const taskId = makeTask('setTaskBadge same-path task');
    const filename = 'set-task-badge-same.jpg';
    const absPath = path.join(config.UPLOADS_DIR, filename);
    fs.writeFileSync(absPath, 'fake-jpeg-bytes');
    const artPath = photos.urlForOriginal(filename);

    taskBadges.setTaskBadge(taskId, { artPath });
    expect(fs.existsSync(absPath)).toBe(true);

    taskBadges.setTaskBadge(taskId, { artPath }); // re-post the exact same path
    expect(fs.existsSync(absPath)).toBe(true); // still there, not self-deleted
  });

  it('a name-only update leaves art_path (and therefore the file) untouched', () => {
    const taskId = makeTask('setTaskBadge name-only task');
    const filename = 'set-task-badge-name-only.jpg';
    const absPath = path.join(config.UPLOADS_DIR, filename);
    fs.writeFileSync(absPath, 'fake-jpeg-bytes');
    const artPath = photos.urlForOriginal(filename);

    taskBadges.setTaskBadge(taskId, { artPath });
    taskBadges.setTaskBadge(taskId, { name: 'Renamed, no new art' });

    expect(fs.existsSync(absPath)).toBe(true);
    const badge = db.prepare('SELECT name, art_path FROM badges WHERE task_id = ?').get(taskId);
    expect(badge.name).toBe('Renamed, no new art');
    expect(badge.art_path).toBe(artPath);
  });
});

// ---------------------------------------------------------------------------
// AC1: task delete unlinks a host-uploaded badge art file (end-to-end via the
// real admin routes). The route no longer accepts a file, so this drives the
// underlying service layer to place an uploaded art_path, then deletes the
// task via the real HTTP route to prove the cleanup path still fires.
// ---------------------------------------------------------------------------
describe('AC1: task delete unlinks uploaded badge art', () => {
  it('removes the uploaded art file from disk when the task is deleted', async () => {
    const taskId = makeTask('AC1 delete task');
    const filename = 'ac1.jpg';
    const absPath = path.join(config.UPLOADS_DIR, filename);
    fs.writeFileSync(absPath, 'fake-jpeg-bytes');
    taskBadges.setTaskBadge(taskId, { artPath: photos.urlForOriginal(filename) });
    expect(fs.existsSync(absPath)).toBe(true);

    const deleteRes = await adminAgent.post(`/admin/tasks/${taskId}/delete`);
    expect(deleteRes.status).toBe(303);

    expect(fs.existsSync(absPath)).toBe(false);
    expect(db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId)).toBeUndefined();
    expect(db.prepare('SELECT id FROM badges WHERE task_id = ?').get(taskId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC2: the shared default ribbon SVG is never touched by a task delete —
// whether or not the task's badge row was ever lazily created.
// ---------------------------------------------------------------------------
describe('AC2: default badge art survives task delete', () => {
  it('a task whose badge row already resolved to the default survives deletion with the SVG intact', async () => {
    const taskId = makeTask('AC2 default-resolved task');

    // Render the task board once so resolveTaskBadge lazily inserts the
    // default-pointing row — mirrors the real admin flow (the task board GET
    // is what creates it, before a delete could ever be clicked).
    const listRes = await adminAgent.get('/admin/tasks');
    expect(listRes.status).toBe(200);
    const badge = db.prepare('SELECT art_path FROM badges WHERE task_id = ?').get(taskId);
    expect(badge.art_path).toBe(taskBadges.DEFAULT_RIBBON_ART_PATH);

    expect(fs.existsSync(DEFAULT_RIBBON_ABS_PATH)).toBe(true);

    const deleteRes = await adminAgent.post(`/admin/tasks/${taskId}/delete`);
    expect(deleteRes.status).toBe(303);

    expect(fs.existsSync(DEFAULT_RIBBON_ABS_PATH)).toBe(true);
  });

  it('a task with no badge row at all (never rendered) deletes cleanly with the SVG intact', async () => {
    const taskId = makeTask('AC2 no-badge-row task');
    expect(db.prepare('SELECT id FROM badges WHERE task_id = ?').get(taskId)).toBeUndefined();

    const deleteRes = await adminAgent.post(`/admin/tasks/${taskId}/delete`);
    expect(deleteRes.status).toBe(303);

    expect(fs.existsSync(DEFAULT_RIBBON_ABS_PATH)).toBe(true);
    expect(db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId)).toBeUndefined();
  });

  it('deleting a nonexistent task id is a harmless no-op (no FK violation from a lazy insert)', async () => {
    const deleteRes = await adminAgent.post('/admin/tasks/999999999/delete');
    expect(deleteRes.status).toBe(303);
    expect(fs.existsSync(DEFAULT_RIBBON_ABS_PATH)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC3: replacing badge art removes the prior file and keeps the new one
// (service-level — the route itself only ever writes a bundled icon path
// now, never an uploaded one; see setTaskBadge coverage above for the
// route-adjacent replace case with an icon path, which is never unlinked).
// ---------------------------------------------------------------------------
describe('AC3: replacing badge art removes the prior file', () => {
  it('setting art B after art A deletes A and keeps B', () => {
    const taskId = makeTask('AC3 replace task');
    const filenameA = 'ac3-a.jpg';
    const absA = path.join(config.UPLOADS_DIR, filenameA);
    fs.writeFileSync(absA, 'fake-jpeg-a');
    taskBadges.setTaskBadge(taskId, { artPath: photos.urlForOriginal(filenameA) });
    expect(fs.existsSync(absA)).toBe(true);

    const filenameB = 'ac3-b.jpg';
    const absB = path.join(config.UPLOADS_DIR, filenameB);
    fs.writeFileSync(absB, 'fake-jpeg-b');
    taskBadges.setTaskBadge(taskId, { artPath: photos.urlForOriginal(filenameB) });

    const badgeB = db.prepare('SELECT art_path FROM badges WHERE task_id = ?').get(taskId);
    expect(badgeB.art_path).toBe(photos.urlForOriginal(filenameB));
    expect(fs.existsSync(absA)).toBe(false); // A unlinked by the replacement
    expect(fs.existsSync(absB)).toBe(true); // B present
  });
});

// ---------------------------------------------------------------------------
// AC-icon (#410): a task whose badge is a picked catalog icon survives
// deletion with the bundled SVG intact — the route-level end-to-end version
// of the isUploadedArtPath/unlinkUploadedArt unit coverage above.
// ---------------------------------------------------------------------------
describe('AC-icon: task delete never unlinks a bundled icon SVG', () => {
  it('deleting a task whose badge is a catalog icon leaves the bundled SVG on disk', async () => {
    const taskId = makeTask('AC-icon delete task');
    const [icon] = badgeIcons.listIcons();

    const setRes = await adminAgent
      .post(`/admin/tasks/${taskId}/badge`)
      .type('form')
      .send({ name: 'Icon Badge', icon: icon.id });
    expect([301, 302, 303]).toContain(setRes.status);

    const iconPath = badgeIcons.resolveIconPath(icon.id);
    const absIconPath = path.join(config.PUBLIC_DIR, iconPath.replace(/^\//, ''));
    expect(fs.existsSync(absIconPath)).toBe(true);

    const deleteRes = await adminAgent.post(`/admin/tasks/${taskId}/delete`);
    expect(deleteRes.status).toBe(303);

    expect(fs.existsSync(absIconPath)).toBe(true); // untouched
    expect(db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId)).toBeUndefined();
  });
});
