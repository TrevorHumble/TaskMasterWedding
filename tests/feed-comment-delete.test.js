// tests/feed-comment-delete.test.js
// Covers issue #338 acceptance criteria — a guest deleting their own comment:
//   AC1 — owner deletes -> JSON {deleted:true, commentCount:1}; the row is
//         gone from a subsequent load
//   AC2 — a non-owner's delete attempt gets 403; the comment and its count
//         are unchanged
//   AC3 — an anonymous request is refused by requireGuest (403); no row is
//         deleted
//   AC4 — an unknown commentId, and a commentId already deleted once, both
//         404 on the (second) attempt; no row is deleted
//   AC5 — the dialog thread renders the ⋯ actions menu trigger
//         (aria-label "Comment actions"/"More") and the Delete control
//         (data-delete-comment) only on the signed-in guest's own comment
//         rows; another guest's row has neither
//   AC6 — the no-JS path (no Accept: json) redirects to the bounded feed
//         page; deletion still runs
//   AC7 — each own-comment actions menu is a native <details> element whose
//         <summary> is the ⋯ trigger and whose content contains the Delete
//         form (a no-JS-reachable disclosure)
//   AC8 — the menu trigger and the Delete control are quiet plain text: the
//         summary marker is hidden, both are in the tap-highlight-transparent
//         group and the :focus-visible outline group, and Delete carries no
//         button-box background/border
//   AC9 — the Delete form carries the app's destructive-confirm attribute
//         (data-confirm)
//
// Fixture/seeding mirrors tests/photo-comments.test.js and
// tests/feed-card.test.js.
//
// REQUIRE ORDER: config / db / app are required only AFTER loadApp() sets
// DATA_DIR / DB_PATH. Do not hoist requires above the loadApp() call.
'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { JSDOM } = require('jsdom');
const { loadApp } = require('./helpers/testApp');

const THEME_CSS_PATH = path.join(__dirname, '..', 'src', 'public', 'css', 'theme.css');
const THEME_CSS_SOURCE = fs.readFileSync(THEME_CSS_PATH, 'utf8');

let app;
let db;

beforeAll(async () => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
});

/**
 * Insert a guest row with the given token and return { guestId, agent } where
 * agent is a supertest agent already signed in as that guest (same pattern
 * tests/photo-comments.test.js and tests/feed-card.test.js use).
 */
async function signedInGuest(token, name) {
  const guestId = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run(token, name).lastInsertRowid;
  const agent = request.agent(app);
  await agent.get('/j/' + token);
  return { guestId, agent };
}

/** Insert a task + submission and return the submission id. */
function seedSubmission(authorGuestId, opts = {}) {
  const taskId = db
    .prepare(`INSERT INTO tasks (title) VALUES (?)`)
    .run(opts.taskTitle || 'Comment Delete Test Task').lastInsertRowid;
  const submissionId = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, 0)`
    )
    .run(
      authorGuestId,
      taskId,
      opts.photoPath || 'comment-delete-test.jpg',
      opts.thumbPath || 'comment-delete-test-thumb.jpg'
    ).lastInsertRowid;
  return submissionId;
}

/** Post a comment as `commenter` and return its new row id. */
async function postComment(commenterAgent, submissionId, body) {
  await commenterAgent
    .post('/p/' + submissionId + '/comments')
    .type('form')
    .send({ body });
  return db
    .prepare(`SELECT id FROM comments WHERE submission_id = ? AND body = ?`)
    .get(submissionId, body).id;
}

/**
 * Slice out just the feed-item article for one submission id (same pattern
 * as tests/photo-comments.test.js / tests/feed-card.test.js).
 */
function feedItemChunk(body, submissionId) {
  const marker = 'id="photo-' + submissionId + '"';
  const start = body.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const nextArticle = body.indexOf('<article', start + marker.length);
  return body.slice(start, nextArticle === -1 ? body.length : nextArticle);
}

/** Find the balanced {...} block whose '{' is the first at or after fromIndex. */
function extractBalancedBlock(source, fromIndex) {
  const braceStart = source.indexOf('{', fromIndex);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(braceStart, i + 1);
    }
  }
  throw new Error('unbalanced braces from index ' + fromIndex);
}

/** The selector list immediately preceding the block containing `marker`. */
function selectorGroupContaining(source, marker) {
  const idx = source.indexOf(marker);
  expect(idx).toBeGreaterThan(-1);
  const blockStart = source.lastIndexOf('{', idx);
  const selectorsStart = source.lastIndexOf('}', blockStart) + 1;
  return source.slice(selectorsStart, blockStart);
}

// ---------------------------------------------------------------------------
// AC1 — owner deletes: JSON {deleted:true, commentCount:1}; row gone after.
// ---------------------------------------------------------------------------
it('AC1: the owning guest deletes their own comment -> JSON {deleted:true,commentCount:1}, and it is gone from the feed', async () => {
  const author = await signedInGuest('del-ac1-author', 'AC1 Author');
  const commenter = await signedInGuest('del-ac1-commenter', 'AC1 Commenter');
  const other = await signedInGuest('del-ac1-other', 'AC1 Other');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'del-ac1.jpg',
    thumbPath: 'del-ac1t.jpg',
  });

  // 2 comments total on S.
  const commentId = await postComment(commenter.agent, submissionId, 'Mine to delete');
  await postComment(other.agent, submissionId, 'Someone elses');

  const res = await commenter.agent
    .post('/p/' + submissionId + '/comments/' + commentId + '/delete')
    .set('Accept', 'application/json');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ deleted: true, commentCount: 1 });

  const row = db.prepare(`SELECT * FROM comments WHERE id = ?`).get(commentId);
  expect(row).toBeUndefined();

  const feedRes = await commenter.agent.get('/feed');
  const chunk = feedItemChunk(feedRes.text, submissionId);
  expect(chunk).not.toContain('Mine to delete');
  expect(chunk).toContain('Someone elses');
});

// ---------------------------------------------------------------------------
// AC2 — a non-owner's delete attempt is refused; the comment and count stand.
// ---------------------------------------------------------------------------
it("AC2: a non-owner deleting another guest's comment gets 403 and the comment remains", async () => {
  const author = await signedInGuest('del-ac2-author', 'AC2 Author');
  const commenter = await signedInGuest('del-ac2-commenter', 'AC2 Commenter');
  const attacker = await signedInGuest('del-ac2-attacker', 'AC2 Attacker');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'del-ac2.jpg',
    thumbPath: 'del-ac2t.jpg',
  });
  const commentId = await postComment(commenter.agent, submissionId, 'Not yours');

  const res = await attacker.agent
    .post('/p/' + submissionId + '/comments/' + commentId + '/delete')
    .set('Accept', 'application/json');
  expect(res.status).toBe(403);

  const row = db.prepare(`SELECT * FROM comments WHERE id = ?`).get(commentId);
  expect(row).toBeTruthy();
  expect(row.body).toBe('Not yours');
  const count = db
    .prepare(`SELECT COUNT(*) AS n FROM comments WHERE submission_id = ?`)
    .get(submissionId).n;
  expect(count).toBe(1);
});

// ---------------------------------------------------------------------------
// AC3 — anonymous is refused by requireGuest before the handler runs.
// ---------------------------------------------------------------------------
it('AC3: an anonymous request is refused (403) and deletes nothing', async () => {
  const author = await signedInGuest('del-ac3-author', 'AC3 Author');
  const commenter = await signedInGuest('del-ac3-commenter', 'AC3 Commenter');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'del-ac3.jpg',
    thumbPath: 'del-ac3t.jpg',
  });
  const commentId = await postComment(commenter.agent, submissionId, 'stays put');

  const res = await request(app).post('/p/' + submissionId + '/comments/' + commentId + '/delete');
  expect(res.status).toBe(403);

  const row = db.prepare(`SELECT * FROM comments WHERE id = ?`).get(commentId);
  expect(row).toBeTruthy();
});

// ---------------------------------------------------------------------------
// AC4 — an unknown id, and a re-delete of an already-deleted id, both 404.
// ---------------------------------------------------------------------------
describe('AC4: a missing or already-deleted commentId 404s', () => {
  it('a commentId that never existed 404s', async () => {
    const author = await signedInGuest('del-ac4a-author', 'AC4a Author');
    const submissionId = seedSubmission(author.guestId, {
      photoPath: 'del-ac4a.jpg',
      thumbPath: 'del-ac4at.jpg',
    });

    const res = await author.agent
      .post('/p/' + submissionId + '/comments/999999/delete')
      .set('Accept', 'application/json');
    expect(res.status).toBe(404);
  });

  it('deleting the same comment a second time 404s (no row to delete twice)', async () => {
    const author = await signedInGuest('del-ac4b-author', 'AC4b Author');
    const commenter = await signedInGuest('del-ac4b-commenter', 'AC4b Commenter');
    const submissionId = seedSubmission(author.guestId, {
      photoPath: 'del-ac4b.jpg',
      thumbPath: 'del-ac4bt.jpg',
    });
    const commentId = await postComment(commenter.agent, submissionId, 'once');

    const first = await commenter.agent
      .post('/p/' + submissionId + '/comments/' + commentId + '/delete')
      .set('Accept', 'application/json');
    expect(first.status).toBe(200);

    const second = await commenter.agent
      .post('/p/' + submissionId + '/comments/' + commentId + '/delete')
      .set('Accept', 'application/json');
    expect(second.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// AC5 — the ⋯ menu trigger and Delete control render only on the signed-in
// guest's own comment rows; another guest's row has neither.
// ---------------------------------------------------------------------------
it("AC5: the ⋯ menu and Delete control appear only on the viewing guest's own comment rows", async () => {
  const author = await signedInGuest('del-ac5-author', 'AC5 Author');
  const viewer = await signedInGuest('del-ac5-viewer', 'AC5 Viewer');
  const other = await signedInGuest('del-ac5-other', 'AC5 Other');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'del-ac5.jpg',
    thumbPath: 'del-ac5t.jpg',
  });
  const viewerCommentId = await postComment(viewer.agent, submissionId, 'viewer comment');
  const otherCommentId = await postComment(other.agent, submissionId, 'other comment');

  const res = await viewer.agent.get('/feed');
  const dom = new JSDOM(res.text);
  const article = dom.window.document.getElementById('photo-' + submissionId);
  const thread = article.querySelector('.comments-dialog-thread');
  expect(thread).not.toBeNull();

  const ownRow = thread
    .querySelector('[data-delete-comment="' + viewerCommentId + '"]')
    .closest('.feed-comment-item');
  const ownTrigger = ownRow.querySelector('.comment-menu-trigger');
  expect(ownTrigger).not.toBeNull();
  expect(ownTrigger.getAttribute('aria-label')).toMatch(/^(Comment actions|More)$/);
  const ownControl = ownRow.querySelector('[data-delete-comment="' + viewerCommentId + '"]');
  expect(ownControl).not.toBeNull();
  expect(ownControl.textContent.trim()).toMatch(/^Delete( comment)?$/);

  const otherRow = thread
    .querySelector('a[href="/u/' + other.guestId + '"]')
    .closest('.feed-comment-item');
  expect(otherRow.querySelector('.comment-menu-trigger')).toBeNull();
  expect(otherRow.querySelector('[data-delete-comment="' + otherCommentId + '"]')).toBeNull();
});

// ---------------------------------------------------------------------------
// AC6 — no-JS path: a plain POST redirects to the bounded feed page, and
// deletion still runs (not just the JSON path).
// ---------------------------------------------------------------------------
it('AC6: a plain POST (no JSON Accept) redirects to /feed?from=S#photo-S and still deletes the row', async () => {
  const author = await signedInGuest('del-ac6-author', 'AC6 Author');
  const commenter = await signedInGuest('del-ac6-commenter', 'AC6 Commenter');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'del-ac6.jpg',
    thumbPath: 'del-ac6t.jpg',
  });
  const commentId = await postComment(commenter.agent, submissionId, 'plain post delete');

  const res = await commenter.agent
    .post('/p/' + submissionId + '/comments/' + commentId + '/delete')
    .type('form');
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe('/feed?from=' + submissionId + '#photo-' + submissionId);

  const row = db.prepare(`SELECT * FROM comments WHERE id = ?`).get(commentId);
  expect(row).toBeUndefined();
});

// ---------------------------------------------------------------------------
// AC7 — each own-comment actions menu is a native <details> whose <summary>
// is the ⋯ trigger and whose content contains the Delete form.
// ---------------------------------------------------------------------------
it('AC7: the own-comment actions menu is a native <details>/<summary> disclosure containing Delete', async () => {
  const author = await signedInGuest('del-ac7-author', 'AC7 Author');
  const viewer = await signedInGuest('del-ac7-viewer', 'AC7 Viewer');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'del-ac7.jpg',
    thumbPath: 'del-ac7t.jpg',
  });
  await postComment(viewer.agent, submissionId, 'own comment for AC7');

  const res = await viewer.agent.get('/feed');
  const dom = new JSDOM(res.text);
  const article = dom.window.document.getElementById('photo-' + submissionId);
  const menu = article.querySelector('.comment-menu');
  expect(menu).not.toBeNull();
  expect(menu.tagName).toBe('DETAILS');

  const summary = menu.querySelector(':scope > summary');
  expect(summary).not.toBeNull();
  expect(summary.className).toContain('comment-menu-trigger');

  const deleteControl = menu.querySelector('[data-delete-comment]');
  expect(deleteControl).not.toBeNull();
  // Sanity: a plain <p> would fail this same assertion, so the test would
  // catch a regression back to the old always-visible inline link.
  expect(menu.querySelector('form.comment-delete-form')).not.toBeNull();
});

// ---------------------------------------------------------------------------
// AC8 — the menu trigger and Delete are quiet plain text: summary marker
// hidden, tap-highlight/focus-visible groups, Delete has no button box.
// ---------------------------------------------------------------------------
describe('AC8: the ⋯ trigger and Delete are quiet plain text, not boxed controls', () => {
  it('.comment-menu-trigger hides the default <summary> disclosure marker', () => {
    const idx = THEME_CSS_SOURCE.indexOf('.comment-menu-trigger {');
    expect(idx).toBeGreaterThan(-1);
    const rule = extractBalancedBlock(THEME_CSS_SOURCE, idx);
    expect(rule).toContain('list-style: none');

    const markerIdx = THEME_CSS_SOURCE.indexOf('.comment-menu-trigger::-webkit-details-marker');
    expect(markerIdx).toBeGreaterThan(-1);
    const markerRule = extractBalancedBlock(THEME_CSS_SOURCE, markerIdx);
    expect(markerRule).toContain('display: none');
  });

  it('.comment-menu-trigger and .comment-delete are in the tap-highlight-transparent selector group', () => {
    const selectors = selectorGroupContaining(
      THEME_CSS_SOURCE,
      '-webkit-tap-highlight-color: transparent;'
    );
    expect(selectors).toContain('.comment-menu-trigger');
    expect(selectors).toContain('.comment-delete');
  });

  it('.comment-menu-trigger:focus-visible and .comment-delete:focus-visible are in the outline selector group', () => {
    const selectors = selectorGroupContaining(
      THEME_CSS_SOURCE,
      'outline: 2px solid var(--color-primary);'
    );
    expect(selectors).toContain('.comment-menu-trigger:focus-visible');
    expect(selectors).toContain('.comment-delete:focus-visible');
  });

  it('the .comment-delete rule itself carries no button-box background/border', () => {
    const idx = THEME_CSS_SOURCE.indexOf('.comment-delete {');
    expect(idx).toBeGreaterThan(-1);
    const rule = extractBalancedBlock(THEME_CSS_SOURCE, idx);
    expect(rule).toContain('border: none');
    expect(rule).toContain('background: none');
  });
});

// ---------------------------------------------------------------------------
// AC9 — the Delete form carries the app's destructive-confirm attribute.
// ---------------------------------------------------------------------------
it('AC9: the Delete form carries data-confirm, matching the destructive-confirm convention', async () => {
  const author = await signedInGuest('del-ac9-author', 'AC9 Author');
  const viewer = await signedInGuest('del-ac9-viewer', 'AC9 Viewer');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'del-ac9.jpg',
    thumbPath: 'del-ac9t.jpg',
  });
  await postComment(viewer.agent, submissionId, 'own comment for AC9');

  const res = await viewer.agent.get('/feed');
  const dom = new JSDOM(res.text);
  const article = dom.window.document.getElementById('photo-' + submissionId);
  const form = article.querySelector('form.comment-delete-form');
  expect(form).not.toBeNull();
  expect(form.getAttribute('data-confirm')).toBeTruthy();
});
