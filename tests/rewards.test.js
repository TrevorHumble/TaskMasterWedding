// tests/rewards.test.js
// Issue #255: the task-complete success card + badge-earned MODAL. Covers:
//   AC1 — a completion that earns NO new badge: the inline card contains
//         "Task complete!", "+1 point", and the guest's fresh total ("5
//         points" for a guest at 4 points completing one task), AND the page
//         contains no `badge-dialog` element
//   AC2 — crossing a badge threshold (BLOOM at 5 completions) renders a
//         `<dialog class="badge-dialog">` whose text includes the badge name
//         "First Bloom", the title "First Bloom!", and the catalog
//         description "Completed 5 tasks.", with NO points language inside
//         that dialog; the inline card still shows "+1 point". A following
//         non-threshold completion shows neither the name nor the dialog.
//   AC3 — submissions.submitPhoto's return value carries the newly-earned
//         badge id(s) on the crossing call, then an empty list on the next
//         (unit-level, direct calls, no HTTP)
//   AC4 — a replace (status 'replaced'/'replaced_hidden') keeps the existing
//         plain flash — neither the inline success card nor the badge dialog
//   AC5 — the badge-pop/sway/ring/spark bloom keyframes are gated under
//         prefers-reduced-motion: no-preference (structural, CSS source check)
//   AC6 — the modal is a native <dialog> opened via showModal() (structural:
//         src/views/task.ejs and src/public/js/badge-moment.js source check)
//   AC7 — src/public/js/upload.js submits with fetch(..., { redirect: 'manual' })
//         and navigates via form.getAttribute('action') rather than relying on
//         a followed redirect, so the one-shot reward cookie is not silently
//         consumed by a discarded fetch response (structural, JS source check)
//
// REQUIRE ORDER: config / db / services are required only AFTER loadApp() sets
// DATA_DIR / DB_PATH, matching tests/submission-intake.test.js and
// tests/per-photo-points.test.js.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const sharp = require('sharp');
const { loadApp, signInGuest } = require('./helpers/testApp');

let app;
let db;
let config;
let submissions;
let scoring;
let uploadsDir;
let validJpeg;

beforeAll(async () => {
  // A tiny real JPEG so photos.makeThumb (sharp) succeeds on every submit
  // below — same fixture tests/submission-intake.test.js uses.
  validJpeg = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .jpeg()
    .toBuffer();

  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;

  config = require('../config');
  submissions = require('../src/services/submissions');
  scoring = require('../src/services/scoring');
  uploadsDir = config.UPLOADS_DIR;
});

function insertGuest(token) {
  return db
    .prepare(`INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)`)
    .run(token, 'Rewards Guest').lastInsertRowid;
}

function insertTask(title) {
  return db.prepare(`INSERT INTO tasks (title, is_active) VALUES (?, 1)`).run(title)
    .lastInsertRowid;
}

// Seed `n` ALREADY-VISIBLE completed-task rows for a guest directly (bypassing
// submitPhoto/recompute), so a test can put a guest at an exact
// completed-count baseline before driving the ONE submission under test
// through the real path (route or submitPhoto).
function seedCompletedTasks(guestId, n, labelPrefix) {
  for (let i = 0; i < n; i++) {
    const taskId = insertTask(`${labelPrefix} seed task ${i}`);
    db.prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, 0)`
    ).run(guestId, taskId, `${labelPrefix}-seed-${i}.jpg`, `${labelPrefix}-seed-${i}t.jpg`);
  }
}

async function signInGuestAgent(token) {
  // The old per-guest /j/:token magic link was retired (routes/auth.js) — it
  // now just redirects to /join and signs no one in. signInGuest crafts the
  // signed gsid cookie directly, the same way the other route tests
  // authenticate (tests/helpers/testApp.js).
  const agent = request.agent(app);
  signInGuest(app, token, agent);
  return agent;
}

// Write a real JPEG into UPLOADS_DIR (mirroring what multer's disk storage
// would already have done) and return the { filename, path } descriptor
// submitPhoto expects — same helper shape as tests/submission-intake.test.js.
function writeOriginal(filename) {
  const absPath = path.join(uploadsDir, filename);
  fs.writeFileSync(absPath, validJpeg);
  return { filename, path: absPath };
}

// Pull just the badge-earned dialog's own markup out of a full page body, or
// null if it isn't present — lets a test assert on text INSIDE the dialog
// (e.g. "no points language") without a stray match elsewhere on the page
// (the inline success card legitimately says "+1 point" on the same page).
function extractBadgeDialog(html) {
  const match = html.match(/<dialog class="badge-dialog"[\s\S]*?<\/dialog>/);
  return match ? match[0] : null;
}

// ---------------------------------------------------------------------------
// AC1
// ---------------------------------------------------------------------------
it('AC1: a completion earning NO new badge shows "Task complete!" / "+1 point" / "5 points", and no badge-dialog', async () => {
  // A "leader" guest with more visible task submissions than this test's
  // guest will ever reach (2). Historically (issue #80) this kept a
  // transferable "most submissions" badge from tying and non-deterministically
  // landing on the guest under test; that badge (MOSTPHOTOS) was retired by
  // #711 and the transferable registry is now empty, so this setup is inert
  // but kept for parity with AC3's guard below.
  const leaderGuestId = insertGuest(`rewards-ac1-leader-${crypto.randomUUID()}`);
  seedCompletedTasks(leaderGuestId, 3, 'ac1-leader');

  const token = `rewards-ac1-${crypto.randomUUID()}`;
  const guestId = insertGuest(token);
  // 4 BONUS points (no seeded completions) puts the guest at 4 points WITHOUT
  // crossing BLOOM — the auto-badge threshold is 5 COMPLETED TASKS, not 5
  // points, so the one completion under test brings completed-task count to
  // only 1, nowhere near the threshold. Getting to "4 points" via seeded
  // completions instead (as AC2 does) would earn BLOOM on this very
  // submission and silently turn this "no new badge" scenario into AC2's.
  scoring.addBonusPoints(guestId, 4);
  const taskId = insertTask('AC1 task under test');

  const agent = await signInGuestAgent(token);
  const res = await agent
    .post(`/tasks/${taskId}/submit`)
    .attach('photo', validJpeg, { filename: 'ac1.jpg', contentType: 'image/jpeg' });
  expect([302, 303]).toContain(res.status);

  const page = await agent.get(res.headers.location);
  expect(page.text).toContain('Task complete!');
  expect(page.text).toContain('+1 point');
  // Bound to the guest's fresh total (1 completion + 4 bonus = 5), not a
  // stray "5" elsewhere on the page — an inversion-sensitive check: a
  // stale/wrong total (e.g. still "4 points") would fail this.
  expect(page.text).toContain('5 points');
  // AC1's other half: no badge modal at all for a no-badge completion.
  expect(page.text).not.toContain('badge-dialog');
});

// ---------------------------------------------------------------------------
// AC2
// ---------------------------------------------------------------------------
it('AC2: crossing the BLOOM threshold renders a badge-dialog with the name + heading and no points inside it; a non-threshold submission shows neither', async () => {
  const token = `rewards-ac2-${crypto.randomUUID()}`;
  const guestId = insertGuest(token);
  seedCompletedTasks(guestId, 4, 'ac2'); // guest is at 4 completions
  const fifthTaskId = insertTask('AC2 fifth task');

  const agent = await signInGuestAgent(token);
  const fifthRes = await agent
    .post(`/tasks/${fifthTaskId}/submit`)
    .attach('photo', validJpeg, { filename: 'ac2-fifth.jpg', contentType: 'image/jpeg' });
  expect([302, 303]).toContain(fifthRes.status);

  const fifthPage = await agent.get(fifthRes.headers.location);
  // The inline card still carries the point (points live ONLY there).
  expect(fifthPage.text).toContain('+1 point');

  const dialog = extractBadgeDialog(fifthPage.text);
  expect(dialog).not.toBeNull();
  expect(dialog).toContain('First Bloom');
  expect(dialog).toContain('First Bloom!');
  expect(dialog).toContain('Completed 5 tasks.');
  // No points language belongs inside the badge dialog (AC2) — an
  // inversion-sensitive check: if the inline card's markup were nested
  // inside the dialog by mistake, this would catch it.
  expect(dialog).not.toContain('+1 point');
  expect(dialog).not.toContain('points');

  // A SIXTH completion crosses no new threshold (BOUQUET is at 10) — neither
  // the badge name nor a badge-dialog element must appear. Inversion check:
  // if the before/after diff were dropped in favor of "list every badge the
  // guest holds," BLOOM would wrongly still show up here too.
  const sixthTaskId = insertTask('AC2 sixth task');
  const sixthRes = await agent
    .post(`/tasks/${sixthTaskId}/submit`)
    .attach('photo', validJpeg, { filename: 'ac2-sixth.jpg', contentType: 'image/jpeg' });
  expect([302, 303]).toContain(sixthRes.status);

  const sixthPage = await agent.get(sixthRes.headers.location);
  expect(sixthPage.text).not.toContain('First Bloom');
  expect(sixthPage.text).not.toContain('badge-dialog');
});

// ---------------------------------------------------------------------------
// AC3 (unit-level: direct submitPhoto calls, no HTTP)
// ---------------------------------------------------------------------------
it('AC3: submitPhoto returns newBadgeIds containing BLOOM on the threshold-crossing call, then empty on the next', async () => {
  // A "leader" guest with more visible task submissions than this test's
  // guest will ever reach (6). Historically (issue #80) this kept a
  // transferable "most submissions" badge from tying and non-deterministically
  // leaking into the "empty on the next call" assertion below; that badge
  // (MOSTPHOTOS) was retired by #711 and the transferable registry is now
  // empty, so this setup is inert but kept for parity with AC1's guard above.
  const leaderGuestId = insertGuest(`rewards-ac3-leader-${crypto.randomUUID()}`);
  seedCompletedTasks(leaderGuestId, 20, 'ac3-leader');

  const guestId = insertGuest(`rewards-ac3-${crypto.randomUUID()}`);
  seedCompletedTasks(guestId, 4, 'ac3');

  const fifthTaskId = insertTask('AC3 fifth task');
  const fifthFile = writeOriginal('ac3-fifth.jpg');
  const fifthResult = await submissions.submitPhoto({
    guestId,
    taskId: fifthTaskId,
    file: fifthFile,
    caption: '',
  });
  expect(fifthResult.status).toBe('created');
  expect(fifthResult.newBadgeIds).toContain('BLOOM');
  expect(fifthResult.pointsTotal).toBe(5);

  const sixthTaskId = insertTask('AC3 sixth task');
  const sixthFile = writeOriginal('ac3-sixth.jpg');
  const sixthResult = await submissions.submitPhoto({
    guestId,
    taskId: sixthTaskId,
    file: sixthFile,
    caption: '',
  });
  expect(sixthResult.status).toBe('created');
  expect(sixthResult.newBadgeIds).toEqual([]);
});

// ---------------------------------------------------------------------------
// AC4
// ---------------------------------------------------------------------------
it('AC4: a replace (not a new completion) keeps the plain "Photo replaced!" flash, not the success card', async () => {
  const token = `rewards-ac4-${crypto.randomUUID()}`;
  insertGuest(token);
  const taskId = insertTask('AC4 task');
  const agent = await signInGuestAgent(token);

  const firstRes = await agent
    .post(`/tasks/${taskId}/submit`)
    .attach('photo', validJpeg, { filename: 'ac4-first.jpg', contentType: 'image/jpeg' });
  expect([302, 303]).toContain(firstRes.status);

  const replaceRes = await agent
    .post(`/tasks/${taskId}/submit`)
    .attach('photo', validJpeg, { filename: 'ac4-second.jpg', contentType: 'image/jpeg' });
  expect([302, 303]).toContain(replaceRes.status);

  const page = await agent.get(replaceRes.headers.location);
  expect(page.text).not.toContain('Task complete!');
  expect(page.text).not.toContain('badge-dialog');
  expect(page.text).toContain('Photo replaced!');
});

it('AC4b: replaced_hidden (resubmit onto a taken-down row) keeps its plain flash, not the success card', async () => {
  const token = `rewards-ac4b-${crypto.randomUUID()}`;
  const guestId = insertGuest(token);
  const taskId = insertTask('AC4b task');
  const agent = await signInGuestAgent(token);

  const firstRes = await agent
    .post(`/tasks/${taskId}/submit`)
    .attach('photo', validJpeg, { filename: 'ac4b-first.jpg', contentType: 'image/jpeg' });
  expect([302, 303]).toContain(firstRes.status);

  // Host takes the submission down before the guest resubmits.
  db.prepare(`UPDATE submissions SET taken_down = 1 WHERE guest_id = ? AND task_id = ?`).run(
    guestId,
    taskId
  );

  const resubmitRes = await agent
    .post(`/tasks/${taskId}/submit`)
    .attach('photo', validJpeg, { filename: 'ac4b-second.jpg', contentType: 'image/jpeg' });
  expect([302, 303]).toContain(resubmitRes.status);

  const page = await agent.get(resubmitRes.headers.location);
  expect(page.text).not.toContain('Task complete!');
  expect(page.text).not.toContain('badge-dialog');
  expect(page.text).toContain('Photo received — it will appear once the hosts approve it.');
});

// ---------------------------------------------------------------------------
// AC5 (structural: CSS source, not rendered output)
// ---------------------------------------------------------------------------
it.each(['badge-pop', 'badge-sway', 'badge-ring', 'spark'])(
  'AC5: @keyframes %s is nested inside a prefers-reduced-motion: no-preference media block',
  (keyframeName) => {
    const css = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'public', 'css', 'theme.css'),
      'utf8'
    );

    const keyframeIndex = css.indexOf(`@keyframes ${keyframeName}`);
    expect(keyframeIndex).toBeGreaterThan(-1);

    const mediaIndex = css.lastIndexOf(
      '@media (prefers-reduced-motion: no-preference)',
      keyframeIndex
    );
    expect(mediaIndex).toBeGreaterThan(-1);

    // If a fully-closed media block sat between the query and the keyframes
    // rule, the brace counts in that slice would balance (equal opens/closes)
    // — proving the keyframe is NOT actually nested inside THIS query, just
    // sitting unguarded after it. An unbalanced (more opens than closes)
    // count is what nesting looks like.
    const between = css.slice(mediaIndex, keyframeIndex);
    const opens = (between.match(/\{/g) || []).length;
    const closes = (between.match(/\}/g) || []).length;
    expect(opens).toBeGreaterThan(closes);
  }
);

// ---------------------------------------------------------------------------
// AC6 (structural: the modal is a native <dialog> opened via showModal())
// ---------------------------------------------------------------------------
it('AC6: task.ejs renders a <dialog class="badge-dialog"> and badge-moment.js calls showModal()', () => {
  const viewSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'views', 'task.ejs'),
    'utf8'
  );
  expect(viewSource).toMatch(/<dialog\s+class="badge-dialog"/);

  const scriptSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'public', 'js', 'badge-moment.js'),
    'utf8'
  );
  expect(scriptSource).toContain('.showModal()');
});

// ---------------------------------------------------------------------------
// AC7 (structural: the submit fetch must not let the browser transparently
// follow the server's redirect, or the one-shot reward cookie gets consumed
// by a discarded response before the real page navigation ever sees it)
// ---------------------------------------------------------------------------
it("AC7: upload.js submits with fetch(..., { redirect: 'manual' }) and navigates via form.getAttribute('action')", () => {
  const scriptSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'public', 'js', 'upload.js'),
    'utf8'
  );

  // Inversion-sensitive: a plain `fetch(form.action, {...})` with no
  // redirect option (the browser default 'follow') would silently eat the
  // reward cookie on the discarded intermediate response — this asserts the
  // literal opt-out is present, not just that fetch is called somewhere.
  expect(scriptSource).toMatch(/redirect:\s*'manual'/);

  // The real navigation must be driven from the form's own action attribute
  // (with the /submit suffix stripped), not by trusting a followed redirect
  // response the code above explicitly declines to follow.
  expect(scriptSource).toContain("form.getAttribute('action').replace(/\\/submit$/, '')");
});

// ---------------------------------------------------------------------------
// Double-tap precedence: a guest tapping submit twice near-simultaneously can
// land both the taskComplete cookie (created) and a "Photo replaced!" flash
// cookie (replaced) on the same redirected GET. The success card must
// supersede the plain flash so the guest never sees both at once.
// ---------------------------------------------------------------------------
it('the success card supersedes a concurrent plain flash (double-tap race)', async () => {
  const signature = require('cookie-signature');
  const token = `rewards-race-${crypto.randomUUID()}`;
  insertGuest(token);
  const taskId = insertTask('race task');

  // Craft both signed cookies the way cookie-parser verifies them.
  const sign = (val) => 's:' + signature.sign(val, config.COOKIE_SECRET);
  const gsid = sign(token);
  const taskComplete = sign(JSON.stringify({ points: 5, newBadgeIds: [] }));
  const flash = sign(JSON.stringify({ type: 'ok', msg: 'Photo replaced!' }));

  const page = await request(app)
    .get(`/tasks/${taskId}`)
    .set(
      'Cookie',
      [
        `gsid=${encodeURIComponent(gsid)}`,
        `taskComplete=${encodeURIComponent(taskComplete)}`,
        `flash=${encodeURIComponent(flash)}`,
      ].join('; ')
    );

  expect(page.status).toBe(200);
  // Card wins…
  expect(page.text).toContain('Task complete!');
  // …and the concurrent plain flash is dropped.
  expect(page.text).not.toContain('Photo replaced!');
  expect(page.text).not.toContain('flash-ok');
});
