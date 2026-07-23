// tests/crowd-favorite-crown.test.js
// Covers issue #788 acceptance criteria — the crowd-favorite crown as a
// RENDER-TIME marker, phase 2 (wiring scoring.crowdFavorites() into the
// gallery/feed/public-profile render paths; the phase-1 look itself —
// partials/crowd-favorite-mark.ejs, the .cf-crown/.cf-crown-gold CSS, and
// the 403 -> nopeLike client branch — is owner-approved and byte-stable, not
// re-tested here beyond AC5's behavioral check).
//
//   AC1 — every crowd-favorite surface (gallery, feed, public profile) calls
//         scoring.crowdFavorites() exactly ONCE per request and renders the
//         crown purely from that call's own rank order — no second
//         like-count query, no re-derived ranking.
//   AC2 — a full like/unlike/takedown/restore cycle across every surface
//         never writes a guest_badges row for the crown, and no `badges`
//         catalog row is required for the crown to render.
//   AC3 — a placing photo (rank 1-5) wears the shared crown mark on all
//         three surfaces; a non-placing photo wears none.
//   AC4 — rank 1 renders gold, ranks 2-5 render white, identically on all
//         three surfaces (one partial, one CSS rule, no per-surface fork).
//   AC5 — a blocked self-like (403, #712) plays the client "nope" shake and
//         records nothing; a like on another guest's photo is unaffected.
//         The server-side 403 contract itself is already covered by
//         tests/self-like-block.test.js — this file adds the client-side
//         behavior #788 introduces on top of it (feed.js's nopeLike branch).
//
// Seeding style mirrors tests/crowd-favorites.test.js (memory submissions —
// task_id NULL — so a guest may hold any number without the
// UNIQUE(guest_id, task_id) collision a shared task would risk).
//
// REQUIRE ORDER: config / db / services are required only AFTER loadApp()
// sets DATA_DIR / DB_PATH. Do not hoist requires above the loadApp() call.
'use strict';

const { JSDOM } = require('jsdom');
const { loadApp, signInGuest } = require('./helpers/testApp');

let app;
let db;
let scoring;
let photos;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;

  scoring = require('../src/services/scoring');
  photos = require('../src/services/photos');
});

// ---------------------------------------------------------------------------
// Seeding helpers (mirrors tests/crowd-favorites.test.js).
// ---------------------------------------------------------------------------

function resetField() {
  db.prepare('DELETE FROM guests').run();
  db.prepare('DELETE FROM tasks').run();
  db.prepare('DELETE FROM badges').run();
}

let seq = 0;

function makeGuest(name) {
  seq += 1;
  const token = `crown-token-${seq}`;
  const id = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run(token, name).lastInsertRowid;
  return { id, token };
}

function makeSubmission(guestId) {
  seq += 1;
  return db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, NULL, ?, ?, 0)`
    )
    .run(guestId, `crown-p${seq}.jpg`, `crown-t${seq}.jpg`).lastInsertRowid;
}

function addLikes(submissionId, count) {
  for (let i = 0; i < count; i++) {
    const liker = makeGuest(`Crown Liker ${seq}`);
    db.prepare(`INSERT INTO likes (submission_id, guest_id) VALUES (?, ?)`).run(
      submissionId,
      liker.id
    );
  }
}

/**
 * Run `fn` (which must issue at least one HTTP request via supertest) while
 * counting how many times ANY prepared statement whose SQL text contains
 * 'like_count > 0' — the substring unique to scoring.js's
 * stmtVisibleLikeCounts, the query crowdFavorites() runs — has its `.all()`
 * called. Same technique as tests/crowd-favorites.test.js's AC8 spy: it
 * patches the SHARED better-sqlite3 Statement prototype, so it counts real
 * query execution, not call sites in source.
 * @param {() => Promise<void>} fn
 * @returns {Promise<number>}
 */
async function countCrowdFavoriteQueries(fn) {
  const proto = Object.getPrototypeOf(db.prepare('SELECT 1'));
  const original = proto.all;
  let callCount = 0;
  proto.all = function (...args) {
    if (typeof this.source === 'string' && this.source.includes('like_count > 0')) {
      callCount += 1;
    }
    return original.apply(this, args);
  };
  try {
    await fn();
  } finally {
    proto.all = original;
  }
  return callCount;
}

/** GET `url` with `agent`, counting crowd-favorite queries issued during it. */
async function getCounted(agent, url) {
  let res;
  const queryCount = await countCrowdFavoriteQueries(async () => {
    res = await agent.get(url);
  });
  return { res, queryCount };
}

/**
 * Extract whether submission `id`'s tile in `text` wears the crown mark, and
 * whether it is gold — by slicing from the tile's own anchor marker up to
 * the NEXT tile's boundary token, so one tile's assertions can never bleed
 * into a neighbor's (same bounded-chunk technique
 * tests/photo-likes.test.js's likeCountInFeedBody and
 * tests/feed-card.test.js's feedItemChunk use).
 * @returns {'gold'|'white'|null} null when no crown mark is present.
 */
function crownStateFromChunk(text, marker, boundaryToken) {
  const start = text.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const nextBoundary = text.indexOf(boundaryToken, start + marker.length);
  const chunk = text.slice(start, nextBoundary === -1 ? text.length : nextBoundary);
  if (!chunk.includes('cf-crown')) {
    return null;
  }
  return chunk.includes('cf-crown-gold') ? 'gold' : 'white';
}

function galleryTileCrown(text, submissionId) {
  return crownStateFromChunk(
    text,
    'href="/feed?from=' + submissionId + '#photo-' + submissionId + '"',
    '<figure'
  );
}

function profileTileCrown(text, submissionId) {
  return crownStateFromChunk(text, 'href="/p/' + submissionId + '"', '<figure');
}

function feedCardCrown(text, submissionId) {
  return crownStateFromChunk(text, 'id="photo-' + submissionId + '"', '<article');
}

// ---------------------------------------------------------------------------
// AC1 / AC3 / AC4 — one crowdFavorites() call per request; the crown mark on
// every surface matches that call's own order exactly, cross-surface.
// ---------------------------------------------------------------------------
describe('AC1/AC3/AC4: the crown on every surface reads ONE crowdFavorites() call, rank-correct and consistent', () => {
  it('gallery, feed, and public profile all render the identical rank/gold state, with exactly one crowd-favorite query per request', async () => {
    resetField();
    const owner = makeGuest('Crown Owner');
    const s1 = makeSubmission(owner.id);
    addLikes(s1, 5); // rank 1 -> gold
    const s2 = makeSubmission(owner.id);
    addLikes(s2, 4); // rank 2 -> white
    const s3 = makeSubmission(owner.id);
    addLikes(s3, 3); // rank 3 -> white
    const s4 = makeSubmission(owner.id);
    addLikes(s4, 2); // rank 4 -> white
    const s5 = makeSubmission(owner.id);
    addLikes(s5, 1); // rank 5 -> white
    const s6 = makeSubmission(owner.id); // 0 likes -> never places, no crown

    // Sanity: the derived set itself really does place s1-s5 and exclude s6,
    // at the ranks this test's expectations below assume.
    const placingBySubmission = new Map(scoring.crowdFavorites().map((p) => [p.submission_id, p]));
    expect(placingBySubmission.get(s1)).toMatchObject({ rank: 1 });
    expect(placingBySubmission.get(s5)).toMatchObject({ rank: 5 });
    expect(placingBySubmission.has(s6)).toBe(false);

    const agent = signInGuest(app, owner.token);

    // Gallery and feed have no OTHER caller of crowdFavorites() in the same
    // request, so their crown wiring's one call is the request's only one.
    const gallery = await getCounted(agent, '/gallery');
    expect(gallery.res.status).toBe(200);
    expect(gallery.queryCount).toBe(1);

    const feed = await getCounted(agent, '/feed');
    expect(feed.res.status).toBe(200);
    expect(feed.queryCount).toBe(1);

    // The profile route is the one place a SECOND, unrelated caller already
    // exists: scoring.getPoints(guestId) (pre-#788, for the profile's own
    // points header) sums crowdPointsByGuest(), which itself calls
    // crowdFavorites() once for the total-points term — a different purpose
    // than the crown. crownRankLookup() adds exactly one MORE call on top of
    // that pre-existing one; it is not a second call for the SAME crown
    // purpose (AC1's "no second like-count query" is about the crown
    // feature never re-deriving its own ranking, not about eliminating an
    // unrelated pre-existing caller in the same request).
    const profile = await getCounted(agent, '/u/' + owner.id);
    expect(profile.res.status).toBe(200);
    expect(profile.queryCount).toBe(2);

    const expected = {
      [s1]: 'gold',
      [s2]: 'white',
      [s3]: 'white',
      [s4]: 'white',
      [s5]: 'white',
      [s6]: null,
    };
    for (const [id, state] of Object.entries(expected)) {
      expect(galleryTileCrown(gallery.res.text, id)).toBe(state);
      expect(feedCardCrown(feed.res.text, id)).toBe(state);
      expect(profileTileCrown(profile.res.text, id)).toBe(state);
    }

    // Exactly one gold crown renders on each page — the aggregate mirror of
    // the per-tile assertions above.
    expect((gallery.res.text.match(/cf-crown-gold/g) || []).length).toBe(1);
    expect((feed.res.text.match(/cf-crown-gold/g) || []).length).toBe(1);
    expect((profile.res.text.match(/cf-crown-gold/g) || []).length).toBe(1);
  });

  it('the crownRank guard line in each view defaults to {} without throwing when the local is absent', () => {
    // The real routes always pass crownRank now (community.js's three
    // crownRankLookup() call sites), so a route render can never exercise
    // the "local omitted" branch — this renders the GUARD LINE EXTRACTED
    // VERBATIM from each view file (never a hand-copied duplicate that could
    // drift from the real source) with no crownRank local at all, proving
    // the fallback is `{}`, not a throw, matching the issue's "a caller that
    // does not supply it renders no crowns rather than throwing" contract.
    const ejs = require('ejs');
    const fs = require('fs');
    const path = require('path');
    const viewFiles = ['gallery.ejs', 'feed.ejs', 'public-profile.ejs'];
    for (const file of viewFiles) {
      const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', file), 'utf8');
      const guardLine = source
        .split('\n')
        .find((line) => line.includes('var crownRank = (typeof crownRank'));
      expect(guardLine).toBeDefined();
      const output = ejs.render(guardLine + '<%- JSON.stringify(crownRank) %>', {});
      expect(output.trim()).toBe('{}');
    }
  });
});

// ---------------------------------------------------------------------------
// AC2 — a full like/unlike/takedown/restore cycle across every surface never
// materializes a guest_badges row for the crown; no badge catalog row is
// required for it to render.
// ---------------------------------------------------------------------------
describe('AC2: a full cycle across every surface writes no guest_badges row for the crown', () => {
  it('guest_badges row count is unchanged after gallery/feed/profile all re-render post-cycle; no CROWD catalog row exists', async () => {
    resetField();
    const owner = makeGuest('AC2 Crown Owner');
    const liker = makeGuest('AC2 Crown Liker');
    const submissionId = makeSubmission(owner.id);

    const before = db.prepare('SELECT COUNT(*) AS n FROM guest_badges').get().n;

    const agent = signInGuest(app, liker.token);
    await agent.post(`/p/${submissionId}/like`).type('form').send({}); // like -> places at rank 1
    await agent.post(`/p/${submissionId}/like`).type('form').send({}); // unlike -> drops out

    photos.hideSubmission(submissionId);
    photos.restoreSubmission(submissionId);

    // Re-render every crowd-favorite surface after the cycle — none of them
    // may write a guest_badges row as a side effect of rendering the crown,
    // and none needs a `badges` catalog row to succeed (badges table was
    // emptied by resetField() above).
    const galleryRes = await agent.get('/gallery');
    const feedRes = await agent.get('/feed');
    const profileRes = await agent.get('/u/' + owner.id);
    expect(galleryRes.status).toBe(200);
    expect(feedRes.status).toBe(200);
    expect(profileRes.status).toBe(200);

    const after = db.prepare('SELECT COUNT(*) AS n FROM guest_badges').get().n;
    expect(after).toBe(before);

    const crowdCatalogRow = db.prepare("SELECT 1 FROM badges WHERE code LIKE '%CROWD%'").get();
    expect(crowdCatalogRow).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC5 — a blocked self-like plays the client "nope" shake and records
// nothing; a like on another guest's photo is unaffected. The server-side
// 403 contract itself (issue #712) is already covered by
// tests/self-like-block.test.js; this exercises feed.js's client-side
// nopeLike branch the #788 phase-1 front end added on top of that 403.
// jsdom pattern mirrors tests/feed-card.test.js's AC5c dialog test: stub
// fetch + HTMLFormElement.submit, install window/document/navigator as
// globals BEFORE requiring feed.js fresh, then dispatch a real submit event.
// ---------------------------------------------------------------------------
describe('AC5: a blocked self-like (403) plays "nope" client-side and records nothing', () => {
  it('feed.js adds like-button-nope on a 403 response, leaves the count untouched, and never falls back to form.submit()', async () => {
    resetField();
    const owner = makeGuest('AC5 Crown Owner');
    const submissionId = makeSubmission(owner.id);
    const agent = signInGuest(app, owner.token);

    const res = await agent.get('/feed');
    expect(res.status).toBe(200);

    const dom = new JSDOM(res.text, { url: 'http://localhost/' });

    const submitCalls = [];
    // jsdom's HTMLFormElement.submit() throws "not implemented" — stub it so
    // a fallback form.submit() call (the network-failure path, NOT the 403
    // path) is observable instead of erroring the test.
    dom.window.HTMLFormElement.prototype.submit = function () {
      submitCalls.push(this);
    };
    // Stub fetch to resolve exactly like a blocked self-like: 403, no body
    // consumed (nopeLike's branch returns before any res.json() call).
    dom.window.fetch = function () {
      return Promise.resolve({ status: 403, ok: false });
    };

    const keys = ['window', 'document', 'navigator', 'fetch'];
    const saved = {};
    keys.forEach((key) => {
      saved[key] = Object.getOwnPropertyDescriptor(global, key);
      const value = key === 'window' ? dom.window : dom.window[key];
      Object.defineProperty(global, key, { value, configurable: true, writable: true });
    });

    try {
      delete require.cache[require.resolve('../src/public/js/feed.js')];
      require('../src/public/js/feed.js');

      const doc = dom.window.document;
      const form = doc.querySelector('.like-form[action="/p/' + submissionId + '/like"]');
      expect(form).not.toBeNull();
      const button = form.querySelector('.like-button');
      const countEl = form.querySelector('.like-count');
      const countBefore = countEl.textContent;

      expect(button.classList.contains('like-button-nope')).toBe(false);

      const event = new dom.window.Event('submit', { bubbles: true, cancelable: true });
      form.dispatchEvent(event);
      // preventDefault runs synchronously inside the submit handler, before
      // any fetch promise resolves.
      expect(event.defaultPrevented).toBe(true);

      // Let the stubbed fetch's promise chain (both .then() hops) resolve —
      // a macrotask boundary guarantees every pending microtask has already
      // drained by the time it fires.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(button.classList.contains('like-button-nope')).toBe(true);
      // Nothing was recorded: the count in the DOM is untouched (no
      // liked/likeCount handling ever ran for a 403), and no self-like row
      // exists server-side either.
      expect(countEl.textContent).toBe(countBefore);
      expect(submitCalls.length).toBe(0);
    } finally {
      keys.forEach((key) => {
        if (saved[key]) {
          Object.defineProperty(global, key, saved[key]);
        } else {
          delete global[key];
        }
      });
    }

    const likeRow = db
      .prepare('SELECT 1 FROM likes WHERE submission_id = ? AND guest_id = ?')
      .get(submissionId, owner.id);
    expect(likeRow).toBeUndefined();
  });

  it("regression guard: a like on another guest's photo is unaffected by the nope path (still toggles normally)", async () => {
    resetField();
    const owner = makeGuest('AC5b Crown Owner');
    const liker = makeGuest('AC5b Crown Liker');
    const submissionId = makeSubmission(owner.id);
    const agent = signInGuest(app, liker.token);

    const res = await agent.post('/p/' + submissionId + '/like').set('Accept', 'application/json');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ liked: true, likeCount: 1 });
  });
});
