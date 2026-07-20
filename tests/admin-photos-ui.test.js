// tests/admin-photos-ui.test.js
// Issue #259 — admin photos: full guest-gallery parity (favorites,
// tap-into-feed, give-a-badge winner selection). Covers AC2-AC8; AC1 (the
// frozen visual-approval hash) is out of this file's scope per the issue's
// own handoff instructions — the orchestrator re-verifies and re-freezes the
// look after implementation, this suite only proves the real wiring behind
// it behaves correctly.
//
// REQUIRE ORDER: loadApp() must run before any require that pulls in config
// or db (see tests/helpers/testApp.js).
'use strict';

const { loadApp, makeAdminAgent } = require('./helpers/testApp');

let app;
let db;
let adminAgent;

beforeAll(async () => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
  adminAgent = await makeAdminAgent(app, 'photos-ui-admin-pw');
});

function insertGuest(name, token) {
  return db.prepare('INSERT INTO guests (token, name) VALUES (?, ?)').run(token, name)
    .lastInsertRowid;
}

function insertTask(title) {
  return db.prepare('INSERT INTO tasks (title) VALUES (?)').run(title).lastInsertRowid;
}

function insertSubmission({
  guestId,
  taskId = null,
  photoPath,
  thumbPath,
  takenDown = 0,
  photoBonus = 0,
  resubmitted = 0,
}) {
  return db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, photo_bonus, resubmitted)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(guestId, taskId, photoPath, thumbPath, takenDown, photoBonus, resubmitted).lastInsertRowid;
}

/** Slice out the single <figure> tile whose <img src> names this thumb. */
function tileChunk(html, thumbPath) {
  const imgAt = html.indexOf('src="/thumbs/' + thumbPath + '"');
  expect(imgAt).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<figure', imgAt);
  const end = html.indexOf('</figure>', imgAt);
  return html.slice(start, end);
}

/** Slice out the single <article> feed card for a submission id. */
function feedCardChunk(html, submissionId) {
  const marker = 'id="feed-photo-' + submissionId + '"';
  const markerAt = html.indexOf(marker);
  expect(markerAt).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<article', markerAt);
  const end = html.indexOf('</article>', markerAt);
  return html.slice(start, end);
}

/**
 * Everything BEFORE the inline feed panel — the current view's chips/search/
 * grid or groups. The feed panel (data-view-panel="feed") deliberately
 * renders EVERY submission regardless of the active ?view=/?q= (issue #259:
 * tapping any tile from any view must be able to land on that photo's feed
 * card), so a "this photo/heading is absent from the CURRENT VIEW" assertion
 * must be scoped to this slice — checking the whole page text would always
 * find a match inside the always-present feed, view/search notwithstanding.
 */
function gridOnly(html) {
  const feedAt = html.indexOf('<section data-view-panel="feed"');
  expect(feedAt).toBeGreaterThan(-1);
  return html.slice(0, feedAt);
}

// ---------------------------------------------------------------------------
// AC2/AC3 — server-side task/user grouping across 40+ guests, ?q= filters
// group headings, and the search box shows only for task/user views.
// ---------------------------------------------------------------------------
describe('AC2: server-side task/user grouping', () => {
  beforeAll(() => {
    const cakeTaskId = insertTask('AC2 Cake Task');
    const toastTaskId = insertTask('AC2 Toast Task');
    for (let i = 0; i < 20; i++) {
      const gid = insertGuest('AC2 Cake Guest ' + i, 'ac2-cake-' + i);
      insertSubmission({
        guestId: gid,
        taskId: cakeTaskId,
        photoPath: 'ac2-cake-' + i + '.jpg',
        thumbPath: 'ac2-cake-' + i + '-t.jpg',
      });
    }
    for (let i = 0; i < 21; i++) {
      const gid = insertGuest('AC2 Toast Guest ' + i, 'ac2-toast-' + i);
      insertSubmission({
        guestId: gid,
        taskId: toastTaskId,
        photoPath: 'ac2-toast-' + i + '.jpg',
        thumbPath: 'ac2-toast-' + i + '-t.jpg',
      });
    }
  });

  it('view=task groups all 41 seeded photos under their task headings, uncapped', async () => {
    const res = await adminAgent.get('/admin/photos?view=task');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<h2 class="gallery-group-heading">AC2 Cake Task</h2>');
    expect(res.text).toContain('20 photos');
    expect(res.text).toContain('<h2 class="gallery-group-heading">AC2 Toast Task</h2>');
    expect(res.text).toContain('21 photos');
    // Uncapped: every one of the 20 cake tiles is present, no "+N" overlay
    // (that guest-gallery preview cap is deliberately NOT reused here).
    expect(res.text).not.toContain('tile-more');
  });

  it('view=user groups the same photos under each guest heading', async () => {
    const res = await adminAgent.get('/admin/photos?view=user');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<h2 class="gallery-group-heading">AC2 Cake Guest 0</h2>');
    expect(res.text).toContain('<h2 class="gallery-group-heading">AC2 Toast Guest 20</h2>');
  });

  it('?q= filters view=task groups by heading — only the matching task remains', async () => {
    const res = await adminAgent.get('/admin/photos?view=task&q=Toast');
    expect(res.status).toBe(200);
    // Scoped to the grid section: the inline feed panel always renders every
    // task's photos regardless of ?q= (issue #259 — tapping any tile from any
    // view must reach its feed card), so "Cake Task" legitimately still
    // appears further down the page; only the GROUPED view must be filtered.
    const grid = gridOnly(res.text);
    expect(grid).toContain('AC2 Toast Task');
    expect(grid).not.toContain('AC2 Cake Task');
  });

  it('?q= filters view=user groups by heading — only the matching person remains', async () => {
    const res = await adminAgent.get(
      '/admin/photos?view=user&q=' + encodeURIComponent('Cake Guest 5')
    );
    expect(res.status).toBe(200);
    const grid = gridOnly(res.text);
    expect(grid).toContain('<h2 class="gallery-group-heading">AC2 Cake Guest 5</h2>');
    expect(grid).not.toContain('AC2 Cake Guest 0<');
  });

  it('an unrecognized ?view= falls back to recent (HTTP 200, no group headings)', async () => {
    const res = await adminAgent.get('/admin/photos?view=banana');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('gallery-group-heading');
  });
});

describe('AC3: search box shown only for task/user views', () => {
  it('view=recent has no search box', async () => {
    const res = await adminAgent.get('/admin/photos?view=recent');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('class="gallery-search"');
  });

  it('view=fav has no search box', async () => {
    const res = await adminAgent.get('/admin/photos?view=fav');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('class="gallery-search"');
  });

  it('view=task has a search box', async () => {
    const res = await adminAgent.get('/admin/photos?view=task');
    expect(res.status).toBe(200);
    expect(res.text).toContain('class="gallery-search"');
  });

  it('view=user has a search box', async () => {
    const res = await adminAgent.get('/admin/photos?view=user');
    expect(res.status).toBe(200);
    expect(res.text).toContain('class="gallery-search"');
  });
});

// ---------------------------------------------------------------------------
// AC4 — favoriting persists (real DB, not client-only state), the heart
// shows red on both the tile and the feed card, and it appears in view=fav.
// ---------------------------------------------------------------------------
describe('AC4: favorite persists and shows red on tile + feed card', () => {
  let submissionId;

  beforeAll(() => {
    const taskId = insertTask('AC4 Task');
    const guestId = insertGuest('AC4 Guest', 'ac4-guest');
    submissionId = insertSubmission({
      guestId,
      taskId,
      photoPath: 'ac4.jpg',
      thumbPath: 'ac4-t.jpg',
    });
  });

  it('POST .../favorite writes a real admin_favorites row', async () => {
    const res = await adminAgent
      .post('/admin/photos/' + submissionId + '/favorite')
      .type('form')
      .send({ view: 'recent' });
    expect(res.status).toBe(303);
    expect(res.headers.location).toContain('view=recent');

    const row = db
      .prepare('SELECT 1 AS x FROM admin_favorites WHERE submission_id = ?')
      .get(submissionId);
    expect(row).toBeDefined();
  });

  it('view=fav includes the photo, heart shown red (admin-fav-on, aria-pressed=true) on the tile', async () => {
    const res = await adminAgent.get('/admin/photos?view=fav');
    expect(res.status).toBe(200);
    const chunk = tileChunk(res.text, 'ac4-t.jpg');
    expect(chunk).toContain('admin-tile-btn admin-fav admin-fav-on');
    expect(chunk).toContain('aria-pressed="true"');
  });

  it('the inline feed card for the same photo also shows the red (liked) heart', async () => {
    const res = await adminAgent.get('/admin/photos');
    const chunk = feedCardChunk(res.text, submissionId);
    expect(chunk).toContain('like-button admin-feed-fav like-button-liked');
    expect(chunk).toContain('aria-pressed="true"');
  });

  it('persists across a fresh reload with no re-toggle', async () => {
    const res = await adminAgent.get('/admin/photos?view=fav');
    expect(res.text).toContain('/thumbs/ac4-t.jpg');
  });

  it('toggling again removes it from Favorites (real value inversion, not a stuck flag)', async () => {
    const toggleRes = await adminAgent
      .post('/admin/photos/' + submissionId + '/favorite')
      .type('form')
      .send({ view: 'fav' });
    expect(toggleRes.status).toBe(303);

    const row = db
      .prepare('SELECT 1 AS x FROM admin_favorites WHERE submission_id = ?')
      .get(submissionId);
    expect(row).toBeUndefined();

    const favRes = await adminAgent.get('/admin/photos?view=fav');
    // Scoped to the grid: the inline feed panel always renders this photo
    // regardless of favorite state (issue #259's "show everything" feed), so
    // only the Favorites GRID must have dropped it.
    expect(gridOnly(favRes.text)).not.toContain('/thumbs/ac4-t.jpg');
  });

  it('favoriting an unknown submission id redirects with "Submission not found."', async () => {
    const res = await adminAgent.post('/admin/photos/999999/favorite').type('form').send({});
    expect(decodeURIComponent(res.headers.location)).toMatch(/Submission not found\./);
  });
});

// ---------------------------------------------------------------------------
// AC5 — tapping a tile lands on the SAME photo's card in the inline feed,
// which carries its own favorite + give-a-badge controls.
// ---------------------------------------------------------------------------
describe('AC5: tap-into-feed — tile and feed card share one submission id', () => {
  it('the tile trigger and the feed card share the id; the card carries favorite + badge controls', async () => {
    const taskId = insertTask('AC5 Task');
    const guestId = insertGuest('AC5 Guest', 'ac5-guest');
    const submissionId = insertSubmission({
      guestId,
      taskId,
      photoPath: 'ac5.jpg',
      thumbPath: 'ac5-t.jpg',
    });

    const res = await adminAgent.get('/admin/photos');
    expect(res.status).toBe(200);
    expect(res.text).toContain('data-open-feed="' + submissionId + '"');

    const chunk = feedCardChunk(res.text, submissionId);
    expect(chunk).toContain('action="/admin/photos/' + submissionId + '/favorite"');
    expect(chunk).toContain('data-badge-open');
    expect(chunk).toContain('data-id="' + submissionId + '"');
  });
});

// ---------------------------------------------------------------------------
// AC6 — awarding a badge records the photo as a winner, increments N/5,
// keeps the badge control gold, leaves points untouched (no #661 write here).
// ---------------------------------------------------------------------------
describe('AC6: awarding a badge records a winner, increments N/5, no points written', () => {
  let submissionId;

  beforeAll(() => {
    const taskId = insertTask('AC6 Task');
    const guestId = insertGuest('AC6 Guest', 'ac6-guest');
    submissionId = insertSubmission({
      guestId,
      taskId,
      photoPath: 'ac6.jpg',
      thumbPath: 'ac6-t.jpg',
      photoBonus: 3,
    });
  });

  it('SHUTTERBUG starts at 0/5', async () => {
    const res = await adminAgent.get('/admin/photos');
    expect(res.text).toMatch(
      /<span class="admin-badge-count">0\/5<\/span>\s*<span class="admin-badge-name">Shutterbug<\/span>/
    );
  });

  it('POST .../badge action=award code=SHUTTERBUG records the winner row', async () => {
    const res = await adminAgent
      .post('/admin/photos/' + submissionId + '/badge')
      .type('form')
      .send({ code: 'SHUTTERBUG', action: 'award', view: 'recent' });
    expect(res.status).toBe(303);
    expect(res.headers.location).toContain('view=recent');

    const row = db
      .prepare('SELECT 1 AS x FROM badge_winners WHERE badge_code = ? AND submission_id = ?')
      .get('SHUTTERBUG', submissionId);
    expect(row).toBeDefined();
  });

  it('the picker now reads 1/5 for Shutterbug', async () => {
    const res = await adminAgent.get('/admin/photos');
    expect(res.text).toMatch(
      /<span class="admin-badge-count">1\/5<\/span>\s*<span class="admin-badge-name">Shutterbug<\/span>/
    );
  });

  it('the tile badge control stays gold and photo_bonus is unchanged (no points written here)', async () => {
    const res = await adminAgent.get('/admin/photos');
    const chunk = tileChunk(res.text, 'ac6-t.jpg');
    expect(chunk).toContain('admin-badge-tilebtn admin-badge-on');
    expect(chunk).toContain('aria-pressed="true"');

    const row = db.prepare('SELECT photo_bonus FROM submissions WHERE id = ?').get(submissionId);
    expect(row.photo_bonus).toBe(3);
  });

  it('a repeat award is idempotent — the count stays at 1, not 2', async () => {
    await adminAgent
      .post('/admin/photos/' + submissionId + '/badge')
      .type('form')
      .send({ code: 'SHUTTERBUG', action: 'award' });
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM badge_winners WHERE badge_code = ?')
      .get('SHUTTERBUG').n;
    expect(count).toBe(1);
  });

  it('an unknown badge code is refused with "Unknown badge." and writes nothing', async () => {
    const res = await adminAgent
      .post('/admin/photos/' + submissionId + '/badge')
      .type('form')
      .send({ code: 'NOPE', action: 'award' });
    expect(decodeURIComponent(res.headers.location)).toMatch(/Unknown badge\./);
    const row = db.prepare('SELECT 1 AS x FROM badge_winners WHERE badge_code = ?').get('NOPE');
    expect(row).toBeUndefined();
  });

  it('an unknown submission id is refused with "Submission not found."', async () => {
    const res = await adminAgent
      .post('/admin/photos/999999/badge')
      .type('form')
      .send({ code: 'SHUTTERBUG', action: 'award' });
    expect(decodeURIComponent(res.headers.location)).toMatch(/Submission not found\./);
  });
});

// ---------------------------------------------------------------------------
// AC7 — a taken-down photo shows the "Taken down" tile state, drops out of
// the live By-task grouping, and take down/restore return to the SAME view.
// ---------------------------------------------------------------------------
describe('AC7: moderation preserved — Taken down state, and takedown/restore return to the same view', () => {
  let submissionId;

  beforeAll(() => {
    const taskId = insertTask('AC7 Task');
    const guestId = insertGuest('AC7 Guest', 'ac7-guest');
    submissionId = insertSubmission({
      guestId,
      taskId,
      photoPath: 'ac7.jpg',
      thumbPath: 'ac7-t.jpg',
    });
  });

  it('POST takedown with view=task in the body redirects back to ?view=task', async () => {
    const res = await adminAgent
      .post('/admin/photos/' + submissionId + '/takedown')
      .type('form')
      .send({ view: 'task' });
    expect(res.status).toBe(303);
    expect(res.headers.location).toContain('view=task');

    const row = db.prepare('SELECT taken_down FROM submissions WHERE id = ?').get(submissionId);
    expect(row.taken_down).toBe(1);
  });

  it('the Recent wall shows the taken-down state on its tile', async () => {
    const res = await adminAgent.get('/admin/photos');
    const chunk = tileChunk(res.text, 'ac7-t.jpg');
    expect(chunk).toContain('admin-tile is-down');
    expect(chunk).toContain('admin-tile-down">Taken down<');
  });

  it('the By-task grouped view excludes it while taken down (live-only grouping)', async () => {
    const res = await adminAgent.get('/admin/photos?view=task');
    // Scoped to the grid: the inline feed panel always shows a taken-down
    // photo too (marked "Taken down — hidden from guests"), so only the
    // By-task GROUPING (livePhotos-only) must have dropped it.
    expect(gridOnly(res.text)).not.toContain('/thumbs/ac7-t.jpg');
  });

  it('POST restore with view=task in the body redirects back to ?view=task and flips taken_down to 0', async () => {
    const res = await adminAgent
      .post('/admin/photos/' + submissionId + '/restore')
      .type('form')
      .send({ view: 'task' });
    expect(res.status).toBe(303);
    expect(res.headers.location).toContain('view=task');

    const row = db.prepare('SELECT taken_down FROM submissions WHERE id = ?').get(submissionId);
    expect(row.taken_down).toBe(0);
  });

  it('after restore the tile no longer carries the taken-down state, and it is back in By-task', async () => {
    const res = await adminAgent.get('/admin/photos');
    const chunk = tileChunk(res.text, 'ac7-t.jpg');
    expect(chunk).not.toContain('is-down');

    const taskRes = await adminAgent.get('/admin/photos?view=task');
    expect(taskRes.text).toContain('/thumbs/ac7-t.jpg');
  });

  // Issue #684 moved takedown/restore OUT of the give-a-badge dialog (which
  // is now award-only) and into a per-photo kebab (⋯) menu on the feed card
  // — see tests/admin-moderation-684.test.js for the dedicated coverage.
  // This still asserts the tile-level state this AC actually owns.
  it('the tile reflects live state (not taken down) via data-down', async () => {
    const res = await adminAgent.get('/admin/photos');
    const chunk = tileChunk(res.text, 'ac7-t.jpg');
    expect(chunk).toContain('data-down="0"');
  });

  it('takedown on an unknown submission id redirects with "Submission not found."', async () => {
    const res = await adminAgent
      .post('/admin/photos/999999/takedown')
      .type('form')
      .send({ view: 'task' });
    expect(res.headers.location).toContain('view=task');
    expect(decodeURIComponent(res.headers.location)).toMatch(/Submission not found\./);
  });

  // AC7's resubmitted-marker clause: a taken-down photo carrying
  // resubmitted=1 gets the "Resubmitted — review" tile marker; a taken-down
  // photo without it does not. Two fixtures, same taken_down=1, differing
  // only on resubmitted, so the marker's presence/absence is the only
  // variable under test.
  it('a taken-down + resubmitted photo shows the "Resubmitted — review" marker on its tile', async () => {
    const taskId = insertTask('AC7 Resub Task');
    const guestId = insertGuest('AC7 Resub Guest', 'ac7-resub-guest');
    insertSubmission({
      guestId,
      taskId,
      photoPath: 'ac7-resub.jpg',
      thumbPath: 'ac7-resub-t.jpg',
      takenDown: 1,
      resubmitted: 1,
    });

    const res = await adminAgent.get('/admin/photos');
    const chunk = tileChunk(res.text, 'ac7-resub-t.jpg');
    expect(chunk).toContain('admin-tile-resub');
    expect(chunk).toContain('Resubmitted');
  });

  it('a taken-down but NOT-resubmitted photo does not show the resubmitted marker', async () => {
    const taskId = insertTask('AC7 NoResub Task');
    const guestId = insertGuest('AC7 NoResub Guest', 'ac7-noresub-guest');
    insertSubmission({
      guestId,
      taskId,
      photoPath: 'ac7-noresub.jpg',
      thumbPath: 'ac7-noresub-t.jpg',
      takenDown: 1,
      // resubmitted omitted -> defaults to 0, unlike the fixture above.
    });

    const res = await adminAgent.get('/admin/photos');
    const chunk = tileChunk(res.text, 'ac7-noresub-t.jpg');
    expect(chunk).toContain('admin-tile-down">Taken down<');
    expect(chunk).not.toContain('admin-tile-resub');
  });
});

// ---------------------------------------------------------------------------
// AC8 — removing a badge deletes the winner record, decrements N/5, and
// clears the gold highlight.
// ---------------------------------------------------------------------------
describe('AC8: removing a badge decrements N/5 and clears the highlight', () => {
  let submissionId;

  beforeAll(() => {
    const taskId = insertTask('AC8 Task');
    const guestId = insertGuest('AC8 Guest', 'ac8-guest');
    submissionId = insertSubmission({
      guestId,
      taskId,
      photoPath: 'ac8.jpg',
      thumbPath: 'ac8-t.jpg',
    });
  });

  it('award then remove GOLDEN — the count returns to 0/5 and the tile highlight clears', async () => {
    await adminAgent
      .post('/admin/photos/' + submissionId + '/badge')
      .type('form')
      .send({ code: 'GOLDEN', action: 'award' });

    let res = await adminAgent.get('/admin/photos');
    expect(res.text).toMatch(
      /<span class="admin-badge-count">1\/5<\/span>\s*<span class="admin-badge-name">Golden Hour<\/span>/
    );
    let chunk = tileChunk(res.text, 'ac8-t.jpg');
    expect(chunk).toContain('admin-badge-tilebtn admin-badge-on');

    const removeRes = await adminAgent
      .post('/admin/photos/' + submissionId + '/badge')
      .type('form')
      .send({ code: 'GOLDEN', action: 'remove' });
    expect(removeRes.status).toBe(303);

    const row = db
      .prepare('SELECT 1 AS x FROM badge_winners WHERE badge_code = ? AND submission_id = ?')
      .get('GOLDEN', submissionId);
    expect(row).toBeUndefined();

    res = await adminAgent.get('/admin/photos');
    expect(res.text).toMatch(
      /<span class="admin-badge-count">0\/5<\/span>\s*<span class="admin-badge-name">Golden Hour<\/span>/
    );
    chunk = tileChunk(res.text, 'ac8-t.jpg');
    expect(chunk).not.toContain('admin-badge-on');
    expect(chunk).toContain('aria-pressed="false"');
  });

  it('action=toggle flips the OTHER direction once a badge is already held', async () => {
    await adminAgent
      .post('/admin/photos/' + submissionId + '/badge')
      .type('form')
      .send({ code: 'BESTDANCE', action: 'toggle' });
    let held = db
      .prepare('SELECT 1 AS x FROM badge_winners WHERE badge_code = ? AND submission_id = ?')
      .get('BESTDANCE', submissionId);
    expect(held).toBeDefined();

    await adminAgent
      .post('/admin/photos/' + submissionId + '/badge')
      .type('form')
      .send({ code: 'BESTDANCE', action: 'toggle' });
    held = db
      .prepare('SELECT 1 AS x FROM badge_winners WHERE badge_code = ? AND submission_id = ?')
      .get('BESTDANCE', submissionId);
    expect(held).toBeUndefined();
  });

  it('removing a badge the photo never held is a harmless no-op', async () => {
    const res = await adminAgent
      .post('/admin/photos/' + submissionId + '/badge')
      .type('form')
      .send({ code: 'CROWDFAV', action: 'remove' });
    expect(res.status).toBe(303);
    const row = db
      .prepare('SELECT 1 AS x FROM badge_winners WHERE badge_code = ? AND submission_id = ?')
      .get('CROWDFAV', submissionId);
    expect(row).toBeUndefined();
  });
});
