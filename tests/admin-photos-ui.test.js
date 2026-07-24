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
// which carries its own favorite control (the give-a-badge control this AC
// originally also asserted is retired — see the AC6/AC8 replacement below).
// ---------------------------------------------------------------------------
describe('AC5: tap-into-feed — tile and feed card share one submission id', () => {
  it('the tile trigger and the feed card share the id; the card carries the favorite control', async () => {
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
  });
});

// ---------------------------------------------------------------------------
// AC6/AC8 (issue #259) — RETIRED (issue #661's one-badge-system
// consolidation). The five-code give-a-badge photo-winner picker these two
// ACs originally covered (photo-badges.js, badge_winners, POST
// /admin/photos/:id/badge, the admin-badge-* dialog markup) is deleted
// outright — ranking and awarding a task's photos now happens on
// GET/POST /admin/tasks/:id/rank (see tests/task-badge-rank-release.test.js).
// Same "blanket retirement, not a not-found guard" shape as
// tests/admin-moderation-684.test.js's own AC7 (POST /admin/photos/:id/points).
// ---------------------------------------------------------------------------
describe('AC6/AC8 (retired by #661): POST /admin/photos/:id/badge is gone', () => {
  it('returns a real 404 for an existing submission id, and writes nothing', async () => {
    const taskId = insertTask('AC6 Retired Task');
    const guestId = insertGuest('AC6 Retired Guest', 'ac6-retired-guest');
    const submissionId = insertSubmission({
      guestId,
      taskId,
      photoPath: 'ac6-retired.jpg',
      thumbPath: 'ac6-retired-t.jpg',
      photoBonus: 3,
    });

    const res = await adminAgent
      .post('/admin/photos/' + submissionId + '/badge')
      .type('form')
      .send({ code: 'SHUTTERBUG', action: 'award', view: 'recent' });
    expect(res.status).toBe(404);
    expect(res.headers.location).toBeUndefined();

    // No give-a-badge markup or table survives to check against — the
    // module (photo-badges.js) and its badge_winners table are both gone.
    // The only remaining fact worth asserting is that the retired POST left
    // the photo's own row untouched.
    const row = db.prepare('SELECT photo_bonus FROM submissions WHERE id = ?').get(submissionId);
    expect(row.photo_bonus).toBe(3);
  });

  it('returns 404 for an unknown submission id too (blanket retirement, not a not-found guard)', async () => {
    const res = await adminAgent
      .post('/admin/photos/999999/badge')
      .type('form')
      .send({ code: 'SHUTTERBUG', action: 'award' });
    expect(res.status).toBe(404);
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
  // — see tests/admin-moderation-684.test.js for the dedicated coverage. The
  // tile-level "not taken down" assertion this AC actually owns is the
  // `not.toContain('is-down')` check in the preceding test — this file used
  // to duplicate it via a `data-down` attribute that lived exclusively on
  // the give-a-badge trigger button; issue #661 deleted that button along
  // with the rest of the give-a-badge dialog, taking `data-down` with it, so
  // there is no second mechanism left to assert this same fact through.

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
// Issue #748 — GET /admin/photos?view=task&task=<id> scopes the by-task wall
// to a single task: taken-down submissions included (moderation), q ignored,
// and the scope carried through every mutating form's redirect.
// ---------------------------------------------------------------------------
describe('#748: task-scoped view=task&task=<id>', () => {
  describe("AC1: the scoped group holds exactly that task's 4 submissions (taken-down included, other tasks/memories excluded)", () => {
    let scopedTaskId;

    beforeAll(() => {
      scopedTaskId = insertTask('748 Scoped Task');
      const otherTaskId = insertTask('748 Other Task');

      const g1 = insertGuest('748 Scoped Guest 1', '748-scoped-1');
      const g2 = insertGuest('748 Scoped Guest 2', '748-scoped-2');
      const g3 = insertGuest('748 Scoped Guest 3', '748-scoped-3');
      const g4 = insertGuest('748 Scoped Guest 4', '748-scoped-4');
      insertSubmission({
        guestId: g1,
        taskId: scopedTaskId,
        photoPath: '748-s1.jpg',
        thumbPath: '748-s1-t.jpg',
      });
      insertSubmission({
        guestId: g2,
        taskId: scopedTaskId,
        photoPath: '748-s2.jpg',
        thumbPath: '748-s2-t.jpg',
      });
      insertSubmission({
        guestId: g3,
        taskId: scopedTaskId,
        photoPath: '748-s3.jpg',
        thumbPath: '748-s3-t.jpg',
      });
      insertSubmission({
        guestId: g4,
        taskId: scopedTaskId,
        photoPath: '748-s4-down.jpg',
        thumbPath: '748-s4-down-t.jpg',
        takenDown: 1,
      });

      // Noise the scoped group must exclude: another task's submission, and a
      // memory (task_id NULL).
      const gOther = insertGuest('748 Other Guest', '748-other');
      insertSubmission({
        guestId: gOther,
        taskId: otherTaskId,
        photoPath: '748-other.jpg',
        thumbPath: '748-other-t.jpg',
      });
      const gMem = insertGuest('748 Memory Guest', '748-memory');
      insertSubmission({
        guestId: gMem,
        taskId: null,
        photoPath: '748-memory.jpg',
        thumbPath: '748-memory-t.jpg',
      });
    });

    it('renders exactly one group headed by the task title, containing all 4 submissions and no others', async () => {
      const res = await adminAgent.get('/admin/photos?view=task&task=' + scopedTaskId);
      expect(res.status).toBe(200);
      const grid = gridOnly(res.text);
      expect(grid).toContain('<h2 class="gallery-group-heading">748 Scoped Task</h2>');
      // Exactly one group — no other task's group renders alongside it.
      expect((grid.match(/gallery-group-heading/g) || []).length).toBe(1);
      expect(grid).toContain('/thumbs/748-s1-t.jpg');
      expect(grid).toContain('/thumbs/748-s2-t.jpg');
      expect(grid).toContain('/thumbs/748-s3-t.jpg');
      expect(grid).toContain('/thumbs/748-s4-down-t.jpg');
      expect(grid).not.toContain('/thumbs/748-other-t.jpg');
      expect(grid).not.toContain('/thumbs/748-memory-t.jpg');
    });

    it('the taken-down submission is included and marked "Taken down" (moderation needs it visible)', async () => {
      const res = await adminAgent.get('/admin/photos?view=task&task=' + scopedTaskId);
      const chunk = tileChunk(res.text, '748-s4-down-t.jpg');
      expect(chunk).toContain('admin-tile-down">Taken down<');
    });

    it('the page H1 count reads "4 photos"; the group count is now the rank-and-award link (issue #812 AC2 supersedes the plain span for a real task group)', async () => {
      const res = await adminAgent.get('/admin/photos?view=task&task=' + scopedTaskId);
      expect(res.text).toContain('<span class="gallery-count">4 photos</span>');
      expect(res.text).toContain(
        '<a class="gallery-group-count gallery-group-rank" href="/admin/tasks/' +
          scopedTaskId +
          '/rank">4 photos to rank and award</a>'
      );
      expect(res.text).not.toContain('<span class="gallery-group-count">4 photos</span>');
    });
  });

  describe('AC2: a task with no submissions renders the visible empty state, not a blank body', () => {
    it('responds 200 with "No photos submitted yet." and no group heading', async () => {
      const emptyTaskId = insertTask('748 Empty Task');
      const res = await adminAgent.get('/admin/photos?view=task&task=' + emptyTaskId);
      expect(res.status).toBe(200);
      const grid = gridOnly(res.text);
      expect(grid).toContain('No photos submitted yet.');
      expect(grid).not.toContain('gallery-group-heading');
    });
  });

  describe('AC3: an absent, non-numeric, or unknown task param leaves the request unscoped', () => {
    let taskAId;
    let taskBId;

    beforeAll(() => {
      taskAId = insertTask('748 Wall Task A');
      taskBId = insertTask('748 Wall Task B');
      const gA = insertGuest('748 Wall Guest A', '748-wall-a');
      const gB = insertGuest('748 Wall Guest B', '748-wall-b');
      insertSubmission({
        guestId: gA,
        taskId: taskAId,
        photoPath: '748-wall-a.jpg',
        thumbPath: '748-wall-a-t.jpg',
      });
      insertSubmission({
        guestId: gB,
        taskId: taskBId,
        photoPath: '748-wall-b.jpg',
        thumbPath: '748-wall-b-t.jpg',
      });
    });

    it('an absent task renders the full by-task wall (both tasks grouped) — not view=recent', async () => {
      const res = await adminAgent.get('/admin/photos?view=task');
      expect(res.status).toBe(200);
      const grid = gridOnly(res.text);
      expect(grid).toContain('748 Wall Task A');
      expect(grid).toContain('748 Wall Task B');
      // Proves this is still the task/user view, not the recent fallback,
      // which never shows a search box (AC3 of issue #259).
      expect(res.text).toContain('class="gallery-search"');
    });

    it('a non-numeric task (e.g. "12abc") renders the full by-task wall', async () => {
      const res = await adminAgent.get('/admin/photos?view=task&task=12abc');
      expect(res.status).toBe(200);
      const grid = gridOnly(res.text);
      expect(grid).toContain('748 Wall Task A');
      expect(grid).toContain('748 Wall Task B');
    });

    it('an unknown task id renders the full by-task wall', async () => {
      const res = await adminAgent.get('/admin/photos?view=task&task=999999');
      expect(res.status).toBe(200);
      const grid = gridOnly(res.text);
      expect(grid).toContain('748 Wall Task A');
      expect(grid).toContain('748 Wall Task B');
    });

    it('a repeated task param (Express hands back an array) renders the full by-task wall', async () => {
      const res = await adminAgent.get(
        '/admin/photos?view=task&task=' + taskAId + '&task=' + taskBId
      );
      expect(res.status).toBe(200);
      const grid = gridOnly(res.text);
      expect(grid).toContain('748 Wall Task A');
      expect(grid).toContain('748 Wall Task B');
    });
  });

  describe('AC4: a mutating POST from the scoped view redirects back to the same scope', () => {
    let scopedTaskId;
    let submissionId;

    beforeAll(() => {
      scopedTaskId = insertTask('748 Mutate Task');
      const guestId = insertGuest('748 Mutate Guest', '748-mutate');
      submissionId = insertSubmission({
        guestId,
        taskId: scopedTaskId,
        photoPath: '748-mutate.jpg',
        thumbPath: '748-mutate-t.jpg',
      });
    });

    it('takedown redirects to a Location containing view=task and task=<id>', async () => {
      const res = await adminAgent
        .post('/admin/photos/' + submissionId + '/takedown')
        .type('form')
        .send({ view: 'task', task: String(scopedTaskId) });
      expect(res.status).toBe(303);
      expect(res.headers.location).toContain('view=task');
      expect(res.headers.location).toContain('task=' + scopedTaskId);
    });

    it('restore redirects to a Location containing view=task and task=<id>', async () => {
      const res = await adminAgent
        .post('/admin/photos/' + submissionId + '/restore')
        .type('form')
        .send({ view: 'task', task: String(scopedTaskId) });
      expect(res.status).toBe(303);
      expect(res.headers.location).toContain('view=task');
      expect(res.headers.location).toContain('task=' + scopedTaskId);
    });

    it('favorite redirects to a Location containing view=task and task=<id>', async () => {
      const res = await adminAgent
        .post('/admin/photos/' + submissionId + '/favorite')
        .type('form')
        .send({ view: 'task', task: String(scopedTaskId) });
      expect(res.status).toBe(303);
      expect(res.headers.location).toContain('view=task');
      expect(res.headers.location).toContain('task=' + scopedTaskId);
    });

    // The badge-award redirect case this block originally covered is gone
    // along with the route itself (issue #661 retires POST
    // /admin/photos/:id/badge outright — see the AC6/AC8 replacement
    // describe block above) — a 404 carries no Location to assert against.

    it('an absent task field produces no task= in the redirect (pre-#748 behavior unaffected)', async () => {
      const res = await adminAgent
        .post('/admin/photos/' + submissionId + '/favorite')
        .type('form')
        .send({ view: 'recent' });
      expect(res.status).toBe(303);
      expect(res.headers.location).toContain('view=recent');
      expect(res.headers.location).not.toContain('task=');
    });

    // The redirect assertions above synthesize the POST body themselves, so
    // they would still pass if the page rendered no `task` field at all —
    // i.e. if a real host's click sent nothing to carry. This asserts the
    // view half of that round-trip: the scope is actually in the markup the
    // browser posts back, and is blank (not 'undefined'/'null') when there
    // is no scope to carry.
    it('a scoped page renders the hidden task field, and an unscoped page renders it empty', async () => {
      const scoped = await adminAgent.get('/admin/photos?view=task&task=' + scopedTaskId);
      expect(scoped.status).toBe(200);
      expect(scoped.text).toContain('name="task" value="' + scopedTaskId + '"');

      const unscoped = await adminAgent.get('/admin/photos?view=recent');
      expect(unscoped.status).toBe(200);
      expect(unscoped.text).toContain('name="task" value=""');
      expect(unscoped.text).not.toContain('name="task" value="' + scopedTaskId + '"');
    });
  });

  describe('AC5 (superseded by issue #812 AC1): the Tasks admin page photo-count link', () => {
    // #812 replaced the view=task&task=<id> gallery-scope destination this
    // link used to carry with a direct door to that task's Rank & award page
    // — the full behavioral coverage for the new destination and its exact
    // link text now lives in tests/admin-tasks-ui.test.js's "issue #812 AC1"
    // describe block. This case is kept, updated to the current href, so the
    // fact "the Tasks list photo-count control targets /rank, not the scoped
    // gallery" stays proven in this file too, not silently deleted.
    it('the admin-task-photos href now reads /admin/tasks/<id>/rank, not the retired view=task&task= destination', async () => {
      const taskId = insertTask('748 Link Task');
      const guestId = insertGuest('748 Link Guest', '748-link');
      insertSubmission({
        guestId,
        taskId,
        photoPath: '748-link.jpg',
        thumbPath: '748-link-t.jpg',
      });

      const res = await adminAgent.get('/admin/tasks');
      expect(res.status).toBe(200);
      expect(res.text).toContain('href="/admin/tasks/' + taskId + '/rank"');
      expect(res.text).not.toContain('href="/admin/photos?view=task&amp;task=' + taskId + '"');
    });
  });

  describe("AC6: a scoped URL with ?q= ignores q and still renders the task's group", () => {
    it('the scope wins regardless of whether q matches the task title', async () => {
      const taskId = insertTask('748 Query Task');
      const guestId = insertGuest('748 Query Guest', '748-query');
      insertSubmission({
        guestId,
        taskId,
        photoPath: '748-query.jpg',
        thumbPath: '748-query-t.jpg',
      });

      const res = await adminAgent.get(
        '/admin/photos?view=task&task=' +
          taskId +
          '&q=' +
          encodeURIComponent('totally unrelated text')
      );
      expect(res.status).toBe(200);
      const grid = gridOnly(res.text);
      expect(grid).toContain('<h2 class="gallery-group-heading">748 Query Task</h2>');
      expect(grid).toContain('/thumbs/748-query-t.jpg');
    });
  });
});

// ---------------------------------------------------------------------------
// Issue #812 AC2/AC3 — the by-task gallery's group count doubles as the same
// door to Rank & award as the Tasks list (AC2), but only for a real task
// group; the task-less "Memories" group and every By-person group stay a
// plain, unlinked count (AC3 guard) so the rank-and-award affordance never
// leaks onto a group with no task to rank.
// ---------------------------------------------------------------------------
describe('issue #812 AC2: by-task gallery count is the rank-and-award link', () => {
  it('a real task group (view=task) renders <a class="gallery-group-count gallery-group-rank" href="/admin/tasks/<that task id>/rank">, text ending "to rank and award"', async () => {
    const taskId = insertTask('812 Gallery Rank Task');
    for (let i = 0; i < 3; i++) {
      const gid = insertGuest('812 Gallery Rank Guest ' + i, '812-gallery-rank-' + i);
      insertSubmission({
        guestId: gid,
        taskId,
        photoPath: '812-gallery-rank-' + i + '.jpg',
        thumbPath: '812-gallery-rank-' + i + '-t.jpg',
      });
    }

    const res = await adminAgent.get('/admin/photos?view=task');
    expect(res.status).toBe(200);
    const grid = gridOnly(res.text);

    // Tied to the real seeded task id and its real count (3) — would fail if
    // the href pointed at another task's id, or at the retired
    // ?view=task&task=<id> gallery-scope destination.
    expect(grid).toContain(
      '<a class="gallery-group-count gallery-group-rank" href="/admin/tasks/' +
        taskId +
        '/rank">3 photos to rank and award</a>'
    );
  });

  it('singular count (n === 1) reads "1 photo to rank and award"', async () => {
    const taskId = insertTask('812 Gallery Rank Singular Task');
    const gid = insertGuest('812 Gallery Rank Singular Guest', '812-gallery-rank-singular');
    insertSubmission({
      guestId: gid,
      taskId,
      photoPath: '812-gallery-rank-singular.jpg',
      thumbPath: '812-gallery-rank-singular-t.jpg',
    });

    const res = await adminAgent.get('/admin/photos?view=task');
    expect(res.status).toBe(200);
    expect(gridOnly(res.text)).toContain(
      '<a class="gallery-group-count gallery-group-rank" href="/admin/tasks/' +
        taskId +
        '/rank">1 photo to rank and award</a>'
    );
  });
});

describe('issue #812 AC3: non-task group counts stay a plain, unlinked span', () => {
  it('view=user renders every group count as <span class="gallery-group-count">, never gallery-group-rank or a /rank href', async () => {
    const taskId = insertTask('812 Guard User View Task');
    const gid = insertGuest('812 Guard User Guest', '812-guard-user');
    insertSubmission({
      guestId: gid,
      taskId,
      photoPath: '812-guard-user.jpg',
      thumbPath: '812-guard-user-t.jpg',
    });

    const res = await adminAgent.get('/admin/photos?view=user');
    expect(res.status).toBe(200);
    const grid = gridOnly(res.text);

    // The real value: this guest's own group count is a bare span with the
    // real count text, not an anchor — proven against the actual seeded
    // guest/count, not just "some span exists somewhere".
    expect(grid).toContain('<span class="gallery-group-count">1 photo</span>');
    expect(grid).not.toContain('gallery-group-rank');
    expect(grid).not.toContain('/rank">');
  });

  it('the task-less "Memories" group in view=task (photos with null task_id) also stays a plain span, no rank link', async () => {
    const gid = insertGuest('812 Guard Memory Guest', '812-guard-memory');
    insertSubmission({
      guestId: gid,
      taskId: null,
      photoPath: '812-guard-memory.jpg',
      thumbPath: '812-guard-memory-t.jpg',
    });

    // Earlier tests in this shared-DB file may have already seeded other
    // null-task_id ("Memories") submissions, so the real live count is not
    // necessarily 1 — read it back from the DB rather than assume, so the
    // assertion still ties to the actual rendered VALUE instead of going
    // structure-only.
    const expectedCount = db
      .prepare('SELECT COUNT(*) AS n FROM submissions WHERE task_id IS NULL AND taken_down = 0')
      .get().n;

    const res = await adminAgent.get('/admin/photos?view=task');
    expect(res.status).toBe(200);
    const grid = gridOnly(res.text);

    // The Memories heading's own count sits right after its heading; assert
    // the plain-span form is present with the real count and that no anchor
    // variant of THIS group's count leaked in — the file's other tests
    // already prove real task groups DO render the anchor, so a global "no
    // gallery-group-rank anywhere" assertion would be too strong (and wrong)
    // here; this checks the Memories group specifically via its
    // heading-adjacent count.
    const headingAt = grid.indexOf('<h2 class="gallery-group-heading">Memories</h2>');
    expect(headingAt).toBeGreaterThan(-1);
    const afterHeading = grid.slice(headingAt, headingAt + 400);
    expect(afterHeading).toContain(
      '<span class="gallery-group-count">' +
        expectedCount +
        ' photo' +
        (expectedCount === 1 ? '' : 's') +
        '</span>'
    );
    expect(afterHeading).not.toContain('gallery-group-rank');
    expect(afterHeading).not.toContain('/rank"');
  });
});
