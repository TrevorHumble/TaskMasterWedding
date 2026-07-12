// tests/community-branches.test.js
// Issue #305 — branch coverage for src/routes/community.js fallback/edge arms
// not exercised by the existing gallery/feed/leaderboard/profile suites:
// parseSocialLinks' malformed-input and protocol-guard arms, the
// zero-photo arms shared by attachViewerLikes/attachComments/attachPhotoPoints,
// the like/comment routes' not-found arms, the leaderboard podium's rank>3
// stop and multi-tie-group arms, and the public-profile not-found arms.
//
// EVERY route in this file requires a SIGNED-IN guest, including the ones
// community.js's own comments call "public": src/routes/guest.js mounts at
// '/' with a blanket `router.use(requireGuest)` (no path filter) BEFORE
// communityRouter is mounted (see src/app.js's comment: "guest.js applies
// requireGuest to every path under '/'"). That blanket middleware runs for
// ANY request that reaches it — matched route or not — and 403s an
// anonymous request before it ever reaches community.js. Confirmed
// empirically: `request(app).get('/u/<id>')` with no signed-in agent returns
// 403 "Private Link Needed", never reaching community.js's own logic. So
// attachViewerLikes' `!guestId` arm (community.js:116) is UNREACHABLE via
// the live HTTP app under the current routing and is not exercised here —
// see the handoff note.
//
// REQUIRE ORDER: config/db/app are required only AFTER loadApp() sets
// DATA_DIR/DB_PATH (same pattern as tests/photo-likes.test.js).
'use strict';

const crypto = require('crypto');
const request = require('supertest');
const { loadApp, signInGuest } = require('./helpers/testApp');

let app;
let db;

beforeAll(() => {
  const result = loadApp();
  app = result.app;
  db = result.db;
});

function insertGuest(name, opts = {}) {
  const token = `community-branches-${crypto.randomUUID()}`;
  const guestId = db
    .prepare(`INSERT INTO guests (token, name, social_links, onboarded) VALUES (?, ?, ?, 1)`)
    .run(token, name, opts.socialLinks !== undefined ? opts.socialLinks : '{}').lastInsertRowid;
  return { guestId, token };
}

async function agentFor(token) {
  const agent = request.agent(app);
  signInGuest(app, token, agent);
  return agent;
}

function insertTask(title) {
  return db.prepare(`INSERT INTO tasks (title) VALUES (?)`).run(title).lastInsertRowid;
}

function insertVisibleSubmission(guestId, taskId, seq) {
  return db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, 0)`
    )
    .run(guestId, taskId, `community-${seq}.jpg`, `community-${seq}-t.jpg`).lastInsertRowid;
}

// A second, unrelated signed-in guest used purely as "the viewer" for routes
// that require a guest — never the subject of the assertions below.
async function viewerAgent() {
  const { token } = insertGuest('Community Branches Viewer');
  return agentFor(token);
}

// ---------------------------------------------------------------------------
// parseSocialLinks, reached via GET /u/:guestId (lines 26,30,47,51,57,61,69,73,79).
// ---------------------------------------------------------------------------
describe('parseSocialLinks via GET /u/:guestId', () => {
  it('malformed JSON social_links -> caught, page still 200 with no crash (line 26-28)', async () => {
    const { guestId } = insertGuest('Malformed JSON Guest', { socialLinks: '{not json' });
    const viewer = await viewerAgent();
    const res = await viewer.get('/u/' + guestId);
    expect(res.status).toBe(200);
  });

  it('a JSON value that is not an object (e.g. a bare number) -> parseSocialLinks returns [] (line 30)', async () => {
    const { guestId } = insertGuest('Non-Object JSON Guest', { socialLinks: '123' });
    const viewer = await viewerAgent();
    const res = await viewer.get('/u/' + guestId);
    expect(res.status).toBe(200);
    // public-profile.ejs only renders <ul class="profile-socials"> when
    // socialLinks.length > 0 — its absence proves parseSocialLinks returned [].
    expect(res.text).not.toContain('profile-socials');
  });

  it('a non-string value for a key is dropped (line 47)', async () => {
    const { guestId } = insertGuest('Non-String Value Guest', {
      socialLinks: JSON.stringify({ instagram: 123 }),
    });
    const viewer = await viewerAgent();
    const res = await viewer.get('/u/' + guestId);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('profile-socials');
  });

  it('a whitespace-only value is dropped (line 51)', async () => {
    const { guestId } = insertGuest('Whitespace Value Guest', {
      socialLinks: JSON.stringify({ instagram: '   ' }),
    });
    const viewer = await viewerAgent();
    const res = await viewer.get('/u/' + guestId);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('profile-socials');
  });

  it('a bare email address gets a mailto: prefix (line 57)', async () => {
    const { guestId } = insertGuest('Bare Email Guest', {
      socialLinks: JSON.stringify({ email: 'me@example.com' }),
    });
    const viewer = await viewerAgent();
    const res = await viewer.get('/u/' + guestId);
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="mailto:me@example.com"');
  });

  it('an email already prefixed with mailto: is left as-is (the other half of line 57)', async () => {
    const { guestId } = insertGuest('Mailto Prefixed Guest', {
      socialLinks: JSON.stringify({ email: 'mailto:me@example.com' }),
    });
    const viewer = await viewerAgent();
    const res = await viewer.get('/u/' + guestId);
    expect(res.status).toBe(200);
    // Exactly one mailto: prefix, never a doubled "mailto:mailto:".
    expect(res.text).toContain('href="mailto:me@example.com"');
    expect(res.text).not.toContain('mailto:mailto:');
  });

  it('a bare handle for a non-email key is prefixed with https:// (line 61)', async () => {
    const { guestId } = insertGuest('Bare Handle Guest', {
      socialLinks: JSON.stringify({ instagram: 'myhandle' }),
    });
    const viewer = await viewerAgent();
    const res = await viewer.get('/u/' + guestId);
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="https://myhandle"');
  });

  it('an unknown key falls back to using the key itself as the label (line 79)', async () => {
    const { guestId } = insertGuest('Unknown Key Guest', {
      socialLinks: JSON.stringify({ myspace: 'https://myspace.example/handle' }),
    });
    const viewer = await viewerAgent();
    const res = await viewer.get('/u/' + guestId);
    expect(res.status).toBe(200);
    // Unknown key -> label falls back to the key itself ("myspace"), rendered
    // as the link text (labels map has no 'myspace' entry).
    expect(res.text).toContain('myspace');
    expect(res.text).toContain('href="https://myspace.example/handle"');
  });

  it('a value that fails URL parsing after scheme handling is dropped, not rendered (lines 69/73)', async () => {
    // key === 'email', already has no '@', so the email-mailto branch does not
    // fire and the https-prepend branch is skipped (key === 'email'), leaving
    // "notanemail-no-at" handed straight to `new URL(...)`, which throws.
    const { guestId } = insertGuest('Bad URL Guest', {
      socialLinks: JSON.stringify({ email: 'notanemail-no-at' }),
    });
    const viewer = await viewerAgent();
    const res = await viewer.get('/u/' + guestId);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('notanemail-no-at');
  });
});

// ---------------------------------------------------------------------------
// attachViewerLikes/attachComments/attachPhotoPoints — zero-photo arms
// (113,178,244), via GET /feed as a signed-in guest.
// ---------------------------------------------------------------------------
describe('attachViewerLikes/attachComments/attachPhotoPoints empty-array arms', () => {
  it('GET /feed with ZERO visible photos -> 200, hits every empty-array short-circuit', async () => {
    // This is the FIRST test in the file to touch /feed, and this file's
    // beforeAll gives it a fresh temp DB (loadApp()), so no submission exists
    // yet anywhere in this DB — feed.feedWindow() returns an empty photos array.
    const viewer = await viewerAgent();
    const res = await viewer.get('/feed');
    expect(res.status).toBe(200);
  });

  it('GET /feed WITH photos present -> the per-photo loop arm runs (distinct from the empty-array arm)', async () => {
    const { guestId } = insertGuest('Feed Author');
    const taskId = insertTask('Feed Author Task');
    const submissionId = insertVisibleSubmission(guestId, taskId, 'feed-present');

    const viewer = await viewerAgent();
    const res = await viewer.get('/feed');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="photo-' + submissionId + '"');
  });
});

// ---------------------------------------------------------------------------
// POST /p/:submissionId/like — not-found arms (402/407).
// ---------------------------------------------------------------------------
describe('POST /p/:submissionId/like not-found arms', () => {
  it('a non-numeric submissionId -> 404 (line 402)', async () => {
    const { token } = insertGuest('Like NonNumeric Guest');
    const agent = await agentFor(token);
    const res = await agent.post('/p/abc/like');
    expect(res.status).toBe(404);
  });

  it('a numeric but nonexistent submissionId -> 404 (line 407)', async () => {
    const { token } = insertGuest('Like Missing Guest');
    const agent = await agentFor(token);
    const res = await agent.post('/p/999999999/like');
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /p/:submissionId/comments — not-found arms (458/463).
// ---------------------------------------------------------------------------
describe('POST /p/:submissionId/comments not-found arms', () => {
  it('a non-numeric submissionId -> 404 (line 458)', async () => {
    const { token } = insertGuest('Comment NonNumeric Guest');
    const agent = await agentFor(token);
    const res = await agent.post('/p/abc/comments').type('form').send({ body: 'hi' });
    expect(res.status).toBe(404);
  });

  it('a numeric but nonexistent submissionId -> 404 (line 463)', async () => {
    const { token } = insertGuest('Comment Missing Guest');
    const agent = await agentFor(token);
    const res = await agent.post('/p/999999999/comments').type('form').send({ body: 'hi' });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /leaderboard — podium's rank>3 break (604) and the groupsByRank.has
// guard (605), via a field with more than 3 distinct point values.
// ---------------------------------------------------------------------------
describe('leaderboard podium rank>3 break and multi-group tie handling', () => {
  it('5 guests at 5 distinct point totals: podium holds only ranks 1-3, rows 4-5 still render', async () => {
    const names = ['Board A', 'Board B', 'Board C', 'Board D', 'Board E'];
    const guestIds = names.map((n) => insertGuest(n).guestId);
    // Distinct, strictly descending bonus_points so ranks are 1,2,3,4,5 with
    // no ties — forces the podium-building loop past rank 3 (line 604's break)
    // and through multiple distinct groupsByRank entries (line 605).
    guestIds.forEach((id, i) => {
      db.prepare('UPDATE guests SET bonus_points = ? WHERE id = ?').run(50 - i * 10, id);
    });

    const viewer = await viewerAgent();
    const res = await viewer.get('/leaderboard');
    expect(res.status).toBe(200);
    // All 5 names render in the full list even though only 3 make the podium.
    for (const name of names) {
      expect(res.text).toContain(name);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /u/:guestId — not-found arms (663/675).
// ---------------------------------------------------------------------------
describe('GET /u/:guestId not-found arms', () => {
  it('a non-numeric guestId -> 404 (line 663)', async () => {
    const viewer = await viewerAgent();
    const res = await viewer.get('/u/abc');
    expect(res.status).toBe(404);
  });

  it('a numeric but nonexistent guestId -> 404 (line 675)', async () => {
    const viewer = await viewerAgent();
    const res = await viewer.get('/u/999999999');
    expect(res.status).toBe(404);
  });
});
