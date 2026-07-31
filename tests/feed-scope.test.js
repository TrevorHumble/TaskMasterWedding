// tests/feed-scope.test.js
// Issue #952 — every guest photo grid opens a scoped feed. Covers:
//   AC4 — the service-level scoping contract (feed.parseScope /
//         feed.feedWindow): owner/task/memories windows, malformed scope,
//         well-formed-but-nonexistent scope, an out-of-scope `from` anchor,
//         taken-down exclusion, and the GET /feed route's pager-scope
//         propagation + empty-valid-scope copy.
//   AC5 — the scoped feed's back-link targets, including the signed-in
//         guest's own-photos special case.
//   AC1 — GET /u/:guestId supplies badgeVictory (the profile grid wears the
//         same task-badge victory medal /gallery already renders).
//
// REQUIRE ORDER: config / db / feed / task-badges / app are required only
// AFTER loadApp() sets DATA_DIR / DB_PATH — see tests/helpers/testApp.js
// "REQUIRE ORDER MATTERS".
'use strict';

const { loadApp, signInGuest } = require('./helpers/testApp');

let app;
let db;
let feed;
let taskBadges;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
  feed = require('../src/services/feed');
  taskBadges = require('../src/services/task-badges');
});

let seq = 0;
function makeGuest(name) {
  seq += 1;
  const token = `scope-token-${seq}`;
  const id = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run(token, name).lastInsertRowid;
  return { id, token };
}

function makeTask(title) {
  return db.prepare(`INSERT INTO tasks (title) VALUES (?)`).run(title).lastInsertRowid;
}

function makeSubmission({ guestId, taskId = null, takenDown = 0 }) {
  seq += 1;
  return db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(guestId, taskId, `scope-p${seq}.jpg`, `scope-t${seq}.jpg`, takenDown).lastInsertRowid;
}

// ---------------------------------------------------------------------------
// AC4 (service level) — feed.parseScope: the 'u<id>' / 't<id>' / 'm' grammar,
// and the malformed/nonexistent fallback to null.
// ---------------------------------------------------------------------------
describe('feed.parseScope', () => {
  it('parses a well-formed, existing guest/task id, and the bare memory token', () => {
    const guest = makeGuest('Scope Parse Guest');
    const taskId = makeTask('Scope Parse Task');

    expect(feed.parseScope('u' + guest.id)).toEqual({ type: 'guest', id: guest.id });
    expect(feed.parseScope('t' + taskId)).toEqual({ type: 'task', id: taskId });
    expect(feed.parseScope('m')).toEqual({ type: 'memory' });
  });

  it('returns null for a malformed value', () => {
    expect(feed.parseScope(undefined)).toBeNull();
    expect(feed.parseScope('')).toBeNull();
    expect(feed.parseScope('bogus')).toBeNull();
    expect(feed.parseScope('u')).toBeNull(); // no digits
    expect(feed.parseScope('x5')).toBeNull(); // unknown shape letter
    expect(feed.parseScope(['u1'])).toBeNull(); // array, not a string (repeated ?scope=)
  });

  it('returns null for a well-formed id that does not exist', () => {
    expect(feed.parseScope('u999999')).toBeNull();
    expect(feed.parseScope('t999999')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC4 (service level) — feed.feedWindow(fromId, scope): each shape returns
// ONLY its own set, taken-down rows stay excluded, and an out-of-scope
// `from` anchor degrades to the scoped set's own newest page.
// ---------------------------------------------------------------------------
describe('feed.feedWindow with a scope', () => {
  it("scope 'guest' returns only that guest's visible submissions", () => {
    const owner = makeGuest('Window Guest Owner');
    const other = makeGuest('Window Guest Other');
    const mine = makeSubmission({ guestId: owner.id });
    const minTakenDown = makeSubmission({ guestId: owner.id, takenDown: 1 });
    const theirs = makeSubmission({ guestId: other.id });

    const result = feed.feedWindow(null, { type: 'guest', id: owner.id });
    const ids = result.photos.map((p) => p.submission_id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(minTakenDown); // taken-down excluded even for the owner
    expect(ids).not.toContain(theirs); // another guest's photo excluded
  });

  it("scope 'task' returns only that task's visible submissions", () => {
    const guest = makeGuest('Window Task Guest');
    const taskA = makeTask('Window Task A');
    const taskB = makeTask('Window Task B');
    const inTask = makeSubmission({ guestId: guest.id, taskId: taskA });
    const otherTask = makeSubmission({ guestId: guest.id, taskId: taskB });

    const result = feed.feedWindow(null, { type: 'task', id: taskA });
    const ids = result.photos.map((p) => p.submission_id);
    expect(ids).toContain(inTask);
    expect(ids).not.toContain(otherTask);
  });

  it("scope 'memory' returns only task-free visible submissions", () => {
    const guest = makeGuest('Window Memory Guest');
    const task = makeTask('Window Memory Task');
    const memory = makeSubmission({ guestId: guest.id, taskId: null });
    const taskPhoto = makeSubmission({ guestId: guest.id, taskId: task });

    const result = feed.feedWindow(null, { type: 'memory' });
    const ids = result.photos.map((p) => p.submission_id);
    expect(ids).toContain(memory);
    expect(ids).not.toContain(taskPhoto);
  });

  it('an anchor INSIDE the scoped set anchors the window there (the missing positive case)', () => {
    const owner = makeGuest('Window In-Scope Anchor Owner');
    // Two of the owner's own submissions, so the anchor is neither the only
    // nor necessarily the newest row — anchoring must be doing real work,
    // not just happening to return the single available photo.
    const older = makeSubmission({ guestId: owner.id });
    const anchor = makeSubmission({ guestId: owner.id });

    const result = feed.feedWindow(anchor, { type: 'guest', id: owner.id });
    expect(result.photos[0].submission_id).toBe(anchor);
    expect(result.photos.map((p) => p.submission_id)).toContain(older);
  });

  it('an anchor OUTSIDE the scoped set falls back to the scoped set’s own newest page, not a 500 or the real feed', () => {
    const owner = makeGuest('Window Anchor Owner');
    const stranger = makeGuest('Window Anchor Stranger');
    const mine = makeSubmission({ guestId: owner.id });
    const theirs = makeSubmission({ guestId: stranger.id });

    // Anchor on a submission that is real and visible, but NOT in scope.
    const result = feed.feedWindow(theirs, { type: 'guest', id: owner.id });
    const ids = result.photos.map((p) => p.submission_id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
  });

  it('a null/omitted scope behaves exactly like the unscoped feed (no scope threading regression)', () => {
    const guest = makeGuest('Window Unscoped Guest');
    const sub = makeSubmission({ guestId: guest.id });
    const result = feed.feedWindow(null, null);
    const ids = result.photos.map((p) => p.submission_id);
    expect(ids).toContain(sub);
  });
});

// ---------------------------------------------------------------------------
// AC4 (route level) — GET /feed?scope=...: pager links carry the same scope,
// a malformed/nonexistent scope degrades to the plain unscoped feed (200, no
// scope chrome), and a valid-but-empty scope still renders the scoped frame
// with "No photos here yet." instead of the unscoped empty copy.
// ---------------------------------------------------------------------------
describe('GET /feed with ?scope=', () => {
  it('an invalid scope (malformed or nonexistent) renders 200 with the plain unscoped frame', async () => {
    const { token } = makeGuest('Route Invalid Scope Guest');
    const agent = signInGuest(app, token);

    const malformed = await agent.get('/feed?scope=bogus');
    expect(malformed.status).toBe(200);
    expect(malformed.text).not.toContain('showing only');
    expect(malformed.text).not.toContain('← Back to');

    const nonexistent = await agent.get('/feed?scope=u999999');
    expect(nonexistent.status).toBe(200);
    expect(nonexistent.text).not.toContain('showing only');
    expect(nonexistent.text).not.toContain('← Back to');
  });

  it('a valid scope with visible photos carries the scope on both pager hrefs', async () => {
    const owner = makeGuest('Route Pager Owner');
    const agent = signInGuest(app, owner.token);
    // Enough of owner's own visible photos to force a next-older page, so
    // BOTH pager directions exist to check (feed.FEED_PAGE_SIZE + a few).
    const extraCount = feed.FEED_PAGE_SIZE + 3;
    for (let i = 0; i < extraCount; i++) {
      makeSubmission({ guestId: owner.id });
    }

    const res = await agent.get('/feed?scope=u' + owner.id);
    expect(res.status).toBe(200);
    // The no-JS pager (AC5's degradation contract) still renders, and its
    // Older link carries the same scope token as the request.
    expect(res.text).toContain('class="page-link page-link-older"');
    const olderHrefMatch = res.text.match(/class="page-link page-link-older" href="([^"]+)"/);
    expect(olderHrefMatch).not.toBeNull();
    expect(olderHrefMatch[1]).toContain('scope=u' + owner.id);

    // Following the Older link keeps the SAME scope on the newer-side link
    // back (both pager directions carry the scope, not just the one followed).
    const olderHref = olderHrefMatch[1].replace(/&amp;/g, '&');
    const nextPage = await agent.get(olderHref);
    expect(nextPage.status).toBe(200);
    const newerHrefMatch = nextPage.text.match(/class="page-link page-link-newer" href="([^"]+)"/);
    expect(newerHrefMatch).not.toBeNull();
    expect(newerHrefMatch[1]).toContain('scope=u' + owner.id);
  });

  it('a valid scope whose visible set is empty renders the scoped frame with "No photos here yet."', async () => {
    const owner = makeGuest('Route Empty Scope Owner');
    const agent = signInGuest(app, owner.token);

    // owner has posted nothing, so scope=u<owner.id> is valid but empty.
    const res = await agent.get('/feed?scope=u' + owner.id);
    expect(res.status).toBe(200);
    expect(res.text).toContain('No photos here yet.');
    expect(res.text).not.toContain('Be the first to share one!');
    // The back-link frame still renders even though the set is empty (AC5).
    expect(res.text).toContain('← Back to your photos');
  });
});

// ---------------------------------------------------------------------------
// AC5 — the scoped feed's back-link targets: task, memories, another
// guest's profile, and the signed-in guest's own special case.
// ---------------------------------------------------------------------------
describe('GET /feed back-link targets (AC5)', () => {
  it("scope 't<id>' points back at the gallery task view, named after the task title", async () => {
    const guest = makeGuest('Back Link Task Guest');
    const taskId = makeTask('Confetti Toss');
    makeSubmission({ guestId: guest.id, taskId });
    const agent = signInGuest(app, guest.token);

    const res = await agent.get('/feed?scope=t' + taskId);
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/gallery?view=recent&amp;task=' + taskId + '"');
    expect(res.text).toContain('← Back to the gallery');
    expect(res.text).toContain('“Confetti Toss”');
  });

  it("scope 'm' points back at the gallery's Memories section", async () => {
    const guest = makeGuest('Back Link Memory Guest');
    makeSubmission({ guestId: guest.id, taskId: null });
    const agent = signInGuest(app, guest.token);

    const res = await agent.get('/feed?scope=m');
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/gallery?view=task"');
    expect(res.text).toContain('← Back to the gallery');
    expect(res.text).toContain('shared memories');
  });

  it("scope 'u<id>' for ANOTHER guest points back at that guest's profile, named after them", async () => {
    const viewer = makeGuest('Back Link Viewer');
    const owner = makeGuest('Nora Back Link Owner');
    makeSubmission({ guestId: owner.id });
    const agent = signInGuest(app, viewer.token);

    const res = await agent.get('/feed?scope=u' + owner.id);
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/u/' + owner.id + '"');
    // EJS's <%= %> escapes the apostrophe to &#39; (same convention the
    // success-flash and other rendered strings in this codebase follow).
    expect(res.text).toContain('← Back to Nora Back Link Owner&#39;s profile');
    expect(res.text).toContain('Nora Back Link Owner&#39;s photos');
  });

  it("scope 'u<id>' for the SIGNED-IN guest's own id points back at their own home, reading \"your photos\"", async () => {
    const owner = makeGuest('Back Link Self Owner');
    makeSubmission({ guestId: owner.id });
    const agent = signInGuest(app, owner.token);

    const res = await agent.get('/feed?scope=u' + owner.id);
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/"');
    expect(res.text).toContain('← Back to your photos');
    expect(res.text).toContain('your photos');
    // Never the other-guest phrasing for the viewer's own scope.
    expect(res.text).not.toContain("Back to Back Link Self Owner's profile");
  });
});

// ---------------------------------------------------------------------------
// AC1 — GET /u/:guestId supplies badgeVictory: a released task-badge rank
// renders the victory medal on the profile grid, exactly like /gallery.
// ---------------------------------------------------------------------------
describe('GET /u/:guestId supplies badgeVictory (AC1)', () => {
  it('a submission holding a released rank wears the victory medal on its profile tile', async () => {
    const winner = makeGuest('Profile Victory Winner');
    const taskId = makeTask('Profile Victory Task');
    const winningSub = makeSubmission({ guestId: winner.id, taskId });

    const released = taskBadges.releaseRanking(taskId, [winningSub]);
    expect(released).toBeTruthy();

    const agent = signInGuest(app, winner.token);
    const res = await agent.get('/u/' + winner.id);
    expect(res.status).toBe(200);
    expect(res.text).toContain('tile-victory-badge');
    expect(res.text).toContain('tile-victory-gold'); // rank 1
  });

  it('a submission with no released rank wears no victory medal', async () => {
    const guest = makeGuest('Profile No Victory Guest');
    makeSubmission({ guestId: guest.id });
    const agent = signInGuest(app, guest.token);

    const res = await agent.get('/u/' + guest.id);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('tile-victory-badge');
  });
});
