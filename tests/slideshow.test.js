// tests/slideshow.test.js
// Covers issue #468's production route/data acceptance criteria (AC1-AC5).
// AC6 (the full-screen view's visual treatment) is the owner-approved, frozen
// surface transcribed into src/views/slideshow.ejs/src/public/js/slideshow.js
// — out of scope here; this file only proves the route + feed.slideshowSequence()
// feed those frozen views the sequence the AC1/AC3 rules require.
//
// REQUIRE ORDER: config/db/app are required only via loadApp() (see
// tests/helpers/testApp.js) — do not hoist requires above it.
//
// ONE shared loadApp()/db for the whole file (same constraint
// tests/community-access.test.js documents: a second loadApp() call in the
// same process silently reuses the FIRST temp database). Because of that,
// the AC4 empty-state assertion runs FIRST, in file order, before any other
// describe block inserts a submission — vitest runs describes/its in file
// order within one file, so "no submissions exist yet" is true exactly once,
// right at the top.
'use strict';

const request = require('supertest');
const { loadApp, signInGuest } = require('./helpers/testApp');

let app;
let db;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

let guestCounter = 0;
function makeGuest(name) {
  guestCounter += 1;
  return db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run(`slideshow-guest-${guestCounter}`, name).lastInsertRowid;
}

function makeTask(title) {
  return db.prepare(`INSERT INTO tasks (title) VALUES (?)`).run(title).lastInsertRowid;
}

function makeSubmission({ guestId, taskId, photoPath, photoBonus = 0 }) {
  return db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, photo_bonus)
       VALUES (?, ?, ?, ?, 0, ?)`
    )
    .run(guestId, taskId, photoPath, photoPath + '-thumb', photoBonus).lastInsertRowid;
}

function addLikes(submissionId, count) {
  for (let i = 0; i < count; i++) {
    const likerId = makeGuest(`Liker ${submissionId}-${i}`);
    db.prepare(`INSERT INTO likes (submission_id, guest_id) VALUES (?, ?)`).run(
      submissionId,
      likerId
    );
  }
}

/** One task with one guest/submission, at a given like count and photo_bonus. */
function seedTaskPhoto({ taskTitle, guestName, photoPath, likes, photoBonus = 0 }) {
  const taskId = makeTask(taskTitle);
  const guestId = makeGuest(guestName);
  const submissionId = makeSubmission({ guestId, taskId, photoPath, photoBonus });
  addLikes(submissionId, likes);
  return { taskId, guestId, submissionId, guestName };
}

// ---------------------------------------------------------------------------
// Rendered-markup helpers — locate a photo slide by its unique guest name
// (rendered verbatim in the caption's "who" div) and a title card by its
// unique task/section name (the h2). Mirrors tests/per-photo-points.test.js's
// windowing pattern (indexOf a marker, slice to the next one) so an assertion
// binds to the RIGHT slide's own rank-tag rather than a stray match elsewhere
// on the page.
// ---------------------------------------------------------------------------

function findSlide(body, guestName) {
  const marker = `<div class="who">${guestName}</div>`;
  const idx = body.indexOf(marker);
  if (idx === -1) return null;
  const slideStart = body.lastIndexOf('<div class="slide slide-photo', idx);
  const nextSlideStart = body.indexOf('<div class="slide', idx + marker.length);
  const chunk = body.slice(slideStart, nextSlideStart === -1 ? body.length : nextSlideStart);
  const labelMatch = chunk.match(/rank-tag-label">([^<]+)</);
  return {
    index: slideStart,
    isWinner: chunk.slice(0, 80).includes('slide-photo winner'),
    rankLabel: labelMatch ? labelMatch[1].trim() : null,
    occurrences: body.split(marker).length - 1,
  };
}

function findTitle(body, taskTitle) {
  return body.indexOf(`<h2 class="title-task">${taskTitle}</h2>`);
}

// ---------------------------------------------------------------------------
// AC4 (empty state) — runs first; see the file-header note on ordering.
// ---------------------------------------------------------------------------
describe('AC4: empty state', () => {
  it('zero visible submissions renders "Nothing on screen yet", not an error', async () => {
    const guestId = makeGuest('AC4 Guest');
    const agent = request.agent(app);
    signInGuest(app, `slideshow-guest-${guestCounter}`, agent);
    // guestId is unused beyond proving the insert above succeeded; the guest
    // itself is what signInGuest signs in as.
    expect(guestId).toBeGreaterThan(0);

    const res = await agent.get('/slideshow');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Nothing on screen yet');
  });
});

// ---------------------------------------------------------------------------
// AC2 (guest-gated) — no data dependency, safe anywhere in file order.
// ---------------------------------------------------------------------------
describe('AC2: signed-out gate', () => {
  it('GET /slideshow with no session cookie -> 302 to /join', async () => {
    const res = await request(app).get('/slideshow');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/join');
  });
});

// ---------------------------------------------------------------------------
// AC1 + AC3: Most-Liked-first ordering, winner-last countdown, winner metric
// and rank labels (including the points-tie-broken-by-likes rule).
// ---------------------------------------------------------------------------
describe('AC1 & AC3: sections, winner-last ordering, and rank labels', () => {
  let agent;
  let names;

  beforeAll(() => {
    // --- Most Liked opener candidates: 6 photos, each its own task, likes
    // strictly above everything seeded below so the opener deterministically
    // picks exactly the top 5 (10..6) and excludes the 6th (5). ---
    const oa = seedTaskPhoto({
      taskTitle: 'Bouquet Toss',
      guestName: 'Opener Ten',
      photoPath: 'opener-10.jpg',
      likes: 10,
    });
    const ob = seedTaskPhoto({
      taskTitle: 'Garter Toss',
      guestName: 'Opener Nine',
      photoPath: 'opener-9.jpg',
      likes: 9,
    });
    const oc = seedTaskPhoto({
      taskTitle: 'First Look',
      guestName: 'Opener Eight',
      photoPath: 'opener-8.jpg',
      likes: 8,
    });
    const od = seedTaskPhoto({
      taskTitle: 'Speeches',
      guestName: 'Opener Seven',
      photoPath: 'opener-7.jpg',
      likes: 7,
    });
    const oe = seedTaskPhoto({
      taskTitle: 'Grand Exit',
      guestName: 'Opener Six',
      photoPath: 'opener-6.jpg',
      likes: 6,
    });
    // The 6th-highest-liked photo: excluded from the opener, but its OWN
    // task ("Cake Smash") still forms a valid one-photo task section because
    // it is the ONLY photo left for that task (not consumed by the opener).
    const of = seedTaskPhoto({
      taskTitle: 'Cake Smash',
      guestName: 'Sixth Liked',
      photoPath: 'sixth-liked.jpg',
      likes: 5,
    });

    // --- "Cut the Cake": 3 photos, distinct points, all likes well below
    // the opener's floor (6) so none of them can be pulled into it. Winner
    // by points (not likes). ---
    const ctc = makeTask('Cut the Cake');
    const s1 = makeGuest('Low Points Guest');
    const sub1 = makeSubmission({
      guestId: s1,
      taskId: ctc,
      photoPath: 'cake-1.jpg',
      photoBonus: 0,
    }); // 1 pt
    addLikes(sub1, 3);
    const s2 = makeGuest('High Points Guest');
    const sub2 = makeSubmission({
      guestId: s2,
      taskId: ctc,
      photoPath: 'cake-2.jpg',
      photoBonus: 5,
    }); // 6 pts
    addLikes(sub2, 2);
    const s3 = makeGuest('Mid Points Guest');
    const sub3 = makeSubmission({
      guestId: s3,
      taskId: ctc,
      photoPath: 'cake-3.jpg',
      photoBonus: 2,
    }); // 3 pts
    addLikes(sub3, 1);

    // --- "Tiebreak Task": 2 photos with EQUAL points (both 1 pt) — the
    // winner must be decided by like_count (AC3's tie-break rule), not by
    // insertion order or id. ---
    const tb = makeTask('Tiebreak Task');
    const t1 = makeGuest('Tiebreak More Likes');
    const subT1 = makeSubmission({ guestId: t1, taskId: tb, photoPath: 'tiebreak-a.jpg' }); // 1pt
    addLikes(subT1, 4);
    const t2 = makeGuest('Tiebreak Fewer Likes');
    const subT2 = makeSubmission({ guestId: t2, taskId: tb, photoPath: 'tiebreak-b.jpg' }); // 1pt
    addLikes(subT2, 1);

    agent = request.agent(app);
    signInGuest(app, `slideshow-guest-${guestCounter}`, agent);
    // The guest signed in above is whichever was inserted last by the seed
    // helpers (Tiebreak Fewer Likes) — any signed-in guest works, the route
    // does not vary its output by viewer.

    names = {
      oa: oa.guestName,
      ob: ob.guestName,
      oc: oc.guestName,
      od: od.guestName,
      oe: oe.guestName,
      of: of.guestName,
      cakeLow: 'Low Points Guest',
      cakeHigh: 'High Points Guest',
      cakeMid: 'Mid Points Guest',
      tbMore: 'Tiebreak More Likes',
      tbFewer: 'Tiebreak Fewer Likes',
    };
  });

  it('AC1: sequence starts with Most Liked, then the fullest-first task sections', async () => {
    const res = await agent.get('/slideshow');
    expect(res.status).toBe(200);
    const body = res.text;

    const mostLikedIdx = body.indexOf('<h2 class="title-task">Most Liked</h2>');
    const cutTheCakeIdx = findTitle(body, 'Cut the Cake'); // 3 remaining photos
    const tiebreakIdx = findTitle(body, 'Tiebreak Task'); // 2 remaining photos
    const cakeSmashIdx = findTitle(body, 'Cake Smash'); // 1 remaining photo

    expect(mostLikedIdx).toBeGreaterThan(-1);
    expect(cutTheCakeIdx).toBeGreaterThan(-1);
    expect(tiebreakIdx).toBeGreaterThan(-1);
    expect(cakeSmashIdx).toBeGreaterThan(-1);

    // Most Liked first; then fullest task (3 photos) before the 2-photo
    // task, before the 1-photo task.
    expect(mostLikedIdx).toBeLessThan(cutTheCakeIdx);
    expect(cutTheCakeIdx).toBeLessThan(tiebreakIdx);
    expect(tiebreakIdx).toBeLessThan(cakeSmashIdx);

    // A task fully consumed by the opener (only photo went to Most Liked)
    // never gets its own title card at all.
    expect(findTitle(body, 'Bouquet Toss')).toBe(-1);
    expect(findTitle(body, 'Garter Toss')).toBe(-1);
  });

  it('AC1/AC3: Most Liked opener is a likes-ascending countdown, winner last, labelled "Crowd favorite"', async () => {
    const res = await agent.get('/slideshow');
    const body = res.text;

    const oe = findSlide(body, names.oe); // 6 likes -> rank 5
    const od = findSlide(body, names.od); // 7 likes -> rank 4
    const oc = findSlide(body, names.oc); // 8 likes -> rank 3
    const ob = findSlide(body, names.ob); // 9 likes -> rank 2
    const oa = findSlide(body, names.oa); // 10 likes -> rank 1, winner

    [oe, od, oc, ob, oa].forEach((s) => expect(s).not.toBeNull());

    // Ascending order: the lowest-liked opener photo first, winner last.
    expect(oe.index).toBeLessThan(od.index);
    expect(od.index).toBeLessThan(oc.index);
    expect(oc.index).toBeLessThan(ob.index);
    expect(ob.index).toBeLessThan(oa.index);

    expect(oa.isWinner).toBe(true);
    expect(oa.rankLabel).toBe('Crowd favorite');
    expect(ob.rankLabel).toBe('2nd place');
    expect(oc.rankLabel).toBe('3rd place');
    expect(od.rankLabel).toBe('4th place');
    expect(oe.rankLabel).toBe('5th place');
    expect(ob.isWinner).toBe(false);

    // "show once": the 6th-highest-liked photo did NOT make the opener.
    const excluded = findSlide(body, names.of);
    expect(excluded.index).toBeGreaterThan(oa.index); // appears only later, in its own task section
    expect(excluded.occurrences).toBe(1); // and never twice
  });

  it("AC3: a task section's winner is ranked by points (not likes), ties broken by likes", async () => {
    const res = await agent.get('/slideshow');
    const body = res.text;

    // Cut the Cake: points 1, 6, 3 -> ascending order low(1pt) -> mid(3pt) -> high(6pt, winner).
    const low = findSlide(body, names.cakeLow);
    const mid = findSlide(body, names.cakeMid);
    const high = findSlide(body, names.cakeHigh);
    expect(low.index).toBeLessThan(mid.index);
    expect(mid.index).toBeLessThan(high.index);
    expect(high.isWinner).toBe(true);
    expect(high.rankLabel).toBe('Top shot');
    expect(mid.rankLabel).toBe('2nd place');
    expect(low.rankLabel).toBe('3rd place');

    // Tiebreak Task: both photos are worth the same points (1 pt each) --
    // the winner must be the one with MORE likes (4 vs 1), not the other.
    const fewer = findSlide(body, names.tbFewer);
    const more = findSlide(body, names.tbMore);
    expect(fewer.index).toBeLessThan(more.index);
    expect(more.isWinner).toBe(true);
    expect(more.rankLabel).toBe('Top shot');
    expect(fewer.isWinner).toBe(false);
    expect(fewer.rankLabel).toBe('2nd place');
  });
});

// ---------------------------------------------------------------------------
// AC5: Auto vs Directed markers.
// ---------------------------------------------------------------------------
describe('AC5: mode markers', () => {
  let agent;

  beforeAll(() => {
    // Reuses the data seeded by the AC1/AC3 describe above (this file's
    // shared db) -- any non-empty sequence exercises the dwell markers.
    agent = request.agent(app);
    signInGuest(app, `slideshow-guest-${guestCounter}`, agent);
  });

  it('?mode=directed -> data-mode="directed" on the slideshow container', async () => {
    const res = await agent.get('/slideshow?mode=directed');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="slideshow"');
    expect(res.text).toMatch(/id="slideshow"[^>]*data-mode="directed"/);
  });

  it('no ?mode (and ?mode=auto) -> data-mode="auto", and the dwell markers for each slide kind are present', async () => {
    const resDefault = await agent.get('/slideshow');
    expect(resDefault.text).toMatch(/id="slideshow"[^>]*data-mode="auto"/);

    const resAuto = await agent.get('/slideshow?mode=auto');
    expect(resAuto.text).toMatch(/id="slideshow"[^>]*data-mode="auto"/);

    // AC5's literal dwell values: title ~4.5s, photo ~8s, section winner ~11s.
    expect(resDefault.text).toContain('data-dwell="4500"');
    expect(resDefault.text).toContain('data-dwell="8000"');
    expect(resDefault.text).toContain('data-dwell="11000"');
  });

  it('an unrecognized ?mode value falls back to auto rather than passing it through', async () => {
    const res = await agent.get('/slideshow?mode=bogus');
    expect(res.text).toMatch(/id="slideshow"[^>]*data-mode="auto"/);
  });
});
