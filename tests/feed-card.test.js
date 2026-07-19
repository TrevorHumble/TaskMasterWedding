// tests/feed-card.test.js
// Covers issue #248 (feed card v2) acceptance criteria. Fixture/seeding
// mirrors tests/photo-likes.test.js and tests/photo-comments.test.js; the
// behavioral popup test mirrors tests/upload-ux.test.js's pattern of
// requiring the real src/public/js/feed.js into a synthetic jsdom document.
//
//   AC1 — like toggle: POST /p/:id/like with Accept: application/json ->
//         {liked:true, likeCount:2} then {liked:false, likeCount:1}
//   AC2 — exactly 4 clamped comment rows for 6 comments (the 4 MOST
//         RECENT), exactly 3 rows for 3 comments, 0 rows/no See-all for 0
//         comments; "See all <N> comments" opens the popup; the row CSS
//         clamps to one line
//   AC3 — guest name anchor precedes <img>; points span is right-justified
//   AC4 — .like-button carries a 44x44 minimum tap-target CSS rule
//   AC5 (amended 2026-07-08) — no comment field in the card's inline DOM;
//         the field lives only inside a <dialog> that carries no `open`
//         attribute in served HTML; activating the comment button or the
//         See-all line opens it via showModal() (one dialog at a time),
//         focuses the textarea, and shows the full thread + a `Post`
//         control (`Send` absent); placeholder is literally "Add a comment";
//         "Blurry feet" is absent
//   AC6 — the like pop animation is wrapped in a prefers-reduced-motion guard
//   AC7 — the heart is an inline <svg>; the literal &hearts; entity is absent
//   AC8 (new) — the comments POST answers { comment, commentCount } JSON to
//         Accept: application/json; a plain POST still redirects
//   AC9 (new) — a ::backdrop rule exists; .feed-item reads
//         contain-intrinsic-size: auto 600px; feed.js carries a
//         scrollHeight-driven textarea auto-grow handler
//
// jsdom note (amendment's implementer note): the installed jsdom (29.1.1)
// exposes HTMLDialogElement with only the `open` property — no
// showModal/close (verified: Object.getOwnPropertyNames(prototype) is
// ['constructor', 'open']). Per the amendment, the AC5 behavioral test stubs
// showModal/close minimally (flipping `open`) and asserts the open-attribute
// transitions, with a spy proving showModal() is feed.js's call path.
//
// REQUIRE ORDER: config / db / app are required only AFTER loadApp() sets
// DATA_DIR / DB_PATH. Do not hoist requires above the loadApp() call.
'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { JSDOM } = require('jsdom');
const { loadApp, signInGuest } = require('./helpers/testApp');

const THEME_CSS_PATH = path.join(__dirname, '..', 'src', 'public', 'css', 'theme.css');
const FEED_EJS_PATH = path.join(__dirname, '..', 'src', 'views', 'feed.ejs');
const FEED_JS_PATH = path.join(__dirname, '..', 'src', 'public', 'js', 'feed.js');
const COMMUNITY_ROUTE_PATH = path.join(__dirname, '..', 'src', 'routes', 'community.js');
const THEME_CSS_SOURCE = fs.readFileSync(THEME_CSS_PATH, 'utf8');
const FEED_EJS_SOURCE = fs.readFileSync(FEED_EJS_PATH, 'utf8');
const FEED_JS_SOURCE = fs.readFileSync(FEED_JS_PATH, 'utf8');
const COMMUNITY_ROUTE_SOURCE = fs.readFileSync(COMMUNITY_ROUTE_PATH, 'utf8');

let app;
let db;

beforeAll(async () => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
});

/**
 * Insert a guest row with the given token and return { guestId, agent } where
 * agent is a supertest agent already signed in as that guest (mirrors
 * tests/photo-likes.test.js signedInGuest).
 */
async function signedInGuest(token, name) {
  const guestId = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run(token, name).lastInsertRowid;
  const agent = request.agent(app);
  signInGuest(app, token, agent);
  return { guestId, agent };
}

/** Insert a task + submission and return the submission id. */
function seedSubmission(authorGuestId, opts = {}) {
  const taskId = db
    .prepare(`INSERT INTO tasks (title) VALUES (?)`)
    .run(opts.taskTitle || 'Feed Card Test Task').lastInsertRowid;
  const submissionId = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, 0)`
    )
    .run(
      authorGuestId,
      taskId,
      opts.photoPath || 'card-test.jpg',
      opts.thumbPath || 'card-test-thumb.jpg'
    ).lastInsertRowid;
  return submissionId;
}

/** Insert `n` comments on a submission, bodies "Comment 1".."Comment n", in order. */
function seedComments(submissionId, commenterGuestId, n) {
  for (let i = 1; i <= n; i++) {
    db.prepare(`INSERT INTO comments (submission_id, guest_id, body) VALUES (?, ?, ?)`).run(
      submissionId,
      commenterGuestId,
      'Comment ' + i
    );
  }
}

/**
 * Slice out just the <article id="photo-<id>"> ... markup for one submission,
 * so assertions about one photo never bleed into another (same pattern as
 * tests/photo-likes.test.js / tests/photo-comments.test.js).
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

function allIndicesOf(source, needle) {
  const out = [];
  let i = source.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = source.indexOf(needle, i + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// AC1 — like toggle: JSON path, both halves, real counts.
// ---------------------------------------------------------------------------
describe('AC1: like toggle answers JSON with the real liked state and count', () => {
  it('a signed-in guest toggling a like gets {liked:true,likeCount:2} then {liked:false,likeCount:1}', async () => {
    const author = await signedInGuest('card-ac1-author', 'AC1 Author');
    const otherLiker = await signedInGuest('card-ac1-other', 'AC1 Other Liker');
    const guest = await signedInGuest('card-ac1-guest', 'AC1 Guest');
    const submissionId = seedSubmission(author.guestId, {
      photoPath: 'ac1.jpg',
      thumbPath: 'ac1t.jpg',
    });
    // One pre-existing like from someone else, so the starting count is 1.
    await otherLiker.agent.post('/p/' + submissionId + '/like');

    const likeRes = await guest.agent
      .post('/p/' + submissionId + '/like')
      .set('Accept', 'application/json');
    expect(likeRes.status).toBe(200);
    expect(likeRes.body).toEqual({ liked: true, likeCount: 2 });

    const unlikeRes = await guest.agent
      .post('/p/' + submissionId + '/like')
      .set('Accept', 'application/json');
    expect(unlikeRes.status).toBe(200);
    expect(unlikeRes.body).toEqual({ liked: false, likeCount: 1 });
  });
});

// ---------------------------------------------------------------------------
// AC2 — exactly 4 clamped rows (6 comments) / exactly 3 rows (3 comments);
// "See all <N> comments" text; the row CSS clamps to one line.
// ---------------------------------------------------------------------------
describe('AC2: comment rows and the See-all line', () => {
  it('a photo with 6 comments renders exactly the 4 MOST RECENT as rows, plus "See all 6 comments"', async () => {
    const author = await signedInGuest('card-ac2-author', 'AC2 Author');
    const commenter = await signedInGuest('card-ac2-commenter', 'AC2 Commenter');
    const submissionId = seedSubmission(author.guestId, {
      photoPath: 'ac2-six.jpg',
      thumbPath: 'ac2-six-t.jpg',
    });
    seedComments(submissionId, commenter.guestId, 6);

    const res = await author.agent.get('/feed');
    expect(res.status).toBe(200);

    const dom = new JSDOM(res.text);
    const article = dom.window.document.getElementById('photo-' + submissionId);
    expect(article).not.toBeNull();

    const rows = article.querySelectorAll('.feed-comment-row');
    expect(rows.length).toBe(4);
    // The 4 MOST RECENT, in chronological order — not just any 4, and not
    // the 4 oldest.
    const rowTexts = Array.from(rows).map((r) => r.textContent.trim());
    expect(rowTexts[0]).toContain('Comment 3');
    expect(rowTexts[1]).toContain('Comment 4');
    expect(rowTexts[2]).toContain('Comment 5');
    expect(rowTexts[3]).toContain('Comment 6');
    expect(rowTexts.join(' ')).not.toContain('Comment 1');
    expect(rowTexts.join(' ')).not.toContain('Comment 2');

    const chunk = feedItemChunk(res.text, submissionId);
    expect(chunk).toContain('See all 6 comments');

    // The See-all control and the comment button open the SAME dialog — no
    // separate in-place accordion control exists on the card.
    const seeAll = article.querySelector('.see-all-comments');
    const commentButton = article.querySelector('.comment-button');
    expect(seeAll.getAttribute('data-open-comments')).toBe(String(submissionId));
    expect(commentButton.getAttribute('data-open-comments')).toBe(String(submissionId));
    // No comment accordion on the card (comments open via the dialog). The
    // owner ⋯ menu (issue #387) is a separate, intentional <details> and is
    // excluded — this assertion is about comment controls, not that menu.
    expect(article.querySelector('details:not(.photo-owner-menu)')).toBeNull();
  });

  it('a photo with exactly 3 comments renders exactly 3 rows', async () => {
    const author = await signedInGuest('card-ac2b-author', 'AC2b Author');
    const commenter = await signedInGuest('card-ac2b-commenter', 'AC2b Commenter');
    const submissionId = seedSubmission(author.guestId, {
      photoPath: 'ac2-three.jpg',
      thumbPath: 'ac2-three-t.jpg',
    });
    seedComments(submissionId, commenter.guestId, 3);

    const res = await author.agent.get('/feed');
    const dom = new JSDOM(res.text);
    const article = dom.window.document.getElementById('photo-' + submissionId);
    expect(article.querySelectorAll('.feed-comment-row').length).toBe(3);
    expect(feedItemChunk(res.text, submissionId)).toContain('See all 3 comments');
  });

  it('a photo with 0 comments renders no rows and no See-all line', async () => {
    const author = await signedInGuest('card-ac2c-author', 'AC2c Author');
    const submissionId = seedSubmission(author.guestId, {
      photoPath: 'ac2-zero.jpg',
      thumbPath: 'ac2-zero-t.jpg',
    });

    const res = await author.agent.get('/feed');
    const dom = new JSDOM(res.text);
    const article = dom.window.document.getElementById('photo-' + submissionId);
    expect(article.querySelectorAll('.feed-comment-row').length).toBe(0);
    expect(article.querySelector('.see-all-comments')).toBeNull();
  });

  it('exactly 4 comments renders exactly 4 rows', async () => {
    const author = await signedInGuest('card-ac2d-author', 'AC2d Author');
    const commenter = await signedInGuest('card-ac2d-commenter', 'AC2d Commenter');
    const submissionId = seedSubmission(author.guestId, {
      photoPath: 'ac2-four.jpg',
      thumbPath: 'ac2-four-t.jpg',
    });
    seedComments(submissionId, commenter.guestId, 4);

    const res = await author.agent.get('/feed');
    const dom = new JSDOM(res.text);
    const article = dom.window.document.getElementById('photo-' + submissionId);
    expect(article.querySelectorAll('.feed-comment-row').length).toBe(4);
    expect(feedItemChunk(res.text, submissionId)).toContain('See all 4 comments');
  });

  it('the .feed-comment-row CSS rule clamps to one line', () => {
    const idx = THEME_CSS_SOURCE.indexOf('.feed-comment-row');
    expect(idx).toBeGreaterThan(-1);
    const rule = extractBalancedBlock(THEME_CSS_SOURCE, idx);
    const hasNowrapEllipsis =
      rule.includes('white-space: nowrap') && rule.includes('text-overflow: ellipsis');
    const hasLineClamp = rule.includes('-webkit-line-clamp: 1');
    expect(hasNowrapEllipsis || hasLineClamp).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC3 — guest name anchor precedes <img>; points span is right-justified
// metadata.
// ---------------------------------------------------------------------------
describe('AC3: guest name precedes the photo; points is right-justified metadata', () => {
  it('the guest anchor appears before the <img> in the article markup', async () => {
    const author = await signedInGuest('card-ac3-author', 'AC3 Author');
    const submissionId = seedSubmission(author.guestId, {
      photoPath: 'ac3.jpg',
      thumbPath: 'ac3t.jpg',
    });

    const res = await author.agent.get('/feed');
    const chunk = feedItemChunk(res.text, submissionId);
    const anchorIdx = chunk.indexOf('href="/u/' + author.guestId + '"');
    const imgIdx = chunk.indexOf('<img');
    expect(anchorIdx).toBeGreaterThan(-1);
    expect(imgIdx).toBeGreaterThan(-1);
    expect(anchorIdx).toBeLessThan(imgIdx);
  });

  it('.points-count is styled as right-justified metadata (margin-left: auto)', () => {
    expect(FEED_EJS_SOURCE).toContain('class="points-count"');
    const cssIdx = THEME_CSS_SOURCE.indexOf('.points-count');
    expect(cssIdx).toBeGreaterThan(-1);
    const rule = extractBalancedBlock(THEME_CSS_SOURCE, cssIdx);
    expect(rule).toContain('margin-left: auto');
  });
});

// ---------------------------------------------------------------------------
// AC4 — .like-button carries a 44x44 minimum tap target.
// ---------------------------------------------------------------------------
describe('AC4: .like-button carries a 44x44 minimum tap target', () => {
  it('the .like-button rule in theme.css sets min-width and min-height to 44px', () => {
    // .like-button appears in several selector groups (the sizing rule plus
    // the tap-highlight / focus-visible groups). Pick the block that actually
    // carries the sizing declaration rather than assuming source order (same
    // find-the-right-block pattern as the AC6 guard test).
    const indices = allIndicesOf(THEME_CSS_SOURCE, '.like-button');
    expect(indices.length).toBeGreaterThan(0);
    const rule = indices
      .map((idx) => extractBalancedBlock(THEME_CSS_SOURCE, idx))
      .find((block) => block.includes('min-width: 44px'));
    expect(rule).toBeDefined();
    expect(rule).toContain('min-width: 44px');
    expect(rule).toContain('min-height: 44px');
  });
});

// ---------------------------------------------------------------------------
// AC5 (amended) — the comment field lives only inside a <dialog> served
// closed; the comment button opens it via showModal(), one at a time,
// focuses the textarea, and shows the full thread + a Post control.
// ---------------------------------------------------------------------------
describe('AC5: the comment field lives only inside the closed <dialog>', () => {
  it('no <input>/<textarea> exists in the card except inside the <dialog>, which carries no open attribute', async () => {
    const author = await signedInGuest('card-ac5-author', 'AC5 Author');
    const commenter = await signedInGuest('card-ac5-commenter', 'AC5 Commenter');
    const submissionId = seedSubmission(author.guestId, {
      photoPath: 'ac5.jpg',
      thumbPath: 'ac5t.jpg',
    });
    seedComments(submissionId, commenter.guestId, 2);

    const res = await author.agent.get('/feed');
    const dom = new JSDOM(res.text);
    const article = dom.window.document.getElementById('photo-' + submissionId);
    const fields = article.querySelectorAll('input[type="text"], textarea');
    // The field does exist (inside a dialog) — this is not a "removed
    // entirely" assertion, only a "not inline" assertion. Any text field on
    // the card must live inside a closed <dialog>, not in the card flow: the
    // comment composer in dialog.comments-dialog, and (issue #387) the owner
    // caption editor in dialog.caption-dialog — both closed by default.
    expect(fields.length).toBeGreaterThan(0);
    fields.forEach((field) => {
      expect(field.closest('dialog')).not.toBeNull();
    });

    const dialog = article.querySelector('dialog.comments-dialog');
    expect(dialog).not.toBeNull();
    expect(dialog.hasAttribute('open')).toBe(false);
  });

  it('the placeholder is the literal "Add a comment"; "Blurry feet" and "Send" are absent from feed markup', async () => {
    const author = await signedInGuest('card-ac5b-author', 'AC5b Author');
    seedSubmission(author.guestId, { photoPath: 'ac5b.jpg', thumbPath: 'ac5bt.jpg' });

    const res = await author.agent.get('/feed');
    expect(res.text).toContain('placeholder="Add a comment"');
    expect(res.text).not.toContain('Blurry feet');
    expect(res.text).not.toContain('Send');
    expect(FEED_EJS_SOURCE).not.toContain('Send');
  });

  it('the comment button opens the dialog via showModal, one at a time, focusing the textarea; the full thread and Post render inside', async () => {
    const author = await signedInGuest('card-ac5c-author', 'AC5c Author');
    const commenter = await signedInGuest('card-ac5c-commenter', 'AC5c Commenter');
    const submissionId = seedSubmission(author.guestId, {
      photoPath: 'ac5c.jpg',
      thumbPath: 'ac5ct.jpg',
    });
    // A second card, to prove one dialog cannot stay open while another opens.
    const otherSubmissionId = seedSubmission(author.guestId, {
      taskTitle: 'Feed Card Second Task',
      photoPath: 'ac5c-2.jpg',
      thumbPath: 'ac5c-2-t.jpg',
    });
    // A comment long enough that it only reads in full inside the dialog —
    // the card row clamps it to one line.
    const longBody =
      'This comment is intentionally long enough that it would need to wrap onto ' +
      'more than one line if it were not clamped by the card row rule.';
    db.prepare(`INSERT INTO comments (submission_id, guest_id, body) VALUES (?, ?, ?)`).run(
      submissionId,
      commenter.guestId,
      longBody
    );

    const res = await author.agent.get('/feed');
    const dom = new JSDOM(res.text, { url: 'http://localhost/' });

    // jsdom 29 ships HTMLDialogElement without showModal/close — stub them
    // minimally (flip `open`, which reflects the attribute) and spy, per the
    // amendment's implementer note. The spy proves showModal() is the
    // mechanism feed.js uses, not a hidden-attribute or class flip.
    const showModalCalls = [];
    const closeCalls = [];
    dom.window.HTMLDialogElement.prototype.showModal = function () {
      showModalCalls.push(this.id);
      this.open = true;
    };
    dom.window.HTMLDialogElement.prototype.close = function () {
      closeCalls.push(this.id);
      this.open = false;
    };

    // Install DOM globals so the real feed.js binds its listeners to THIS
    // document (same technique as tests/upload-ux.test.js AC3).
    const keys = ['window', 'document', 'navigator'];
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
      const dialog = doc.getElementById('comments-dialog-' + submissionId);
      const otherDialog = doc.getElementById('comments-dialog-' + otherSubmissionId);
      expect(dialog.open).toBe(false);

      const button = doc.querySelector(
        '.comment-button[data-open-comments="' + submissionId + '"]'
      );
      expect(button).not.toBeNull();
      button.dispatchEvent(new dom.window.Event('click', { bubbles: true }));

      // Opened via showModal(), and the open attribute reflects it.
      expect(showModalCalls).toContain('comments-dialog-' + submissionId);
      expect(dialog.open).toBe(true);
      expect(dialog.hasAttribute('open')).toBe(true);

      // The composer textarea holds focus; Post (not Send) is the control,
      // muted while the field is empty.
      const textarea = dialog.querySelector('textarea[name="body"]');
      expect(doc.activeElement).toBe(textarea);
      const postButton = dialog.querySelector('button[type="submit"]');
      expect(postButton.textContent.trim()).toBe('Post');
      expect(postButton.disabled).toBe(true);

      // The full (unclamped) thread includes the long comment in full.
      expect(dialog.querySelector('.comments-dialog-thread').textContent).toContain(longBody);

      // One dialog at a time: opening the second card's dialog closes the
      // first (real browsers additionally make the background inert).
      const otherButton = doc.querySelector(
        '.comment-button[data-open-comments="' + otherSubmissionId + '"]'
      );
      otherButton.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
      expect(dialog.open).toBe(false);
      expect(otherDialog.open).toBe(true);

      // The close button closes its own dialog.
      const closeButton = otherDialog.querySelector('[data-close-comments]');
      closeButton.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
      expect(otherDialog.open).toBe(false);
    } finally {
      keys.forEach((key) => {
        if (saved[key]) {
          Object.defineProperty(global, key, saved[key]);
        } else {
          delete global[key];
        }
      });
    }
  });
});

// ---------------------------------------------------------------------------
// AC6 — the like pop animation is disabled under prefers-reduced-motion: reduce.
// ---------------------------------------------------------------------------
describe('AC6: the like pop animation is wrapped in a prefers-reduced-motion guard', () => {
  it('the heart-pop keyframe and .like-button-pop rule sit inside the no-preference guard', () => {
    const marker = '@media (prefers-reduced-motion: no-preference) {';
    const indices = allIndicesOf(THEME_CSS_SOURCE, marker);
    expect(indices.length).toBeGreaterThan(0);
    const matchingBlock = indices
      .map((idx) => extractBalancedBlock(THEME_CSS_SOURCE, idx + marker.length - 1))
      .find((block) => block.includes('.like-button-pop'));
    expect(matchingBlock).toBeDefined();
    expect(matchingBlock).toContain('@keyframes heart-pop');
  });
});

// ---------------------------------------------------------------------------
// AC7 — the heart is an inline <svg>; the &hearts; entity is gone.
// ---------------------------------------------------------------------------
describe('AC7: the heart is an inline <svg>; the &hearts; entity is absent', () => {
  it('the like button renders an inline <svg class="like-heart">, and no &hearts; entity remains', async () => {
    const author = await signedInGuest('card-ac7-author', 'AC7 Author');
    const submissionId = seedSubmission(author.guestId, {
      photoPath: 'ac7.jpg',
      thumbPath: 'ac7t.jpg',
    });

    const res = await author.agent.get('/feed');
    const chunk = feedItemChunk(res.text, submissionId);
    expect(chunk).toContain('<svg class="like-heart"');
    expect(res.text).not.toContain('&hearts;');
    expect(FEED_EJS_SOURCE).not.toContain('&hearts;');
  });
});

// ---------------------------------------------------------------------------
// AC8 (amendment) — the comments POST answers JSON to a JSON accept while
// keeping the redirect for plain form posts.
// ---------------------------------------------------------------------------
describe('AC8: comment POST answers JSON in place, redirect for plain posts', () => {
  it('a JSON-accept POST on a photo with 2 comments answers commentCount 3 and the comment body', async () => {
    const author = await signedInGuest('card-ac8-author', 'AC8 Author');
    const commenter = await signedInGuest('card-ac8-commenter', 'AC8 Commenter');
    const submissionId = seedSubmission(author.guestId, {
      photoPath: 'ac8.jpg',
      thumbPath: 'ac8t.jpg',
    });
    seedComments(submissionId, commenter.guestId, 2);

    const res = await author.agent
      .post('/p/' + submissionId + '/comments')
      .set('Accept', 'application/json')
      .type('form')
      .send({ body: 'Lovely!' });
    expect(res.status).toBe(200);
    expect(res.body.commentCount).toBe(3);
    expect(res.body.comment.body).toBe('Lovely!');
    expect(res.body.comment.guest_id).toBe(author.guestId);
    expect(res.body.comment.guest_name).toBe('AC8 Author');
    expect(Number.isInteger(res.body.comment.id)).toBe(true);

    // The row really exists — the JSON is not a fabricated echo.
    const row = db.prepare(`SELECT body FROM comments WHERE id = ?`).get(res.body.comment.id);
    expect(row.body).toBe('Lovely!');
  });

  it('the same POST without a JSON accept still redirects (no-JS fallback)', async () => {
    const author = await signedInGuest('card-ac8b-author', 'AC8b Author');
    const submissionId = seedSubmission(author.guestId, {
      photoPath: 'ac8b.jpg',
      thumbPath: 'ac8bt.jpg',
    });

    const res = await author.agent
      .post('/p/' + submissionId + '/comments')
      .type('form')
      .send({ body: 'Plain post' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/feed?from=' + submissionId + '#photo-' + submissionId);
  });

  it('edge: a JSON-accept POST with a 301-character body answers 400 JSON and inserts no row', async () => {
    const author = await signedInGuest('card-ac8c-author', 'AC8c Author');
    const submissionId = seedSubmission(author.guestId, {
      photoPath: 'ac8c.jpg',
      thumbPath: 'ac8ct.jpg',
    });

    const res = await author.agent
      .post('/p/' + submissionId + '/comments')
      .set('Accept', 'application/json')
      .type('form')
      .send({ body: 'x'.repeat(301) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();

    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM comments WHERE submission_id = ?`)
      .get(submissionId).n;
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Issue #362 fix 1 — the duplicate router.use(attachGuest) mount was removed
// from community.js; the global app.js mount must still supply res.locals.guest.
// ---------------------------------------------------------------------------
describe('#362: res.locals.guest still populated after removing the duplicate mount', () => {
  it('a signed-in guest hitting GET /feed sees their own comment composer (proves guest is set)', async () => {
    const author = await signedInGuest('card-362-author', 'Three Six Two Guest');
    seedSubmission(author.guestId, { photoPath: 'i362.jpg', thumbPath: 'i362t.jpg' });

    const res = await author.agent.get('/feed');
    expect(res.status).toBe(200);
    // The composer only renders `<% if (guest) { %>` (feed.ejs) — its
    // "Add a comment" placeholder proves res.locals.guest was set, which
    // now comes solely from the global app.js mount.
    expect(res.text).toContain('placeholder="Add a comment"');
    expect(res.text).toContain('Three Six Two Guest');
  });

  it('community.js no longer mounts attachGuest at the router level', () => {
    expect(COMMUNITY_ROUTE_SOURCE).not.toMatch(/router\.use\(attachGuest\)/);
  });
});

// ---------------------------------------------------------------------------
// AC9 (amendment) — structural: backdrop rule, remembered card height,
// textarea auto-grow.
// ---------------------------------------------------------------------------
describe('AC9: backdrop rule, contain-intrinsic-size auto, textarea auto-grow', () => {
  it('theme.css carries a ::backdrop rule for the comments dialog', () => {
    expect(THEME_CSS_SOURCE).toContain('.comments-dialog::backdrop');
  });

  it(".feed-item's rule reads contain-intrinsic-size: auto 600px", () => {
    const idx = THEME_CSS_SOURCE.indexOf('.feed-item {');
    expect(idx).toBeGreaterThan(-1);
    const rule = extractBalancedBlock(THEME_CSS_SOURCE, idx);
    expect(rule).toContain('contain-intrinsic-size: auto 600px');
  });

  it('feed.js grows the textarea by assigning style.height from scrollHeight', () => {
    expect(FEED_JS_SOURCE).toMatch(/\.style\.height\s*=\s*\w+\.scrollHeight/);
  });
});
