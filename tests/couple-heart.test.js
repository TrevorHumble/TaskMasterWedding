// tests/couple-heart.test.js
// Covers issue #647 acceptance criteria — the Couple's Heart: a like from a
// couple-flagged guest (guests.is_couple) renders a gold heart on the photo
// and names them in the bell.
//
//   AC1 — the mark renders on every "yes" surface: /feed, /gallery,
//         ?view=task, ?view=user, /u/:guestId — a photo liked only by
//         ordinary guests carries none.
//   AC2 — My Photos (guest-home) stays bare; coupleLikers is absent from
//         that route's render locals.
//   AC3 — the tally names them ("Lilly" + "N other likes", "Axel & Lilly",
//         solo "Lilly liked this"), and data-couple-count matches.
//   AC4 — likers dialog marks the couple's row; an empty-name couple guest
//         falls back to "Guest" on both the dialog row and the tally.
//   AC5: scores +1 (issue #1107 reversal): the like count matches the
//         ordinary-liker case exactly, but a couple-like pays its owner 1
//         point more than an ordinary like does, with crowd-favorite
//         standing unaffected either way.
//   AC6 — the bell row: kind 'love', the solid-heart glyph (not
//         KIND_GLYPH.gold's outline heart), thumb null (recap-icon branch,
//         not recap-thumb).
//   AC7 — the bell's accounting: a couple-only like has no batched row; a
//         couple-like + 3 ordinary likes batches the 3, not 4; the unread
//         chip counts exactly what the list renders.
//
// REQUIRE ORDER: config / db / services are required only AFTER loadApp()
// sets DATA_DIR / DB_PATH. Do not hoist requires above the loadApp() call.
'use strict';

const request = require('supertest');
const { loadApp, signInGuest } = require('./helpers/testApp');

let app;
let db;
let scoring;
let notifications;

let seq = 0;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
  scoring = require('../src/services/scoring');
  notifications = require('../src/services/notifications');
});

/**
 * Insert a guest row and return { guestId, agent } signed in as that guest.
 * @param {{isCouple?: boolean, name?: string}} [opts]
 */
async function makeGuest(opts = {}) {
  seq += 1;
  const token = `couple-heart-${seq}`;
  const name = opts.name !== undefined ? opts.name : `Guest ${seq}`;
  const guestId = db
    .prepare(`INSERT INTO guests (token, name, is_couple) VALUES (?, ?, ?)`)
    .run(token, name, opts.isCouple ? 1 : 0).lastInsertRowid;
  // Pin the recap checkpoint a minute in the past rather than leaving it at
  // created_at (~"now"): SQLite's datetime('now') has only whole-SECOND
  // resolution, so a like posted moments after guest creation can land in
  // the SAME second as an unadjusted checkpoint — the module's own
  // documented edge case (notifications.js's stmtLikeBatches comment) — and
  // the strict `>` bound would then exclude it from the recap entirely.
  db.prepare(`UPDATE guests SET recap_checked_at = datetime('now', '-1 minute') WHERE id = ?`).run(
    guestId
  );
  const agent = request.agent(app);
  signInGuest(app, token, agent);
  return { guestId, agent };
}

/** Insert a task + submission owned by `authorGuestId`, return the submission id. */
function seedSubmission(authorGuestId, opts = {}) {
  seq += 1;
  const taskId = db
    .prepare(`INSERT INTO tasks (title) VALUES (?)`)
    .run(opts.taskTitle || `Couple Heart Task ${seq}`).lastInsertRowid;
  const submissionId = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, 0)`
    )
    .run(authorGuestId, taskId, `ch-${seq}.jpg`, `ch-${seq}t.jpg`).lastInsertRowid;
  return submissionId;
}

/** The <article id="photo-N"> chunk of a /feed response body. */
function feedItemChunk(body, submissionId) {
  const marker = 'id="photo-' + submissionId + '"';
  const start = body.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const nextArticle = body.indexOf('<article', start + marker.length);
  return body.slice(start, nextArticle === -1 ? body.length : nextArticle);
}

/**
 * The <figure class="gallery-item"> chunk for one submission id in a
 * /gallery response body — scoped so a mark asserted (or asserted absent)
 * for one photo can never accidentally read another photo's tile, which
 * matters here since every test in this file shares one accumulating
 * database (many earlier tests' couple-liked photos are still on the page).
 */
function galleryTileChunk(body, submissionId) {
  const marker = 'href="/feed?from=' + submissionId;
  const idx = body.indexOf(marker);
  expect(idx).toBeGreaterThan(-1);
  const figStart = body.lastIndexOf('<figure', idx);
  const figEnd = body.indexOf('</figure>', idx);
  expect(figEnd).toBeGreaterThan(-1);
  return body.slice(figStart, figEnd + '</figure>'.length);
}

// ---------------------------------------------------------------------------
// AC1: the mark renders on every "yes" surface, and only there.
// ---------------------------------------------------------------------------
describe('AC1: the mark renders on every "yes" surface', () => {
  it('a couple-liked photo carries .couple-heart on /feed, /gallery (all three views), and /u/:guestId', async () => {
    const author = await makeGuest({ name: 'AC1 Author' });
    const couple = await makeGuest({ isCouple: true, name: 'Lilly' });
    const ordinary = await makeGuest({ name: 'AC1 Ordinary' });
    const submissionId = seedSubmission(author.guestId);

    await couple.agent.post('/p/' + submissionId + '/like');
    await ordinary.agent.post('/p/' + submissionId + '/like');

    const feedRes = await author.agent.get('/feed');
    expect(feedItemChunk(feedRes.text, submissionId)).toContain('couple-heart');

    const galleryRecent = await author.agent.get('/gallery');
    expect(galleryTileChunk(galleryRecent.text, submissionId)).toContain('couple-heart');

    const galleryTask = await author.agent.get('/gallery?view=task');
    expect(galleryTileChunk(galleryTask.text, submissionId)).toContain('couple-heart');

    const galleryUser = await author.agent.get('/gallery?view=user');
    expect(galleryTileChunk(galleryUser.text, submissionId)).toContain('couple-heart');

    const profileRes = await author.agent.get('/u/' + author.guestId);
    expect(galleryTileChunk(profileRes.text, submissionId)).toContain('couple-heart');
  });

  it('a photo liked only by ordinary guests carries no .couple-heart on any surface', async () => {
    const author = await makeGuest({ name: 'AC1b Author' });
    const ordinary = await makeGuest({ name: 'AC1b Ordinary' });
    const submissionId = seedSubmission(author.guestId);

    await ordinary.agent.post('/p/' + submissionId + '/like');

    const feedRes = await author.agent.get('/feed');
    expect(feedItemChunk(feedRes.text, submissionId)).not.toContain('couple-heart');

    const galleryRecent = await author.agent.get('/gallery');
    expect(galleryTileChunk(galleryRecent.text, submissionId)).not.toContain('couple-heart');

    const galleryTask = await author.agent.get('/gallery?view=task');
    expect(galleryTileChunk(galleryTask.text, submissionId)).not.toContain('couple-heart');

    const galleryUser = await author.agent.get('/gallery?view=user');
    expect(galleryTileChunk(galleryUser.text, submissionId)).not.toContain('couple-heart');

    const profileRes = await author.agent.get('/u/' + author.guestId);
    expect(galleryTileChunk(profileRes.text, submissionId)).not.toContain('couple-heart');
  });
});

// ---------------------------------------------------------------------------
// AC2: My Photos stays bare.
// ---------------------------------------------------------------------------
it('AC2: My Photos (guest-home) never renders .couple-heart, even for a couple-liked photo', async () => {
  const author = await makeGuest({ name: 'AC2 Author' });
  const couple = await makeGuest({ isCouple: true, name: 'AC2 Couple' });
  seedSubmission(author.guestId);
  const submissionId = seedSubmission(author.guestId);
  await couple.agent.post('/p/' + submissionId + '/like');

  const homeRes = await author.agent.get('/');
  expect(homeRes.text).not.toContain('couple-heart');
});

// ---------------------------------------------------------------------------
// AC3: the tally names them.
// ---------------------------------------------------------------------------
describe('AC3: the tally names the couple', () => {
  it('one couple-liker plus 4 ordinary likers reads "Lilly" + 4 other likes, data-couple-count="1"', async () => {
    const author = await makeGuest({ name: 'AC3 Author' });
    const lilly = await makeGuest({ isCouple: true, name: 'Lilly' });
    const submissionId = seedSubmission(author.guestId);

    await lilly.agent.post('/p/' + submissionId + '/like');
    for (let i = 0; i < 4; i += 1) {
      const g = await makeGuest({ name: 'AC3 Other ' + i });
      await g.agent.post('/p/' + submissionId + '/like');
    }

    const feedRes = await author.agent.get('/feed');
    const chunk = feedItemChunk(feedRes.text, submissionId);
    expect(chunk).toContain('<span class="couple-likers">Lilly</span>');
    expect(chunk).toMatch(/<span class="like-count">4<\/span>/);
    expect(chunk).toContain('other like');
    expect(chunk).toContain('data-couple-count="1"');
  });

  it('Axel liking first, then Lilly, reads "Axel & Lilly" with data-couple-count="2"', async () => {
    const author = await makeGuest({ name: 'AC3b Author' });
    const axel = await makeGuest({ isCouple: true, name: 'Axel' });
    const lilly = await makeGuest({ isCouple: true, name: 'Lilly' });
    const submissionId = seedSubmission(author.guestId);

    await axel.agent.post('/p/' + submissionId + '/like');
    await lilly.agent.post('/p/' + submissionId + '/like');

    const feedRes = await author.agent.get('/feed');
    const chunk = feedItemChunk(feedRes.text, submissionId);
    expect(chunk).toContain('<span class="couple-likers">Axel &amp; Lilly</span>');
    expect(chunk).toContain('data-couple-count="2"');
  });

  it('Lilly as the sole liker shows .likes-link-solo and hides .likes-link-others', async () => {
    const author = await makeGuest({ name: 'AC3c Author' });
    const lilly = await makeGuest({ isCouple: true, name: 'Lilly' });
    const submissionId = seedSubmission(author.guestId);

    await lilly.agent.post('/p/' + submissionId + '/like');

    const feedRes = await author.agent.get('/feed');
    const chunk = feedItemChunk(feedRes.text, submissionId);
    expect(chunk).toMatch(/likes-link-solo"[^>]*> liked this/);
    expect(chunk).toMatch(/likes-link-others" hidden>/);
  });
});

// ---------------------------------------------------------------------------
// AC4: likers dialog marks the couple's row; empty-name fallback.
// ---------------------------------------------------------------------------
describe('AC4: likers dialog', () => {
  it("the couple's row wears the mark; an ordinary guest's row does not", async () => {
    const author = await makeGuest({ name: 'AC4 Author' });
    const couple = await makeGuest({ isCouple: true, name: 'AC4 Couple' });
    const ordinary = await makeGuest({ name: 'AC4 Ordinary' });
    const submissionId = seedSubmission(author.guestId);

    await couple.agent.post('/p/' + submissionId + '/like');
    await ordinary.agent.post('/p/' + submissionId + '/like');

    const feedRes = await author.agent.get('/feed');
    const marker = 'id="likes-dialog-' + submissionId + '"';
    const dialogStart = feedRes.text.lastIndexOf('<dialog', feedRes.text.indexOf(marker));
    const dialogEnd = feedRes.text.indexOf('</dialog>', feedRes.text.indexOf(marker));
    const dialogChunk = feedRes.text.slice(dialogStart, dialogEnd);

    const coupleRowStart = dialogChunk.indexOf('AC4 Couple');
    const coupleRowChunkStart = dialogChunk.lastIndexOf('<a class="likes-row"', coupleRowStart);
    const coupleRowChunkEnd = dialogChunk.indexOf('</a>', coupleRowStart);
    expect(dialogChunk.slice(coupleRowChunkStart, coupleRowChunkEnd)).toContain('couple-heart');

    const ordinaryRowStart = dialogChunk.indexOf('AC4 Ordinary');
    const ordinaryRowChunkStart = dialogChunk.lastIndexOf('<a class="likes-row"', ordinaryRowStart);
    const ordinaryRowChunkEnd = dialogChunk.indexOf('</a>', ordinaryRowStart);
    expect(dialogChunk.slice(ordinaryRowChunkStart, ordinaryRowChunkEnd)).not.toContain(
      'couple-heart'
    );
  });

  it('a couple-flagged guest with an empty name reads "Guest" in both the dialog row and the tally', async () => {
    const author = await makeGuest({ name: 'AC4b Author' });
    const nameless = await makeGuest({ isCouple: true, name: '' });
    const submissionId = seedSubmission(author.guestId);

    await nameless.agent.post('/p/' + submissionId + '/like');

    const feedRes = await author.agent.get('/feed');
    const chunk = feedItemChunk(feedRes.text, submissionId);
    expect(chunk).toContain('<span class="couple-likers">Guest</span>');

    const marker = 'id="likes-dialog-' + submissionId + '"';
    const dialogStart = feedRes.text.lastIndexOf('<dialog', feedRes.text.indexOf(marker));
    const dialogEnd = feedRes.text.indexOf('</dialog>', feedRes.text.indexOf(marker));
    const dialogChunk = feedRes.text.slice(dialogStart, dialogEnd);
    expect(dialogChunk).toContain('likes-row-name">Guest<');
  });
});

// ---------------------------------------------------------------------------
// AC5: scores +1 (issue #1107 reversal).
// ---------------------------------------------------------------------------
it('AC5: a couple-like increments the like count by exactly 1 and pays 1 point more than an ordinary like', async () => {
  const author = await makeGuest({ name: 'AC5 Author' });
  const ordinaryAuthor = await makeGuest({ name: 'AC5 Ordinary Author' });
  const couple = await makeGuest({ isCouple: true, name: 'AC5 Couple' });
  const ordinaryLiker = await makeGuest({ name: 'AC5 Ordinary Liker' });

  const coupleLikedSubmission = seedSubmission(author.guestId);
  const ordinaryLikedSubmission = seedSubmission(ordinaryAuthor.guestId);

  const beforeCount = db
    .prepare('SELECT COUNT(*) AS n FROM likes WHERE submission_id = ?')
    .get(coupleLikedSubmission).n;
  await couple.agent.post('/p/' + coupleLikedSubmission + '/like');
  await ordinaryLiker.agent.post('/p/' + ordinaryLikedSubmission + '/like');
  const afterCount = db
    .prepare('SELECT COUNT(*) AS n FROM likes WHERE submission_id = ?')
    .get(coupleLikedSubmission).n;
  expect(afterCount - beforeCount).toBe(1);

  // The couple-liked author scores exactly 1 point more than the
  // ordinary-liked author (issue #1107): a couple-like pays its owner 1
  // point, uncapped, on top of everything an ordinary like already pays
  // (nothing directly, crowd-favorite math is unweighted like-count based,
  // asserted separately below).
  expect(scoring.getPoints(author.guestId)).toBe(scoring.getPoints(ordinaryAuthor.guestId) + 1);

  // Same crowd-favorite standing too — crowdPointsByGuest (not the raw
  // crowdFavorites() array, which only returns the top-5 placing set and
  // would throw a false negative if neither photo places given the whole
  // test file's accumulated like history) reads 0 for a non-placing guest,
  // so this comparison is safe whether or not either photo places.
  const crowdPoints = scoring.crowdPointsByGuest();
  expect(crowdPoints.get(author.guestId) || 0).toBe(crowdPoints.get(ordinaryAuthor.guestId) || 0);
});

// ---------------------------------------------------------------------------
// AC6: the bell row.
// ---------------------------------------------------------------------------
it('AC6: a couple-like produces a recap row reading "<name> loved your photo", kind love, solid heart, no thumb', async () => {
  const author = await makeGuest({ name: 'AC6 Author' });
  const lilly = await makeGuest({ isCouple: true, name: 'Lilly' });
  const submissionId = seedSubmission(author.guestId);

  await lilly.agent.post('/p/' + submissionId + '/like');

  const recap = notifications.getRecap(author.guestId);
  const row = recap.rows.find((r) => r.key.startsWith('couplelike-'));
  expect(row).toBeTruthy();
  expect(row.kind).toBe('love');
  expect(row.thumb).toBeNull();
  expect(row.parts).toEqual([{ text: 'Lilly', emphasis: true }, { text: ' loved your photo' }]);
  expect(row.href).toBe('/p/' + submissionId);
  // The solid heart path (couple-heart-mark.ejs's own path), NOT
  // KIND_GLYPH.gold's thin outline heart (which starts with a different `d`).
  expect(row.glyph).toContain('M12 21s-8.5-5.3-8.5-11.2');
  expect(row.glyph).not.toContain('M12 20s-7-4.4-9.3-8.8');
});

// ---------------------------------------------------------------------------
// AC7: the bell's accounting stays honest.
// ---------------------------------------------------------------------------
describe('AC7: the bell accounting', () => {
  it('a couple-only like produces no batched like row, just the named one', async () => {
    const author = await makeGuest({ name: 'AC7 Author' });
    const lilly = await makeGuest({ isCouple: true, name: 'Lilly' });
    const submissionId = seedSubmission(author.guestId);

    await lilly.agent.post('/p/' + submissionId + '/like');

    const recap = notifications.getRecap(author.guestId);
    const batched = recap.rows.find((r) => r.key === 'like-' + submissionId);
    // The named row's key is 'couplelike-<like id>', not the submission id —
    // find it by prefix.
    const namedRow = recap.rows.find((r) => r.key.startsWith('couplelike-'));
    expect(batched).toBeUndefined();
    expect(namedRow).toBeTruthy();
  });

  it('one new couple-like plus three new ordinary likes on the same photo batches the 3, not 4', async () => {
    const author = await makeGuest({ name: 'AC7b Author' });
    const lilly = await makeGuest({ isCouple: true, name: 'Lilly' });
    const submissionId = seedSubmission(author.guestId);

    await lilly.agent.post('/p/' + submissionId + '/like');
    for (let i = 0; i < 3; i += 1) {
      const g = await makeGuest({ name: 'AC7b Other ' + i });
      await g.agent.post('/p/' + submissionId + '/like');
    }

    const recap = notifications.getRecap(author.guestId);
    const batched = recap.rows.find((r) => r.key === 'like-' + submissionId);
    expect(batched).toBeTruthy();
    expect(batched.parts[0].text).toBe('3 people');

    const namedRow = recap.rows.find((r) => r.key.startsWith('couplelike-'));
    expect(namedRow).toBeTruthy();
  });

  it('the unread chip counts exactly what the list renders when both a named and a batched row exist', async () => {
    const author = await makeGuest({ name: 'AC7c Author' });
    const lilly = await makeGuest({ isCouple: true, name: 'Lilly' });
    const submissionId = seedSubmission(author.guestId);

    await lilly.agent.post('/p/' + submissionId + '/like');
    for (let i = 0; i < 3; i += 1) {
      const g = await makeGuest({ name: 'AC7c Other ' + i });
      await g.agent.post('/p/' + submissionId + '/like');
    }

    const recap = notifications.getRecap(author.guestId);
    const unreadRows = recap.rows.filter((r) => r.unread);
    const unreadCount = notifications.getUnreadCount(author.guestId);
    // Chip must count exactly what the list renders — the core AC7 claim.
    // Not asserted as an exact row total: reaching 4 likes on a fresh photo
    // in this isolated test DB can ALSO place it #1 crowd favorite (and, in
    // turn, grant the Crowd Favorite/TOPLIKED badge) — both real, legitimate
    // recap rows this scenario is not trying to suppress. What matters is
    // that both the named couple-like row and the correctly-batched-3
    // ordinary-like row are present, and the chip never disagrees with the
    // list about the total.
    expect(unreadCount).toBe(unreadRows.length);
    const namedRow = unreadRows.find((r) => r.key.startsWith('couplelike-'));
    const batchedRow = unreadRows.find((r) => r.key === 'like-' + submissionId);
    expect(namedRow).toBeTruthy();
    expect(batchedRow).toBeTruthy();
    expect(batchedRow.parts[0].text).toBe('3 people');
  });
});

// ---------------------------------------------------------------------------
// AC8: admin can flag.
// ---------------------------------------------------------------------------
it('AC8: the admin guest-edit form sets and clears guests.is_couple', async () => {
  const { makeAdminAgent } = require('./helpers/testApp');
  const adminAgent = await makeAdminAgent(app);
  const guestId = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run('ac8-guest', 'AC8 Guest').lastInsertRowid;

  await adminAgent
    .post('/admin/guests/' + guestId + '/edit')
    .type('form')
    .send({ name: 'AC8 Guest', is_couple: '1' });
  expect(db.prepare('SELECT is_couple FROM guests WHERE id = ?').get(guestId).is_couple).toBe(1);

  // An absent checkbox key means unchecked. This is deliberately the one kind
  // of field where an absent key still writes: a checkbox that is off sends
  // nothing at all, so absence is its only "off" signal. Contact and PIN take
  // the opposite rule on this same route (absent means leave alone), which is
  // why this post omits them and they stay untouched.
  await adminAgent
    .post('/admin/guests/' + guestId + '/edit')
    .type('form')
    .send({ name: 'AC8 Guest' });
  expect(db.prepare('SELECT is_couple FROM guests WHERE id = ?').get(guestId).is_couple).toBe(0);
});

it('AC8: flipping the flag flips whether that guest’s like renders the mark', async () => {
  // The column alone is not the promise the host is given: the checkbox says
  // "likes show gold". This asserts the RENDERED consequence in both states,
  // through the same guest and the same photo, so a wiring break between the
  // column and the read model cannot pass by writing a 1 nobody reads.
  const { makeAdminAgent } = require('./helpers/testApp');
  const adminAgent = await makeAdminAgent(app);
  const author = await makeGuest({ name: 'AC8b Author' });
  const liker = await makeGuest({ name: 'AC8b Liker' });
  const submissionId = seedSubmission(author.guestId);
  await liker.agent.post('/p/' + submissionId + '/like');

  // Not flagged yet: an ordinary like, no mark.
  const before = await author.agent.get('/feed');
  expect(feedItemChunk(before.text, submissionId)).not.toContain('couple-heart');

  await adminAgent
    .post('/admin/guests/' + liker.guestId + '/edit')
    .type('form')
    .send({ name: 'AC8b Liker', is_couple: '1' });
  const after = await author.agent.get('/feed');
  expect(feedItemChunk(after.text, submissionId)).toContain('couple-heart');

  // Unticking takes the gold back off the same photo.
  await adminAgent
    .post('/admin/guests/' + liker.guestId + '/edit')
    .type('form')
    .send({ name: 'AC8b Liker' });
  const cleared = await author.agent.get('/feed');
  expect(feedItemChunk(cleared.text, submissionId)).not.toContain('couple-heart');
});
