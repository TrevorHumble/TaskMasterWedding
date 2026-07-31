// tests/admin-feed-likes-scope.test.js
// Issue #953 — admin inline feed, phase 2 of the #259 gallery-parity mock:
// AC1 real guest like counts replace the phase-1 deterministic fake, AC2/AC3
// the person/task scoping the phase-1 mock already shipped stays exactly as
// approved (client-side filter, DESIGN.md "Scoped admin inline feed: a
// client-side filter, deliberately not a server query (#953)").
//
// Three layers, per the issue's own plan step 5:
//   1. Route:  like_count correctness off src/routes/admin.js's photosSelect.
//   2. Markup: the real span shape, no mock expression, no aria-label.
//   3. jsdom:  the scope script is INLINE in src/views/admin-photos.ejs (not
//      an external src/public/js/*.js file like admin-tasks.js), so unlike
//      tests/admin-tasks-script.test.js's require()-the-real-file technique,
//      this file renders the real page, slices the inline <script>...</script>
//      body straight out of the response HTML, and evaluates that exact text
//      in a JSDOM window (dom.window.eval) against the rendered markup — a
//      pasted copy of the script would silently drift from the real one.
//
// REQUIRE ORDER: loadApp() must run before any require that pulls in config
// or db (see tests/helpers/testApp.js).
'use strict';

const { JSDOM } = require('jsdom');
const { loadApp, makeAdminAgent } = require('./helpers/testApp');

let app;
let db;
let adminAgent;

beforeAll(async () => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
  adminAgent = await makeAdminAgent(app, 'feed-likes-scope-admin-pw');
});

function insertGuest(name, token) {
  return db.prepare('INSERT INTO guests (token, name) VALUES (?, ?)').run(token, name)
    .lastInsertRowid;
}

function insertTask(title) {
  return db.prepare('INSERT INTO tasks (title) VALUES (?)').run(title).lastInsertRowid;
}

function insertSubmission({ guestId, taskId = null, photoPath, thumbPath, takenDown = 0 }) {
  return db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(guestId, taskId, photoPath, thumbPath, takenDown).lastInsertRowid;
}

function insertLike(submissionId, guestId) {
  db.prepare('INSERT INTO likes (submission_id, guest_id) VALUES (?, ?)').run(
    submissionId,
    guestId
  );
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
 * Walk forward from a <span ...> opening tag's '<' to the matching close,
 * tracking nested <span> depth — the admin-likes-count span nests two more
 * spans inside it (.like-count, .likes-link-word), so a naive first-</span>
 * search would truncate mid-element.
 */
function balancedSpan(html, startIdx) {
  expect(startIdx).toBeGreaterThan(-1);
  const openTagEnd = html.indexOf('>', startIdx) + 1;
  let depth = 1;
  let i = openTagEnd;
  while (depth > 0) {
    const nextOpen = html.indexOf('<span', i);
    const nextClose = html.indexOf('</span>', i);
    expect(nextClose).toBeGreaterThan(-1);
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      i = nextOpen + '<span'.length;
    } else {
      depth--;
      i = nextClose + '</span>'.length;
    }
  }
  return html.slice(startIdx, i);
}

/** The full <span class="likes-link admin-likes-count">...</span> for a card. */
function likesSpanChunk(cardHtml) {
  return balancedSpan(cardHtml, cardHtml.indexOf('<span class="likes-link admin-likes-count"'));
}

// ---------------------------------------------------------------------------
// AC1 (route half) — like_count is the photo's real guest-like count, off
// src/routes/admin.js's photosSelect correlated subquery.
// ---------------------------------------------------------------------------
describe('AC1: real like counts (route)', () => {
  it('0 likes -> like_count 0', async () => {
    const guestId = insertGuest('Likes Zero Guest', 'likes-zero');
    const submissionId = insertSubmission({
      guestId,
      photoPath: 'likes-zero.jpg',
      thumbPath: 'likes-zero-t.jpg',
    });

    const res = await adminAgent.get('/admin/photos');
    expect(res.status).toBe(200);
    const chunk = likesSpanChunk(feedCardChunk(res.text, submissionId));
    expect(chunk).toContain(
      '<span class="like-count">0</span> <span class="likes-link-word">likes</span>'
    );
  });

  it('1 like -> like_count 1, singular wording', async () => {
    const guestId = insertGuest('Likes One Guest', 'likes-one');
    const likerId = insertGuest('Likes One Liker', 'likes-one-liker');
    const submissionId = insertSubmission({
      guestId,
      photoPath: 'likes-one.jpg',
      thumbPath: 'likes-one-t.jpg',
    });
    insertLike(submissionId, likerId);

    const res = await adminAgent.get('/admin/photos');
    const chunk = likesSpanChunk(feedCardChunk(res.text, submissionId));
    expect(chunk).toContain(
      '<span class="like-count">1</span> <span class="likes-link-word">like</span>'
    );
  });

  it('n (3) likes -> like_count 3, plural wording', async () => {
    const guestId = insertGuest('Likes Three Guest', 'likes-three');
    const submissionId = insertSubmission({
      guestId,
      photoPath: 'likes-three.jpg',
      thumbPath: 'likes-three-t.jpg',
    });
    ['l1', 'l2', 'l3'].forEach((tok) => insertLike(submissionId, insertGuest('Liker ' + tok, tok)));

    const res = await adminAgent.get('/admin/photos');
    const chunk = likesSpanChunk(feedCardChunk(res.text, submissionId));
    expect(chunk).toContain(
      '<span class="like-count">3</span> <span class="likes-link-word">likes</span>'
    );
  });

  it('counts likes on a taken-down photo too (scoping is by set membership, never moderation state — AC4)', async () => {
    const guestId = insertGuest('Likes Down Guest', 'likes-down');
    const submissionId = insertSubmission({
      guestId,
      photoPath: 'likes-down.jpg',
      thumbPath: 'likes-down-t.jpg',
      takenDown: 1,
    });
    insertLike(submissionId, insertGuest('Likes Down Liker', 'likes-down-liker'));

    const res = await adminAgent.get('/admin/photos');
    const chunk = likesSpanChunk(feedCardChunk(res.text, submissionId));
    expect(chunk).toContain(
      '<span class="like-count">1</span> <span class="likes-link-word">like</span>'
    );
  });

  it('two submissions with different like counts on the same request each carry their OWN count (correlated per row, not a shared/global value)', async () => {
    const guestId = insertGuest('Likes Distinct Guest', 'likes-distinct');
    const subA = insertSubmission({
      guestId,
      photoPath: 'likes-distinct-a.jpg',
      thumbPath: 'likes-distinct-a-t.jpg',
    });
    const subB = insertSubmission({
      guestId,
      photoPath: 'likes-distinct-b.jpg',
      thumbPath: 'likes-distinct-b-t.jpg',
    });
    insertLike(subA, insertGuest('Distinct Liker 1', 'distinct-liker-1'));
    insertLike(subA, insertGuest('Distinct Liker 2', 'distinct-liker-2'));
    insertLike(subB, insertGuest('Distinct Liker 3', 'distinct-liker-3'));

    const res = await adminAgent.get('/admin/photos');
    const chunkA = likesSpanChunk(feedCardChunk(res.text, subA));
    const chunkB = likesSpanChunk(feedCardChunk(res.text, subB));
    expect(chunkA).toContain('<span class="like-count">2</span>');
    expect(chunkB).toContain('<span class="like-count">1</span>');
  });
});

// ---------------------------------------------------------------------------
// AC1 (markup half) — the phase-1 mock is gone, no aria-label survives (ARIA
// 1.2 prohibits it on a role-less <span>, so removing it changes nothing
// rendered/announced), and cards carry the scope-filter data attributes.
// ---------------------------------------------------------------------------
describe('AC1: real like counts (markup) + AC2 data attributes', () => {
  it('the phase-1 mock expression is gone from the rendered page', async () => {
    const guestId = insertGuest('Mock Gone Guest', 'mock-gone');
    insertSubmission({ guestId, photoPath: 'mock-gone.jpg', thumbPath: 'mock-gone-t.jpg' });

    const res = await adminAgent.get('/admin/photos');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('* 7) % 9');
    expect(res.text).not.toContain('_mockLikes');
  });

  it('the count span carries no aria-label', async () => {
    const guestId = insertGuest('No Aria Guest', 'no-aria');
    const submissionId = insertSubmission({
      guestId,
      photoPath: 'no-aria.jpg',
      thumbPath: 'no-aria-t.jpg',
    });

    const res = await adminAgent.get('/admin/photos');
    const chunk = likesSpanChunk(feedCardChunk(res.text, submissionId));
    expect(chunk).not.toContain('aria-label');
    expect(chunk.startsWith('<span class="likes-link admin-likes-count">')).toBe(true);
  });

  it('cards carry data-scope-key: g<guest_id> on the guest axis, t<task_id>/"memory" on the task axis, empty on an unscoped view', async () => {
    const guestId = insertGuest('Attr Guest', 'attr-guest');
    const taskId = insertTask('Attr Task');
    const taskSub = insertSubmission({
      guestId,
      taskId,
      photoPath: 'attr-task.jpg',
      thumbPath: 'attr-task-t.jpg',
    });
    const memorySub = insertSubmission({
      guestId,
      taskId: null,
      photoPath: 'attr-memory.jpg',
      thumbPath: 'attr-memory-t.jpg',
    });

    // Guest axis (view=user): both the task-linked and the memory submission
    // scope to their shared guest.
    const userRes = await adminAgent.get('/admin/photos?view=user');
    const userTaskChunk = feedCardChunk(userRes.text, taskSub);
    const userMemoryChunk = feedCardChunk(userRes.text, memorySub);
    expect(userTaskChunk).toContain('data-scope-key="g' + guestId + '"');
    expect(userMemoryChunk).toContain('data-scope-key="g' + guestId + '"');

    // Task axis (view=task): the task-linked submission scopes to its task,
    // the task-free memory scopes to the shared 'memory' key.
    const taskRes = await adminAgent.get('/admin/photos?view=task');
    const taskTaskChunk = feedCardChunk(taskRes.text, taskSub);
    const taskMemoryChunk = feedCardChunk(taskRes.text, memorySub);
    expect(taskTaskChunk).toContain('data-scope-key="t' + taskId + '"');
    expect(taskMemoryChunk).toContain('data-scope-key="memory"');

    // Unscoped view (recent): scopeKey() has no axis to key on, so every
    // card renders an empty data-scope-key.
    const recentRes = await adminAgent.get('/admin/photos?view=recent');
    const recentTaskChunk = feedCardChunk(recentRes.text, taskSub);
    expect(recentTaskChunk).toContain('data-scope-key=""');
  });
});

// ---------------------------------------------------------------------------
// AC2/AC3 — the inline scope script, evaluated for real out of the rendered
// page rather than a pasted copy.
// ---------------------------------------------------------------------------

/** Pull the LAST inline <script>...</script> body out of the page (the two
 *  before it are `<script src="...">` external tags, which this regex's
 *  non-src `<script>` form does not match). */
function extractInlineScript(html) {
  const matches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  expect(matches.length).toBe(1);
  return matches[0][1];
}

/** Build a JSDOM document from a real rendered page and eval the real inline
 *  script into it, so the script's own listeners bind to this document. */
function loadScopedFeed(html, url) {
  // runScripts: 'outside-only' is what wires dom.window.eval() to actually
  // run inside this window's own realm (its `document` global resolving to
  // dom.window.document) instead of Node's — it does NOT execute any
  // <script> ELEMENT in the markup (those stay inert), so admin.js/
  // lightbox.js's own <script src> tags are never pulled in here.
  const dom = new JSDOM(html, { url: url, runScripts: 'outside-only' });
  // jsdom implements no layout engine, so Element.scrollIntoView is absent;
  // openFeedAt() calls it unconditionally on the matched card.
  dom.window.Element.prototype.scrollIntoView = function () {};
  const scriptBody = extractInlineScript(html);
  dom.window.eval(scriptBody);
  return dom;
}

function clickOpenFeed(dom, submissionId) {
  const btn = dom.window.document.querySelector('[data-open-feed="' + submissionId + '"]');
  expect(btn).not.toBeNull();
  btn.dispatchEvent(new dom.window.Event('click', { bubbles: true, cancelable: true }));
}

function clickShowAll(dom) {
  const link = dom.window.document.querySelector('.admin-scope-note a');
  expect(link).not.toBeNull();
  link.dispatchEvent(new dom.window.Event('click', { bubbles: true, cancelable: true }));
}

function clickBackToPhotos(dom) {
  const link = dom.window.document.querySelector('[data-feed-back]');
  expect(link).not.toBeNull();
  link.dispatchEvent(new dom.window.Event('click', { bubbles: true, cancelable: true }));
}

function visibleSubmissionIds(dom) {
  const doc = dom.window.document;
  return Array.from(doc.querySelectorAll('.feed-item'))
    .filter((el) => !el.hidden)
    .map((el) => el.id.replace('feed-photo-', ''));
}

function lightboxGroup(dom, submissionId) {
  const card = dom.window.document.getElementById('feed-photo-' + submissionId);
  return card.querySelector('.js-lightbox').getAttribute('data-lightbox-group');
}

describe('AC2: person axis (view=user) scopes to the opened guest', () => {
  let guestAId;
  let guestBId;
  let subA;
  let subB;

  beforeAll(() => {
    guestAId = insertGuest('Scope Guest A', 'scope-guest-a');
    guestBId = insertGuest('Scope Guest B', 'scope-guest-b');
    subA = insertSubmission({
      guestId: guestAId,
      photoPath: 'scope-a.jpg',
      thumbPath: 'scope-a-t.jpg',
    });
    subB = insertSubmission({
      guestId: guestBId,
      photoPath: 'scope-b.jpg',
      thumbPath: 'scope-b-t.jpg',
    });
  });

  it('opening guest A hides guest B, shows the "Showing only <name> — show all" note, and scopes the lightbox group', async () => {
    const res = await adminAgent.get('/admin/photos?view=user');
    const dom = loadScopedFeed(res.text, 'http://localhost/admin/photos?view=user');

    clickOpenFeed(dom, subA);

    const visible = visibleSubmissionIds(dom);
    expect(visible).toContain(String(subA));
    expect(visible).not.toContain(String(subB));

    const note = dom.window.document.querySelector('.admin-scope-note');
    expect(note).not.toBeNull();
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe('Showing only Scope Guest A — show all');

    expect(lightboxGroup(dom, subA)).toBe('admin-feed');
    expect(lightboxGroup(dom, subB)).toBe('scoped-out');
  });

  it("reopening via the URL hash #feed-photo-<id> (the post-moderation redirect entry point, admin-photos.ejs's trailing IIFE) also scopes the feed (AC2)", async () => {
    // A favorite/takedown/restore form posted from inside the feed carries
    // panel=feed, so the server redirect lands back here with
    // #feed-photo-<id> (src/routes/admin.js's redirectToPhotos) — the page's
    // own trailing IIFE reads window.location.hash and calls openFeedAt()
    // with no click involved. Building the JSDOM window with that hash
    // already on the URL and evaluating the real script (no clickOpenFeed
    // here) exercises that second entry point for real, so a future edit
    // that reorders this IIFE ahead of the VIEW/feedScope declarations above
    // it would fail this test instead of shipping silently broken.
    const res = await adminAgent.get('/admin/photos?view=user');
    const dom = loadScopedFeed(
      res.text,
      'http://localhost/admin/photos?view=user#feed-photo-' + subA
    );

    const visible = visibleSubmissionIds(dom);
    expect(visible).toContain(String(subA));
    expect(visible).not.toContain(String(subB));

    const note = dom.window.document.querySelector('.admin-scope-note');
    expect(note).not.toBeNull();
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe('Showing only Scope Guest A — show all');
  });

  it('"show all" restores every card and hides the note again (AC2)', async () => {
    const res = await adminAgent.get('/admin/photos?view=user');
    const dom = loadScopedFeed(res.text, 'http://localhost/admin/photos?view=user');
    clickOpenFeed(dom, subA);
    expect(visibleSubmissionIds(dom)).not.toContain(String(subB));

    clickShowAll(dom);

    const visible = visibleSubmissionIds(dom);
    expect(visible).toContain(String(subA));
    expect(visible).toContain(String(subB));
    expect(dom.window.document.querySelector('.admin-scope-note').hidden).toBe(true);
    expect(lightboxGroup(dom, subA)).toBe('admin-feed');
    expect(lightboxGroup(dom, subB)).toBe('admin-feed');
  });

  it('"Back to photos" also clears the scope (AC2)', async () => {
    const res = await adminAgent.get('/admin/photos?view=user');
    const dom = loadScopedFeed(res.text, 'http://localhost/admin/photos?view=user');
    clickOpenFeed(dom, subA);
    expect(visibleSubmissionIds(dom)).not.toContain(String(subB));

    clickBackToPhotos(dom);

    expect(visibleSubmissionIds(dom)).toContain(String(subB));
  });
});

describe('AC2: task axis (view=task) scopes to the opened task, note quotes the task title verbatim', () => {
  let taskId;
  let otherTaskId;
  let taskSub;
  let otherSub;

  beforeAll(() => {
    taskId = insertTask('Scope Task Alpha');
    otherTaskId = insertTask('Scope Other Task');
    taskSub = insertSubmission({
      guestId: insertGuest('Task Scope Guest', 'task-scope-guest'),
      taskId,
      photoPath: 'task-scope.jpg',
      thumbPath: 'task-scope-t.jpg',
    });
    otherSub = insertSubmission({
      guestId: insertGuest('Task Scope Other Guest', 'task-scope-other-guest'),
      taskId: otherTaskId,
      photoPath: 'task-scope-other.jpg',
      thumbPath: 'task-scope-other-t.jpg',
    });
  });

  it('opening the task-scoped photo hides the other task and renders the exact for-"title" note', async () => {
    const res = await adminAgent.get('/admin/photos?view=task');
    const dom = loadScopedFeed(res.text, 'http://localhost/admin/photos?view=task');

    clickOpenFeed(dom, taskSub);

    const visible = visibleSubmissionIds(dom);
    expect(visible).toContain(String(taskSub));
    expect(visible).not.toContain(String(otherSub));

    const note = dom.window.document.querySelector('.admin-scope-note');
    // The note's text comes from src/routes/admin.js's scopeLabel() (built
    // from its taskLine() helper), stamped onto the opened card as
    // data-scope-label and read off by the inline feed script into
    // .admin-scope-note's textContent — real curly-quote characters, "for"
    // included (AC2).
    expect(note.textContent).toBe('Showing only for “Scope Task Alpha” — show all');
  });
});

describe('AC2: Memories axis (view=task, task-free) groups every task-free card together', () => {
  let memoryA;
  let memoryB;
  let taskOwnedSub;

  beforeAll(() => {
    const guestId = insertGuest('Memory Scope Guest', 'memory-scope-guest');
    memoryA = insertSubmission({
      guestId,
      taskId: null,
      photoPath: 'memory-a.jpg',
      thumbPath: 'memory-a-t.jpg',
    });
    memoryB = insertSubmission({
      guestId: insertGuest('Memory Scope Guest 2', 'memory-scope-guest-2'),
      taskId: null,
      photoPath: 'memory-b.jpg',
      thumbPath: 'memory-b-t.jpg',
    });
    const taskId = insertTask('Memory Scope Owned Task');
    taskOwnedSub = insertSubmission({
      guestId: insertGuest('Memory Scope Owned Guest', 'memory-scope-owned-guest'),
      taskId,
      photoPath: 'memory-owned.jpg',
      thumbPath: 'memory-owned-t.jpg',
    });
  });

  it('opening one memory shows every memory (both A and B), hides the task-owned photo, and reads "a shared memory"', async () => {
    const res = await adminAgent.get('/admin/photos?view=task');
    const dom = loadScopedFeed(res.text, 'http://localhost/admin/photos?view=task');

    clickOpenFeed(dom, memoryA);

    const visible = visibleSubmissionIds(dom);
    expect(visible).toContain(String(memoryA));
    expect(visible).toContain(String(memoryB));
    expect(visible).not.toContain(String(taskOwnedSub));

    const note = dom.window.document.querySelector('.admin-scope-note');
    expect(note.textContent).toBe('Showing only a shared memory — show all');
  });
});

describe('AC2: opening from an unscoped context (view=recent) shows all cards and no VISIBLE note', () => {
  it('view=recent never scopes, regardless of which tile is opened', async () => {
    const guestId = insertGuest('Unscoped Guest', 'unscoped-guest');
    const subX = insertSubmission({
      guestId,
      photoPath: 'unscoped-x.jpg',
      thumbPath: 'unscoped-x-t.jpg',
    });
    const subY = insertSubmission({
      guestId: insertGuest('Unscoped Guest 2', 'unscoped-guest-2'),
      photoPath: 'unscoped-y.jpg',
      thumbPath: 'unscoped-y-t.jpg',
    });

    const res = await adminAgent.get('/admin/photos?view=recent');
    const dom = loadScopedFeed(res.text, 'http://localhost/admin/photos?view=recent');

    clickOpenFeed(dom, subX);

    const visible = visibleSubmissionIds(dom);
    expect(visible).toContain(String(subX));
    expect(visible).toContain(String(subY));
    // applyFeedScope() always lazily creates the note element (on the first
    // call, whether scoped or not) but leaves it `hidden` when feedScope is
    // null — "no note" means never SHOWN, not "never in the DOM".
    const note = dom.window.document.querySelector('.admin-scope-note');
    expect(note).not.toBeNull();
    expect(note.hidden).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC4 — a taken-down photo inside a scoped set renders exactly as today;
// scoping filters by set membership only, never by moderation state.
// ---------------------------------------------------------------------------
describe('AC4: a taken-down photo in a scoped set keeps its grayscale + pill state', () => {
  it('the taken-down card stays visible (in-scope) and still carries the taken-down marker', async () => {
    const guestId = insertGuest('Scoped Down Guest', 'scoped-down-guest');
    const liveSub = insertSubmission({
      guestId,
      photoPath: 'scoped-down-live.jpg',
      thumbPath: 'scoped-down-live-t.jpg',
    });
    const downSub = insertSubmission({
      guestId,
      photoPath: 'scoped-down-down.jpg',
      thumbPath: 'scoped-down-down-t.jpg',
      takenDown: 1,
    });

    const res = await adminAgent.get('/admin/photos?view=user');
    const dom = loadScopedFeed(res.text, 'http://localhost/admin/photos?view=user');

    clickOpenFeed(dom, liveSub);

    const visible = visibleSubmissionIds(dom);
    expect(visible).toContain(String(downSub));

    const downChunk = feedCardChunk(res.text, downSub);
    expect(downChunk).toContain('admin-feed-item is-down');
    expect(downChunk).toContain('admin-tile-down">Taken down<');
  });
});
