// tests/feed-likers.test.js
// Covers issue #890 AC8 — the likers attachment community.js's attachLikers()
// builds (mirroring attachComments' own grouped-query shape):
//   AC1/AC2 — the dialog lists each liker's real name/avatar and links to
//             their public profile (/u/:guestId)
//   AC3     — zero likes reads "0 likes" and shows "No likes yet."
//   AC8a    — newest like first
//   AC8b    — likers stay grouped per submission id — one photo's dialog
//             never leaks another photo's liker rows (the same guarantee
//             attachComments' grouped query gives per-photo comment threads)
//
// REQUIRE ORDER: config / db / app are required only AFTER loadApp() sets
// DATA_DIR / DB_PATH. Do not hoist requires above the loadApp() call.
'use strict';

const request = require('supertest');
const { loadApp, signInGuest } = require('./helpers/testApp');

let app;
let db;

beforeAll(async () => {
  const result = loadApp();
  app = result.app;
  db = result.db;
});

/**
 * Insert a guest row with the given token and return { guestId, agent } where
 * agent is a supertest agent already signed in as that guest — the same
 * pattern tests/photo-likes.test.js and tests/photo-comments.test.js use.
 */
async function signedInGuest(token, name, avatarPath) {
  const guestId = db
    .prepare(`INSERT INTO guests (token, name, avatar_path) VALUES (?, ?, ?)`)
    .run(token, name, avatarPath || null).lastInsertRowid;
  const agent = request.agent(app);
  signInGuest(app, token, agent);
  return { guestId, agent };
}

/**
 * Insert a task + submission and return the submission id.
 */
function seedSubmission(authorGuestId, opts = {}) {
  const taskId = db
    .prepare(`INSERT INTO tasks (title) VALUES (?)`)
    .run(opts.taskTitle || 'Likers Test Task').lastInsertRowid;
  const submissionId = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      authorGuestId,
      taskId,
      opts.photoPath || 'liker-test.jpg',
      opts.thumbPath || 'liker-test-thumb.jpg',
      opts.takenDown ? 1 : 0
    ).lastInsertRowid;
  return submissionId;
}

/**
 * Slice out the likers <dialog> markup for one submission id, so assertions
 * about one photo's likers can never bleed into another photo's dialog or
 * into the comments dialog (same idea as photo-comments.test.js's own
 * feedItemChunk, scoped to the likes dialog specifically).
 */
function likesDialogChunk(body, submissionId) {
  const marker = 'id="likes-dialog-' + submissionId + '"';
  const markerIdx = body.indexOf(marker);
  expect(markerIdx).toBeGreaterThan(-1);
  const dialogStart = body.lastIndexOf('<dialog', markerIdx);
  const dialogEnd = body.indexOf('</dialog>', markerIdx);
  expect(dialogEnd).toBeGreaterThan(-1);
  return body.slice(dialogStart, dialogEnd + '</dialog>'.length);
}

/** The "N likes" button text for one submission id in a feed response. */
function likesLinkText(body, submissionId) {
  const marker = 'id="photo-' + submissionId + '"';
  const start = body.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const nextArticle = body.indexOf('<article', start + marker.length);
  const chunk = body.slice(start, nextArticle === -1 ? body.length : nextArticle);
  const match = chunk.match(/class="likes-link"[^>]*>([\s\S]*?)<\/button>/);
  expect(match).toBeTruthy();
  // Collapse the inner <span> markup down to plain text, mirroring how a
  // guest reads the rendered button ("3 likes", not "<span...>3</span> likes").
  return match[1]
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// AC8a: likers attach newest-first.
// ---------------------------------------------------------------------------
it('AC8a: the likers dialog lists likers newest-first', async () => {
  const author = await signedInGuest('order-author', 'Order Author');
  const first = await signedInGuest('order-first', 'Order Liker First');
  const second = await signedInGuest('order-second', 'Order Liker Second');
  const third = await signedInGuest('order-third', 'Order Liker Third');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'order.jpg',
    thumbPath: 'ordert.jpg',
  });

  // Sequential likes, oldest to newest.
  await first.agent.post('/p/' + submissionId + '/like');
  await second.agent.post('/p/' + submissionId + '/like');
  await third.agent.post('/p/' + submissionId + '/like');

  const feedRes = await author.agent.get('/feed');
  const chunk = likesDialogChunk(feedRes.text, submissionId);

  const thirdIdx = chunk.indexOf('Order Liker Third');
  const secondIdx = chunk.indexOf('Order Liker Second');
  const firstIdx = chunk.indexOf('Order Liker First');
  expect(thirdIdx).toBeGreaterThan(-1);
  expect(secondIdx).toBeGreaterThan(-1);
  expect(firstIdx).toBeGreaterThan(-1);
  // Most-recently-liked appears first: Third, then Second, then First.
  expect(thirdIdx).toBeLessThan(secondIdx);
  expect(secondIdx).toBeLessThan(firstIdx);
});

// ---------------------------------------------------------------------------
// AC1/AC2: real name + avatar (or initials fallback) + profile link.
// ---------------------------------------------------------------------------
it('AC1/AC2: a liker row renders their avatar photo, name, and links to /u/:guestId', async () => {
  const author = await signedInGuest('avatar-author', 'Avatar Author');
  const withAvatar = await signedInGuest(
    'avatar-liker',
    'Avatar Liker',
    'avatars/avatar-liker.jpg'
  );
  const withoutAvatar = await signedInGuest('initials-liker', 'Initials Liker');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'avatar.jpg',
    thumbPath: 'avatart.jpg',
  });

  await withAvatar.agent.post('/p/' + submissionId + '/like');
  await withoutAvatar.agent.post('/p/' + submissionId + '/like');

  const feedRes = await author.agent.get('/feed');
  const chunk = likesDialogChunk(feedRes.text, submissionId);

  // The photo-having liker gets an <img> avatar, not initials. Issue #890
  // review round: data-likes-row is the row-identity hook stamped on EVERY
  // row (server-rendered or client-inserted), so it's asserted here too.
  expect(chunk).toContain(
    '<a class="likes-row" href="/u/' +
      withAvatar.guestId +
      '" data-likes-row="' +
      withAvatar.guestId +
      '">'
  );
  expect(chunk).toContain('/uploads/avatars/avatar-liker.jpg');
  expect(chunk).toContain('Avatar Liker');

  // The avatar-less liker falls back to initials, and still links to their
  // own profile — the count-chip-must-link-somewhere rule (AC2).
  expect(chunk).toContain(
    '<a class="likes-row" href="/u/' +
      withoutAvatar.guestId +
      '" data-likes-row="' +
      withoutAvatar.guestId +
      '">'
  );
  expect(chunk).toContain('Initials Liker');
  expect(chunk).toMatch(/likes-row-avatar" aria-hidden="true">IL</);
});

// ---------------------------------------------------------------------------
// AC3: zero likes reads "0 likes" and shows the empty state.
// ---------------------------------------------------------------------------
it('AC3: a photo with no likes reads "0 likes" and the dialog shows "No likes yet."', async () => {
  const author = await signedInGuest('empty-author', 'Empty Author');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'empty.jpg',
    thumbPath: 'emptyt.jpg',
  });

  const feedRes = await author.agent.get('/feed');
  expect(likesLinkText(feedRes.text, submissionId)).toBe('0 likes');

  const chunk = likesDialogChunk(feedRes.text, submissionId);
  expect(chunk).toContain('No likes yet.');
  expect(chunk).not.toContain('likes-row-name');
});

// Singular case, alongside the plural case above — "1 like", not "1 likes".
it('a photo with exactly one like reads "1 like" (singular)', async () => {
  const author = await signedInGuest('singular-author', 'Singular Author');
  const liker = await signedInGuest('singular-liker', 'Singular Liker');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'singular.jpg',
    thumbPath: 'singulart.jpg',
  });

  await liker.agent.post('/p/' + submissionId + '/like');

  const feedRes = await author.agent.get('/feed');
  expect(likesLinkText(feedRes.text, submissionId)).toBe('1 like');
});

// ---------------------------------------------------------------------------
// AC8b: likers stay grouped per submission — one photo's dialog never leaks
// another's rows, the same guarantee attachComments' grouped query gives
// per-photo comment threads (no unbounded/cross-photo query).
// ---------------------------------------------------------------------------
it("AC8b: each photo's likers dialog contains only ITS OWN likers, never another photo's", async () => {
  const author = await signedInGuest('bounded-author', 'Bounded Author');
  const likerA = await signedInGuest('bounded-liker-a', 'Bounded Liker A');
  const likerB = await signedInGuest('bounded-liker-b', 'Bounded Liker B');
  const submissionA = seedSubmission(author.guestId, {
    photoPath: 'bounded-a.jpg',
    thumbPath: 'bounded-at.jpg',
  });
  const submissionB = seedSubmission(author.guestId, {
    photoPath: 'bounded-b.jpg',
    thumbPath: 'bounded-bt.jpg',
  });

  await likerA.agent.post('/p/' + submissionA + '/like');
  await likerB.agent.post('/p/' + submissionB + '/like');

  const feedRes = await author.agent.get('/feed');
  const chunkA = likesDialogChunk(feedRes.text, submissionA);
  const chunkB = likesDialogChunk(feedRes.text, submissionB);

  expect(chunkA).toContain('Bounded Liker A');
  expect(chunkA).not.toContain('Bounded Liker B');
  expect(chunkB).toContain('Bounded Liker B');
  expect(chunkB).not.toContain('Bounded Liker A');
});
