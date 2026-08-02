// tests/recap-moderation.test.js
// Issue #783 — recap moderation events: photo_takedown, photo_restore,
// comment_hidden, comment_restored, emitted from the host moderation routes
// (src/routes/admin/moderation.js) via notifications.recordEvent. The
// KIND_VIEW map and getRecap/getUnreadCount machinery are #644's own —
// already covered by tests/recap.test.js — this file only covers the four
// EMITTERS this issue adds: when they fire, who they notify, and that a
// repeat POST does not double-emit (neither writer this issue emits behind
// guards against re-setting taken_down to its current value).
//
//   AC1 — a takedown row is inert (no href, dead); a restore row links to
//         the photo; both survive side by side (stored events are permanent).
//   AC2 — a guest's own delete (POST /p/:submissionId/delete) never reaches
//         this file's emitters (the route the guest hits never calls it),
//         so it writes no photo_takedown row.
//   AC3 — hiding a comment notifies the PHOTO'S OWNER, not the commenter.
//   AC4 — restoring a comment notifies the owner again, with a distinct row.
//   AC5 — a second identical POST (takedown or hide) writes no second row.
//
// REQUIRE ORDER: loadApp() must run before any require that pulls in config
// or db (see tests/helpers/testApp.js).
'use strict';

const { loadApp, makeAdminAgent, signInGuest } = require('./helpers/testApp');

let app;
let db;
let notifications;
let adminAgent;

beforeAll(async () => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
  notifications = require('../src/services/notifications');
  adminAgent = await makeAdminAgent(app, 'recap-moderation-admin-pw');
});

let seq = 0;

function insertGuest(name) {
  seq += 1;
  const token = `recap-mod-${seq}-${name.replace(/\s+/g, '-')}`;
  const id = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run(token, name).lastInsertRowid;
  return { id, token };
}

function insertTask(title) {
  seq += 1;
  return db.prepare(`INSERT INTO tasks (title) VALUES (?)`).run(title || `Recap mod task ${seq}`)
    .lastInsertRowid;
}

function insertSubmission(guestId, taskId) {
  seq += 1;
  return db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, 0)`
    )
    .run(guestId, taskId, `p-${seq}.jpg`, `t-${seq}.jpg`).lastInsertRowid;
}

function insertComment(submissionId, guestId, body) {
  return db
    .prepare(`INSERT INTO comments (submission_id, guest_id, body) VALUES (?, ?, ?)`)
    .run(submissionId, guestId, body).lastInsertRowid;
}

// Same "join structured parts back to plain text" shape tests/recap.test.js
// already uses — a row's `parts` is a structured array, not pre-built HTML,
// so a test that wants to search the copy joins it back to plain text first.
function partsText(parts) {
  return (parts || []).map((part) => (part.quote ? `“${part.text}”` : part.text)).join('');
}

function eventCount(guestId, kind) {
  return db
    .prepare(`SELECT COUNT(*) AS n FROM notification_events WHERE guest_id = ? AND kind = ?`)
    .get(guestId, kind).n;
}

// ---------------------------------------------------------------------------
// AC1: a takedown row is inert; a restore row links to the photo; both
// survive side by side.
// ---------------------------------------------------------------------------
describe('AC1: photo takedown/restore recap rows', () => {
  it('takedown mints an inert row (no href, dead); restore mints a linking row; the takedown row still stands', async () => {
    const owner = insertGuest('AC1 Owner');
    const taskId = insertTask('AC1 task');
    const subId = insertSubmission(owner.id, taskId);

    const takedownRes = await adminAgent.post(`/admin/photos/${subId}/takedown`);
    expect(takedownRes.status).toBe(303);

    const afterTakedown = notifications.getRecap(owner.id).rows;
    const takedownRow = afterTakedown.find((r) =>
      partsText(r.parts).includes('took your photo down')
    );
    expect(takedownRow).toBeDefined();
    expect(takedownRow.href).toBeNull();
    expect(takedownRow.dead).toBe(true);

    const restoreRes = await adminAgent.post(`/admin/photos/${subId}/restore`);
    expect(restoreRes.status).toBe(303);

    const afterRestore = notifications.getRecap(owner.id).rows;
    const restoreRow = afterRestore.find((r) => partsText(r.parts).includes('back up'));
    expect(restoreRow).toBeDefined();
    expect(restoreRow.href).toBe(`/p/${subId}`);
    expect(restoreRow.dead).toBe(false);

    // Neither event is reconstructible from submissions.taken_down's final
    // (now 0) value — the takedown row must still be present alongside the
    // restore row, not overwritten or removed by it.
    expect(afterRestore.some((r) => partsText(r.parts).includes('took your photo down'))).toBe(
      true
    );
  });
});

// ---------------------------------------------------------------------------
// AC2: a guest's own delete never says the hosts did it.
// ---------------------------------------------------------------------------
describe("AC2: a guest's own delete never emits photo_takedown", () => {
  it('POST /p/:submissionId/delete hides the photo but writes no photo_takedown event', async () => {
    const guest = insertGuest('AC2 Guest');
    const taskId = insertTask('AC2 task');
    const subId = insertSubmission(guest.id, taskId);
    const guestAgent = signInGuest(app, guest.token);

    const deleteRes = await guestAgent.post(`/p/${subId}/delete`);
    expect([302, 303]).toContain(deleteRes.status);

    const row = db.prepare('SELECT taken_down FROM submissions WHERE id = ?').get(subId);
    expect(row.taken_down).toBe(1);

    expect(eventCount(guest.id, 'photo_takedown')).toBe(0);
    const rows = notifications.getRecap(guest.id).rows;
    expect(rows.some((r) => partsText(r.parts).includes('took your photo down'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC3/AC4: comment hide/restore notify the photo's OWNER, never the
// commenter (comments.guest_id is the AUTHOR, a different guest here).
// ---------------------------------------------------------------------------
describe('AC3/AC4: comment hide/restore notifies the photo owner, not the commenter', () => {
  it('hide -> comment_hidden row on the owner only; restore -> comment_restored row on the owner only', async () => {
    const owner = insertGuest('AC3 Owner');
    const commenter = insertGuest('AC3 Commenter');
    const taskId = insertTask('AC3 task');
    const subId = insertSubmission(owner.id, taskId);
    const commentId = insertComment(subId, commenter.id, 'nice shot');

    const hideRes = await adminAgent.post(`/admin/comments/${commentId}/hide`);
    expect(hideRes.status).toBe(303);

    const ownerRowsAfterHide = notifications.getRecap(owner.id).rows;
    const hiddenRow = ownerRowsAfterHide.find((r) =>
      partsText(r.parts).includes('removed by the hosts')
    );
    expect(hiddenRow).toBeDefined();
    expect(hiddenRow.href).toBe(`/p/${subId}`);

    expect(eventCount(commenter.id, 'comment_hidden')).toBe(0);

    const restoreRes = await adminAgent.post(`/admin/comments/${commentId}/restore`);
    expect(restoreRes.status).toBe(303);

    const ownerRowsAfterRestore = notifications.getRecap(owner.id).rows;
    const restoredRow = ownerRowsAfterRestore.find((r) =>
      partsText(r.parts).startsWith('A comment on your photo is')
    );
    expect(restoredRow).toBeDefined();
    expect(restoredRow.href).toBe(`/p/${subId}`);

    const commenterRowsAfterRestore = notifications.getRecap(commenter.id).rows;
    expect(
      commenterRowsAfterRestore.some((r) =>
        partsText(r.parts).startsWith('A comment on your photo is')
      )
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC5: repeating a moderation action does not repeat the row — neither
// writer (photos.hideSubmission/restoreSubmission's own _setTakenDownAndRecount,
// nor the comment routes' UPDATE) guards against re-setting a flag to its
// current value, so the emitter's own prior-value read is what stops the
// double row.
// ---------------------------------------------------------------------------
describe('AC5: repeat moderation actions do not double-emit', () => {
  it('takedown POSTed twice on the same submission writes exactly one photo_takedown row', async () => {
    const owner = insertGuest('AC5 Photo Owner');
    const taskId = insertTask('AC5 photo task');
    const subId = insertSubmission(owner.id, taskId);

    const first = await adminAgent.post(`/admin/photos/${subId}/takedown`);
    expect(first.status).toBe(303);
    const second = await adminAgent.post(`/admin/photos/${subId}/takedown`);
    expect(second.status).toBe(303);

    const row = db.prepare('SELECT taken_down FROM submissions WHERE id = ?').get(subId);
    expect(row.taken_down).toBe(1);
    expect(eventCount(owner.id, 'photo_takedown')).toBe(1);
  });

  it('hide POSTed twice on the same comment writes exactly one comment_hidden row', async () => {
    const owner = insertGuest('AC5 Comment Owner');
    const commenter = insertGuest('AC5 Comment Commenter');
    const taskId = insertTask('AC5 comment task');
    const subId = insertSubmission(owner.id, taskId);
    const commentId = insertComment(subId, commenter.id, 'twice hidden');

    const first = await adminAgent.post(`/admin/comments/${commentId}/hide`);
    expect(first.status).toBe(303);
    const second = await adminAgent.post(`/admin/comments/${commentId}/hide`);
    expect(second.status).toBe(303);

    const row = db.prepare('SELECT taken_down FROM comments WHERE id = ?').get(commentId);
    expect(row.taken_down).toBe(1);
    expect(eventCount(owner.id, 'comment_hidden')).toBe(1);
  });
});
