// tests/photo-owner-menu.test.js
// Covers issue #387 acceptance criteria — a guest editing the caption of, or
// taking down, their OWN photo via the ⋯ menu:
//   AC1 — owner edits caption -> redirect, caption trimmed/stored; a
//         600-character input is stored truncated to 500
//   AC2 — a non-owner's caption edit gets 403; the caption is unchanged
//   AC3 — owner take-down -> taken_down=1, gone from GET /feed and
//         GET /gallery bodies, badges recomputed (hideSubmission ran)
//   AC4 — a non-owner's take-down attempt gets 403; taken_down stays 0
//   AC5 — render matrix: the feed shows photo-owner-menu inside the owner's
//         own card and NOT inside another guest's card; the partial rendered
//         with guest=null emits no photo-owner-menu markup at all
//   AC7 — structural: the partial has exactly the Edit-caption trigger + a
//         Delete form (method=post, action /p/<id>/delete), no replace
//         control, and a per-submission caption-dialog-<submission_id> id
//
// Fixture/seeding mirrors tests/feed-comment-delete.test.js.
//
// REQUIRE ORDER: config / db / app are required only AFTER loadApp() sets
// DATA_DIR / DB_PATH. Do not hoist requires above the loadApp() call.
'use strict';

const request = require('supertest');
const ejs = require('ejs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { loadApp, signInGuest } = require('./helpers/testApp');

let app;
let db;

beforeAll(async () => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
});

/**
 * Insert a guest row with the given token and return { guestId, agent } where
 * agent is a supertest agent already signed in as that guest (same pattern
 * tests/feed-comment-delete.test.js uses).
 */
async function signedInGuest(token, name) {
  const guestId = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run(token, name).lastInsertRowid;
  const agent = request.agent(app);
  signInGuest(app, token, agent);
  return { guestId, agent };
}

/** Insert a task + submission owned by `authorGuestId` and return its id. */
function seedSubmission(authorGuestId, opts = {}) {
  const taskId = db
    .prepare(`INSERT INTO tasks (title) VALUES (?)`)
    .run(opts.taskTitle || 'Owner Menu Test Task').lastInsertRowid;
  const submissionId = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, caption, taken_down)
       VALUES (?, ?, ?, ?, ?, 0)`
    )
    .run(
      authorGuestId,
      taskId,
      opts.photoPath || 'owner-menu-test.jpg',
      opts.thumbPath || 'owner-menu-test-thumb.jpg',
      opts.caption || 'old'
    ).lastInsertRowid;
  return submissionId;
}

function getSubmission(submissionId) {
  return db.prepare(`SELECT * FROM submissions WHERE id = ?`).get(submissionId);
}

// ---------------------------------------------------------------------------
// AC1 — owner edits their own caption; trimmed and capped at 500.
// ---------------------------------------------------------------------------
it('AC1: the owning guest edits their caption -> redirect, caption trimmed and stored', async () => {
  const author = await signedInGuest('own-ac1-author', 'AC1 Author');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'own-ac1.jpg',
    thumbPath: 'own-ac1t.jpg',
  });

  const res = await author.agent
    .post('/p/' + submissionId + '/caption')
    .type('form')
    .send({ caption: '  a new caption  ' });
  expect([302, 303]).toContain(res.status);

  const row = getSubmission(submissionId);
  expect(row.caption).toBe('a new caption');
});

it('AC1: a 600-character caption is stored truncated to 500 characters', async () => {
  const author = await signedInGuest('own-ac1b-author', 'AC1b Author');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'own-ac1b.jpg',
    thumbPath: 'own-ac1bt.jpg',
  });
  const longCaption = 'x'.repeat(600);

  const res = await author.agent
    .post('/p/' + submissionId + '/caption')
    .type('form')
    .send({ caption: longCaption });
  expect([302, 303]).toContain(res.status);

  const row = getSubmission(submissionId);
  expect(row.caption.length).toBe(500);
  expect(row.caption).toBe('x'.repeat(500));
});

// ---------------------------------------------------------------------------
// AC2 — a non-owner's caption edit is refused; the caption is unchanged.
// ---------------------------------------------------------------------------
it("AC2: a non-owner editing another guest's caption gets 403 and the caption is unchanged", async () => {
  const author = await signedInGuest('own-ac2-author', 'AC2 Author');
  const attacker = await signedInGuest('own-ac2-attacker', 'AC2 Attacker');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'own-ac2.jpg',
    thumbPath: 'own-ac2t.jpg',
    caption: 'untouched',
  });

  const res = await attacker.agent
    .post('/p/' + submissionId + '/caption')
    .type('form')
    .send({ caption: 'hacked' });
  expect(res.status).toBe(403);

  const row = getSubmission(submissionId);
  expect(row.caption).toBe('untouched');
});

// ---------------------------------------------------------------------------
// AC3 — owner takes down their own photo: taken_down flips, it disappears
// from /feed and /gallery, and badges are recomputed (hideSubmission ran).
// ---------------------------------------------------------------------------
it('AC3: the owning guest takes down their own photo -> taken_down=1, gone from /feed and /gallery', async () => {
  const author = await signedInGuest('own-ac3-author', 'AC3 Author');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'own-ac3.jpg',
    thumbPath: 'own-ac3t.jpg',
  });

  const res = await author.agent.post('/p/' + submissionId + '/delete').type('form');
  expect([302, 303]).toContain(res.status);

  const row = getSubmission(submissionId);
  expect(row.taken_down).toBe(1);

  const feedRes = await author.agent.get('/feed');
  expect(feedRes.text).not.toContain('own-ac3t.jpg');

  const galleryRes = await author.agent.get('/gallery');
  expect(galleryRes.text).not.toContain('own-ac3t.jpg');
});

it('AC3: take-down recomputes the owning guest badges (hideSubmission ran, not a raw UPDATE)', async () => {
  // Required lazily (not hoisted to the top of the file): scoring.js reads
  // db.js at require time, which in turn reads config for DATA_DIR/DB_PATH —
  // safe here because loadApp() in beforeAll already set those env vars and
  // Node's require cache means this resolves to the SAME db.js instance the
  // app under test uses.
  const scoring = require('../src/services/scoring');
  const author = await signedInGuest('own-ac3b-author', 'AC3b Author');

  // BLOOM grants at 5 completed (visible, task-linked) submissions
  // (src/services/scoring.js BADGE_THRESHOLDS). Seed exactly 5 so the guest
  // sits right at the threshold, then take one down through the route —
  // completed drops to 4, and BLOOM should be revoked ONLY if the route ran
  // photos.hideSubmission's recompute transaction, not a raw UPDATE (a raw
  // UPDATE would flip taken_down but leave the stale BLOOM grant in place).
  const submissionIds = [];
  for (let i = 0; i < 5; i++) {
    submissionIds.push(
      seedSubmission(author.guestId, {
        taskTitle: 'AC3b Task ' + i,
        photoPath: 'own-ac3b-' + i + '.jpg',
        thumbPath: 'own-ac3b-' + i + 't.jpg',
      })
    );
  }
  // Recompute once up front (mirroring what submitPhoto would have done on
  // each real upload) so BLOOM is actually granted before the takedown.
  scoring.recomputeAfterSubmissionChange(author.guestId);
  const beforeCodes = scoring.getGuestBadges(author.guestId).map((b) => b.code);
  expect(beforeCodes).toContain('BLOOM');

  const res = await author.agent.post('/p/' + submissionIds[0] + '/delete').type('form');
  expect([302, 303]).toContain(res.status);

  const row = getSubmission(submissionIds[0]);
  expect(row.taken_down).toBe(1);

  const afterCodes = scoring.getGuestBadges(author.guestId).map((b) => b.code);
  expect(afterCodes).not.toContain('BLOOM');
});

// ---------------------------------------------------------------------------
// AC4 — a non-owner's take-down attempt is refused; taken_down stays 0.
// ---------------------------------------------------------------------------
it("AC4: a non-owner taking down another guest's photo gets 403 and taken_down stays 0", async () => {
  const author = await signedInGuest('own-ac4-author', 'AC4 Author');
  const attacker = await signedInGuest('own-ac4-attacker', 'AC4 Attacker');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'own-ac4.jpg',
    thumbPath: 'own-ac4t.jpg',
  });

  const res = await attacker.agent.post('/p/' + submissionId + '/delete').type('form');
  expect(res.status).toBe(403);

  const row = getSubmission(submissionId);
  expect(row.taken_down).toBe(0);
});

// ---------------------------------------------------------------------------
// AC5 — render matrix: the menu shows only inside the owner's own card.
// ---------------------------------------------------------------------------
it("AC5: the feed shows photo-owner-menu inside the viewing guest's own card, not another guest's", async () => {
  const owner = await signedInGuest('own-ac5-owner', 'AC5 Owner');
  const other = await signedInGuest('own-ac5-other', 'AC5 Other');
  const ownedSubmissionId = seedSubmission(owner.guestId, {
    photoPath: 'own-ac5-mine.jpg',
    thumbPath: 'own-ac5-minet.jpg',
  });
  const otherSubmissionId = seedSubmission(other.guestId, {
    photoPath: 'own-ac5-theirs.jpg',
    thumbPath: 'own-ac5-theirst.jpg',
  });

  const res = await owner.agent.get('/feed');
  const dom = new JSDOM(res.text);

  const ownCard = dom.window.document.getElementById('photo-' + ownedSubmissionId);
  expect(ownCard).not.toBeNull();
  expect(ownCard.querySelector('.photo-owner-menu')).not.toBeNull();

  const otherCard = dom.window.document.getElementById('photo-' + otherSubmissionId);
  expect(otherCard).not.toBeNull();
  expect(otherCard.querySelector('.photo-owner-menu')).toBeNull();
});

it('AC5: the partial rendered with guest=null emits no photo-owner-menu markup at all', async () => {
  const partialPath = path.join(
    __dirname,
    '..',
    'src',
    'views',
    'partials',
    'photo-owner-menu.ejs'
  );
  const html = await ejs.renderFile(partialPath, {
    guest: null,
    photo: { submission_id: 1, guest_id: 1, caption: 'whatever' },
  });
  expect(html.trim()).toBe('');
  expect(html).not.toContain('photo-owner-menu');
});

// ---------------------------------------------------------------------------
// AC7 — structural: exactly Edit-caption + Delete, no replace control, and a
// per-submission caption dialog id.
// ---------------------------------------------------------------------------
it('AC7: the partial renders exactly Edit-caption + Delete, no replace control, per-submission dialog id', async () => {
  const partialPath = path.join(
    __dirname,
    '..',
    'src',
    'views',
    'partials',
    'photo-owner-menu.ejs'
  );
  const submissionId = 4242;
  const html = await ejs.renderFile(partialPath, {
    guest: { id: 7 },
    photo: { submission_id: submissionId, guest_id: 7, caption: 'hello' },
    captionMaxLength: 500,
  });
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const menu = doc.querySelector('.photo-owner-menu');
  expect(menu).not.toBeNull();

  const editTrigger = menu.querySelector('[data-edit-caption="' + submissionId + '"]');
  expect(editTrigger).not.toBeNull();

  const deleteForm = menu.querySelector('form.photo-owner-delete-form');
  expect(deleteForm).not.toBeNull();
  expect(deleteForm.getAttribute('method')).toBe('post');
  expect(deleteForm.getAttribute('action')).toBe('/p/' + submissionId + '/delete');

  // Exactly two menu-item controls: Edit caption + Delete, no third (replace).
  const menuItems = menu.querySelectorAll('.photo-owner-menu-item');
  expect(menuItems.length).toBe(2);
  const labels = Array.from(menuItems).map((el) => el.textContent.trim());
  expect(labels).toContain('Edit caption');
  expect(labels).toContain('Delete');
  expect(labels.some((l) => /replace/i.test(l))).toBe(false);

  const dialog = doc.getElementById('caption-dialog-' + submissionId);
  expect(dialog).not.toBeNull();
  expect(dialog.querySelector('form[action="/p/' + submissionId + '/caption"]')).not.toBeNull();
});
