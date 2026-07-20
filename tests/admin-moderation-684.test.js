// tests/admin-moderation-684.test.js
// Issue #684 — kebab takedown out of the badge dialog, real per-photo
// comments in the admin viewer, Comments page removed.
//
//   AC1 — kebab takedown/restore (behavioral)
//   AC2 — badge dialog is award-only (no Take down/Restore control)
//   AC3 — a taken-down photo grays out in the feed viewer (grayscale + pill)
//   AC4 — hiding a comment in context hides it from guests, renders
//         struck-through with Restore in the admin view, and redirects to
//         the photos feed at that photo's card
//   AC5 — a long thread clamps to the 2 most recent + "See all N comments";
//         a lone comment shows in full with no "See all"
//   AC6 — the Comments page and nav tab are gone; GET /admin/comments -> 404
//   AC7 — POST /admin/photos/:id/points is retired -> 404; photo_bonus keeps
//         counting
//
// REQUIRE ORDER: loadApp() must run before any require that pulls in config
// or db (see tests/helpers/testApp.js).
'use strict';

const request = require('supertest');
const { loadApp, makeAdminAgent, signInGuest } = require('./helpers/testApp');

let app;
let db;
let adminAgent;

beforeAll(async () => {
  const result = loadApp();
  app = result.app;
  db = result.db;
  adminAgent = await makeAdminAgent(app, 'moderation-684-admin-pw');
});

function insertGuest(name, token) {
  return db.prepare('INSERT INTO guests (token, name) VALUES (?, ?)').run(token, name)
    .lastInsertRowid;
}

function insertTask(title) {
  return db.prepare('INSERT INTO tasks (title) VALUES (?)').run(title).lastInsertRowid;
}

function insertSubmission({ guestId, taskId = null, photoPath, thumbPath, takenDown = 0 }) {
  return db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(guestId, taskId, photoPath, thumbPath, takenDown).lastInsertRowid;
}

function insertComment(submissionId, guestId, body, takenDown = 0) {
  return db
    .prepare('INSERT INTO comments (submission_id, guest_id, body, taken_down) VALUES (?, ?, ?, ?)')
    .run(submissionId, guestId, body, takenDown).lastInsertRowid;
}

/** Slice out the single <article> feed card for a submission id. */
function feedCardChunk(html, submissionId) {
  const marker = 'id="feed-photo-' + submissionId + '"';
  const markerAt = html.indexOf(marker);
  expect(markerAt).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<article', markerAt);
  const end = html.indexOf('</article>', markerAt);
  return html.slice(start, end);
}

/** Slice out the give-a-badge dialog markup, which is shared (one per page). */
function badgeDialogChunk(html) {
  const start = html.indexOf('id="adminBadgeDialog"');
  expect(start).toBeGreaterThan(-1);
  const openTagStart = html.lastIndexOf('<dialog', start);
  const end = html.indexOf('</dialog>', start);
  return html.slice(openTagStart, end);
}

// ---------------------------------------------------------------------------
// AC1: kebab takedown/restore
// ---------------------------------------------------------------------------
describe('AC1: kebab takedown/restore', () => {
  let submissionId;

  beforeAll(() => {
    const taskId = insertTask('AC1 Task');
    const guestId = insertGuest('AC1 Guest', 'ac1-684-guest');
    submissionId = insertSubmission({
      guestId,
      taskId,
      photoPath: 'ac1-684.jpg',
      thumbPath: 'ac1-684-t.jpg',
    });
  });

  it('a live photo\'s feed card carries a kebab menu with a "Take down photo" form for that exact photo', async () => {
    const res = await adminAgent.get('/admin/photos');
    const chunk = feedCardChunk(res.text, submissionId);
    expect(chunk).toContain('photo-owner-menu-trigger');
    expect(chunk).toContain('action="/admin/photos/' + submissionId + '/takedown"');
    expect(chunk).toContain('Take down photo');
    expect(chunk).not.toContain('Restore photo');
  });

  it('confirming takedown hides the photo from guest surfaces and flips the menu to Restore', async () => {
    const res = await adminAgent
      .post('/admin/photos/' + submissionId + '/takedown')
      .type('form')
      .send({ panel: 'feed' });
    expect(res.status).toBe(303);

    const row = db.prepare('SELECT taken_down FROM submissions WHERE id = ?').get(submissionId);
    expect(row.taken_down).toBe(1);

    const page = await adminAgent.get('/admin/photos');
    const chunk = feedCardChunk(page.text, submissionId);
    expect(chunk).toContain('action="/admin/photos/' + submissionId + '/restore"');
    expect(chunk).toContain('Restore photo');
    expect(chunk).not.toContain('Take down photo');
  });

  it('restoring reverses it — menu is back to Take down, photo is live again', async () => {
    const res = await adminAgent
      .post('/admin/photos/' + submissionId + '/restore')
      .type('form')
      .send({ panel: 'feed' });
    expect(res.status).toBe(303);

    const row = db.prepare('SELECT taken_down FROM submissions WHERE id = ?').get(submissionId);
    expect(row.taken_down).toBe(0);

    const page = await adminAgent.get('/admin/photos');
    const chunk = feedCardChunk(page.text, submissionId);
    expect(chunk).toContain('action="/admin/photos/' + submissionId + '/takedown"');
    expect(chunk).not.toContain('Restore photo');
  });
});

// ---------------------------------------------------------------------------
// AC2: the give-a-badge dialog is award-only
// ---------------------------------------------------------------------------
describe('AC2: badge dialog is award-only', () => {
  it('the give-a-badge dialog contains no Take down/Restore control', async () => {
    const taskId = insertTask('AC2 Task');
    const guestId = insertGuest('AC2 Guest', 'ac2-684-guest');
    insertSubmission({ guestId, taskId, photoPath: 'ac2-684.jpg', thumbPath: 'ac2-684-t.jpg' });

    const res = await adminAgent.get('/admin/photos');
    const dialog = badgeDialogChunk(res.text);
    expect(dialog).not.toContain('Take down');
    expect(dialog).not.toContain('Restore photo');
    expect(dialog).not.toContain('/takedown"');
    expect(dialog).not.toContain('/restore"');
    // It still awards.
    expect(dialog).toContain('Award badge');
  });
});

// ---------------------------------------------------------------------------
// AC3: a taken-down photo grays out in the feed viewer
// ---------------------------------------------------------------------------
describe('AC3: taken-down photo grays out in the feed viewer', () => {
  it('carries the is-down class and the "Taken down" pill on its feed card', async () => {
    const taskId = insertTask('AC3 Task');
    const guestId = insertGuest('AC3 Guest', 'ac3-684-guest');
    const submissionId = insertSubmission({
      guestId,
      taskId,
      photoPath: 'ac3-684.jpg',
      thumbPath: 'ac3-684-t.jpg',
      takenDown: 1,
    });

    const res = await adminAgent.get('/admin/photos');
    const chunk = feedCardChunk(res.text, submissionId);
    expect(chunk).toContain('admin-feed-item is-down');
    expect(chunk).toContain('admin-tile-down">Taken down<');
  });

  it("a live photo's feed card carries neither", async () => {
    const taskId = insertTask('AC3 Live Task');
    const guestId = insertGuest('AC3 Live Guest', 'ac3-684-live-guest');
    const submissionId = insertSubmission({
      guestId,
      taskId,
      photoPath: 'ac3-684-live.jpg',
      thumbPath: 'ac3-684-live-t.jpg',
    });

    const res = await adminAgent.get('/admin/photos');
    const chunk = feedCardChunk(res.text, submissionId);
    expect(chunk).not.toContain('is-down');
    expect(chunk).not.toContain('admin-tile-down');
  });
});

// ---------------------------------------------------------------------------
// AC4: hide a comment in context
// ---------------------------------------------------------------------------
describe('AC4: hide/restore a comment in context', () => {
  let submissionId;
  let commentId;
  let guestAgent;

  beforeAll(async () => {
    const taskId = insertTask('AC4 Task');
    const authorId = insertGuest('AC4 Author', 'ac4-684-author');
    const commenterId = insertGuest('AC4 Commenter', 'ac4-684-commenter');
    submissionId = insertSubmission({
      guestId: authorId,
      taskId,
      photoPath: 'ac4-684.jpg',
      thumbPath: 'ac4-684-t.jpg',
    });
    commentId = insertComment(submissionId, commenterId, 'A single visible comment.');

    guestAgent = request.agent(app);
    signInGuest(app, 'ac4-684-author', guestAgent);
  });

  it('the live comment renders in full with a visible Hide, no clamp (lone comment)', async () => {
    const res = await adminAgent.get('/admin/photos');
    const chunk = feedCardChunk(res.text, submissionId);
    expect(chunk).toContain('A single visible comment.');
    expect(chunk).toContain('action="/admin/comments/' + commentId + '/hide"');
    expect(chunk).not.toContain('See all');
  });

  it("hiding it redirects to the photos feed at this photo's card, not a Comments page", async () => {
    const res = await adminAgent
      .post('/admin/comments/' + commentId + '/hide')
      .type('form')
      .send({ view: 'recent', panel: 'feed' });
    expect(res.status).toBe(303);
    expect(res.headers.location).toContain('/admin/photos');
    expect(res.headers.location).not.toContain('/admin/comments');
    expect(res.headers.location).toContain('view=recent');
    expect(decodeURIComponent(res.headers.location)).toContain('#feed-photo-' + submissionId);

    const row = db.prepare('SELECT taken_down FROM comments WHERE id = ?').get(commentId);
    expect(row.taken_down).toBe(1);
  });

  it('renders struck-through with Restore in the admin viewer', async () => {
    const res = await adminAgent.get('/admin/photos');
    const chunk = feedCardChunk(res.text, submissionId);
    expect(chunk).toContain('admin-comment-item is-hidden');
    expect(chunk).toContain('action="/admin/comments/' + commentId + '/restore"');
    expect(chunk).not.toContain('action="/admin/comments/' + commentId + '/hide"');
  });

  it('disappears from the guest feed while hidden', async () => {
    const res = await guestAgent.get('/feed');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('A single visible comment.');
  });

  it('restoring brings it back exactly as before, also redirecting to the feed card', async () => {
    const res = await adminAgent
      .post('/admin/comments/' + commentId + '/restore')
      .type('form')
      .send({ view: 'recent', panel: 'feed' });
    expect(res.status).toBe(303);
    expect(res.headers.location).toContain('/admin/photos');
    expect(decodeURIComponent(res.headers.location)).toContain('#feed-photo-' + submissionId);

    const row = db.prepare('SELECT taken_down FROM comments WHERE id = ?').get(commentId);
    expect(row.taken_down).toBe(0);

    const page = await adminAgent.get('/admin/photos');
    const chunk = feedCardChunk(page.text, submissionId);
    expect(chunk).not.toContain('is-hidden');
    expect(chunk).toContain('action="/admin/comments/' + commentId + '/hide"');

    const guestRes = await guestAgent.get('/feed');
    expect(guestRes.text).toContain('A single visible comment.');
  });
});

// ---------------------------------------------------------------------------
// AC5: long thread clamps to 2 most recent + "See all N"; lone comment shows
// in full with no "See all".
// ---------------------------------------------------------------------------
describe('AC5: thread clamping vs. lone comment', () => {
  it('5 comments: the feed card shows only the 2 most recent, plus "See all 5 comments"; the dialog holds all 5', async () => {
    const taskId = insertTask('AC5 Task');
    const authorId = insertGuest('AC5 Author', 'ac5-684-author');
    const commenterId = insertGuest('AC5 Commenter', 'ac5-684-commenter');
    const submissionId = insertSubmission({
      guestId: authorId,
      taskId,
      photoPath: 'ac5-684.jpg',
      thumbPath: 'ac5-684-t.jpg',
    });

    const bodies = [
      'First comment',
      'Second comment',
      'Third comment',
      'Fourth comment',
      'Fifth comment',
    ];
    const ids = bodies.map((b) => insertComment(submissionId, commenterId, b));

    const res = await adminAgent.get('/admin/photos');
    const chunk = feedCardChunk(res.text, submissionId);

    // Only the 2 most recent (Fourth, Fifth) appear in the card itself —
    // scoped to before the dialog markup, since the dialog (further down the
    // same card) legitimately repeats all 5.
    const dialogStart = chunk.indexOf('admin-comments-dialog-' + submissionId);
    const cardOnly = chunk.slice(0, dialogStart);
    expect(cardOnly).not.toContain('First comment');
    expect(cardOnly).not.toContain('Third comment');
    expect(cardOnly).toContain('Fourth comment');
    expect(cardOnly).toContain('Fifth comment');
    expect(cardOnly).toContain('admin-comment-clamp');
    expect(cardOnly).toContain('See all 5 comments');

    // The full thread (all 5, oldest-first) lives in the dialog.
    const dialogChunk = chunk.slice(dialogStart);
    bodies.forEach((b) => expect(dialogChunk).toContain(b));
    // Every dialog comment keeps its own Hide/Restore.
    ids.forEach((id) => expect(dialogChunk).toContain('/admin/comments/' + id + '/'));
  });

  it('a lone comment shows in full, no "See all"', async () => {
    const taskId = insertTask('AC5 Lone Task');
    const authorId = insertGuest('AC5 Lone Author', 'ac5-684-lone-author');
    const commenterId = insertGuest('AC5 Lone Commenter', 'ac5-684-lone-commenter');
    const submissionId = insertSubmission({
      guestId: authorId,
      taskId,
      photoPath: 'ac5-684-lone.jpg',
      thumbPath: 'ac5-684-lone-t.jpg',
    });
    insertComment(submissionId, commenterId, 'The only comment here.');

    const res = await adminAgent.get('/admin/photos');
    const chunk = feedCardChunk(res.text, submissionId);
    expect(chunk).toContain('The only comment here.');
    expect(chunk).not.toContain('See all');
    expect(chunk).not.toContain('admin-comment-clamp');
  });

  it('a photo with zero comments renders no comments block and no dialog', async () => {
    const taskId = insertTask('AC5 Zero Task');
    const guestId = insertGuest('AC5 Zero Guest', 'ac5-684-zero-guest');
    const submissionId = insertSubmission({
      guestId,
      taskId,
      photoPath: 'ac5-684-zero.jpg',
      thumbPath: 'ac5-684-zero-t.jpg',
    });

    const res = await adminAgent.get('/admin/photos');
    const chunk = feedCardChunk(res.text, submissionId);
    expect(chunk).not.toContain('feed-comments admin-feed-comments');
    expect(chunk).not.toContain('admin-comments-dialog-' + submissionId);
  });
});

// ---------------------------------------------------------------------------
// AC6: Comments page and nav tab gone
// ---------------------------------------------------------------------------
describe('AC6: the admin Comments page is gone', () => {
  it('GET /admin/comments returns a real 404, not a fall-through redirect', async () => {
    const res = await adminAgent.get('/admin/comments');
    expect(res.status).toBe(404);
    expect(res.headers.location).toBeUndefined();
  });

  it('no admin page links to a Comments tab', async () => {
    const res = await adminAgent.get('/admin');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('href="/admin/comments"');
    expect(res.text).not.toContain('>Comments<');
  });
});

// ---------------------------------------------------------------------------
// AC7: the per-photo points route is retired
// ---------------------------------------------------------------------------
describe('AC7: POST /admin/photos/:id/points is retired', () => {
  it('returns a real 404 for an existing submission id, and leaves photo_bonus untouched', async () => {
    const taskId = insertTask('AC7 Task');
    const guestId = insertGuest('AC7 Guest', 'ac7-684-guest');
    const submissionId = insertSubmission({
      guestId,
      taskId,
      photoPath: 'ac7-684.jpg',
      thumbPath: 'ac7-684-t.jpg',
    });
    db.prepare('UPDATE submissions SET photo_bonus = 3 WHERE id = ?').run(submissionId);

    const res = await adminAgent
      .post('/admin/photos/' + submissionId + '/points')
      .type('form')
      .send({ bonus: '9' });
    expect(res.status).toBe(404);
    expect(res.headers.location).toBeUndefined();

    const row = db.prepare('SELECT photo_bonus FROM submissions WHERE id = ?').get(submissionId);
    expect(row.photo_bonus).toBe(3);

    // The pre-existing bonus still counts — the feed's points line still
    // reflects it (scoring.js still reads photo_bonus; only this write path
    // is gone).
    const page = await adminAgent.get('/admin/photos');
    const chunk = feedCardChunk(page.text, submissionId);
    expect(chunk).toContain('3 points');
  });

  it('returns 404 for an unknown submission id too (blanket retirement, not a not-found guard)', async () => {
    const res = await adminAgent
      .post('/admin/photos/999999/points')
      .type('form')
      .send({ bonus: '1' });
    expect(res.status).toBe(404);
  });
});
