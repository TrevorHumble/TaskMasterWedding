// tests/feed-likers-script.test.js
// Covers issue #890 AC5's CLIENT-SIDE half — src/public/js/feed.js keeping a
// photo's likers dialog truthful after a like toggle, with no reload. Mirrors
// the jsdom-driven pattern in tests/feed-card.test.js / tests/lightbox.test.js
// / tests/crowd-favorite-crown.test.js: render the real server markup via
// GET /feed, load it into a synthetic jsdom document, stub fetch + the
// <dialog> API, require the real feed.js fresh, and dispatch a real 'submit'
// event.
//
// The defect this guards against: a guest who liked a photo BEFORE this page
// load has their own likers-dialog row rendered SERVER-SIDE (attachLikers,
// community.js) with no client-side memory of it. Matching only a
// client-inserted row (a separate "self" marker) would leave that
// server-rendered row behind on unlike, and would let a later re-like insert
// a SECOND row beside it. data-likes-row is the one row-identity hook stamped
// on every row — server-rendered or client-inserted alike — so
// updateLikesDialog() can find and remove the right row regardless of which
// side rendered it, and never duplicate it.
//
// REQUIRE ORDER: config / db / app are required only AFTER loadApp() sets
// DATA_DIR / DB_PATH. Do not hoist requires above the loadApp() call.
//
// Issue #1041 adds a second describe block below, same technique, driving
// feed.js's own comments-dialog backdrop-close branch through the
// drag-dismiss AC1/AC2 sequences against src/public/js/dialog-dismiss.js's
// delegated predicate.
'use strict';

const path = require('path');
const request = require('supertest');
const { JSDOM } = require('jsdom');
const { loadApp, signInGuest } = require('./helpers/testApp');

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
    .run(opts.taskTitle || 'Likers Script Test Task').lastInsertRowid;
  const submissionId = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, 0)`
    )
    .run(
      authorGuestId,
      taskId,
      opts.photoPath || 'likers-script.jpg',
      opts.thumbPath || 'likers-script-thumb.jpg'
    ).lastInsertRowid;
  return submissionId;
}

it(
  'AC5: unlike removes the SERVER-RENDERED own row and restores "No likes yet."; ' +
    're-like inserts exactly one row back (no duplicate); the "N likes" text stays in sync',
  async () => {
    const author = await signedInGuest('script-ac5-author', 'Script AC5 Author');
    const viewer = await signedInGuest('script-ac5-viewer', 'Script AC5 Viewer');
    const submissionId = seedSubmission(author.guestId, {
      photoPath: 'script-ac5.jpg',
      thumbPath: 'script-ac5t.jpg',
    });

    // The viewer already liked this photo BEFORE this page load — their own
    // row is in the card's .feed-card-data payload (issue #1139: the likers
    // dialog is drawn from that payload on open, not rendered server-side
    // into per-card dialog markup any more), with no client-side memory of
    // it beyond that payload.
    await viewer.agent.post('/p/' + submissionId + '/like');

    const feedRes = await viewer.agent.get('/feed');
    expect(feedRes.status).toBe(200);

    const dom = new JSDOM(feedRes.text, { url: 'http://localhost/feed' });

    // jsdom's HTMLDialogElement ships open-only (no showModal/close) — stub
    // minimally, same technique tests/feed-card.test.js and
    // tests/lightbox.test.js use.
    dom.window.HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    dom.window.HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };

    // Stub fetch so the toggle never makes a real network round trip: first
    // call answers the unlike, second answers the re-like. The exact
    // likeCount values are just deterministic fixtures for this DOM-behavior
    // test, not a re-assertion of the server's own counting (photo-likes.test.js
    // already covers that).
    var fetchCallCount = 0;
    var stubbedResponses = [
      { liked: false, likeCount: 0 },
      { liked: true, likeCount: 1 },
    ];
    dom.window.fetch = function () {
      var body = stubbedResponses[fetchCallCount];
      fetchCallCount += 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: function () {
          return Promise.resolve(body);
        },
      });
    };

    const keys = ['window', 'document', 'navigator', 'fetch'];
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
      // Issue #1139: the page carries ONE shared likers dialog, filled from
      // the card's payload when the guest opens it — not pre-filled at page
      // load, so it must be opened first.
      const dialog = doc.getElementById('likes-dialog');
      expect(dialog).not.toBeNull();
      const likesOpener = doc.querySelector('[data-open-likes="' + submissionId + '"]');
      expect(likesOpener).not.toBeNull();
      likesOpener.dispatchEvent(new dom.window.Event('click', { bubbles: true }));

      const ownRowSelector = '[data-likes-row="' + viewer.guestId + '"]';

      // Sanity: exactly one (payload-rendered) row before any toggle.
      expect(dialog.querySelectorAll('.likes-row').length).toBe(1);
      expect(dialog.querySelector(ownRowSelector)).not.toBeNull();
      expect(dialog.querySelector('.comments-dialog-empty')).toBeNull();

      const article = doc.getElementById('photo-' + submissionId);
      const likesLink = article.querySelector('.likes-link');
      expect(likesLink.querySelector('.likes-link-word').textContent).toBe('like');

      const form = doc.querySelector('.like-form[action="/p/' + submissionId + '/like"]');
      expect(form).not.toBeNull();

      // --- Unlike ---------------------------------------------------------
      form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The server-rendered row is GONE (not skipped for lacking a
      // client-only "self" marker) and the empty state is back.
      expect(dialog.querySelectorAll('.likes-row').length).toBe(0);
      expect(dialog.querySelector(ownRowSelector)).toBeNull();
      const emptyAfterUnlike = dialog.querySelector('.comments-dialog-empty');
      expect(emptyAfterUnlike).not.toBeNull();
      expect(emptyAfterUnlike.textContent).toBe('No likes yet.');

      // The "N likes" text and its aria-label follow the toggle too.
      expect(likesLink.querySelector('.like-count').textContent).toBe('0');
      expect(likesLink.querySelector('.likes-link-word').textContent).toBe('likes');
      expect(likesLink.getAttribute('aria-label')).toBe('See who liked this photo — 0 likes');

      // --- Re-like ---------------------------------------------------------
      form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Exactly ONE row comes back — never two.
      expect(dialog.querySelectorAll('.likes-row').length).toBe(1);
      expect(dialog.querySelectorAll(ownRowSelector).length).toBe(1);
      expect(dialog.querySelector('.comments-dialog-empty')).toBeNull();

      expect(likesLink.querySelector('.like-count').textContent).toBe('1');
      expect(likesLink.querySelector('.likes-link-word').textContent).toBe('like');
      expect(likesLink.getAttribute('aria-label')).toBe('See who liked this photo — 1 like');
    } finally {
      keys.forEach((key) => {
        if (saved[key]) {
          Object.defineProperty(global, key, saved[key]);
        } else {
          delete global[key];
        }
      });
    }
  }
);

// ---------------------------------------------------------------------------
// Issue #1041 AC1/AC2: the comments dialog's own backdrop-close branch,
// driven against the real dialog-dismiss.js + feed.js loaded from real
// GET /feed markup, same technique as the AC5 test above.
// ---------------------------------------------------------------------------
describe('issue #1041: feed.js comments dialog drag-dismiss (AC1, AC2)', () => {
  const DIALOG_DISMISS_JS_PATH = path.join(
    __dirname,
    '..',
    'src',
    'public',
    'js',
    'dialog-dismiss.js'
  );
  const FEED_JS_PATH = path.join(__dirname, '..', 'src', 'public', 'js', 'feed.js');

  // Each test calls loadFixture() once against the SAME db (this file's
  // shared beforeAll app/db), so every call needs its own unique token and
  // photo paths -- a fixed literal would collide on guests.token's UNIQUE
  // constraint the second time a test in this describe block runs.
  let fixtureCounter = 0;

  async function loadFixture() {
    fixtureCounter += 1;
    const author = await signedInGuest(
      'script-1041-author-' + fixtureCounter,
      'Script 1041 Author ' + fixtureCounter
    );
    const submissionId = seedSubmission(author.guestId, {
      photoPath: 'script-1041-' + fixtureCounter + '.jpg',
      thumbPath: 'script-1041-' + fixtureCounter + 't.jpg',
    });

    const feedRes = await author.agent.get('/feed');
    expect(feedRes.status).toBe(200);

    const dom = new JSDOM(feedRes.text, { url: 'http://localhost/feed' });
    dom.window.HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    dom.window.HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };

    const keys = ['window', 'document', 'navigator'];
    const saved = {};
    keys.forEach((key) => {
      saved[key] = Object.getOwnPropertyDescriptor(global, key);
      Object.defineProperty(global, key, {
        value: dom.window[key],
        configurable: true,
        writable: true,
      });
    });

    delete require.cache[require.resolve(DIALOG_DISMISS_JS_PATH)];
    require(DIALOG_DISMISS_JS_PATH);
    delete require.cache[require.resolve(FEED_JS_PATH)];
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

    const doc = dom.window.document;
    const opener = doc.querySelector('[data-open-comments="' + submissionId + '"]');
    opener.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    // Issue #1139: one shared comments dialog for the whole page.
    const dialogEl = doc.getElementById('comments-dialog');
    const textarea = dialogEl.querySelector('textarea[name="body"]');

    return { dom, dialogEl, textarea, restore };
  }

  test('AC1: a press inside the composer, released on the retargeted dialog element, leaves the dialog open with the comment intact', async () => {
    const { dom, dialogEl, textarea, restore } = await loadFixture();
    try {
      expect(dialogEl.open).toBe(true);
      textarea.value = 'half-typed comment';

      textarea.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true })); // press started on a descendant
      dialogEl.dispatchEvent(new dom.window.Event('click', { bubbles: true })); // click retargeted to the dialog element

      expect(dialogEl.open).toBe(true);
      expect(textarea.value).toBe('half-typed comment');
    } finally {
      restore();
    }
  });

  test('AC2: a genuine backdrop press-and-release still closes the comments dialog', async () => {
    const { dom, dialogEl, restore } = await loadFixture();
    try {
      expect(dialogEl.open).toBe(true);

      dialogEl.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true })); // press landed on the dialog itself
      dialogEl.dispatchEvent(new dom.window.Event('click', { bubbles: true }));

      expect(dialogEl.open).toBe(false);
    } finally {
      restore();
    }
  });
});
