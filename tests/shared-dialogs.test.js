// tests/shared-dialogs.test.js
// Covers issue #1139 acceptance criteria — the feed's per-card likers and
// comments dialogs collapsed into ONE shared pair (#likes-dialog,
// #comments-dialog) per page, filled on open from each card's
// `.feed-card-data` JSON payload:
//
//   AC1 — a multi-photo feed window renders exactly one likers dialog shell
//         and one comments dialog shell, and each card carries exactly one
//         .feed-card-data payload.
//   AC4 — a live like/comment-post/comment-delete writes back to the card's
//         payload, so closing and re-opening that photo's dialog shows the
//         change, and a like toggled while the likers dialog is OPEN on that
//         photo redraws it in place.
//   AC5 — a card whose payload is absent or unparseable refuses to open
//         either dialog at all, rather than opening onto the previous
//         photo's rows, title and form action.
//   AC6 — a composer draft is cleared switching to a different photo's
//         comments, and kept when the SAME photo's dialog is closed and
//         re-opened.
//   AC7 — a comment body containing the literal text `</script>` does not
//         terminate its card's JSON block early, and renders as text (not
//         markup) once the dialog is opened.
//
// AC2's per-row detail (liker avatar/initials/Couple's Heart, comment
// author/⋯-menu-only-on-own-comments) is covered piecemeal by
// tests/feed-likers.test.js, tests/couple-heart.test.js and
// tests/feed-comment-delete.test.js at the server-render (payload) side; this
// file adds the client-layer assertion that isOwnComment() — not any stored
// per-row flag — is what decides the ⋯ menu, since #1139 moved that decision
// off the server.
//
// Same jsdom-driven pattern as tests/feed-robustness.test.js and
// tests/feed-likers-script.test.js: render the real server markup via
// GET /feed, load it into a synthetic document, stub the <dialog> API and
// window.fetch, delete require.cache, require the real feed.js fresh, and
// dispatch real DOM events.
//
// REQUIRE ORDER: config / db / app are required only AFTER loadApp() sets
// DATA_DIR / DB_PATH. Do not hoist requires above the loadApp() call.
'use strict';

const request = require('supertest');
const { JSDOM } = require('jsdom');
const { loadApp, signInGuest } = require('./helpers/testApp');

const FEED_JS_PATH = require.resolve('../src/public/js/feed.js');

let app;
let db;

beforeAll(async () => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
});

async function signedInGuest(token, name) {
  const guestId = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run(token, name).lastInsertRowid;
  const agent = request.agent(app);
  signInGuest(app, token, agent);
  return { guestId, agent };
}

function seedSubmission(authorGuestId, opts = {}) {
  const taskId = db
    .prepare(`INSERT INTO tasks (title) VALUES (?)`)
    .run(opts.taskTitle || 'Shared Dialogs Test Task').lastInsertRowid;
  const submissionId = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, 0)`
    )
    .run(
      authorGuestId,
      taskId,
      opts.photoPath || 'shared-dialogs.jpg',
      opts.thumbPath || 'shared-dialogs-thumb.jpg'
    ).lastInsertRowid;
  return submissionId;
}

/** Post a comment over HTTP (no-JS path) and return its new row id. */
async function postCommentViaHttp(agent, submissionId, body) {
  await agent
    .post('/p/' + submissionId + '/comments')
    .type('form')
    .send({ body });
  return db
    .prepare(`SELECT id FROM comments WHERE submission_id = ? AND body = ?`)
    .get(submissionId, body).id;
}

/**
 * Parse one card's `.feed-card-data` JSON payload straight out of the raw
 * response text (not via JSDOM) — needed for AC7, where the point of the
 * assertion is that the RAW bytes never contain a literal `</script>` that
 * would confuse an HTML parser before JSDOM ever gets a chance to normalize
 * anything.
 */
function feedCardDataChunk(body, submissionId) {
  const marker = 'class="feed-card-data" data-for="' + submissionId + '"';
  const markerIdx = body.indexOf(marker);
  expect(markerIdx).toBeGreaterThan(-1);
  const start = body.indexOf('>', markerIdx) + 1;
  const end = body.indexOf('</script>', start);
  expect(end).toBeGreaterThan(-1);
  return body.slice(start, end);
}

/**
 * A controllable window.fetch stand-in (mirrors tests/feed-robustness.test.js's
 * makeFetchStub, duplicated here per this codebase's per-file helper
 * convention). Queued responses are consumed one-shot by the NEXT call;
 * with nothing queued the call resolves immediately with `okBody` — AC4's
 * write-back tests need every fetch to actually settle, unlike
 * feed-robustness's hang-by-default stub.
 */
function makeFetchStub() {
  const calls = [];
  const queue = [];
  function stub(url, opts) {
    calls.push({ url, opts });
    const next = queue.shift();
    if (typeof next === 'function') {
      return next();
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: function () {
        return Promise.resolve({});
      },
    });
  }
  stub.calls = calls;
  stub.queueOk = function (jsonBody) {
    queue.push(function () {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: function () {
          return Promise.resolve(jsonBody);
        },
      });
    });
  };
  stub.queueFail = function (status) {
    queue.push(function () {
      return Promise.resolve({
        ok: false,
        status: status || 429,
        json: function () {
          return Promise.resolve({ error: 'rate limited' });
        },
      });
    });
  };
  // A one-shot response the test resolves ITSELF, later — the shape the
  // cross-photo in-flight race needs: hold a request open past a photo
  // switch, let the guest switch to a different photo's dialog, THEN settle
  // the abandoned one and assert it never touches the photo now on screen.
  stub.queueDeferred = function () {
    var deferred = {};
    deferred.promise = new Promise(function (resolve, reject) {
      deferred.resolve = resolve;
      deferred.reject = reject;
    });
    queue.push(function () {
      return deferred.promise;
    });
    return deferred;
  };
  return stub;
}

/**
 * Render GET /feed as `agent`, load it into a fresh jsdom document, stub the
 * <dialog> API and window.fetch, require the real feed.js fresh against it.
 * Returns the DOM handles the tests need plus a `restore()` that MUST be
 * called from a finally block (same convention as
 * tests/feed-robustness.test.js / tests/feed-likers-script.test.js).
 */
async function loadFeedFixture(agent) {
  const feedRes = await agent.get('/feed');
  expect(feedRes.status).toBe(200);

  const dom = new JSDOM(feedRes.text, { url: 'http://localhost/feed' });
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };

  const fetchStub = makeFetchStub();
  dom.window.fetch = fetchStub;

  const keys = ['window', 'document', 'navigator', 'fetch'];
  const saved = {};
  keys.forEach((key) => {
    saved[key] = Object.getOwnPropertyDescriptor(global, key);
    const value = key === 'window' ? dom.window : dom.window[key];
    Object.defineProperty(global, key, { value, configurable: true, writable: true });
  });

  delete require.cache[FEED_JS_PATH];
  require(FEED_JS_PATH);

  function restore() {
    keys.forEach((key) => {
      if (saved[key]) {
        Object.defineProperty(global, key, saved[key]);
      } else {
        delete global[key];
      }
    });
  }

  return { dom, doc: dom.window.document, fetchStub, restore };
}

function click(doc, el) {
  el.dispatchEvent(new doc.defaultView.Event('click', { bubbles: true }));
}

function submit(doc, form) {
  form.dispatchEvent(new doc.defaultView.Event('submit', { bubbles: true, cancelable: true }));
}

async function flushMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// AC1: exactly one shell of each dialog per page; one payload per card.
// ---------------------------------------------------------------------------
it('AC1: a feed window of 3 photos renders exactly one likers dialog shell and one comments dialog shell, and each card carries exactly one .feed-card-data payload', async () => {
  const author = await signedInGuest('sd-ac1-author', 'AC1 Author');
  const ids = [0, 1, 2].map((i) =>
    seedSubmission(author.guestId, {
      photoPath: 'sd-ac1-' + i + '.jpg',
      thumbPath: 'sd-ac1-' + i + 't.jpg',
    })
  );

  const res = await author.agent.get('/feed');
  const dom = new JSDOM(res.text);
  const doc = dom.window.document;

  expect(doc.querySelectorAll('dialog#likes-dialog').length).toBe(1);
  expect(doc.querySelectorAll('dialog#comments-dialog').length).toBe(1);
  expect(doc.querySelectorAll('.feed-card-data').length).toBe(ids.length);
  ids.forEach((id) => {
    expect(doc.querySelectorAll('.feed-card-data[data-for="' + id + '"]').length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC4: live mutations write back to the payload; the open likers dialog
// redraws in place on a live like toggle.
// ---------------------------------------------------------------------------
it('AC4: a live like toggle redraws the OPEN likers dialog in place, and the write-back survives a close + re-open', async () => {
  const author = await signedInGuest('sd-ac4l-author', 'AC4L Author');
  const viewer = await signedInGuest('sd-ac4l-viewer', 'AC4L Viewer');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'sd-ac4l.jpg',
    thumbPath: 'sd-ac4lt.jpg',
  });

  const { doc, fetchStub, restore } = await loadFeedFixture(viewer.agent);
  try {
    const article = doc.getElementById('photo-' + submissionId);
    const likeForm = article.querySelector('.like-form');
    const likesDialog = doc.getElementById('likes-dialog');
    const likesOpener = article.querySelector('[data-open-likes="' + submissionId + '"]');

    click(doc, likesOpener);
    expect(likesDialog.open).toBe(true);
    expect(likesDialog.querySelectorAll('.likes-row').length).toBe(0);

    fetchStub.queueOk({ liked: true, likeCount: 1 });
    submit(doc, likeForm);
    await flushMicrotasks();

    // Redrawn in place while the dialog is still open on this photo.
    expect(likesDialog.querySelectorAll('.likes-row').length).toBe(1);
    expect(likesDialog.querySelector('[data-likes-row="' + viewer.guestId + '"]')).not.toBeNull();

    // The write-back is to the card's payload, not just the open DOM: close
    // and re-open shows it again from scratch.
    likesDialog.close();
    expect(likesDialog.querySelectorAll('.likes-row').length).toBe(1); // close doesn't clear
    click(doc, likesOpener);
    expect(likesDialog.querySelectorAll('.likes-row').length).toBe(1);
    expect(likesDialog.querySelector('[data-likes-row="' + viewer.guestId + '"]')).not.toBeNull();
  } finally {
    restore();
  }
});

it('AC4: a posted comment and its later deletion both write back to the payload, surviving a close + re-open of the comments dialog', async () => {
  const author = await signedInGuest('sd-ac4c-author', 'AC4C Author');
  const viewer = await signedInGuest('sd-ac4c-viewer', 'AC4C Viewer');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'sd-ac4c.jpg',
    thumbPath: 'sd-ac4ct.jpg',
  });

  const { doc, fetchStub, restore } = await loadFeedFixture(viewer.agent);
  try {
    const opener = doc.querySelector('[data-open-comments="' + submissionId + '"]');
    const dialog = doc.getElementById('comments-dialog');

    click(doc, opener);
    const form = dialog.querySelector('form.comments-dialog-form');
    const textarea = form.querySelector('textarea[name="body"]');
    textarea.value = 'fresh comment';

    fetchStub.queueOk({
      comment: { id: 501, guest_id: viewer.guestId, body: 'fresh comment' },
      commentCount: 1,
    });
    submit(doc, form);
    await flushMicrotasks();
    expect(dialog.querySelectorAll('.feed-comment').length).toBe(1);

    // Close and re-open: the posted comment is drawn again from the
    // payload, not carried over as leftover DOM.
    dialog.close();
    click(doc, opener);
    expect(dialog.querySelectorAll('.feed-comment').length).toBe(1);
    const deleteForm = dialog.querySelector(
      'form.comment-delete-form[action$="/comments/501/delete"]'
    );
    expect(deleteForm).not.toBeNull();

    doc.defaultView.confirm = function () {
      return true;
    };
    fetchStub.queueOk({ deleted: true, commentCount: 0 });
    submit(doc, deleteForm);
    await flushMicrotasks();
    expect(dialog.querySelectorAll('.feed-comment').length).toBe(0);

    dialog.close();
    click(doc, opener);
    expect(dialog.querySelectorAll('.feed-comment').length).toBe(0);
    expect(dialog.querySelector('.comments-dialog-empty')).not.toBeNull();
    expect(dialog.querySelector('.comments-dialog-empty').textContent).toBe('No comments yet.');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// AC5: a missing/unparseable payload refuses to open either dialog, rather
// than opening onto the previous photo's rows/title/form action.
// ---------------------------------------------------------------------------
it('AC5: a card whose payload is unparseable refuses to open the comments dialog, leaving the form still naming the LAST photo it opened for', async () => {
  const author = await signedInGuest('sd-ac5c-author', 'AC5C Author');
  const goodId = seedSubmission(author.guestId, {
    photoPath: 'sd-ac5c-good.jpg',
    thumbPath: 'sd-ac5c-goodt.jpg',
  });
  const badId = seedSubmission(author.guestId, {
    photoPath: 'sd-ac5c-bad.jpg',
    thumbPath: 'sd-ac5c-badt.jpg',
  });

  const { doc, restore } = await loadFeedFixture(author.agent);
  try {
    const dialog = doc.getElementById('comments-dialog');
    const goodOpener = doc.querySelector('[data-open-comments="' + goodId + '"]');
    click(doc, goodOpener);
    expect(dialog.open).toBe(true);
    const form = dialog.querySelector('form.comments-dialog-form');
    expect(form.getAttribute('action')).toBe('/p/' + goodId + '/comments');
    dialog.close();

    // Corrupt the OTHER card's payload after the fact — e.g. malformed by a
    // scroll-window swap gone wrong (#1139's own DANGER case).
    const badScript = doc.querySelector('.feed-card-data[data-for="' + badId + '"]');
    badScript.textContent = '{not valid json';

    const badOpener = doc.querySelector('[data-open-comments="' + badId + '"]');
    click(doc, badOpener);

    // Never opened...
    expect(dialog.open).toBe(false);
    // ...and critically, the composer's action still names the GOOD photo —
    // proving the guard actually refused to touch the dialog at all, not
    // just that it happens to read closed.
    expect(form.getAttribute('action')).toBe('/p/' + goodId + '/comments');
  } finally {
    restore();
  }
});

it('AC5: a card whose payload node is entirely absent refuses to open the likers dialog', async () => {
  const author = await signedInGuest('sd-ac5l-author', 'AC5L Author');
  const goodId = seedSubmission(author.guestId, {
    photoPath: 'sd-ac5l-good.jpg',
    thumbPath: 'sd-ac5l-goodt.jpg',
  });
  const badId = seedSubmission(author.guestId, {
    photoPath: 'sd-ac5l-bad.jpg',
    thumbPath: 'sd-ac5l-badt.jpg',
  });

  const { doc, restore } = await loadFeedFixture(author.agent);
  try {
    const dialog = doc.getElementById('likes-dialog');
    const goodOpener = doc.querySelector('[data-open-likes="' + goodId + '"]');
    click(doc, goodOpener);
    expect(dialog.open).toBe(true);
    expect(dialog.getAttribute('data-submission-id')).toBe(String(goodId));
    dialog.close();

    const badScript = doc.querySelector('.feed-card-data[data-for="' + badId + '"]');
    badScript.parentNode.removeChild(badScript);

    const badOpener = doc.querySelector('[data-open-likes="' + badId + '"]');
    click(doc, badOpener);

    expect(dialog.open).toBe(false);
    // Still stamped with the last successfully-opened photo, not the bad one.
    expect(dialog.getAttribute('data-submission-id')).toBe(String(goodId));
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// AC6: a draft is cleared switching to a different photo, kept re-opening
// the same one.
// ---------------------------------------------------------------------------
it('AC6: closing and re-opening the SAME photo keeps the draft; opening a DIFFERENT photo clears it', async () => {
  const author = await signedInGuest('sd-ac6-author', 'AC6 Author');
  const submissionA = seedSubmission(author.guestId, {
    photoPath: 'sd-ac6-a.jpg',
    thumbPath: 'sd-ac6-at.jpg',
  });
  const submissionB = seedSubmission(author.guestId, {
    taskTitle: 'Shared Dialogs Test Task B',
    photoPath: 'sd-ac6-b.jpg',
    thumbPath: 'sd-ac6-bt.jpg',
  });

  const { doc, restore } = await loadFeedFixture(author.agent);
  try {
    const dialog = doc.getElementById('comments-dialog');
    const openerA = doc.querySelector('[data-open-comments="' + submissionA + '"]');
    const openerB = doc.querySelector('[data-open-comments="' + submissionB + '"]');

    click(doc, openerA);
    const textarea = dialog.querySelector('textarea[name="body"]');
    textarea.value = 'draft for A';
    dialog.close();

    // Same photo, re-opened: the draft survives.
    click(doc, openerA);
    expect(textarea.value).toBe('draft for A');

    // A different photo opened next: the draft is gone.
    click(doc, openerB);
    expect(textarea.value).toBe('');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// AC7: a `</script>` comment body cannot terminate its card's JSON block.
// ---------------------------------------------------------------------------
it('AC7: a comment body containing </script> does not end its card JSON block early, and renders as text once the dialog opens', async () => {
  const author = await signedInGuest('sd-ac7-author', 'AC7 Author');
  const commenter = await signedInGuest('sd-ac7-commenter', 'AC7 Commenter');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'sd-ac7.jpg',
    thumbPath: 'sd-ac7t.jpg',
  });
  const trickyBody = 'nice pic </script><script>window.pwned=true</script> right?';
  await postCommentViaHttp(commenter.agent, submissionId, trickyBody);

  const res = await author.agent.get('/feed');

  // The raw payload text never contains a literal `</script>` — it is
  // escaped to the < JSON string-escape, which JSON.parse un-escapes
  // back to `<` on the client.
  const rawJson = feedCardDataChunk(res.text, submissionId);
  expect(rawJson).not.toContain('</script>');
  expect(rawJson).toContain('\\u003c');
  const parsed = JSON.parse(rawJson);
  expect(parsed.comments.some((c) => c.body === trickyBody)).toBe(true);

  // The page parses normally past this card: the shared dialogs and every
  // later card-data block still exist.
  const dom = new JSDOM(res.text);
  const doc = dom.window.document;
  expect(doc.getElementById('comments-dialog')).not.toBeNull();
  expect(doc.getElementById('likes-dialog')).not.toBeNull();
  expect(doc.querySelectorAll('.feed-card-data[data-for="' + submissionId + '"]').length).toBe(1);

  // Opened via feed.js, the comment renders as inert TEXT — no injected
  // <script> element, and the paragraph's own text carries the literal
  // "</script>" characters.
  const { doc: liveDoc, restore } = await loadFeedFixture(author.agent);
  try {
    const opener = liveDoc.querySelector('[data-open-comments="' + submissionId + '"]');
    click(liveDoc, opener);
    const dialog = liveDoc.getElementById('comments-dialog');
    const thread = dialog.querySelector('.comments-dialog-thread');
    expect(thread.querySelectorAll('script').length).toBe(0);
    const rows = thread.querySelectorAll('.feed-comment');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain(trickyBody);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// AC2 (client layer): the ⋯ delete menu is decided by isOwnComment() at open
// time — off the .feed root's own guest identity, not a per-row stored flag —
// since #1139 moved this off the server. tests/feed-comment-delete.test.js
// covers the same promise through its own AC5; this is the assertion at the
// layer #1139 actually changed.
// ---------------------------------------------------------------------------
it("AC2: the comments dialog's ⋯ menu renders only on the signed-in guest's own rows, decided fresh on every open", async () => {
  const author = await signedInGuest('sd-ac2-author', 'AC2 Author');
  const viewer = await signedInGuest('sd-ac2-viewer', 'AC2 Viewer');
  const other = await signedInGuest('sd-ac2-other', 'AC2 Other');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'sd-ac2.jpg',
    thumbPath: 'sd-ac2t.jpg',
  });
  const ownCommentId = await postCommentViaHttp(viewer.agent, submissionId, 'mine');
  await postCommentViaHttp(other.agent, submissionId, 'not mine');

  const { doc, restore } = await loadFeedFixture(viewer.agent);
  try {
    const opener = doc.querySelector('[data-open-comments="' + submissionId + '"]');
    click(doc, opener);
    const dialog = doc.getElementById('comments-dialog');
    const thread = dialog.querySelector('.comments-dialog-thread');

    const ownItem = thread
      .querySelector('[data-delete-comment="' + ownCommentId + '"]')
      .closest('.feed-comment-item');
    expect(ownItem.querySelector('.comment-menu')).not.toBeNull();

    const otherItem = thread
      .querySelector('a[href="/u/' + other.guestId + '"]')
      .closest('.feed-comment-item');
    expect(otherItem.querySelector('.comment-menu')).toBeNull();
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Cross-photo in-flight settle (this round's reviewer-found blocker). The
// shared composer and the shared per-row delete forms are keyed by
// beginInFlight's per-form token, but there is now only ONE composer form and
// resetSharedComposer() deletes its token when the guest switches the dialog
// to a different photo. A request begun on photo A that settles AFTER that
// switch must still write A's payload (the server accepted it — losing it
// client-side would be a real data loss, not a cosmetic drift) but must never
// touch the dialog now open on photo B, and must never touch card B either.
// feed.js's `acted` flag (captured once from release(), independent of
// staleness) plus `dialogShows(dialog, submissionId)` is what keeps those two
// promises apart: acted gates nothing about the payload write (unconditional,
// dedup'd by comment id / filtered by id), `acted && dialogShows` gates every
// DOM write to the shared dialog and its error line.
// ---------------------------------------------------------------------------
describe('cross-photo in-flight settle', () => {
  it('a comment POST begun on A that resolves after switching to B updates only card A -- B is untouched', async () => {
    const author = await signedInGuest('sd-xp-post-author', 'XP Post Author');
    const viewer = await signedInGuest('sd-xp-post-viewer', 'XP Post Viewer');
    const submissionA = seedSubmission(author.guestId, {
      photoPath: 'sd-xp-post-a.jpg',
      thumbPath: 'sd-xp-post-at.jpg',
    });
    const submissionB = seedSubmission(author.guestId, {
      taskTitle: 'Shared Dialogs XP Post B',
      photoPath: 'sd-xp-post-b.jpg',
      thumbPath: 'sd-xp-post-bt.jpg',
    });

    const { doc, fetchStub, restore } = await loadFeedFixture(viewer.agent);
    try {
      const dialog = doc.getElementById('comments-dialog');
      const openerA = doc.querySelector('[data-open-comments="' + submissionA + '"]');
      const openerB = doc.querySelector('[data-open-comments="' + submissionB + '"]');
      const badgeBBefore = doc
        .getElementById('photo-' + submissionB)
        .querySelector('.comment-count').textContent;

      click(doc, openerA);
      const form = dialog.querySelector('form.comments-dialog-form');
      const textarea = form.querySelector('textarea[name="body"]');
      textarea.value = 'posted on A, arrives late';

      const deferredA = fetchStub.queueDeferred();
      submit(doc, form);
      expect(fetchStub.calls.length).toBe(1);

      // Switch to B before A's POST settles -- this is what deletes the
      // composer form's in-flight token (resetSharedComposer).
      click(doc, openerB);
      expect(dialog.getAttribute('data-submission-id')).toBe(String(submissionB));
      expect(dialog.querySelectorAll('.feed-comment').length).toBe(0);

      deferredA.resolve({
        ok: true,
        status: 200,
        json: function () {
          return Promise.resolve({
            comment: { id: 9001, guest_id: viewer.guestId, body: 'posted on A, arrives late' },
            commentCount: 1,
          });
        },
      });
      await flushMicrotasks();

      // B's open thread and card are untouched.
      expect(dialog.getAttribute('data-submission-id')).toBe(String(submissionB));
      expect(dialog.querySelectorAll('.feed-comment').length).toBe(0);
      expect(
        doc.getElementById('photo-' + submissionB).querySelector('.comment-count').textContent
      ).toBe(badgeBBefore);

      // A's payload and card DID update, even though A is no longer showing.
      const dataA = JSON.parse(
        doc.querySelector('.feed-card-data[data-for="' + submissionA + '"]').textContent
      );
      expect(dataA.comments.some((c) => c.id === 9001)).toBe(true);
      expect(
        doc.getElementById('photo-' + submissionA).querySelector('.comment-count').textContent
      ).toBe('1');
    } finally {
      restore();
    }
  });

  it('a comment DELETE begun on A that resolves after switching to B updates only card A -- B is untouched', async () => {
    const author = await signedInGuest('sd-xp-del-author', 'XP Del Author');
    const viewer = await signedInGuest('sd-xp-del-viewer', 'XP Del Viewer');
    const submissionA = seedSubmission(author.guestId, {
      photoPath: 'sd-xp-del-a.jpg',
      thumbPath: 'sd-xp-del-at.jpg',
    });
    const submissionB = seedSubmission(author.guestId, {
      taskTitle: 'Shared Dialogs XP Del B',
      photoPath: 'sd-xp-del-b.jpg',
      thumbPath: 'sd-xp-del-bt.jpg',
    });
    const commentId = await postCommentViaHttp(viewer.agent, submissionA, 'to be deleted');

    const { doc, fetchStub, restore } = await loadFeedFixture(viewer.agent);
    try {
      const dialog = doc.getElementById('comments-dialog');
      const openerA = doc.querySelector('[data-open-comments="' + submissionA + '"]');
      const openerB = doc.querySelector('[data-open-comments="' + submissionB + '"]');
      const badgeBBefore = doc
        .getElementById('photo-' + submissionB)
        .querySelector('.comment-count').textContent;

      click(doc, openerA);
      expect(dialog.querySelectorAll('.feed-comment').length).toBe(1);
      const deleteForm = dialog.querySelector(
        'form.comment-delete-form[action$="/comments/' + commentId + '/delete"]'
      );
      expect(deleteForm).not.toBeNull();
      doc.defaultView.confirm = function () {
        return true;
      };

      const deferredA = fetchStub.queueDeferred();
      submit(doc, deleteForm);
      expect(fetchStub.calls.length).toBe(1);

      click(doc, openerB);
      expect(dialog.getAttribute('data-submission-id')).toBe(String(submissionB));
      // B has no comments, so opening it already drew ONE empty-state row.
      expect(
        dialog.querySelector('.comments-dialog-thread').querySelectorAll('.comments-dialog-empty')
          .length
      ).toBe(1);

      deferredA.resolve({
        ok: true,
        status: 200,
        json: function () {
          return Promise.resolve({ deleted: true, commentCount: 0 });
        },
      });
      await flushMicrotasks();

      // B is untouched: still exactly one empty-state row, not a second one
      // appended by A's late-arriving delete finding B's thread already
      // "empty" and re-drawing the empty state on top of it.
      expect(
        dialog.querySelector('.comments-dialog-thread').querySelectorAll('.comments-dialog-empty')
          .length
      ).toBe(1);
      expect(dialog.getAttribute('data-submission-id')).toBe(String(submissionB));
      expect(
        doc.getElementById('photo-' + submissionB).querySelector('.comment-count').textContent
      ).toBe(badgeBBefore);

      // A's payload and card DID lose the comment.
      const dataA = JSON.parse(
        doc.querySelector('.feed-card-data[data-for="' + submissionA + '"]').textContent
      );
      expect(dataA.comments.some((c) => c.id === commentId)).toBe(false);
      expect(
        doc.getElementById('photo-' + submissionA).querySelector('.comment-count').textContent
      ).toBe('0');
    } finally {
      restore();
    }
  });

  it('a comment POST that FAILS after the guest switched away never raises the error line on the photo now showing', async () => {
    const author = await signedInGuest('sd-xp-fail-author', 'XP Fail Author');
    const viewer = await signedInGuest('sd-xp-fail-viewer', 'XP Fail Viewer');
    const submissionA = seedSubmission(author.guestId, {
      photoPath: 'sd-xp-fail-a.jpg',
      thumbPath: 'sd-xp-fail-at.jpg',
    });
    const submissionB = seedSubmission(author.guestId, {
      taskTitle: 'Shared Dialogs XP Fail B',
      photoPath: 'sd-xp-fail-b.jpg',
      thumbPath: 'sd-xp-fail-bt.jpg',
    });

    const { doc, fetchStub, restore } = await loadFeedFixture(viewer.agent);
    try {
      const dialog = doc.getElementById('comments-dialog');
      const openerA = doc.querySelector('[data-open-comments="' + submissionA + '"]');
      const openerB = doc.querySelector('[data-open-comments="' + submissionB + '"]');

      click(doc, openerA);
      const form = dialog.querySelector('form.comments-dialog-form');
      const textarea = form.querySelector('textarea[name="body"]');
      textarea.value = 'will fail after switch';

      const deferredA = fetchStub.queueDeferred();
      submit(doc, form);
      expect(fetchStub.calls.length).toBe(1);

      click(doc, openerB);
      const errorEl = dialog.querySelector('.comment-error');
      expect(errorEl.hidden).toBe(true);

      deferredA.reject(new Error('network drop'));
      await flushMicrotasks();

      expect(dialog.getAttribute('data-submission-id')).toBe(String(submissionB));
      expect(errorEl.hidden).toBe(true);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Composer handover: switching the shared dialog to a different photo while
// a POST is still pending on the last one must hand the ONE composer back to
// the guest immediately -- resetSharedComposer's direct button reset plus its
// token deletion (which lets beginInFlight arm a fresh request) is what makes
// that true; without it Post would stay disabled/"Posting…" on B until
// A's IN_FLIGHT_RELEASE_MS watchdog fires, silently swallowing B's taps.
// ---------------------------------------------------------------------------
it("composer handover: switching photos while A's POST is pending re-enables Post immediately, and a fresh submit on B actually fetches", async () => {
  const author = await signedInGuest('sd-handover-author', 'Handover Author');
  const viewer = await signedInGuest('sd-handover-viewer', 'Handover Viewer');
  const submissionA = seedSubmission(author.guestId, {
    photoPath: 'sd-handover-a.jpg',
    thumbPath: 'sd-handover-at.jpg',
  });
  const submissionB = seedSubmission(author.guestId, {
    taskTitle: 'Shared Dialogs Handover B',
    photoPath: 'sd-handover-b.jpg',
    thumbPath: 'sd-handover-bt.jpg',
  });

  const { doc, fetchStub, restore } = await loadFeedFixture(viewer.agent);
  try {
    const dialog = doc.getElementById('comments-dialog');
    const openerA = doc.querySelector('[data-open-comments="' + submissionA + '"]');
    const openerB = doc.querySelector('[data-open-comments="' + submissionB + '"]');

    click(doc, openerA);
    const form = dialog.querySelector('form.comments-dialog-form');
    const textarea = form.querySelector('textarea[name="body"]');
    const postButton = form.querySelector('.comment-post');
    const restingLabel = postButton.textContent;

    textarea.value = 'pending on A';
    fetchStub.queueDeferred(); // never resolves in this test
    submit(doc, form);
    expect(fetchStub.calls.length).toBe(1);
    expect(postButton.disabled).toBe(true);
    expect(postButton.textContent).toBe('Posting…');

    click(doc, openerB);
    // Not stuck showing A's in-flight state: the label is back to resting
    // ("Post", never "Posting…"), and the composer's own empty-box mute rule
    // is what disables it now -- not a still-armed guard left over from A.
    expect(postButton.textContent).toBe(restingLabel);
    expect(postButton.disabled).toBe(true);

    // Proof the control is genuinely usable, not just visually reset: typing
    // on B re-enables Post (the ordinary empty-composer rule, now free to
    // react), and submitting actually reaches fetch a second time rather
    // than being silently swallowed by a guard token A's pending request
    // left armed.
    textarea.value = 'fresh on B';
    textarea.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
    expect(postButton.disabled).toBe(false);

    submit(doc, form);
    expect(fetchStub.calls.length).toBe(2);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Couple's Heart (client): a payload liker row carrying couple:1 draws a
// .couple-heart node (feed.js's coupleHeartNode(), cloned from the single
// <template id="couple-heart-template">) with role="img" and the aria-label
// substituted from the template's own "{name}" placeholder -- COUPLE_HEART_
// NAME_SLOT. A row without the flag draws no such node.
// ---------------------------------------------------------------------------
it('Couple\'s Heart (client): a couple:1 liker row renders a .couple-heart with role=img and the substituted "Loved by <name>" label; a plain row renders none, and no literal "{name}" survives', async () => {
  const author = await signedInGuest('sd-heart-author', 'Heart Author');
  const couple = await signedInGuest('sd-heart-couple', 'Heart Lilly');
  const ordinary = await signedInGuest('sd-heart-ordinary', 'Heart Ordinary');
  db.prepare('UPDATE guests SET is_couple = 1 WHERE id = ?').run(couple.guestId);
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'sd-heart.jpg',
    thumbPath: 'sd-heartt.jpg',
  });
  await couple.agent.post('/p/' + submissionId + '/like');
  await ordinary.agent.post('/p/' + submissionId + '/like');

  const { doc, restore } = await loadFeedFixture(author.agent);
  try {
    const opener = doc.querySelector('[data-open-likes="' + submissionId + '"]');
    click(doc, opener);
    const dialog = doc.getElementById('likes-dialog');
    const thread = dialog.querySelector('.likes-thread');

    const coupleRow = thread.querySelector('[data-likes-row="' + couple.guestId + '"]');
    expect(coupleRow).not.toBeNull();
    const heart = coupleRow.querySelector('.couple-heart');
    expect(heart).not.toBeNull();
    expect(heart.getAttribute('role')).toBe('img');
    expect(heart.getAttribute('aria-label')).toBe('Loved by Heart Lilly');

    const ordinaryRow = thread.querySelector('[data-likes-row="' + ordinary.guestId + '"]');
    expect(ordinaryRow).not.toBeNull();
    expect(ordinaryRow.querySelector('.couple-heart')).toBeNull();

    // The placeholder the template is rendered with server-side never
    // survives into what the guest sees, on either row.
    expect(dialog.innerHTML).not.toContain('{name}');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// The viewer's own like keeps the heart: selfLikerRow() reads guest.couple
// off the .feed root's data-guest-couple attribute (feed.ejs), so a
// couple-flagged guest's OWN live like writes couple:1 into the card
// payload -- not just server-rendered rows from BEFORE this page load.
// ---------------------------------------------------------------------------
describe("the viewer's own like keeps the Couple's Heart", () => {
  it('data-guest-couple="1": a live like writes couple:1 into the payload, and the re-opened dialog shows the heart on the own row', async () => {
    const author = await signedInGuest('sd-selfheart-author', 'SelfHeart Author');
    const viewer = await signedInGuest('sd-selfheart-viewer', 'SelfHeart Lilly');
    db.prepare('UPDATE guests SET is_couple = 1 WHERE id = ?').run(viewer.guestId);
    const submissionId = seedSubmission(author.guestId, {
      photoPath: 'sd-selfheart.jpg',
      thumbPath: 'sd-selfheartt.jpg',
    });

    const { doc, fetchStub, restore } = await loadFeedFixture(viewer.agent);
    try {
      expect(doc.querySelector('.feed').getAttribute('data-guest-couple')).toBe('1');

      const article = doc.getElementById('photo-' + submissionId);
      const likeForm = article.querySelector('.like-form');
      fetchStub.queueOk({ liked: true, likeCount: 1 });
      submit(doc, likeForm);
      await flushMicrotasks();

      const data = JSON.parse(
        doc.querySelector('.feed-card-data[data-for="' + submissionId + '"]').textContent
      );
      const ownRow = data.likers.find((row) => String(row.id) === String(viewer.guestId));
      expect(ownRow).toBeTruthy();
      expect(ownRow.couple).toBe(1);

      const likesDialog = doc.getElementById('likes-dialog');
      const opener = article.querySelector('[data-open-likes="' + submissionId + '"]');
      click(doc, opener);
      const ownDomRow = likesDialog.querySelector('[data-likes-row="' + viewer.guestId + '"]');
      expect(ownDomRow.querySelector('.couple-heart')).not.toBeNull();
    } finally {
      restore();
    }
  });

  it('data-guest-couple absent: a live like writes no couple flag, and the row shows no heart', async () => {
    const author = await signedInGuest('sd-selfheart2-author', 'SelfHeart2 Author');
    const viewer = await signedInGuest('sd-selfheart2-viewer', 'SelfHeart2 Viewer');
    const submissionId = seedSubmission(author.guestId, {
      photoPath: 'sd-selfheart2.jpg',
      thumbPath: 'sd-selfheart2t.jpg',
    });

    const { doc, fetchStub, restore } = await loadFeedFixture(viewer.agent);
    try {
      expect(doc.querySelector('.feed').getAttribute('data-guest-couple')).toBe('');

      const article = doc.getElementById('photo-' + submissionId);
      const likeForm = article.querySelector('.like-form');
      fetchStub.queueOk({ liked: true, likeCount: 1 });
      submit(doc, likeForm);
      await flushMicrotasks();

      const data = JSON.parse(
        doc.querySelector('.feed-card-data[data-for="' + submissionId + '"]').textContent
      );
      const ownRow = data.likers.find((row) => String(row.id) === String(viewer.guestId));
      expect(ownRow).toBeTruthy();
      expect(ownRow.couple).toBeUndefined();

      const likesDialog = doc.getElementById('likes-dialog');
      const opener = article.querySelector('[data-open-likes="' + submissionId + '"]');
      click(doc, opener);
      const ownDomRow = likesDialog.querySelector('[data-likes-row="' + viewer.guestId + '"]');
      expect(ownDomRow.querySelector('.couple-heart')).toBeNull();
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Dialog title: derived at open time from the OPENED card's .feed-by-name,
// not carried in the payload -- so it must change when a different card
// opens the same shared dialog.
// ---------------------------------------------------------------------------
it('dialog title: reads "<Name>\'s photo" for the photo actually opened, and changes when a different card opens', async () => {
  const authorA = await signedInGuest('sd-title-a-author', 'Title Author A');
  const authorB = await signedInGuest('sd-title-b-author', 'Title Author B');
  const submissionA = seedSubmission(authorA.guestId, {
    photoPath: 'sd-title-a.jpg',
    thumbPath: 'sd-title-at.jpg',
  });
  const submissionB = seedSubmission(authorB.guestId, {
    taskTitle: 'Shared Dialogs Title B',
    photoPath: 'sd-title-b.jpg',
    thumbPath: 'sd-title-bt.jpg',
  });

  const { doc, restore } = await loadFeedFixture(authorA.agent);
  try {
    const dialog = doc.getElementById('comments-dialog');
    const title = dialog.querySelector('.comments-dialog-title');
    const openerA = doc.querySelector('[data-open-comments="' + submissionA + '"]');
    const openerB = doc.querySelector('[data-open-comments="' + submissionB + '"]');

    click(doc, openerA);
    expect(title.textContent).toBe('Title Author A’s photo');

    click(doc, openerB);
    expect(title.textContent).toBe('Title Author B’s photo');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// A -> B -> A round trips. resetSharedComposer no longer clears the pending
// token when the guest wanders away and back (only the draft and the Post
// button's visible state) -- beginInFlight's per-photo `scope` is what lets a
// tap on B's Post arm a fresh request while A's is outstanding, without
// disturbing A's own token. Returning to A leaves that token untouched, so
// A's eventual settle is still "current" (release() succeeds) and lands on a
// dialog that is once again showing A.
// ---------------------------------------------------------------------------
describe('A -> B -> A round trip', () => {
  it('a comment POST on A held through a detour to B and back settles into A exactly once, with a sane composer', async () => {
    const author = await signedInGuest('sd-rt-post-author', 'RT Post Author');
    const viewer = await signedInGuest('sd-rt-post-viewer', 'RT Post Viewer');
    const submissionA = seedSubmission(author.guestId, {
      photoPath: 'sd-rt-post-a.jpg',
      thumbPath: 'sd-rt-post-at.jpg',
    });
    const submissionB = seedSubmission(author.guestId, {
      taskTitle: 'Shared Dialogs RT Post B',
      photoPath: 'sd-rt-post-b.jpg',
      thumbPath: 'sd-rt-post-bt.jpg',
    });

    const { doc, fetchStub, restore } = await loadFeedFixture(viewer.agent);
    try {
      const dialog = doc.getElementById('comments-dialog');
      const openerA = doc.querySelector('[data-open-comments="' + submissionA + '"]');
      const openerB = doc.querySelector('[data-open-comments="' + submissionB + '"]');

      click(doc, openerA);
      const form = dialog.querySelector('form.comments-dialog-form');
      const textarea = form.querySelector('textarea[name="body"]');
      const postButton = form.querySelector('.comment-post');
      const restingLabel = postButton.textContent;
      textarea.value = 'posted on A, arrives after the detour';

      const deferredA = fetchStub.queueDeferred();
      submit(doc, form);
      expect(fetchStub.calls.length).toBe(1);

      // Detour to B, then back to A -- still no settle.
      click(doc, openerB);
      click(doc, openerA);
      expect(dialog.getAttribute('data-submission-id')).toBe(String(submissionA));

      deferredA.resolve({
        ok: true,
        status: 200,
        json: function () {
          return Promise.resolve({
            comment: {
              id: 9101,
              guest_id: viewer.guestId,
              body: 'posted on A, arrives after the detour',
            },
            commentCount: 1,
          });
        },
      });
      await flushMicrotasks();

      // Exactly one copy in the open thread -- not zero (the detour didn't
      // eat it) and not two (the pre-settle redraw plus the append didn't
      // double it).
      const rows = dialog.querySelectorAll('.feed-comment');
      expect(rows.length).toBe(1);
      expect(rows[0].textContent).toContain('posted on A, arrives after the detour');

      // Payload and badge agree with the thread.
      const dataA = JSON.parse(
        doc.querySelector('.feed-card-data[data-for="' + submissionA + '"]').textContent
      );
      expect(dataA.comments.filter((c) => c.id === 9101).length).toBe(1);
      expect(
        doc.getElementById('photo-' + submissionA).querySelector('.comment-count').textContent
      ).toBe('1');

      // The composer is left sane: the sent draft is gone, Post reads its
      // resting label (not stuck "Posting…"), and is disabled because the
      // box is genuinely empty -- not because a guard is still armed.
      expect(textarea.value).toBe('');
      expect(postButton.textContent).toBe(restingLabel);
      expect(postButton.disabled).toBe(true);
    } finally {
      restore();
    }
  });

  it('a comment DELETE on A held through a detour to B and back removes the comment from the open thread with no leftover Delete control', async () => {
    const author = await signedInGuest('sd-rt-del-author', 'RT Del Author');
    const viewer = await signedInGuest('sd-rt-del-viewer', 'RT Del Viewer');
    const submissionA = seedSubmission(author.guestId, {
      photoPath: 'sd-rt-del-a.jpg',
      thumbPath: 'sd-rt-del-at.jpg',
    });
    const submissionB = seedSubmission(author.guestId, {
      taskTitle: 'Shared Dialogs RT Del B',
      photoPath: 'sd-rt-del-b.jpg',
      thumbPath: 'sd-rt-del-bt.jpg',
    });
    const commentId = await postCommentViaHttp(
      viewer.agent,
      submissionA,
      'to be deleted via detour'
    );

    const { doc, fetchStub, restore } = await loadFeedFixture(viewer.agent);
    try {
      const dialog = doc.getElementById('comments-dialog');
      const openerA = doc.querySelector('[data-open-comments="' + submissionA + '"]');
      const openerB = doc.querySelector('[data-open-comments="' + submissionB + '"]');

      click(doc, openerA);
      expect(dialog.querySelectorAll('.feed-comment').length).toBe(1);
      const deleteForm = dialog.querySelector(
        'form.comment-delete-form[action$="/comments/' + commentId + '/delete"]'
      );
      expect(deleteForm).not.toBeNull();
      doc.defaultView.confirm = function () {
        return true;
      };

      const deferredA = fetchStub.queueDeferred();
      submit(doc, deleteForm);
      expect(fetchStub.calls.length).toBe(1);

      // Detour to B, then back to A. The return redraws A's thread from the
      // still-unchanged payload, so the comment (and a FRESH delete form for
      // it) is back on screen -- the old captured `deleteForm` reference is
      // now a detached node.
      click(doc, openerB);
      click(doc, openerA);
      expect(dialog.querySelectorAll('.feed-comment').length).toBe(1);

      deferredA.resolve({
        ok: true,
        status: 200,
        json: function () {
          return Promise.resolve({ deleted: true, commentCount: 0 });
        },
      });
      await flushMicrotasks();

      expect(dialog.querySelectorAll('.feed-comment').length).toBe(0);
      expect(dialog.querySelector('[data-delete-comment="' + commentId + '"]')).toBeNull();
      expect(dialog.querySelector('.comments-dialog-empty')).not.toBeNull();

      const dataA = JSON.parse(
        doc.querySelector('.feed-card-data[data-for="' + submissionA + '"]').textContent
      );
      expect(dataA.comments.some((c) => c.id === commentId)).toBe(false);
      expect(
        doc.getElementById('photo-' + submissionA).querySelector('.comment-count').textContent
      ).toBe('0');
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// The distinguishing case: a hung post whose watchdog fires and which the
// guest then retries on the SAME photo must still reject the original's late
// settle -- no stale append, no hiding the retry's own error line -- even
// though the dialog never left that photo (dialogShows is true throughout,
// so the token comparison inside release() is the only thing standing
// between this and a corrupted thread). tests/feed-robustness.test.js covers
// this scenario already; this is the same promise asserted directly against
// the shared dialog's own elements, so a regression in either file's picture
// of the guard shows up independently.
// ---------------------------------------------------------------------------
it('same-photo watchdog + retry: a hung POST that settles AFTER the watchdog released and the guest retried does not hide the retry error or append a stale comment', async () => {
  const author = await signedInGuest('sd-watchdog-author', 'Watchdog Author');
  const viewer = await signedInGuest('sd-watchdog-viewer', 'Watchdog Viewer');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'sd-watchdog.jpg',
    thumbPath: 'sd-watchdogt.jpg',
  });

  const { doc, fetchStub, restore } = await loadFeedFixture(viewer.agent);
  try {
    const dialog = doc.getElementById('comments-dialog');
    const opener = doc.querySelector('[data-open-comments="' + submissionId + '"]');
    click(doc, opener);
    const form = dialog.querySelector('form.comments-dialog-form');
    const textarea = form.querySelector('textarea[name="body"]');
    const errorEl = dialog.querySelector('.comment-error');
    const thread = dialog.querySelector('.comments-dialog-thread');

    vi.useFakeTimers();
    try {
      var hungRequest = fetchStub.queueDeferred();
      textarea.value = 'hangs then arrives late';
      submit(doc, form);
      expect(fetchStub.calls.length).toBe(1);

      // The watchdog elapses -- the guest is un-stuck, the guard released.
      await vi.advanceTimersByTimeAsync(10000);

      // The retry, still on the SAME photo, fails and raises the error line.
      fetchStub.queueFail(429);
      textarea.value = 'retry that fails';
      submit(doc, form);
      expect(fetchStub.calls.length).toBe(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(errorEl.hidden).toBe(false);
      const countAfterRetry = thread.querySelectorAll('.feed-comment').length;

      // The abandoned first request finally resolves -- it must not hide the
      // retry's error line or append its now-stale comment.
      hungRequest.resolve({
        ok: true,
        status: 200,
        json: function () {
          return Promise.resolve({
            comment: { id: 9201, guest_id: viewer.guestId, body: 'hangs then arrives late' },
            commentCount: 5,
          });
        },
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(errorEl.hidden).toBe(false);
      expect(thread.querySelectorAll('.feed-comment').length).toBe(countAfterRetry);
      expect(dialog.getAttribute('data-submission-id')).toBe(String(submissionId));
    } finally {
      vi.useRealTimers();
    }
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Composer scope: a tap for photo B is a DIFFERENT scope from photo A, so it
// is allowed to arm and fetch even while A's own POST is still outstanding --
// but a second tap for A itself, while A is still pending, is the ordinary
// same-scope double-tap and sends nothing.
// ---------------------------------------------------------------------------
it('composer scope: a second tap on A sends nothing while A is pending; opening B leaves Post usable and B posts to its own route', async () => {
  const author = await signedInGuest('sd-scope-author', 'Scope Author');
  const viewer = await signedInGuest('sd-scope-viewer', 'Scope Viewer');
  const submissionA = seedSubmission(author.guestId, {
    photoPath: 'sd-scope-a.jpg',
    thumbPath: 'sd-scope-at.jpg',
  });
  const submissionB = seedSubmission(author.guestId, {
    taskTitle: 'Shared Dialogs Scope B',
    photoPath: 'sd-scope-b.jpg',
    thumbPath: 'sd-scope-bt.jpg',
  });

  const { doc, fetchStub, restore } = await loadFeedFixture(viewer.agent);
  try {
    const dialog = doc.getElementById('comments-dialog');
    const openerA = doc.querySelector('[data-open-comments="' + submissionA + '"]');
    const openerB = doc.querySelector('[data-open-comments="' + submissionB + '"]');

    click(doc, openerA);
    const form = dialog.querySelector('form.comments-dialog-form');
    const textarea = form.querySelector('textarea[name="body"]');
    const postButton = form.querySelector('.comment-post');
    const restingLabel = postButton.textContent;

    fetchStub.queueDeferred(); // A's request never settles in this test
    textarea.value = 'first on A';
    submit(doc, form);
    expect(fetchStub.calls.length).toBe(1);

    // A second tap on A itself, still pending: same scope, blocked outright.
    textarea.value = 'second on A';
    submit(doc, form);
    expect(fetchStub.calls.length).toBe(1);

    // Switching to B is a DIFFERENT scope: Post is usable immediately.
    click(doc, openerB);
    expect(postButton.textContent).toBe(restingLabel);
    expect(postButton.disabled).toBe(true); // empty box, the ordinary mute rule

    fetchStub.queueDeferred(); // B's request also never settles here
    textarea.value = 'first on B';
    textarea.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
    expect(postButton.disabled).toBe(false);
    submit(doc, form);

    expect(fetchStub.calls.length).toBe(2);
    expect(fetchStub.calls[1].url).toBe('/p/' + submissionB + '/comments');
  } finally {
    restore();
  }
});
