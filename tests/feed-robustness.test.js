// tests/feed-robustness.test.js
// Issue #934 AC1-AC4: like/comment/delete robustness on the feed card
// (src/public/js/feed.js) --
//   AC1 -- a comment Post double-tap while the first POST is in flight sends
//          exactly one request; the button disables and reads "Posting…"
//          until the response settles.
//   AC2 -- a like double-tap while the first toggle is in flight sends
//          exactly one request -- the trained double-tap gesture cannot
//          like-then-unlike itself.
//   AC3 -- a like/comment/delete fetch that rejects or answers a non-ok
//          status (429) shows the pre-rendered inline message in place and
//          NEVER navigates (no native form.submit() fallback); a subsequent
//          successful action re-hides the message.
//   AC4 -- a fetch that never settles releases its control (Post / the
//          heart) via the named watchdog constant, so a guest is never
//          permanently locked out by a dropped request.
//
// Same jsdom-driven pattern as tests/feed-likers-script.test.js: render the
// real server markup via GET /feed, load it into a synthetic document, stub
// the <dialog> API and window.fetch, delete require.cache, require the real
// feed.js fresh, and dispatch real 'submit' events.
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
  const result = loadApp();
  app = result.app;
  db = result.db;
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
    .run(opts.taskTitle || 'Robustness Test Task').lastInsertRowid;
  const submissionId = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, 0)`
    )
    .run(
      authorGuestId,
      taskId,
      opts.photoPath || 'robustness.jpg',
      opts.thumbPath || 'robustness-thumb.jpg'
    ).lastInsertRowid;
  return submissionId;
}

/** Post a comment as `agent` and return its new row id (mirrors feed-comment-delete.test.js). */
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
 * A controllable window.fetch stand-in. Each call is recorded in `.calls`.
 * By default (nothing queued) a call returns a promise that NEVER settles --
 * exactly the shape both the double-tap ACs (AC1/AC2: "first response
 * pending") and the watchdog AC (AC4: "a fetch that never settles") need
 * without any extra setup. `.queueOk`/`.queueFail`/`.queueReject` push a
 * one-shot resolution consumed by the NEXT call.
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
    return new Promise(function () {}); // never settles
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
  stub.queueReject = function () {
    queue.push(function () {
      return Promise.reject(new Error('network drop'));
    });
  };
  // A one-shot response the test resolves ITSELF, later, via the returned
  // deferred — the shape the stale-late-response race (AC3) needs: hold a
  // request open past the watchdog, let the guest retry, THEN settle the
  // abandoned one and assert it mutates nothing.
  stub.queueDeferred = function () {
    var deferred = {};
    deferred.promise = new Promise(function (resolve) {
      deferred.resolve = resolve;
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
 * <dialog> API + HTMLFormElement.prototype.submit (a spy, so AC3's "never
 * navigates" claim is checked directly, not inferred) + window.fetch, then
 * require the real feed.js fresh against this document. Returns the DOM
 * handles the tests need plus a `restore()` to undo the global swap -- ALWAYS
 * call it in a finally block, same convention as feed-likers-script.test.js.
 */
async function loadFeedFixture(agent) {
  const feedRes = await agent.get('/feed');
  expect(feedRes.status).toBe(200);

  const dom = new JSDOM(feedRes.text, { url: 'http://localhost/feed' });

  // jsdom's HTMLDialogElement ships open-only -- stub minimally, same
  // technique tests/feed-likers-script.test.js uses.
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };

  const submitCalls = [];
  dom.window.HTMLFormElement.prototype.submit = function () {
    submitCalls.push(this);
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

  return { dom, doc: dom.window.document, fetchStub, submitCalls, restore };
}

async function flushMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Open the page's ONE shared comments dialog onto `submissionId` (issue
 * #1139): click that card's comment opener so feed.js fills the dialog from
 * its .feed-card-data payload and sets the composer's form action, then
 * return the now-open dialog. Every test below that reaches into the
 * comments dialog's form needs this first -- before #1139 each card's dialog
 * (and its form action) was already in the served HTML; now it is drawn only
 * on open.
 */
function openComments(doc, submissionId) {
  const opener = doc.querySelector('[data-open-comments="' + submissionId + '"]');
  opener.dispatchEvent(new doc.defaultView.Event('click', { bubbles: true }));
  return doc.getElementById('comments-dialog');
}

// ---------------------------------------------------------------------------
// AC1: comment Post double-tap.
// ---------------------------------------------------------------------------
it('AC1: a Post double-tap while the first POST is pending sends exactly one request; the button disables and reads "Posting…" until it settles', async () => {
  const author = await signedInGuest('robust-ac1-author', 'AC1 Author');
  const viewer = await signedInGuest('robust-ac1-viewer', 'AC1 Viewer');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'ac1.jpg',
    thumbPath: 'ac1t.jpg',
  });

  const { doc, fetchStub, restore } = await loadFeedFixture(viewer.agent);
  try {
    const dialog = openComments(doc, submissionId);
    const form = dialog.querySelector('form.comments-dialog-form');
    const textarea = form.querySelector('textarea[name="body"]');
    const postButton = form.querySelector('.comment-post');
    expect(postButton.textContent).toBe('Post');

    textarea.value = 'first tap';
    // Two rapid taps -- the first fetch call is deliberately left pending
    // (fetchStub's default) so the second tap lands DURING flight.
    form.dispatchEvent(new domEvent(doc, 'submit'));
    form.dispatchEvent(new domEvent(doc, 'submit'));

    expect(fetchStub.calls.length).toBe(1);
    expect(postButton.disabled).toBe(true);
    expect(postButton.textContent).toBe('Posting…');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// AC2: like double-tap.
// ---------------------------------------------------------------------------
it("AC2: a like double-tap while the first toggle is in flight sends exactly one request -- the double-tap can't self-cancel", async () => {
  const author = await signedInGuest('robust-ac2-author', 'AC2 Author');
  const viewer = await signedInGuest('robust-ac2-viewer', 'AC2 Viewer');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'ac2.jpg',
    thumbPath: 'ac2t.jpg',
  });

  const { doc, fetchStub, restore } = await loadFeedFixture(viewer.agent);
  try {
    const form = doc.querySelector('.like-form[action="/p/' + submissionId + '/like"]');

    form.dispatchEvent(new domEvent(doc, 'submit'));
    form.dispatchEvent(new domEvent(doc, 'submit'));

    expect(fetchStub.calls.length).toBe(1);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// AC3: a rejected/429 fetch shows the inline message, never navigates; a
// later successful action re-hides it. Covered for like, comment post, and
// comment delete -- the three paths the issue names.
// ---------------------------------------------------------------------------
describe('AC3: failure degrades to the inline message, never a page navigation', () => {
  it('like: a 429 response un-hides .feed-action-error and form.submit() is never called; a successful retry re-hides it', async () => {
    const author = await signedInGuest('robust-ac3l-author', 'AC3L Author');
    const viewer = await signedInGuest('robust-ac3l-viewer', 'AC3L Viewer');
    const submissionId = seedSubmission(author.guestId, {
      photoPath: 'ac3l.jpg',
      thumbPath: 'ac3lt.jpg',
    });

    const { doc, fetchStub, submitCalls, restore } = await loadFeedFixture(viewer.agent);
    try {
      const article = doc.getElementById('photo-' + submissionId);
      const form = article.querySelector('.like-form');
      const errorEl = article.querySelector('.feed-action-error');
      expect(errorEl.hidden).toBe(true);

      fetchStub.queueFail(429);
      form.dispatchEvent(new domEvent(doc, 'submit'));
      await flushMicrotasks();

      expect(errorEl.hidden).toBe(false);
      expect(submitCalls.length).toBe(0); // no full-page re-POST

      // A successful retry re-hides the line.
      fetchStub.queueOk({ liked: true, likeCount: 1 });
      form.dispatchEvent(new domEvent(doc, 'submit'));
      await flushMicrotasks();

      expect(errorEl.hidden).toBe(true);
    } finally {
      restore();
    }
  });

  it('comment post: a rejected fetch un-hides .comment-error and form.submit() is never called; a successful retry re-hides it', async () => {
    const author = await signedInGuest('robust-ac3c-author', 'AC3C Author');
    const viewer = await signedInGuest('robust-ac3c-viewer', 'AC3C Viewer');
    const submissionId = seedSubmission(author.guestId, {
      photoPath: 'ac3c.jpg',
      thumbPath: 'ac3ct.jpg',
    });

    const { doc, fetchStub, submitCalls, restore } = await loadFeedFixture(viewer.agent);
    try {
      const dialog = openComments(doc, submissionId);
      const form = dialog.querySelector('form.comments-dialog-form');
      const textarea = form.querySelector('textarea[name="body"]');
      const postButton = form.querySelector('.comment-post');
      const errorEl = dialog.querySelector('.comment-error');
      expect(errorEl.hidden).toBe(true);

      textarea.value = 'will fail';
      fetchStub.queueReject();
      form.dispatchEvent(new domEvent(doc, 'submit'));
      await flushMicrotasks();

      expect(errorEl.hidden).toBe(false);
      expect(submitCalls.length).toBe(0);
      // The button is usable again immediately on the settled failure path
      // (not just via the watchdog -- see AC4 below for the hung-request case).
      expect(postButton.disabled).toBe(false);
      expect(postButton.textContent).toBe('Post');

      // A successful retry re-hides the line.
      textarea.value = 'this one works';
      fetchStub.queueOk({
        comment: { id: 1, guest_id: viewer.guestId, body: 'this one works' },
        commentCount: 1,
      });
      form.dispatchEvent(new domEvent(doc, 'submit'));
      await flushMicrotasks();

      expect(errorEl.hidden).toBe(true);
    } finally {
      restore();
    }
  });

  it('comment delete: a rejected fetch un-hides .comment-error, the comment row stays, and form.submit() is never called', async () => {
    const author = await signedInGuest('robust-ac3d-author', 'AC3D Author');
    const viewer = await signedInGuest('robust-ac3d-viewer', 'AC3D Viewer');
    const submissionId = seedSubmission(author.guestId, {
      photoPath: 'ac3d.jpg',
      thumbPath: 'ac3dt.jpg',
    });
    const commentId = await postCommentViaHttp(viewer.agent, submissionId, 'mine to delete');

    const { doc, fetchStub, submitCalls, restore } = await loadFeedFixture(viewer.agent);
    try {
      const dialog = openComments(doc, submissionId);
      const deleteForm = dialog.querySelector(
        'form.comment-delete-form[action$="/comments/' + commentId + '/delete"]'
      );
      expect(deleteForm).not.toBeNull();
      const errorEl = dialog.querySelector('.comment-error');
      expect(errorEl.hidden).toBe(true);

      fetchStub.queueReject();
      // deleteComment is only reached past the confirm check, which lives in
      // the submit listener itself -- window.confirm isn't stubbed, so stub
      // it here to auto-accept, matching a real confirmed delete tap.
      doc.defaultView.confirm = function () {
        return true;
      };
      deleteForm.dispatchEvent(new domEvent(doc, 'submit'));
      await flushMicrotasks();

      expect(errorEl.hidden).toBe(false);
      expect(submitCalls.length).toBe(0);
      // The row is still there -- the failed delete did not remove it.
      expect(doc.querySelector('[data-delete-comment="' + commentId + '"]')).not.toBeNull();
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// AC4: a fetch that never settles -- the watchdog releases the control.
// ---------------------------------------------------------------------------
describe('AC4: the watchdog releases a control whose fetch never settles', () => {
  it('comment Post: stays "Posting…"/disabled while the fetch hangs, then re-enables once the watchdog elapses -- and a fresh tap sends a new request', async () => {
    // Fake timers are armed AFTER all the real async setup below (supertest/
    // better-sqlite3), never around it -- superagent's own machinery relies
    // on real timers, so wrapping the setup in fake ones hangs the test.
    const author = await signedInGuest('robust-ac4c-author', 'AC4C Author');
    const viewer = await signedInGuest('robust-ac4c-viewer', 'AC4C Viewer');
    const submissionId = seedSubmission(author.guestId, {
      photoPath: 'ac4c.jpg',
      thumbPath: 'ac4ct.jpg',
    });

    const { doc, fetchStub, restore } = await loadFeedFixture(viewer.agent);
    try {
      const dialog = openComments(doc, submissionId);
      const form = dialog.querySelector('form.comments-dialog-form');
      const textarea = form.querySelector('textarea[name="body"]');
      const postButton = form.querySelector('.comment-post');

      vi.useFakeTimers();
      try {
        textarea.value = 'hung request';
        form.dispatchEvent(new domEvent(doc, 'submit')); // fetchStub's default: never settles
        expect(fetchStub.calls.length).toBe(1);
        expect(postButton.disabled).toBe(true);
        expect(postButton.textContent).toBe('Posting…');

        // Not yet at the watchdog's own duration: still muted.
        await vi.advanceTimersByTimeAsync(9999);
        expect(postButton.disabled).toBe(true);

        // The watchdog elapses -- the control is usable again, per AC4, even
        // though the original fetch never resolved or rejected.
        await vi.advanceTimersByTimeAsync(1);
        expect(postButton.disabled).toBe(false);
        expect(postButton.textContent).toBe('Post');

        // Proof the control is genuinely usable, not just visually reset: a
        // fresh tap sends a SECOND request.
        textarea.value = 'retry after watchdog';
        form.dispatchEvent(new domEvent(doc, 'submit'));
        expect(fetchStub.calls.length).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    } finally {
      restore();
    }
  });

  it('like: the heart re-enables its control (usable for a fresh tap) once the watchdog elapses on a hung toggle', async () => {
    const author = await signedInGuest('robust-ac4l-author', 'AC4L Author');
    const viewer = await signedInGuest('robust-ac4l-viewer', 'AC4L Viewer');
    const submissionId = seedSubmission(author.guestId, {
      photoPath: 'ac4l.jpg',
      thumbPath: 'ac4lt.jpg',
    });

    const { doc, fetchStub, restore } = await loadFeedFixture(viewer.agent);
    try {
      const form = doc.querySelector('.like-form[action="/p/' + submissionId + '/like"]');

      vi.useFakeTimers();
      try {
        form.dispatchEvent(new domEvent(doc, 'submit')); // never settles
        expect(fetchStub.calls.length).toBe(1);
        // A second tap while still (apparently) pending is ignored.
        form.dispatchEvent(new domEvent(doc, 'submit'));
        expect(fetchStub.calls.length).toBe(1);

        await vi.advanceTimersByTimeAsync(10000);

        // The guard released -- a fresh tap now sends a new request.
        form.dispatchEvent(new domEvent(doc, 'submit'));
        expect(fetchStub.calls.length).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// AC3 (stale late response): a request that hangs past the watchdog, is
// abandoned, retried, and THEN finally succeeds must not mutate the DOM — it
// must not hide the retry's fresh error line or append its now-stale payload.
// Guards the per-form guard's stale-safety extending to response handling,
// not just the guard token.
// ---------------------------------------------------------------------------
it('a hung comment POST that succeeds AFTER the watchdog released and the guest retried does not hide the retry error or append a stale comment', async () => {
  const author = await signedInGuest('robust-stale-author', 'Stale Author');
  const viewer = await signedInGuest('robust-stale-viewer', 'Stale Viewer');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'stale.jpg',
    thumbPath: 'stalet.jpg',
  });

  const { doc, fetchStub, restore } = await loadFeedFixture(viewer.agent);
  try {
    const dialog = openComments(doc, submissionId);
    const form = dialog.querySelector('form.comments-dialog-form');
    const textarea = form.querySelector('textarea[name="body"]');
    const errorEl = dialog.querySelector('.comment-error');
    const thread = dialog.querySelector('.comments-dialog-thread');

    vi.useFakeTimers();
    try {
      // Request A hangs. Hold it open with a deferred we resolve ourselves.
      const requestA = fetchStub.queueDeferred();
      textarea.value = 'hangs then arrives late';
      form.dispatchEvent(domEvent(doc, 'submit'));
      expect(fetchStub.calls.length).toBe(1);

      // The watchdog elapses: the guest is un-stuck, the guard released.
      // 10000ms mirrors feed.js's private IN_FLIGHT_RELEASE_MS — a change to
      // that constant makes this advance too short and the test fails loudly.
      await vi.advanceTimersByTimeAsync(10000);

      // Request B (the retry) fails and raises the inline error.
      fetchStub.queueFail(429);
      textarea.value = 'retry that fails';
      form.dispatchEvent(domEvent(doc, 'submit'));
      expect(fetchStub.calls.length).toBe(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(errorEl.hidden).toBe(false);
      const threadCountAfterRetry = thread.querySelectorAll('.feed-comment').length;

      // Request A finally resolves 200 — the abandoned, stale one. It must
      // NOT hide B's error line and must NOT append its comment.
      requestA.resolve({
        ok: true,
        status: 200,
        json: function () {
          return Promise.resolve({
            comment: { id: 99, guest_id: viewer.guestId, body: 'hangs then arrives late' },
            commentCount: 5,
          });
        },
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(errorEl.hidden).toBe(false); // B's error still shown
      expect(thread.querySelectorAll('.feed-comment').length).toBe(threadCountAfterRetry); // no stale append
    } finally {
      vi.useRealTimers();
    }
  } finally {
    restore();
  }
});

/** A real 'submit' Event constructed in the fixture's own jsdom realm. */
function domEvent(doc, type) {
  return new doc.defaultView.Event(type, { bubbles: true, cancelable: true });
}
