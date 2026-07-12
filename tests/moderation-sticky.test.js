// tests/moderation-sticky.test.js
// Covers issue #190 acceptance criteria: a submission the host has taken
// down must stay taken down across a guest resubmit — moderation is a
// decision the host owns, not one any guest can silently reverse.
//   AC1 — resubmitting onto a taken-down row keeps taken_down = 1, and the
//         photo stays absent from GET /feed and GET /gallery.
//   AC2 — GET /tasks/:id for that guest reads "with the hosts", and does not
//         present the task as not-done.
//   AC3 — GET /admin/photos (as admin) shows a RESUBMITTED marker alongside
//         the existing TAKEN DOWN state and Restore button.
//   AC4 — a normal (never-taken-down) replace stays visible: status quo.
//   AC5 — GET /leaderboard's total excludes the still-hidden submission.
//   Plus: restoreSubmission clears the resubmitted flag (src/services/photos.js).
//
// REQUIRE ORDER: config / db / services are required only AFTER loadApp() sets
// DATA_DIR / DB_PATH, matching tests/submission-intake.test.js and
// tests/photo-comments.test.js.
'use strict';

const crypto = require('crypto');
const request = require('supertest');
const sharp = require('sharp');
const { loadApp, makeAdminAgent, signInGuest } = require('./helpers/testApp');

let app;
let db;
let validJpeg;
let adminAgent;

beforeAll(async () => {
  // A tiny real JPEG so photos.makeThumb (sharp) succeeds on every submit.
  validJpeg = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 40, g: 90, b: 140 } },
  })
    .jpeg()
    .toBuffer();

  const result = loadApp();
  app = result.app;
  db = result.db;
  adminAgent = await makeAdminAgent(app, 'sticky-takedown-admin-pw');
});

/**
 * Insert a guest row with the given token and return { guestId, agent } where
 * agent is a supertest agent already signed in as that guest (via signInGuest,
 * the same pattern tests/photo-comments.test.js uses).
 */
async function signedInGuest(token, name) {
  const guestId = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run(token, name).lastInsertRowid;
  const agent = request.agent(app);
  signInGuest(app, token, agent);
  return { guestId, agent };
}

function insertTask(title) {
  return db.prepare(`INSERT INTO tasks (title, is_active) VALUES (?, 1)`).run(title)
    .lastInsertRowid;
}

function getSubmission(guestId, taskId) {
  return db
    .prepare(`SELECT * FROM submissions WHERE guest_id = ? AND task_id = ?`)
    .get(guestId, taskId);
}

/** POST a photo submit for taskId as the given guest agent; returns the redirect response. */
async function postPhoto(agent, taskId, filename) {
  return agent
    .post('/tasks/' + taskId + '/submit')
    .attach('photo', validJpeg, { filename, contentType: 'image/jpeg' });
}

// ---------------------------------------------------------------------------
// AC1: a resubmit onto a taken-down row does not self-restore, and the photo
// stays absent from /feed and /gallery.
// ---------------------------------------------------------------------------
it('AC1: resubmitting onto a taken-down row keeps taken_down = 1 and stays out of /feed and /gallery', async () => {
  const guest = await signedInGuest('sticky-ac1-' + crypto.randomUUID(), 'AC1 Guest');
  const taskId = insertTask('AC1 Task');

  const firstRes = await postPhoto(guest.agent, taskId, 'ac1-first.jpg');
  expect([302, 303]).toContain(firstRes.status);

  const firstRow = getSubmission(guest.guestId, taskId);
  expect(firstRow).toBeDefined();
  expect(firstRow.taken_down).toBe(0);

  // Host takes the photo down.
  const takedownRes = await adminAgent.post('/admin/photos/' + firstRow.id + '/takedown');
  expect(takedownRes.status).toBe(303);
  expect(getSubmission(guest.guestId, taskId).taken_down).toBe(1);

  // Guest resubmits onto the exact same (guest, task) slot.
  const secondRes = await postPhoto(guest.agent, taskId, 'ac1-second.jpg');
  expect([302, 303]).toContain(secondRes.status);

  // Core assertion: same row, still taken down, now flagged resubmitted.
  // If the #190 bug (stmtReplaceSubmission forcing taken_down = 0) were
  // reintroduced, taken_down here would read 0 and this would fail.
  const afterResubmit = getSubmission(guest.guestId, taskId);
  expect(afterResubmit.id).toBe(firstRow.id);
  expect(afterResubmit.taken_down).toBe(1);
  expect(afterResubmit.resubmitted).toBe(1);
  // The new file did land (superseded-file replace still happened).
  expect(afterResubmit.photo_path).not.toBe(firstRow.photo_path);

  const feedRes = await guest.agent.get('/feed');
  expect(feedRes.status).toBe(200);
  expect(feedRes.text).not.toContain(afterResubmit.thumb_path);

  const galleryRes = await guest.agent.get('/gallery');
  expect(galleryRes.status).toBe(200);
  expect(galleryRes.text).not.toContain(afterResubmit.thumb_path);
});

// ---------------------------------------------------------------------------
// AC2: the guest's task page reads "with the hosts" and does not present the
// task as not-done.
// ---------------------------------------------------------------------------
it('AC2: GET /tasks/:id for a taken-down submission reads "with the hosts", not "not done"', async () => {
  const guest = await signedInGuest('sticky-ac2-' + crypto.randomUUID(), 'AC2 Guest');
  const taskId = insertTask('AC2 Task');

  const submitRes = await postPhoto(guest.agent, taskId, 'ac2-first.jpg');
  expect([302, 303]).toContain(submitRes.status);
  const row = getSubmission(guest.guestId, taskId);

  await adminAgent.post('/admin/photos/' + row.id + '/takedown');
  expect(getSubmission(guest.guestId, taskId).taken_down).toBe(1);

  const taskPage = await guest.agent.get('/tasks/' + taskId);
  expect(taskPage.status).toBe(200);
  expect(taskPage.text).toContain('with the hosts');
  // The task must not present as not-done — that heading is exactly what
  // used to invite the resubmit that silently reversed the takedown.
  expect(taskPage.text).not.toContain('Upload a photo to complete this task');
});

// ---------------------------------------------------------------------------
// AC3: the admin photos page shows a RESUBMITTED marker alongside TAKEN DOWN
// and the Restore button.
// ---------------------------------------------------------------------------
it('AC3: GET /admin/photos shows RESUBMITTED alongside TAKEN DOWN for a resubmitted-while-hidden photo', async () => {
  const guest = await signedInGuest('sticky-ac3-' + crypto.randomUUID(), 'AC3 Guest');
  const taskId = insertTask('AC3 Task');

  await postPhoto(guest.agent, taskId, 'ac3-first.jpg');
  const row = getSubmission(guest.guestId, taskId);

  await adminAgent.post('/admin/photos/' + row.id + '/takedown');
  await postPhoto(guest.agent, taskId, 'ac3-second.jpg');
  expect(getSubmission(guest.guestId, taskId).resubmitted).toBe(1);

  const adminPhotosPage = await adminAgent.get('/admin/photos');
  expect(adminPhotosPage.status).toBe(200);

  // Slice out this card's chunk so the assertion cannot bleed into another
  // photo's markup (other tests in this file also seed rows into the same
  // shared temp DB).
  const marker = 'action="/admin/photos/' + row.id + '/restore"';
  const start = adminPhotosPage.text.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const cardStart = adminPhotosPage.text.lastIndexOf('photo-admin-card', start);
  const chunk = adminPhotosPage.text.slice(cardStart, start + marker.length + 100);

  expect(chunk).toContain('TAKEN DOWN');
  expect(chunk).toContain('RESUBMITTED');
});

// ---------------------------------------------------------------------------
// AC4: a normal replace (never taken down) stays visible — status quo.
// ---------------------------------------------------------------------------
it('AC4: replacing a visible (never-taken-down) submission leaves it visible', async () => {
  const guest = await signedInGuest('sticky-ac4-' + crypto.randomUUID(), 'AC4 Guest');
  const taskId = insertTask('AC4 Task');

  const firstRes = await postPhoto(guest.agent, taskId, 'ac4-first.jpg');
  expect([302, 303]).toContain(firstRes.status);
  const firstRow = getSubmission(guest.guestId, taskId);
  expect(firstRow.taken_down).toBe(0);

  const secondRes = await postPhoto(guest.agent, taskId, 'ac4-second.jpg');
  expect([302, 303]).toContain(secondRes.status);

  const replacedRow = getSubmission(guest.guestId, taskId);
  expect(replacedRow.id).toBe(firstRow.id);
  expect(replacedRow.taken_down).toBe(0);
  expect(replacedRow.resubmitted).toBe(0);

  const page = await guest.agent.get(secondRes.headers.location);
  expect(page.text).toContain('Photo replaced!');
});

// ---------------------------------------------------------------------------
// AC5: the guest's leaderboard total excludes the still-hidden submission.
// ---------------------------------------------------------------------------
it('AC5: GET /leaderboard excludes a taken-down-then-resubmitted submission from the guest total', async () => {
  const guest = await signedInGuest('sticky-ac5-' + crypto.randomUUID(), 'AC5 Guest');
  const taskId = insertTask('AC5 Task');

  await postPhoto(guest.agent, taskId, 'ac5-first.jpg');
  const row = getSubmission(guest.guestId, taskId);

  await adminAgent.post('/admin/photos/' + row.id + '/takedown');
  await postPhoto(guest.agent, taskId, 'ac5-second.jpg'); // resubmit while hidden
  expect(getSubmission(guest.guestId, taskId).taken_down).toBe(1);

  const leaderboardPage = await guest.agent.get('/leaderboard');
  expect(leaderboardPage.status).toBe(200);

  // scoring.leaderboard() is the exact query GET /leaderboard renders from
  // (src/routes/community.js); read the guest's row from it directly rather
  // than parsing rank/tie HTML, which is orthogonal to this AC.
  const scoring = require('../src/services/scoring');
  const lbRow = scoring.leaderboard().find((r) => r.id === guest.guestId);
  expect(lbRow).toBeDefined();
  expect(lbRow.points).toBe(0);
  expect(lbRow.completed).toBe(0);
});

// ---------------------------------------------------------------------------
// Restore clears the resubmitted flag (src/services/photos.js), in the same
// transaction as the taken_down flip back to 0.
// ---------------------------------------------------------------------------
it('restoreSubmission clears resubmitted back to 0 when un-hiding a resubmitted row', async () => {
  const guest = await signedInGuest('sticky-restore-' + crypto.randomUUID(), 'Restore Guest');
  const taskId = insertTask('Restore Task');

  await postPhoto(guest.agent, taskId, 'restore-first.jpg');
  const row = getSubmission(guest.guestId, taskId);

  await adminAgent.post('/admin/photos/' + row.id + '/takedown');
  await postPhoto(guest.agent, taskId, 'restore-second.jpg');
  expect(getSubmission(guest.guestId, taskId).resubmitted).toBe(1);

  const restoreRes = await adminAgent.post('/admin/photos/' + row.id + '/restore');
  expect(restoreRes.status).toBe(303);

  const restored = getSubmission(guest.guestId, taskId);
  expect(restored.taken_down).toBe(0);
  expect(restored.resubmitted).toBe(0);
});
