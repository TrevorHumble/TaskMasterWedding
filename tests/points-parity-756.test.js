// tests/points-parity-756.test.js
// Issue #756: one photo, one number — the success card, the feed, and the
// slideshow all report a photo's points INCLUDING its banked one-day-only
// bonus (submissions.bonus_amount, issue #753), never just worth (+ the
// admin photo_bonus alone). Covers:
//   AC1 — the success card reads what was actually banked: "+5 points" for a
//         worth-2/bonus-3 task submitted ON its date, "+2 points" (never "+5")
//         for the same task submitted AFTER its date — and the SAME line's
//         grand-total half still reads the guest's real running total, from a
//         non-zero starting score (proves the earned figure was not written
//         into the wrong key)
//   AC2 — the feed's per-photo points value is 5 for the on-day photo above
//   AC3 — the slideshow ranks a task group by that SAME bonus-inclusive
//         points value (points-first, likes as tiebreak) — proven with a
//         differential setup rather than a direct `points` assertion,
//         because buildSlideshowSection's sequence-item contract
//         (src/services/feed.js, restated at its own :552) carries no
//         `points` key at all — the rank metric is consumed to sort and then
//         discarded, so there is no value on the returned object an equality
//         assertion could target. A forgotten bonus_amount SELECT would
//         silently default to 0 via photoPoints's own default parameter
//         (never throws, never NaNs), so only an outcome that depends on
//         which photo WINS the ranking can catch it
//   also: scoring.photoPoints's own three-term arithmetic, direct unit checks
//
// "Today" for the on-day submit route comes from
// src/services/event-days.js's eventLocalDateString(getEventConfig().timezone)
// — monkeypatched to a fixed date for this file's duration, the same
// shared-module-object technique tests/oneday-guest-surface.test.js (#754)
// and tests/oneday-challenge-engine.test.js (#753) already use.
//
// REQUIRE ORDER: config/db/services are required only AFTER loadApp() sets
// DATA_DIR/DB_PATH — see tests/helpers/testApp.js.
'use strict';

const sharp = require('sharp');
const crypto = require('crypto');
const { loadApp, signInGuest } = require('./helpers/testApp');

let app;
let db;
let scoring;
let feed;
let eventDaysSvc;
let validJpeg;

const FIXED_TODAY = '2026-08-07';
const YESTERDAY = '2026-08-06';

beforeAll(async () => {
  validJpeg = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 5, g: 5, b: 5 } },
  })
    .jpeg()
    .toBuffer();

  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;

  scoring = require('../src/services/scoring');
  feed = require('../src/services/feed');
  eventDaysSvc = require('../src/services/event-days');
});

let originalEventLocalDateString;
beforeAll(() => {
  // Shared-module-object monkeypatch (see file header): guest.js/submissions.js
  // hold a reference to this same module object, so patching the property
  // here takes effect for every route/service under test without re-requiring
  // anything.
  originalEventLocalDateString = eventDaysSvc.eventLocalDateString;
  eventDaysSvc.eventLocalDateString = () => FIXED_TODAY;
});
afterAll(() => {
  eventDaysSvc.eventLocalDateString = originalEventLocalDateString;
});

let seq = 0;

function insertGuest({ bonusPoints = 0 } = {}) {
  seq += 1;
  const token = `points-parity-guest-${seq}-${crypto.randomUUID()}`;
  const id = db
    .prepare(`INSERT INTO guests (token, name, bonus_points, onboarded) VALUES (?, ?, ?, 1)`)
    .run(token, 'Points Parity Guest', bonusPoints).lastInsertRowid;
  return { id, token };
}

function insertTask({ title, worth = 1, specialDate = null, specialBonus = null } = {}) {
  seq += 1;
  const mode = specialDate ? 'oneday' : 'none';
  return db
    .prepare(
      `INSERT INTO tasks (title, worth, special_mode, special_date, special_bonus)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(title || `Points Parity Task ${seq}`, worth, mode, specialDate, specialBonus)
    .lastInsertRowid;
}

// ---------------------------------------------------------------------------
// scoring.photoPoints: direct unit checks on the three-term formula (issue
// #756 extends this from two terms to three).
// ---------------------------------------------------------------------------
describe('scoring.photoPoints sums worth + photoBonus + bonusAmount', () => {
  it('all three terms combine', () => {
    expect(scoring.photoPoints(0, 2, 3)).toBe(5);
    expect(scoring.photoPoints(1, 2, 3)).toBe(6);
  });

  it('worth and bonusAmount both default to 0 (a memory / a one-arg caller)', () => {
    expect(scoring.photoPoints(4)).toBe(4);
    expect(scoring.photoPoints(0, 2)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AC1: the success card.
// ---------------------------------------------------------------------------
describe('AC1: the success card reports the banked amount, and the grand total stays the real total', () => {
  it('a worth-2/bonus-3 task submitted ON its date reads "+5 points" and the guest\'s real running total', async () => {
    // 17 starting points from bonus_points alone (no other submissions), so
    // the grand-total half of the line proves the earned figure (5) was not
    // written into the wrong key — a guest at 17 who earns 5 must read 22,
    // never 5 (issue #756 AC1's central warning).
    const guest = insertGuest({ bonusPoints: 17 });
    // An ordinary (non-challenge) decoy task the guest never completes.
    // scoring.js's COMPLETIONIST metric excludes challenge tasks
    // (tasks.challengeTaskWhere) from its "every active task" set — with NO
    // ordinary task in the DB at all, that set is vacuously empty and the
    // guest would earn COMPLETIONIST's +1 on this very submission, pushing
    // the grand total to 23 and breaking this test's own arithmetic. This
    // decoy keeps the set non-vacuous and unmet.
    insertTask({ title: 'Onday Decoy Ordinary Task', worth: 1 });
    const taskId = insertTask({
      title: 'Onday Success Card Task',
      worth: 2,
      specialDate: FIXED_TODAY,
      specialBonus: 3,
    });

    const agent = signInGuest(app, guest.token);
    const res = await agent
      .post(`/tasks/${taskId}/submit`)
      .attach('photo', validJpeg, { filename: 'onday-success.jpg', contentType: 'image/jpeg' });
    expect([302, 303]).toContain(res.status);

    const page = await agent.get(res.headers.location);
    expect(page.text).toContain('Task complete!');
    expect(page.text).toContain('+5 points');
    expect(page.text).not.toContain('+2 points');
    expect(page.text).toContain("you're at 22 points");
  });

  it('the SAME task submitted AFTER its date reads "+2 points", never "+5" (worth + special_bonus unconditionally)', async () => {
    const guest = insertGuest();
    // Same vacuous-COMPLETIONIST guard as the test above.
    insertTask({ title: 'Offday Decoy Ordinary Task', worth: 1 });
    const taskId = insertTask({
      title: 'Offday Success Card Task',
      worth: 2,
      specialDate: YESTERDAY, // already passed: unsealed (reachable), but not "on day"
      specialBonus: 3,
    });

    const agent = signInGuest(app, guest.token);
    const res = await agent
      .post(`/tasks/${taskId}/submit`)
      .attach('photo', validJpeg, { filename: 'offday-success.jpg', contentType: 'image/jpeg' });
    expect([302, 303]).toContain(res.status);

    const page = await agent.get(res.headers.location);
    expect(page.text).toContain('Task complete!');
    expect(page.text).toContain('+2 points');
    expect(page.text).not.toContain('+5 points');
    expect(page.text).toContain("you're at 2 points");
  });
});

// ---------------------------------------------------------------------------
// AC2: the feed.
// ---------------------------------------------------------------------------
describe('AC2: the feed reports the same figure the leaderboard credits', () => {
  it('an on-day worth-2/bonus_amount-3 submission shows feed points 5', async () => {
    const guest = insertGuest();
    const taskId = insertTask({ title: 'Feed Parity Task', worth: 2 });
    const submissionId = db
      .prepare(
        `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, bonus_amount)
         VALUES (?, ?, ?, ?, 0, ?)`
      )
      .run(guest.id, taskId, 'feed-parity.jpg', 'feed-parity-thumb.jpg', 3).lastInsertRowid;

    // The single-authority total for this photo (worth 2 + bonus_amount 3) is
    // the figure the feed must match.
    expect(scoring.getPoints(guest.id)).toBe(5);

    const agent = signInGuest(app, guest.token);
    const res = await agent.get('/feed');
    expect(res.status).toBe(200);

    // Isolate this photo's own feed article (same windowing pattern as
    // tests/per-photo-points.test.js's pointsInFeedBody) so the assertion
    // binds to the right photo's points, not a stray match elsewhere.
    const marker = 'id="photo-' + submissionId + '"';
    const start = res.text.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const nextArticle = res.text.indexOf('<article', start + marker.length);
    const chunk = res.text.slice(start, nextArticle === -1 ? res.text.length : nextArticle);
    const match = chunk.match(/<span class="points-count">(\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match[1])).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// AC3: the slideshow ranks a task group by the real (bonus-inclusive) points.
// ---------------------------------------------------------------------------
describe("AC3: the slideshow ranks a task group by a photo's real (bonus-inclusive) points", () => {
  it('a worth-2/bonus_amount-3 (5 pts) photo outranks a worth-2/photo_bonus-2 (4 pts) photo in the same task, despite fewer likes', () => {
    function makeGuest(name) {
      seq += 1;
      return db
        .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
        .run(`slideshow-parity-${seq}-${crypto.randomUUID()}`, name).lastInsertRowid;
    }
    function makeSubmission({ guestId, taskId, photoPath, photoBonus = 0, bonusAmount = 0 }) {
      return db
        .prepare(
          `INSERT INTO submissions
             (guest_id, task_id, photo_path, thumb_path, taken_down, photo_bonus, bonus_amount)
           VALUES (?, ?, ?, ?, 0, ?, ?)`
        )
        .run(guestId, taskId, photoPath, photoPath + '-thumb', photoBonus, bonusAmount)
        .lastInsertRowid;
    }
    function addLikes(submissionId, count) {
      for (let i = 0; i < count; i++) {
        const likerId = makeGuest(`Parity Liker ${submissionId}-${i}`);
        db.prepare(`INSERT INTO likes (submission_id, guest_id) VALUES (?, ?)`).run(
          submissionId,
          likerId
        );
      }
    }

    // 5 filler memories, each with more likes (5) than either photo under
    // test can reach — the "Most Liked" opener (top 5 by likes) fills
    // entirely with these, pushing both photos under test into "remaining",
    // where they land in a real task GROUP: the points-first, likes-tiebreak
    // code path this criterion targets, not the opener's likes-first one.
    for (let i = 0; i < 5; i++) {
      const fillerGuestId = makeGuest(`Filler Guest ${i}`);
      const fillerId = db
        .prepare(
          `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
           VALUES (?, NULL, ?, ?, 0)`
        )
        .run(fillerGuestId, `filler-${i}.jpg`, `filler-${i}-thumb.jpg`).lastInsertRowid;
      addLikes(fillerId, 5);
    }

    const taskId = insertTask({ title: 'Slideshow Parity Task', worth: 2 });
    const onDayGuestId = makeGuest('Onday Photo Guest');
    const decoyGuestId = makeGuest('Decoy Photo Guest');

    // The true photo: worth 2 + banked bonus_amount 3 = 5 points, 0 likes.
    makeSubmission({
      guestId: onDayGuestId,
      taskId,
      photoPath: 'onday-slide.jpg',
      bonusAmount: 3,
    });

    // The decoy: worth 2 + admin photo_bonus 2 = 4 points, but MORE likes
    // (3). If bonus_amount were silently dropped to 0 (a forgotten SELECT
    // defaults photoPoints's third argument to 0 via its own default
    // parameter — never throws, never NaNs), the true photo's points would
    // read 2, losing to the decoy's 4. If ranking regressed to likes-first,
    // the decoy would also wrongly win. Either defect flips this outcome.
    const decoySubmissionId = makeSubmission({
      guestId: decoyGuestId,
      taskId,
      photoPath: 'decoy-slide.jpg',
      photoBonus: 2,
    });
    addLikes(decoySubmissionId, 3);

    const sequence = feed.slideshowSequence();

    const taskTitleIdx = sequence.findIndex(
      (item) => item.type === 'title' && item.title === 'Slideshow Parity Task'
    );
    expect(taskTitleIdx).toBeGreaterThan(-1);

    const afterTitle = sequence.slice(taskTitleIdx + 1);
    const nextTitleOffset = afterTitle.findIndex((item) => item.type === 'title');
    const sectionPhotos =
      nextTitleOffset === -1 ? afterTitle : afterTitle.slice(0, nextTitleOffset);
    expect(sectionPhotos.length).toBe(2);
    expect(sectionPhotos.every((item) => item.type === 'photo')).toBe(true);

    // Winner-last (countdown to the winner, issue #468): the true 5-point
    // photo must be the winner, regardless of the decoy's higher like count.
    const winner = sectionPhotos[sectionPhotos.length - 1];
    expect(winner.winner).toBe(true);
    expect(winner.guest_name).toBe('Onday Photo Guest');
  });
});
