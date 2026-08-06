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
 * Parse one card's `.feed-card-data` JSON payload (issue #1139). The page now
 * carries one shared likers dialog filled on open from this block, so a
 * server-render assertion about one photo's likers reads its payload's
 * `likers` array — which is grouped per submission by attachLikers() the same
 * way the old per-card dialog markup was — rather than dialog markup that no
 * longer exists per card.
 */
function feedCardData(body, submissionId) {
  const marker = 'class="feed-card-data" data-for="' + submissionId + '"';
  const markerIdx = body.indexOf(marker);
  expect(markerIdx).toBeGreaterThan(-1);
  const start = body.indexOf('>', markerIdx) + 1;
  const end = body.indexOf('</script>', start);
  return JSON.parse(body.slice(start, end));
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
  const data = feedCardData(feedRes.text, submissionId);
  const names = data.likers.map((row) => row.name);

  // Most-recently-liked appears first: Third, then Second, then First.
  expect(names).toEqual(['Order Liker Third', 'Order Liker Second', 'Order Liker First']);
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
  const data = feedCardData(feedRes.text, submissionId);

  // The photo-having liker's payload row carries the avatar path and their
  // real name; feed.js's likesRowNode() builds the actual <a class="likes-row"
  // href="/u/:id" data-likes-row="...">, tested client-side in
  // tests/shared-dialogs.test.js — this is the server-render side: the data
  // that row is built from.
  const avatarRow = data.likers.find((row) => row.id === withAvatar.guestId);
  expect(avatarRow).toBeTruthy();
  expect(avatarRow.av).toBe('avatars/avatar-liker.jpg');
  expect(avatarRow.name).toBe('Avatar Liker');

  // The avatar-less liker falls back to a pre-computed initials string, and
  // still carries their own id for the profile link (AC2).
  const initialsRow = data.likers.find((row) => row.id === withoutAvatar.guestId);
  expect(initialsRow).toBeTruthy();
  expect(initialsRow.av).toBe('');
  expect(initialsRow.name).toBe('Initials Liker');
  expect(initialsRow.init).toBe('IL');
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

  // The "No likes yet." empty state is drawn by feed.js when the shared
  // dialog opens onto an empty payload (tests/shared-dialogs.test.js AC2);
  // the server-render side of that promise is an empty `likers` array.
  const data = feedCardData(feedRes.text, submissionId);
  expect(data.likers).toEqual([]);
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
  const dataA = feedCardData(feedRes.text, submissionA);
  const dataB = feedCardData(feedRes.text, submissionB);

  expect(dataA.likers.map((row) => row.name)).toEqual(['Bounded Liker A']);
  expect(dataB.likers.map((row) => row.name)).toEqual(['Bounded Liker B']);
});
