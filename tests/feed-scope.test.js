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
// Issue #954 adds, in the "issue #954" section near the end of this file:
//   AC5: the fourth scope shape, 'badge': feed.parseScope's 'b<id>' token,
//        feed.feedWindow's holder-set predicate (constrained in SQL, not
//        filtered after fetch), and the badge token riding every pager href.
//   AC2/AC3/AC4: the origin allowlist. The back href/label for every row of
//        the issue's AC2 table, a missing/malformed/inapplicable origin
//        token degrading to the scope type's own default (never an error,
//        never a raw query string reflected into an href), and AC1's
//        setLabel/"showing only" removal.
//   AC6: regression cover for every pre-existing scope shape under the
//        restructured scopeBackLinkContext and origin-aware pager hrefs.
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

// --- Issue #954 helpers: a badge and its (possibly award-carrying) holders. ---
function makeBadge(name) {
  seq += 1;
  const code = `SCOPE-BADGE-${seq}`;
  return db
    .prepare(
      `INSERT INTO badges (code, name, type, threshold, art_path, description)
       VALUES (?, ?, 'custom', NULL, '/badges/default-ribbon.svg', '')`
    )
    .run(code, name).lastInsertRowid;
}

// A "current holder" row: awarded_by/points mirror how the real award paths
// (task-badges.js's awardTaskBadge/releaseRanking) write a real earned award,
// but this test only needs the (badge_id, guest_id, submission_id) shape
// feed.js's badge scope predicate reads, not the full award machinery.
function grantHolder(badgeId, guestId, submissionId) {
  db.prepare(
    `INSERT INTO guest_badges (guest_id, badge_id, awarded_by, points, submission_id)
     VALUES (?, ?, 'admin', 5, ?)`
  ).run(guestId, badgeId, submissionId);
}

// A possession-only award with NO earning submission (e.g. an auto/metric/
// transferable/special badge). Must never count toward the scoped set, per
// the issue's own definition ("the non-null submission_id values").
function grantHolderNoSubmission(badgeId, guestId) {
  db.prepare(
    `INSERT INTO guest_badges (guest_id, badge_id, awarded_by, points) VALUES (?, ?, 'admin', 0)`
  ).run(guestId, badgeId);
}

function revokeHolder(badgeId, guestId) {
  db.prepare('DELETE FROM guest_badges WHERE badge_id = ? AND guest_id = ?').run(badgeId, guestId);
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
    // Issue #954 AC1: the old "showing only ___" tail (which used to name the
    // task here) is gone; only the back link itself remains.
    expect(res.text).not.toContain('showing only');
  });

  it("scope 'm' points back at the gallery's Memories section", async () => {
    const guest = makeGuest('Back Link Memory Guest');
    makeSubmission({ guestId: guest.id, taskId: null });
    const agent = signInGuest(app, guest.token);

    const res = await agent.get('/feed?scope=m');
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/gallery?view=task"');
    expect(res.text).toContain('← Back to the gallery');
    // Issue #954 AC1: the old "showing only shared memories" tail is gone.
    expect(res.text).not.toContain('showing only');
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
    // Issue #954 AC1: the old "showing only Nora Back Link Owner's photos"
    // tail is gone; the back link alone remains.
    expect(res.text).not.toContain('showing only');
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

// =============================================================================
// Issue #954: the badge scope shape, the origin allowlist, AC1's tail
// removal, and regression cover for every pre-existing scope shape.
// =============================================================================

// ---------------------------------------------------------------------------
// AC1: no "showing only" text survives for ANY scope shape, with real photos
// present (the invalid-scope case above already covers the fallback path;
// this sweeps every VALID shape, which is where the old setLabel branches
// actually rendered their sentence).
// ---------------------------------------------------------------------------
describe('AC1: the "showing only" tail never renders for a valid scope', () => {
  it('is absent for guest, task, memory, and badge scopes alike', async () => {
    const guest = makeGuest('Tail Sweep Guest');
    const taskId = makeTask('Tail Sweep Task');
    const taskSub = makeSubmission({ guestId: guest.id, taskId });
    makeSubmission({ guestId: guest.id, taskId: null }); // a memory
    const badgeId = makeBadge('Tail Sweep Badge');
    grantHolder(badgeId, guest.id, taskSub);
    const agent = signInGuest(app, guest.token);

    for (const scope of ['u' + guest.id, 't' + taskId, 'm', 'b' + badgeId]) {
      const res = await agent.get('/feed?scope=' + scope);
      expect(res.status).toBe(200);
      expect(res.text).not.toContain('showing only');
    }
  });
});

// ---------------------------------------------------------------------------
// AC5: feed.parseScope's 'b<id>' badge token. Well-formed + existing,
// malformed, and well-formed-but-nonexistent, mirroring the u/t coverage above.
// ---------------------------------------------------------------------------
describe('feed.parseScope: the badge scope token', () => {
  it("parses 'b<id>' for an existing badge", () => {
    const badgeId = makeBadge('Parse Badge');
    expect(feed.parseScope('b' + badgeId)).toEqual({ type: 'badge', id: badgeId });
  });

  it('returns null for a malformed badge token', () => {
    expect(feed.parseScope('b')).toBeNull(); // no digits
    expect(feed.parseScope('bx5')).toBeNull();
  });

  it('returns null for a well-formed id that does not exist', () => {
    expect(feed.parseScope('b999999')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC5: feed.feedWindow's badge shape, constrained to the badge's current
// holders' earning submissions ONLY, in the SQL predicate (proven the same
// way every other shape in this file is: by what the returned/excluded ids
// are, never by inspecting SQL text). A possession-only award (no earning
// submission), a revoked holder, and a taken-down earning photo are each
// excluded on their own, distinct grounds.
// ---------------------------------------------------------------------------
describe('feed.feedWindow with a badge scope', () => {
  it("returns only this badge's holders' earning submissions, excluding a non-holder's photo", () => {
    const holder = makeGuest('Badge Window Holder');
    const stranger = makeGuest('Badge Window Stranger');
    const badgeId = makeBadge('Window Badge');
    const earning = makeSubmission({ guestId: holder.id });
    grantHolder(badgeId, holder.id, earning);
    const theirs = makeSubmission({ guestId: stranger.id });

    const result = feed.feedWindow(null, { type: 'badge', id: badgeId });
    const ids = result.photos.map((p) => p.submission_id);
    expect(ids).toContain(earning);
    expect(ids).not.toContain(theirs);
  });

  it('excludes a possession-only award with no earning submission_id (e.g. an auto/metric-style grant)', () => {
    const holder = makeGuest('Badge Window No-Submission Holder');
    const badgeId = makeBadge('Window No-Submission Badge');
    grantHolderNoSubmission(badgeId, holder.id);
    // A photo this same guest happens to have posted is NOT the badge's
    // earning submission (no guest_badges row names it) and must stay out.
    const unrelatedPhoto = makeSubmission({ guestId: holder.id });

    const result = feed.feedWindow(null, { type: 'badge', id: badgeId });
    const ids = result.photos.map((p) => p.submission_id);
    expect(ids).not.toContain(unrelatedPhoto);
  });

  it('excludes a REVOKED holder\'s earning submission (current holders only)', () => {
    const exHolder = makeGuest('Badge Window Revoked Holder');
    const badgeId = makeBadge('Window Revoked Badge');
    const earning = makeSubmission({ guestId: exHolder.id });
    grantHolder(badgeId, exHolder.id, earning);
    revokeHolder(badgeId, exHolder.id);

    const result = feed.feedWindow(null, { type: 'badge', id: badgeId });
    const ids = result.photos.map((p) => p.submission_id);
    expect(ids).not.toContain(earning);
  });

  it('excludes a holder\'s earning submission once taken down (same visibility rule every shape shares)', () => {
    const holder = makeGuest('Badge Window Taken-Down Holder');
    const badgeId = makeBadge('Window Taken-Down Badge');
    const earning = makeSubmission({ guestId: holder.id, takenDown: 1 });
    grantHolder(badgeId, holder.id, earning);

    const result = feed.feedWindow(null, { type: 'badge', id: badgeId });
    const ids = result.photos.map((p) => p.submission_id);
    expect(ids).not.toContain(earning);
  });

  it('an anchor OUTSIDE the badge scope falls back to the scoped set\'s own newest page', () => {
    const holder = makeGuest('Badge Window Anchor Holder');
    const stranger = makeGuest('Badge Window Anchor Stranger');
    const badgeId = makeBadge('Window Anchor Badge');
    const mine = makeSubmission({ guestId: holder.id });
    grantHolder(badgeId, holder.id, mine);
    const theirs = makeSubmission({ guestId: stranger.id });

    const result = feed.feedWindow(theirs, { type: 'badge', id: badgeId });
    const ids = result.photos.map((p) => p.submission_id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
  });
});

// ---------------------------------------------------------------------------
// AC6: the badge scope token rides both pager hrefs, same contract the
// guest-scope pager test above already proves for 'u<id>'.
// ---------------------------------------------------------------------------
describe('GET /feed?scope=b<id> pager propagation', () => {
  it('carries the badge scope token on both the older and newer pager hrefs', async () => {
    const holder = makeGuest('Badge Pager Holder');
    const badgeId = makeBadge('Pager Badge');
    const agent = signInGuest(app, holder.token);

    const extraCount = feed.FEED_PAGE_SIZE + 3;
    for (let i = 0; i < extraCount; i++) {
      grantHolder(badgeId, makeGuest('Badge Pager Holder ' + i).id, makeSubmission({ guestId: holder.id }));
    }

    const res = await agent.get('/feed?scope=b' + badgeId);
    expect(res.status).toBe(200);
    const olderHrefMatch = res.text.match(/class="page-link page-link-older" href="([^"]+)"/);
    expect(olderHrefMatch).not.toBeNull();
    expect(olderHrefMatch[1]).toContain('scope=b' + badgeId);

    const olderHref = olderHrefMatch[1].replace(/&amp;/g, '&');
    const nextPage = await agent.get(olderHref);
    expect(nextPage.status).toBe(200);
    const newerHrefMatch = nextPage.text.match(/class="page-link page-link-newer" href="([^"]+)"/);
    expect(newerHrefMatch).not.toBeNull();
    expect(newerHrefMatch[1]).toContain('scope=b' + badgeId);
  });
});

// ---------------------------------------------------------------------------
// AC2/AC4: the origin allowlist's back href AND label for every row of the
// issue's AC2 table, exercised via GET /feed?scope=...&origin=....
// ---------------------------------------------------------------------------
describe('origin allowlist: back href + label for every AC2 row', () => {
  it("'gallery-user' origin overrides a guest scope's default to the gallery's By-person list", async () => {
    const ownerName = 'Origin Gallery User Owner';
    const owner = makeGuest(ownerName);
    makeSubmission({ guestId: owner.id });
    const viewer = makeGuest('Origin Gallery User Viewer');
    const agent = signInGuest(app, viewer.token);

    const res = await agent.get('/feed?scope=u' + owner.id + '&origin=gallery-user');
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/gallery?view=user"');
    expect(res.text).toContain('← Back to the gallery');
    // Never the profile/home phrasing this scope would otherwise default to.
    // EJS escapes the apostrophe to &#39; (same convention as the pre-#954
    // back-link tests above).
    expect(res.text).not.toContain('Back to ' + ownerName + '&#39;s profile');
    expect(res.text).not.toContain('your photos');
  });

  it("'profile' origin points at the scoped guest's own /u/<id>, even for the viewer's OWN scope", async () => {
    const ownerName = 'Origin Profile Self Owner';
    const owner = makeGuest(ownerName);
    makeSubmission({ guestId: owner.id });
    const agent = signInGuest(app, owner.token);

    // The viewer IS the scoped guest, but origin=profile says they clicked
    // from their OWN /u/<id> page (not My Photos), so back must still read
    // "profile," never "your photos." Origin decides this, not the self-check
    // defaultBackLinkFor uses when no origin is given.
    const res = await agent.get('/feed?scope=u' + owner.id + '&origin=profile');
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/u/' + owner.id + '"');
    expect(res.text).toContain('Back to ' + ownerName + '&#39;s profile');
    expect(res.text).not.toContain('your photos');
  });

  it("'home' origin points at '/', even for a scope that is NOT the viewer's own", async () => {
    const owner = makeGuest('Origin Home Other Owner');
    makeSubmission({ guestId: owner.id });
    const viewer = makeGuest('Origin Home Viewer');
    const agent = signInGuest(app, viewer.token);

    // A forged combination (this viewer's My Photos never links to another
    // guest's scope), but the origin allowlist is a pure function of the
    // token: 'home' always resolves to '/', "your photos." Documenting that
    // behavior here rather than leaving it untested.
    const res = await agent.get('/feed?scope=u' + owner.id + '&origin=home');
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/"');
    expect(res.text).toContain('your photos');
  });

  it("'gallery-task' origin overrides a TASK scope's default to the gallery's By-task list", async () => {
    const guest = makeGuest('Origin Gallery Task Guest');
    const taskId = makeTask('Origin Gallery Task');
    makeSubmission({ guestId: guest.id, taskId });
    const agent = signInGuest(app, guest.token);

    const res = await agent.get('/feed?scope=t' + taskId + '&origin=gallery-task');
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/gallery?view=task"');
    expect(res.text).toContain('← Back to the gallery');
    // Never the ?view=recent&task= default this origin exists to override.
    expect(res.text).not.toContain('view=recent&amp;task=');
  });

  it("'gallery-recent' origin on a TASK scope matches the pre-#954 default (?view=recent&task=<id>)", async () => {
    const guest = makeGuest('Origin Gallery Recent Guest');
    const taskId = makeTask('Origin Gallery Recent Task');
    makeSubmission({ guestId: guest.id, taskId });
    const agent = signInGuest(app, guest.token);

    const res = await agent.get('/feed?scope=t' + taskId + '&origin=gallery-recent');
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/gallery?view=recent&amp;task=' + taskId + '"');
  });

  it("'gallery-task' origin on a MEMORY scope matches the pre-#954 default (?view=task)", async () => {
    const guest = makeGuest('Origin Gallery Task Memory Guest');
    makeSubmission({ guestId: guest.id, taskId: null });
    const agent = signInGuest(app, guest.token);

    const res = await agent.get('/feed?scope=m&origin=gallery-task');
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/gallery?view=task"');
  });

  it("'badge' origin on a badge scope points at that badge's own detail page", async () => {
    const holder = makeGuest('Origin Badge Guest');
    const badgeId = makeBadge('Origin Badge');
    const badgeCode = db.prepare('SELECT code FROM badges WHERE id = ?').get(badgeId).code;
    const earning = makeSubmission({ guestId: holder.id });
    grantHolder(badgeId, holder.id, earning);
    const agent = signInGuest(app, holder.token);

    const res = await agent.get('/feed?scope=b' + badgeId + '&origin=badge');
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/badge/' + badgeCode + '"');
    expect(res.text).toContain('← Back to the badge');
  });
});

// ---------------------------------------------------------------------------
// AC3: the origin allowlist degrades to the scope type's own default for
// every non-membership case: missing, malformed, applicable-to-a-different-
// scope-type, and (the edge case an unguarded object-property lookup would
// get wrong) a JS-inherited property name. None of these may error, and none
// may reflect the raw origin string into the rendered href.
// ---------------------------------------------------------------------------
describe('origin allowlist: fallback for missing/malformed/inapplicable/unsafe tokens (AC3)', () => {
  it('missing ?origin= falls back to the task scope\'s pre-#954 default', async () => {
    const guest = makeGuest('Origin Missing Guest');
    const taskId = makeTask('Origin Missing Task');
    makeSubmission({ guestId: guest.id, taskId });
    const agent = signInGuest(app, guest.token);

    const res = await agent.get('/feed?scope=t' + taskId);
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/gallery?view=recent&amp;task=' + taskId + '"');
  });

  it('an origin token not in the allowlist falls back to the default, 200, no raw token reflected', async () => {
    const guest = makeGuest('Origin Malformed Guest');
    const taskId = makeTask('Origin Malformed Task');
    makeSubmission({ guestId: guest.id, taskId });
    const agent = signInGuest(app, guest.token);

    const res = await agent.get(
      '/feed?scope=t' + taskId + '&origin=' + encodeURIComponent('totally-bogus-origin')
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/gallery?view=recent&amp;task=' + taskId + '"');
    expect(res.text).not.toContain('totally-bogus-origin');
  });

  it("an origin valid for a DIFFERENT scope type (e.g. 'badge' on a guest scope) is ignored, falling back to the guest default", async () => {
    const owner = makeGuest('Origin Mismatch Owner');
    makeSubmission({ guestId: owner.id });
    const viewer = makeGuest('Origin Mismatch Viewer');
    const agent = signInGuest(app, viewer.token);

    const res = await agent.get('/feed?scope=u' + owner.id + '&origin=badge');
    expect(res.status).toBe(200);
    // Falls back to the guest scope's own default (the other-guest profile
    // branch, since viewer !== owner). Never "Back to the badge".
    expect(res.text).toContain('href="/u/' + owner.id + '"');
    expect(res.text).not.toContain('Back to the badge');
  });

  it('an origin naming a JS Object.prototype property (constructor) never crashes the request and is treated as unknown', async () => {
    const guest = makeGuest('Origin Prototype Guest');
    const taskId = makeTask('Origin Prototype Task');
    makeSubmission({ guestId: guest.id, taskId });
    const agent = signInGuest(app, guest.token);

    // A plain-object allowlist lookup keyed by an unconstrained user string
    // would resolve 'constructor' to Object.prototype.constructor (truthy,
    // no .scopeTypes) and throw on the very next read. This is the case
    // ORIGIN_SHAPES being a Map (not a plain object) exists to rule out.
    for (const trap of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      const res = await agent.get('/feed?scope=t' + taskId + '&origin=' + trap);
      expect(res.status).toBe(200);
      expect(res.text).toContain('href="/gallery?view=recent&amp;task=' + taskId + '"');
    }
  });
});

// ---------------------------------------------------------------------------
// AC6: regression cover. Every pre-existing scope shape still scopes across
// first page / older / newer / a valid ?from= anchor, an out-of-scope ?from=
// still falls back, and an invalid scope still degrades to unscoped, under
// the restructured scopeBackLinkContext and origin-aware pager hrefs.
// ---------------------------------------------------------------------------
describe('AC6: no unscoped regressions across first page / older / newer / anchor', () => {
  // Each fixture builds `mine` (in scope) and `theirs` (a real, visible
  // submission that is deliberately OUTSIDE this scope shape). For 'memory'
  // that means `theirs` must be TASK-linked (another memory would still be
  // in scope for 'm', since memory scope matches every task-free submission
  // regardless of guest).
  const fixtures = {
    guest: () => {
      const guest = makeGuest('AC6 guest Guest');
      const stranger = makeGuest('AC6 guest Stranger');
      const mine = makeSubmission({ guestId: guest.id });
      const theirs = makeSubmission({ guestId: stranger.id });
      return { guest, token: 'u' + guest.id, mine, theirs };
    },
    task: () => {
      const guest = makeGuest('AC6 task Guest');
      const stranger = makeGuest('AC6 task Stranger');
      const taskId = makeTask('AC6 task Task');
      const otherTaskId = makeTask('AC6 task Other Task');
      const mine = makeSubmission({ guestId: guest.id, taskId });
      const theirs = makeSubmission({ guestId: stranger.id, taskId: otherTaskId });
      return { guest, token: 't' + taskId, mine, theirs };
    },
    memory: () => {
      const guest = makeGuest('AC6 memory Guest');
      const stranger = makeGuest('AC6 memory Stranger');
      const otherTaskId = makeTask('AC6 memory Other Task');
      const mine = makeSubmission({ guestId: guest.id, taskId: null });
      // Task-linked, so excluded from scope='m' (s.task_id IS NULL) even
      // though it belongs to a different guest than `mine` either way.
      const theirs = makeSubmission({ guestId: stranger.id, taskId: otherTaskId });
      return { guest, token: 'm', mine, theirs };
    },
  };

  it.each(Object.keys(fixtures))(
    '%s scope: first page, an in-scope ?from= anchor, and an out-of-scope ?from= all behave correctly',
    async (label) => {
      const { guest, token, mine, theirs } = fixtures[label]();
      const agent = signInGuest(app, guest.token);

      // First page: only the in-scope photo appears.
      const firstPage = await agent.get('/feed?scope=' + token);
      expect(firstPage.status).toBe(200);
      expect(firstPage.text).toContain('id="photo-' + mine + '"');
      expect(firstPage.text).not.toContain('id="photo-' + theirs + '"');

      // A valid in-scope ?from= anchor lands on a page containing that photo.
      const anchored = await agent.get('/feed?scope=' + token + '&from=' + mine + '#photo-' + mine);
      expect(anchored.status).toBe(200);
      expect(anchored.text).toContain('id="photo-' + mine + '"');

      // An out-of-scope ?from= (another guest/task's real, visible
      // submission) falls back to the scoped set's own newest page, not the
      // real feed.
      const outOfScope = await agent.get('/feed?scope=' + token + '&from=' + theirs);
      expect(outOfScope.status).toBe(200);
      expect(outOfScope.text).toContain('id="photo-' + mine + '"');
      expect(outOfScope.text).not.toContain('id="photo-' + theirs + '"');
    }
  );

  it('an invalid scope string still degrades to the plain unscoped feed (200, both photos visible)', async () => {
    const guest = makeGuest('AC6 Invalid Guest');
    const stranger = makeGuest('AC6 Invalid Stranger');
    const mine = makeSubmission({ guestId: guest.id });
    const theirs = makeSubmission({ guestId: stranger.id });
    const agent = signInGuest(app, guest.token);

    const res = await agent.get('/feed?scope=not-a-real-scope');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="photo-' + mine + '"');
    expect(res.text).toContain('id="photo-' + theirs + '"');
  });
});
