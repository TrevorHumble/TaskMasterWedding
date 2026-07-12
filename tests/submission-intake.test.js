// tests/submission-intake.test.js
// Issue #106 (0059): submissions.submitPhoto is the one function that runs
// the whole submit-or-replace sequence, callable directly with a plain file
// descriptor — no multipart HTTP request required. This file has two suites:
//   1. Direct calls to submissions.submitPhoto (no Express/multer) asserting
//      AC1-AC7 with concrete values.
//   2. A route-level test driving the real POST /tasks/:id/submit endpoint,
//      asserting the AC9 status -> response mapping.
//
// REQUIRE ORDER: config / db / services are required only AFTER loadApp() sets
// DATA_DIR / DB_PATH env vars, matching tests/photo-access.test.js and
// tests/upload-filename-safety.test.js.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const sharp = require('sharp');
const { loadApp, signInGuest } = require('./helpers/testApp');

let db;
let config;
let photos;
let submissions;
let uploadsDir;
let validJpeg;

// Write a real JPEG into UPLOADS_DIR (mirroring what multer's disk storage
// would have already done before submitPhoto is ever called) and return the
// { filename, path } descriptor submitPhoto expects.
function writeOriginal(filename) {
  const absPath = path.join(uploadsDir, filename);
  fs.writeFileSync(absPath, validJpeg);
  return { filename, path: absPath };
}

beforeAll(async () => {
  // A tiny real JPEG so photos.makeThumb (sharp) succeeds on the happy paths.
  validJpeg = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .jpeg()
    .toBuffer();

  const loaded = loadApp();
  db = loaded.db;

  config = require('../config');
  photos = require('../src/services/photos');
  submissions = require('../src/services/submissions');
  uploadsDir = config.UPLOADS_DIR;
});

function insertGuest(token) {
  return db.prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`).run(token, 'Intake Guest')
    .lastInsertRowid;
}

function insertTask(title, isActive = 1) {
  return db.prepare(`INSERT INTO tasks (title, is_active) VALUES (?, ?)`).run(title, isActive)
    .lastInsertRowid;
}

function getSubmission(guestId, taskId) {
  return db
    .prepare('SELECT * FROM submissions WHERE guest_id = ? AND task_id = ?')
    .get(guestId, taskId);
}

// ===========================================================================
// Suite 1: direct calls to submissions.submitPhoto — AC1-AC7
// ===========================================================================
describe('submissions.submitPhoto — direct calls (issue #106)', () => {
  it('AC1: create — new row with taken_down=0 and completed count +1', async () => {
    const guestId = insertGuest(`intake-ac1-${crypto.randomUUID()}`);
    const taskId = insertTask('AC1 Task');
    const before = require('../src/services/scoring').getCompletedCount(guestId);

    const file = writeOriginal('ac1-original.jpg');
    const result = await submissions.submitPhoto({
      guestId,
      taskId,
      file,
      caption: 'a caption',
    });

    expect(result.status).toBe('created');
    expect(typeof result.submissionId).toBe('number');

    const row = getSubmission(guestId, taskId);
    expect(row).toBeDefined();
    expect(row.taken_down).toBe(0);
    expect(row.caption).toBe('a caption');

    const after = require('../src/services/scoring').getCompletedCount(guestId);
    expect(after).toBe(before + 1);
  });

  it('AC2: replace — status "replaced", taken_down stays 0, created_at bumped, count unchanged, old files deleted', async () => {
    const guestId = insertGuest(`intake-ac2-${crypto.randomUUID()}`);
    const taskId = insertTask('AC2 Task');
    const scoring = require('../src/services/scoring');

    // First submission.
    const firstFile = writeOriginal('ac2-first.jpg');
    const first = await submissions.submitPhoto({ guestId, taskId, file: firstFile, caption: '' });
    expect(first.status).toBe('created');

    const firstRow = getSubmission(guestId, taskId);
    const oldPhotoPath = firstRow.photo_path;
    const oldThumbPath = firstRow.thumb_path;
    expect(fs.existsSync(photos.absOriginalPath(oldPhotoPath))).toBe(true);
    expect(fs.existsSync(photos.absThumbPath(oldThumbPath))).toBe(true);

    // Force a distinguishable created_at so the "bumped to now" assertion is
    // meaningful rather than trivially true.
    db.prepare(`UPDATE submissions SET created_at = '2000-01-01 00:00:00' WHERE id = ?`).run(
      firstRow.id
    );

    const countBeforeReplace = scoring.getCompletedCount(guestId);

    // Second submission for the SAME (guest, task) — a different stored
    // filename, exactly the "resubmit" case AC2 describes.
    const secondFile = writeOriginal('ac2-second.jpg');
    const second = await submissions.submitPhoto({
      guestId,
      taskId,
      file: secondFile,
      caption: '',
    });

    expect(second.status).toBe('replaced');
    expect(second.submissionId).toBe(firstRow.id); // same row, not a new one

    const replacedRow = getSubmission(guestId, taskId);
    expect(replacedRow.taken_down).toBe(0);
    expect(replacedRow.photo_path).toBe(secondFile.filename);
    expect(replacedRow.created_at).not.toBe('2000-01-01 00:00:00'); // bumped to now

    // Completed count is unchanged (still one row for this task).
    expect(scoring.getCompletedCount(guestId)).toBe(countBeforeReplace);

    // Old original + old thumbnail were deleted; new ones exist.
    expect(fs.existsSync(photos.absOriginalPath(oldPhotoPath))).toBe(false);
    expect(fs.existsSync(photos.absThumbPath(oldThumbPath))).toBe(false);
    expect(fs.existsSync(photos.absOriginalPath(replacedRow.photo_path))).toBe(true);
    expect(fs.existsSync(photos.absThumbPath(replacedRow.thumb_path))).toBe(true);
  });

  it('AC3: inactive task — status "task_inactive", no row written, original file deleted', async () => {
    const guestId = insertGuest(`intake-ac3-${crypto.randomUUID()}`);
    const taskId = insertTask('AC3 Inactive Task', 0); // is_active = 0

    const file = writeOriginal('ac3-orphan.jpg');
    expect(fs.existsSync(file.path)).toBe(true);

    const result = await submissions.submitPhoto({ guestId, taskId, file, caption: '' });

    expect(result.status).toBe('task_inactive');
    expect(result.submissionId).toBeUndefined();
    expect(getSubmission(guestId, taskId)).toBeUndefined();
    // The orphan multer already wrote to disk is cleaned up — no leak.
    expect(fs.existsSync(file.path)).toBe(false);
  });

  it('AC3b: missing task id behaves the same as inactive (no such task, no throw)', async () => {
    const guestId = insertGuest(`intake-ac3b-${crypto.randomUUID()}`);
    const file = writeOriginal('ac3b-orphan.jpg');

    const result = await submissions.submitPhoto({
      guestId,
      taskId: 999999,
      file,
      caption: '',
    });

    expect(result.status).toBe('task_inactive');
    expect(fs.existsSync(file.path)).toBe(false);
  });

  it('AC4: makeThumb throws — status "thumb_failed", original deleted, no row written', async () => {
    const guestId = insertGuest(`intake-ac4-${crypto.randomUUID()}`);
    const taskId = insertTask('AC4 Task');

    // file.path points at a file that does not exist, so sharp (inside
    // photos.makeThumb) throws "Input file is missing".
    const filename = 'ac4-nonexistent.jpg';
    const file = { filename, path: path.join(uploadsDir, filename) };
    expect(fs.existsSync(file.path)).toBe(false);

    const result = await submissions.submitPhoto({ guestId, taskId, file, caption: '' });

    expect(result.status).toBe('thumb_failed');
    expect(result.submissionId).toBeUndefined();
    expect(getSubmission(guestId, taskId)).toBeUndefined();
    // deleteOriginalFile ignores "already missing" (ENOENT), so this call
    // must not have thrown even though there was nothing to delete.
    expect(fs.existsSync(file.path)).toBe(false);
  });

  it('AC5: caption longer than 500 chars is trimmed and truncated to 500', async () => {
    const guestId = insertGuest(`intake-ac5-${crypto.randomUUID()}`);
    const taskId = insertTask('AC5 Task');

    const longCaption = '  ' + 'x'.repeat(600) + '  '; // 604 chars incl. padding
    const file = writeOriginal('ac5-original.jpg');
    const result = await submissions.submitPhoto({
      guestId,
      taskId,
      file,
      caption: longCaption,
    });

    expect(result.status).toBe('created');
    const row = getSubmission(guestId, taskId);
    expect(row.caption).toHaveLength(500);
    expect(row.caption).toBe('x'.repeat(500));
  });

  it('AC6: absent/non-string caption stores empty string without throwing', async () => {
    const guestId = insertGuest(`intake-ac6-${crypto.randomUUID()}`);

    const taskA = insertTask('AC6 Task A');
    const fileA = writeOriginal('ac6-undefined.jpg');
    const resultA = await submissions.submitPhoto({
      guestId,
      taskId: taskA,
      file: fileA,
      caption: undefined,
    });
    expect(resultA.status).toBe('created');
    expect(getSubmission(guestId, taskA).caption).toBe('');

    const taskB = insertTask('AC6 Task B');
    const fileB = writeOriginal('ac6-nonstring.jpg');
    const resultB = await submissions.submitPhoto({
      guestId,
      taskId: taskB,
      file: fileB,
      caption: 42, // not a string
    });
    expect(resultB.status).toBe('created');
    expect(getSubmission(guestId, taskB).caption).toBe('');
  });

  it('AC7: recomputeAfterSubmissionChange throwing does not lose the submission or the status', async () => {
    const guestId = insertGuest(`intake-ac7-${crypto.randomUUID()}`);
    const taskId = insertTask('AC7 Task');

    const scoring = require('../src/services/scoring');
    const original = scoring.recomputeAfterSubmissionChange;
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Monkeypatch the shared scoring module so submissions.js (which required
    // the same cached module instance) picks up the throwing version. Issue
    // #80 routes submitPhoto's post-submit recompute through the single
    // recomputeAfterSubmissionChange seam, so patching that seam is what
    // exercises submitPhoto's swallow-and-log path.
    scoring.recomputeAfterSubmissionChange = () => {
      throw new Error('boom: recompute failed');
    };

    try {
      const file = writeOriginal('ac7-original.jpg');
      const result = await submissions.submitPhoto({ guestId, taskId, file, caption: '' });

      // Status is still 'created' — the recompute failure is not propagated.
      expect(result.status).toBe('created');
      // The row was NOT rolled back.
      const row = getSubmission(guestId, taskId);
      expect(row).toBeDefined();
      expect(row.taken_down).toBe(0);
      // The failure was logged.
      expect(consoleErrorSpy).toHaveBeenCalled();
    } finally {
      scoring.recomputeAfterSubmissionChange = original;
      consoleErrorSpy.mockRestore();
    }
  });
});

// ===========================================================================
// Suite 2: route-level status -> response mapping — AC9
// ===========================================================================
describe('POST /tasks/:id/submit — status to response mapping (issue #106)', () => {
  let app;
  let routeGuestId;
  let activeTaskId;
  let inactiveTaskId;

  const routeGuestToken = `intake-route-token-${crypto.randomUUID()}`;

  beforeAll(() => {
    app = require('../src/app');
    routeGuestId = db
      .prepare(`INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)`)
      .run(routeGuestToken, 'Route Guest').lastInsertRowid;
    activeTaskId = insertTask('Route Active Task', 1);
    inactiveTaskId = insertTask('Route Inactive Task', 0);
  });

  // Logs in as the ONE shared route guest (routeGuestId) created in beforeAll
  // above. Every call re-authenticates as that same guest — this is what lets
  // 'task_inactive' and 'thumb_failed' assert on routeGuestId's row state.
  async function makeGuestAgent() {
    const agent = request.agent(app);
    signInGuest(app, routeGuestToken, agent);
    return agent;
  }

  // Creates and logs in as a brand-new, independent guest (its own row, its
  // own token) rather than the shared routeGuestId. Used where a test needs a
  // guest with no prior submission history, instead of inheriting whatever
  // state sibling tests left on the shared route guest.
  async function makeFreshGuestAgent() {
    const token = `intake-route-fresh-${crypto.randomUUID()}`;
    db.prepare(`INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)`).run(
      token,
      'Fresh Route Guest'
    );
    const agent = request.agent(app);
    signInGuest(app, token, agent);
    return agent;
  }

  it('created: success card (not the plain flash) and redirect (issue #255)', async () => {
    const agent = await makeGuestAgent();
    const res = await agent
      .post(`/tasks/${activeTaskId}/submit`)
      .attach('photo', validJpeg, { filename: 'route-created.jpg', contentType: 'image/jpeg' });

    expect([302, 303]).toContain(res.status);
    expect(res.headers.location).toBe('/tasks/' + activeTaskId);

    // The taskComplete cookie is SIGNED (cookie-parser, req.signedCookies) —
    // rather than reimplementing signature verification in the test, follow
    // the redirect with the same agent (it resends the cookie automatically)
    // and assert on the rendered success-card text, exactly what a guest
    // would see. Issue #255 replaced the plain "Task complete! +1 point."
    // flash with a success card for the 'created' case — see
    // tests/rewards.test.js for the full AC1-AC5 coverage.
    const page = await agent.get(res.headers.location);
    expect(page.text).toContain('Task complete!');
    expect(page.text).toContain('+1 point');
    expect(page.text).not.toContain('flash-ok');
  });

  it('replaced: flash "Photo replaced!" and redirect', async () => {
    // Self-contained: this test creates its own "already submitted once"
    // state on a fresh guest, rather than relying on a sibling test (e.g.
    // 'created') having already POSTed to activeTaskId first. A shared
    // activeTaskId fixture is fine — concurrent guests submitting to the same
    // task mirrors real behavior — but the guest submitting twice must be
    // this test's own guest, not one inherited from execution order.
    const agent = await makeFreshGuestAgent();

    // First submission for this (guest, task) pair — sets up the "already
    // submitted" state. Not the AC under test here, so only a minimal sanity
    // check on the setup POST itself.
    const setupRes = await agent.post(`/tasks/${activeTaskId}/submit`).attach('photo', validJpeg, {
      filename: 'route-replaced-setup.jpg',
      contentType: 'image/jpeg',
    });
    expect([302, 303]).toContain(setupRes.status);

    // Second submission to the SAME task by the SAME guest — this is the one
    // that must yield 'replaced'.
    const res = await agent
      .post(`/tasks/${activeTaskId}/submit`)
      .attach('photo', validJpeg, { filename: 'route-replaced.jpg', contentType: 'image/jpeg' });

    expect([302, 303]).toContain(res.status);
    expect(res.headers.location).toBe('/tasks/' + activeTaskId);

    const page = await agent.get(res.headers.location);
    expect(page.text).toContain('Photo replaced!');
    expect(page.text).toContain('flash-ok');
  });

  it('task_inactive: 404 render, no submissions row, uploaded file not left behind', async () => {
    const agent = await makeGuestAgent();
    const beforeRow = getSubmission(routeGuestId, inactiveTaskId);
    expect(beforeRow).toBeUndefined();

    const res = await agent
      .post(`/tasks/${inactiveTaskId}/submit`)
      .attach('photo', validJpeg, { filename: 'route-inactive.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(404);
    expect(getSubmission(routeGuestId, inactiveTaskId)).toBeUndefined();
  });

  it('thumb_failed: flash "Sorry, we could not save that photo. Please try again." and redirect', async () => {
    const agent = await makeGuestAgent();
    const taskId = insertTask('Route Thumb-Fail Task', 1);

    // Bytes that are not a valid image, so photos.makeThumb (sharp) throws
    // once multer has already written them to disk.
    const garbage = Buffer.from('this is not an image');
    const res = await agent
      .post(`/tasks/${taskId}/submit`)
      .attach('photo', garbage, { filename: 'route-garbage.jpg', contentType: 'image/jpeg' });

    expect([302, 303]).toContain(res.status);
    expect(res.headers.location).toBe('/tasks/' + taskId);

    const page = await agent.get(res.headers.location);
    expect(page.text).toContain('Sorry, we could not save that photo. Please try again.');
    expect(page.text).toContain('flash-err');
    expect(getSubmission(routeGuestId, taskId)).toBeUndefined();
  });

  it('route contains no submissions SQL and no direct recomputeAutoBadges call', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'guest.js'), 'utf8');
    expect(source).not.toMatch(/INSERT\s+INTO\s+submissions/i);
    expect(source).not.toMatch(/UPDATE\s+submissions/i);
    expect(source).not.toMatch(/scoring\.recomputeAutoBadges/);
  });
});
