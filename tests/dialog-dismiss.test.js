// tests/dialog-dismiss.test.js
//
// Issue #879: src/public/js/dialog-dismiss.js is the single shared owner of
// backdrop-dismiss wiring for every modal <dialog> in this app that holds
// user input. Covers:
//   (a) the helper directly — a press-inside/release-outside drag no longer
//       closes the dialog (AC1); a genuine backdrop press-and-release still
//       does (AC2); the recorded press flag resets across an open/close/open
//       cycle so a stale flag from one cycle cannot leak into the next.
//   (b) the slideshow-launch dialog's AC1/AC2 sequences driven against the
//       real src/public/js/slideshow-launch.js (AC3) — no existing jsdom
//       test covers that file; tests/slideshow.test.js is a supertest route
//       test and stays untouched.
//   (c) AC5 — the wiring line itself: GET /admin/tasks and GET /admin both
//       serve <script src="/js/dialog-dismiss.js" before every consumer
//       script that page loads, the same wiring-line pattern
//       tests/task-badges.test.js's #903 describe block already establishes.
//
// Issue #1041 extends this file with the module's DELEGATED variant (a guest
// surface where one document-level listener serves many dialog instances,
// rather than one listener per known dialog element) — see
// DialogDismiss.pressAllowsDelegatedClose:
//   (d) the delegated predicate directly, including a dialog inserted into
//       the document AFTER the module's own load-time registration (AC5 —
//       mirrors what feed-scroll.js does during infinite scroll).
//   (e) AC6 — GET /feed and GET /p/:id both serve
//       <script src="/js/dialog-dismiss.js" (presence only; document order
//       relative to feed.js is deliberately not asserted — see DESIGN.md).
//   (f) AC7 — feed.js and photo-owner-menu.js loaded with window.DialogDismiss
//       left entirely unset: no error, and backdrop dismissal itself still
//       works via the click-target-only fallback.
'use strict';

const path = require('path');
const { JSDOM } = require('jsdom');
const { loadApp, makeAdminAgent, seed, signInGuest } = require('./helpers/testApp');

const DIALOG_DISMISS_JS_PATH = path.join(
  __dirname,
  '..',
  'src',
  'public',
  'js',
  'dialog-dismiss.js'
);
const SLIDESHOW_LAUNCH_JS_PATH = path.join(
  __dirname,
  '..',
  'src',
  'public',
  'js',
  'slideshow-launch.js'
);
const FEED_JS_PATH = path.join(__dirname, '..', 'src', 'public', 'js', 'feed.js');

/**
 * Stub HTMLDialogElement.showModal/close on `dialogEl` the same way
 * tests/badge-picker-script.test.js does (jsdom implements neither), with
 * one addition the module's own close-event flag reset depends on: `close`
 * must also dispatch a `close` Event after setting `open = false`, or
 * dialog-dismiss.js's stale-flag reset (registered via
 * dialogEl.addEventListener('close', ...)) never fires.
 */
function stubDialog(dialogEl) {
  dialogEl.showModal = function () {
    this.open = true;
  };
  dialogEl.close = function () {
    this.open = false;
    // Must construct the Event via THIS document's own window — Node's
    // global Event (available since Node 15) is a different class than
    // jsdom's, and jsdom's dispatchEvent rejects it with a TypeError that
    // (per DOM spec, same as a listener throwing) is swallowed rather than
    // propagated, silently skipping the module's close listener instead of
    // raising a visible test failure.
    this.dispatchEvent(new this.ownerDocument.defaultView.Event('close'));
  };
}

function pointerdown(doc, el) {
  el.dispatchEvent(new doc.defaultView.Event('pointerdown', { bubbles: true }));
}

// Issue #879 PR review, finding 3: a real PointerEvent from a second,
// non-primary touch carries isPrimary: false. jsdom implements no
// PointerEvent constructor (pointerdown above dispatches a plain Event,
// where isPrimary is undefined -- the "treat undefined as primary" case the
// module's own guard documents), so this stands one in by hand.
function pointerdownNonPrimary(doc, el) {
  const event = new doc.defaultView.Event('pointerdown', { bubbles: true });
  event.isPrimary = false;
  el.dispatchEvent(event);
}

// The click that a real browser retargets to the dialog element when a
// press-and-release straddle the dialog/backdrop boundary. Dispatched
// directly on the dialog (its target IS the dialog), mirroring what plan
// step 6 specifies: a bubbling click whose target is the dialog element.
function clickOnDialog(doc, dialogEl) {
  dialogEl.dispatchEvent(new doc.defaultView.Event('click', { bubbles: true }));
}

describe('DialogDismiss.backdrop (issue #879) — the helper directly', () => {
  let dom;
  let doc;
  let dialogEl;
  let fieldEl;

  beforeEach(() => {
    dom = new JSDOM(
      '<!doctype html><html><body>' +
        '<dialog id="d"><input id="field" /></dialog>' +
        '</body></html>'
    );

    const keys = ['window', 'document', 'navigator'];
    keys.forEach((key) => {
      Object.defineProperty(global, key, {
        value: dom.window[key],
        configurable: true,
        writable: true,
      });
    });

    doc = dom.window.document;
    dialogEl = doc.getElementById('d');
    fieldEl = doc.getElementById('field');
    stubDialog(dialogEl);

    delete require.cache[require.resolve(DIALOG_DISMISS_JS_PATH)];
    require(DIALOG_DISMISS_JS_PATH);

    global.window.DialogDismiss.backdrop(dialogEl);
    dialogEl.showModal();
  });

  test('AC1: a press inside the dialog, released on the retargeted dialog element, leaves the dialog open', () => {
    fieldEl.value = 'half-typed work';

    pointerdown(doc, fieldEl); // press started on a descendant
    clickOnDialog(doc, dialogEl); // click retargeted to the dialog element

    expect(dialogEl.open).toBe(true);
    expect(fieldEl.value).toBe('half-typed work');
  });

  test('AC2: a genuine backdrop press-and-release (both pointerdown and click target the dialog) still closes it', () => {
    pointerdown(doc, dialogEl); // press landed on the dialog itself (the backdrop)
    clickOnDialog(doc, dialogEl);

    expect(dialogEl.open).toBe(false);
  });

  test('the recorded press flag resets on close, so a stale true cannot leak into the next open', () => {
    // First cycle: a genuine backdrop press-and-release closes the dialog
    // and (via the module's own close listener) resets the recorded flag.
    pointerdown(doc, dialogEl);
    clickOnDialog(doc, dialogEl);
    expect(dialogEl.open).toBe(false);

    // Reopen. No pointerdown fires in this new cycle before the click below
    // — if the flag had leaked from the previous cycle instead of resetting,
    // this click would incorrectly close the dialog again.
    dialogEl.showModal();
    clickOnDialog(doc, dialogEl);

    expect(dialogEl.open).toBe(true);
  });

  test('issue #879 PR review, finding 3: a non-primary pointerdown (a second simultaneous touch) does not record a press, so a click retargeted from a DIFFERENT finger cannot close the dialog', () => {
    // A second touch starts on the dialog's own backdrop (isPrimary: false)
    // while the primary touch is still down elsewhere -- without the guard,
    // this would set pressWasOnDialog = true from a touch that never drove
    // the click below.
    pointerdownNonPrimary(doc, dialogEl);
    clickOnDialog(doc, dialogEl);

    expect(dialogEl.open).toBe(true);
  });

  test('no-ops on a null dialog rather than throwing', () => {
    expect(() => global.window.DialogDismiss.backdrop(null)).not.toThrow();
    expect(() => global.window.DialogDismiss.backdrop(undefined)).not.toThrow();
  });
});

describe('slideshow-launch.js (issue #879 AC3) — the real script driven through AC1/AC2', () => {
  function pageMarkup() {
    return (
      '<button type="button" data-open-slideshow></button>' +
      '<dialog id="slideshow-dialog">' +
      '<form>' +
      '<button type="button" data-close-slideshow></button>' +
      '<label><input type="radio" name="mode" value="auto" checked /></label>' +
      '<label><input type="radio" name="mode" value="directed" /></label>' +
      '</form>' +
      '</dialog>'
    );
  }

  // `options.skipDialogDismiss` (issue #879 PR review, finding 2): stands
  // in for dialog-dismiss.js failing to load at all (a missing/reordered
  // script tag) — window.DialogDismiss is left entirely unset, the same
  // absent-global shape the guarded call site is meant to survive.
  function loadSlideshowLaunch(options) {
    const opts = options || {};

    const dom = new JSDOM('<!doctype html><html><body>' + pageMarkup() + '</body></html>', {
      url: 'http://localhost/admin',
    });

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

    const dialogEl = dom.window.document.getElementById('slideshow-dialog');
    stubDialog(dialogEl);

    if (!opts.skipDialogDismiss) {
      delete require.cache[require.resolve(DIALOG_DISMISS_JS_PATH)];
      require(DIALOG_DISMISS_JS_PATH);
    }

    delete require.cache[require.resolve(SLIDESHOW_LAUNCH_JS_PATH)];
    require(SLIDESHOW_LAUNCH_JS_PATH);

    function restore() {
      keys.forEach((key) => {
        if (saved[key]) {
          Object.defineProperty(global, key, saved[key]);
        } else {
          delete global[key];
        }
      });
    }

    return { doc: dom.window.document, restore };
  }

  function click(doc, el) {
    el.dispatchEvent(new doc.defaultView.Event('click', { bubbles: true, cancelable: true }));
  }

  test('AC1: a press inside the dialog, released on the retargeted dialog element, leaves it open', () => {
    const { doc, restore } = loadSlideshowLaunch();
    const dialogEl = doc.getElementById('slideshow-dialog');
    const radio = doc.querySelector('input[value="directed"]');

    click(doc, doc.querySelector('[data-open-slideshow]'));
    expect(dialogEl.open).toBe(true);

    pointerdown(doc, radio);
    clickOnDialog(doc, dialogEl);

    expect(dialogEl.open).toBe(true);

    restore();
  });

  test('AC2: a genuine backdrop press-and-release still closes it', () => {
    const { doc, restore } = loadSlideshowLaunch();
    const dialogEl = doc.getElementById('slideshow-dialog');

    click(doc, doc.querySelector('[data-open-slideshow]'));
    expect(dialogEl.open).toBe(true);

    pointerdown(doc, dialogEl);
    clickOnDialog(doc, dialogEl);

    expect(dialogEl.open).toBe(false);

    restore();
  });

  test('fails safe when window.DialogDismiss is absent: the SAME document click listener that opens AND closes the dialog still registers (PR review, finding 2)', () => {
    // The bug this guards against: slideshow-launch.js's guarded call sits
    // as the FIRST statement in its IIFE, immediately before
    // document.addEventListener('click', ...) — the one listener that
    // handles both [data-open-slideshow] and [data-close-slideshow]. An
    // uncaught TypeError there would mean that listener never registers at
    // all, killing "Play slideshow" outright, not just backdrop dismissal.
    let loaded;
    expect(() => {
      loaded = loadSlideshowLaunch({ skipDialogDismiss: true });
    }).not.toThrow();

    const { doc, restore } = loaded;
    expect(doc.defaultView.DialogDismiss).toBeUndefined();

    const dialogEl = doc.getElementById('slideshow-dialog');
    click(doc, doc.querySelector('[data-open-slideshow]'));
    expect(dialogEl.open).toBe(true);

    click(doc, doc.querySelector('[data-close-slideshow]'));
    expect(dialogEl.open).toBe(false);

    restore();
  });
});

// ---------------------------------------------------------------------------
// AC5 — the wiring line. Dropping the <script src="/js/dialog-dismiss.js">
// tag, or reordering it after any consumer, would silently revert every
// registration back to no dismissal wiring at all with a fully green suite
// otherwise -- nothing else asserts the wiring line, only dialog-dismiss.js's
// own shape (the describe blocks above) and each consumer's behavior.
// ---------------------------------------------------------------------------
describe('issue #879 AC5: /js/dialog-dismiss.js loads before every consumer script', () => {
  let app;
  let adminAgent;

  beforeAll(async () => {
    const result = loadApp();
    app = result.app;
    adminAgent = await makeAdminAgent(app);
  });

  test('GET /admin/tasks serves dialog-dismiss.js before badge-picker.js and admin-tasks.js', async () => {
    const res = await adminAgent.get('/admin/tasks');
    expect(res.status).toBe(200);

    const dismissIndex = res.text.indexOf('<script src="/js/dialog-dismiss.js"');
    const pickerIndex = res.text.indexOf('<script src="/js/badge-picker.js"');
    const tasksIndex = res.text.indexOf('<script src="/js/admin-tasks.js"');

    expect(dismissIndex).toBeGreaterThan(-1);
    expect(pickerIndex).toBeGreaterThan(-1);
    expect(tasksIndex).toBeGreaterThan(-1);
    expect(dismissIndex).toBeLessThan(pickerIndex);
    expect(dismissIndex).toBeLessThan(tasksIndex);
  });

  test('GET /admin serves dialog-dismiss.js before slideshow-launch.js', async () => {
    const res = await adminAgent.get('/admin');
    expect(res.status).toBe(200);

    const dismissIndex = res.text.indexOf('<script src="/js/dialog-dismiss.js"');
    const slideshowIndex = res.text.indexOf('<script src="/js/slideshow-launch.js"');

    expect(dismissIndex).toBeGreaterThan(-1);
    expect(slideshowIndex).toBeGreaterThan(-1);
    expect(dismissIndex).toBeLessThan(slideshowIndex);
  });
});

// ---------------------------------------------------------------------------
// Issue #1041: DialogDismiss.pressAllowsDelegatedClose — the delegated
// variant, document-level rather than per dialog element, for a guest
// surface (feed.js's comments/likes dialogs, photo-owner-menu.js's caption
// dialog) that opens dialogs the module could not have registered against
// individually at load time.
// ---------------------------------------------------------------------------
describe('DialogDismiss.pressAllowsDelegatedClose (issue #1041) — the delegated variant directly', () => {
  let dom;
  let doc;

  function loadFresh(markup) {
    dom = new JSDOM('<!doctype html><html><body>' + markup + '</body></html>');

    const keys = ['window', 'document', 'navigator'];
    keys.forEach((key) => {
      Object.defineProperty(global, key, {
        value: dom.window[key],
        configurable: true,
        writable: true,
      });
    });

    doc = dom.window.document;

    delete require.cache[require.resolve(DIALOG_DISMISS_JS_PATH)];
    require(DIALOG_DISMISS_JS_PATH);
  }

  test('AC1: a press inside the dialog, released on the retargeted dialog element, does not allow the close', () => {
    loadFresh('<dialog id="d"><textarea id="field"></textarea></dialog>');
    const dialogEl = doc.getElementById('d');
    const fieldEl = doc.getElementById('field');
    fieldEl.value = 'half-typed comment';

    pointerdown(doc, fieldEl); // press started on a descendant
    const clickEvent = new doc.defaultView.Event('click', { bubbles: true });
    dialogEl.dispatchEvent(clickEvent); // click retargeted to the dialog element

    expect(global.window.DialogDismiss.pressAllowsDelegatedClose(clickEvent)).toBe(false);
    expect(fieldEl.value).toBe('half-typed comment');
  });

  test('AC2: a genuine backdrop press-and-release (both pointerdown and click target the dialog) allows the close', () => {
    loadFresh('<dialog id="d"><textarea id="field"></textarea></dialog>');
    const dialogEl = doc.getElementById('d');

    pointerdown(doc, dialogEl); // press landed on the dialog itself (the backdrop)
    const clickEvent = new doc.defaultView.Event('click', { bubbles: true });
    dialogEl.dispatchEvent(clickEvent);

    expect(global.window.DialogDismiss.pressAllowsDelegatedClose(clickEvent)).toBe(true);
  });

  test('AC4: a non-primary pointerdown on the dialog records no press, so a click retargeted from a DIFFERENT finger is not allowed to close', () => {
    loadFresh('<dialog id="d"><textarea id="field"></textarea></dialog>');
    const dialogEl = doc.getElementById('d');
    const fieldEl = doc.getElementById('field');

    // A real primary press first, on the field -- if the non-primary guard
    // below did NOT work, this would be overwritten by the dialog-targeted
    // touch that follows, and the click below would wrongly read as
    // press-target-agrees-with-click (both dialogEl), passing this test for
    // the wrong reason. Preceding with a real primary press proves the
    // guard actually prevents the overwrite, rather than this test merely
    // observing the module's initial null state.
    pointerdown(doc, fieldEl);
    pointerdownNonPrimary(doc, dialogEl); // a second, simultaneous touch
    const clickEvent = new doc.defaultView.Event('click', { bubbles: true });
    dialogEl.dispatchEvent(clickEvent);

    expect(global.window.DialogDismiss.pressAllowsDelegatedClose(clickEvent)).toBe(false);
  });

  test('AC5: a comments dialog whose card was inserted into the document AFTER dialog-dismiss.js registration is protected and dismissed the same as one present at load', () => {
    loadFresh('<div id="scroll-container"></div>');

    // Mirrors feed-scroll.js appending a whole new .feed-item card (with its
    // own comments dialog) into the document well after this module's own
    // document-level pointerdown listener registered at require() above.
    // The real src/public/js/feed.js is loaded against it too, so this
    // exercises the actual consumer's backdrop-close branch (the class and
    // id shape it looks for), not just the predicate in isolation.
    const container = doc.getElementById('scroll-container');
    container.insertAdjacentHTML(
      'beforeend',
      '<dialog id="comments-dialog-42" class="comments-dialog">' +
        '<textarea name="body"></textarea>' +
        '</dialog>'
    );
    const dialogEl = doc.getElementById('comments-dialog-42');
    stubDialog(dialogEl);
    dialogEl.showModal();
    const fieldEl = dialogEl.querySelector('textarea[name="body"]');
    fieldEl.value = 'half-typed comment';

    delete require.cache[require.resolve(FEED_JS_PATH)];
    require(FEED_JS_PATH);

    // AC1-equivalent on the late-inserted dialog: press inside, retargeted
    // click on the dialog -> feed.js's own backdrop-close branch must NOT
    // close it.
    pointerdown(doc, fieldEl);
    dialogEl.dispatchEvent(new doc.defaultView.Event('click', { bubbles: true }));
    expect(dialogEl.open).toBe(true);
    expect(fieldEl.value).toBe('half-typed comment');

    // AC2-equivalent: genuine backdrop press-and-release -> feed.js closes it.
    pointerdown(doc, dialogEl);
    dialogEl.dispatchEvent(new doc.defaultView.Event('click', { bubbles: true }));
    expect(dialogEl.open).toBe(false);
  });

  test('returns false when called with no click event, rather than throwing', () => {
    loadFresh('<dialog id="d"></dialog>');
    expect(() => global.window.DialogDismiss.pressAllowsDelegatedClose(null)).not.toThrow();
    expect(global.window.DialogDismiss.pressAllowsDelegatedClose(null)).toBe(false);
    expect(global.window.DialogDismiss.pressAllowsDelegatedClose(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Issue #1041 AC6 — the wiring line for the guest surface. Same reasoning as
// the #879 AC5 block above: dropping or reordering the script tag would
// silently revert to no delegated protection with a fully green suite
// otherwise, since nothing else asserts the wiring line.
// ---------------------------------------------------------------------------
describe('issue #1041 AC6: /js/dialog-dismiss.js is served on GET /feed and GET /p/:id', () => {
  let app;
  let db;
  let guestAgent;
  let submissionId;

  beforeAll(async () => {
    const result = loadApp();
    app = result.app;
    db = result.db;
    const seeded = seed(db);
    submissionId = seeded.submissionId;
    guestAgent = signInGuest(app, 'seedtoken');
  });

  test('GET /feed serves dialog-dismiss.js', async () => {
    const res = await guestAgent.get('/feed');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<script src="/js/dialog-dismiss.js"');
  });

  test('GET /p/:id serves dialog-dismiss.js', async () => {
    const res = await guestAgent.get('/p/' + submissionId);
    expect(res.status).toBe(200);
    expect(res.text).toContain('<script src="/js/dialog-dismiss.js"');
  });
});

// ---------------------------------------------------------------------------
// Issue #1041 AC7 — degradation. Mirrors the #879 "fails safe when
// window.DialogDismiss is absent" test above, applied to feed.js and
// photo-owner-menu.js's own delegated click listeners rather than
// slideshow-launch.js's per-element one.
// ---------------------------------------------------------------------------
describe('issue #1041 AC7: feed.js and photo-owner-menu.js degrade safely when window.DialogDismiss is absent', () => {
  const PHOTO_OWNER_MENU_JS_PATH = path.join(
    __dirname,
    '..',
    'src',
    'public',
    'js',
    'photo-owner-menu.js'
  );

  function loadWithoutDialogDismiss() {
    const dom = new JSDOM(
      '<!doctype html><html><body>' +
        '<dialog id="comments-dialog-1" class="comments-dialog">' +
        '<button type="button" data-close-comments></button>' +
        '<details class="comment-menu" open><summary></summary></details>' +
        '</dialog>' +
        '<dialog id="caption-dialog-1" class="caption-dialog">' +
        '<button type="button" data-close-caption></button>' +
        '<textarea name="caption"></textarea>' +
        '</dialog>' +
        '</body></html>'
    );

    const keys = ['window', 'document', 'navigator'];
    keys.forEach((key) => {
      Object.defineProperty(global, key, {
        value: dom.window[key],
        configurable: true,
        writable: true,
      });
    });

    const doc = dom.window.document;
    [doc.getElementById('comments-dialog-1'), doc.getElementById('caption-dialog-1')].forEach(
      stubDialog
    );

    // window.DialogDismiss is left entirely unset -- the missing/reordered
    // script-tag case AC7 covers.
    expect(global.window.DialogDismiss).toBeUndefined();

    delete require.cache[require.resolve(FEED_JS_PATH)];
    delete require.cache[require.resolve(PHOTO_OWNER_MENU_JS_PATH)];
    require(FEED_JS_PATH);
    require(PHOTO_OWNER_MENU_JS_PATH);

    return doc;
  }

  test('a comments-dialog close button click still closes it, no error thrown', () => {
    const doc = loadWithoutDialogDismiss();
    const dialogEl = doc.getElementById('comments-dialog-1');
    dialogEl.showModal();

    expect(() => {
      doc
        .querySelector('[data-close-comments]')
        .dispatchEvent(new doc.defaultView.Event('click', { bubbles: true }));
    }).not.toThrow();

    expect(dialogEl.open).toBe(false);
  });

  test('a comments-dialog backdrop click (click-target-only, module absent) still closes it -- dismissal falls back rather than disappearing', () => {
    const doc = loadWithoutDialogDismiss();
    const dialogEl = doc.getElementById('comments-dialog-1');
    dialogEl.showModal();

    expect(() => {
      dialogEl.dispatchEvent(new doc.defaultView.Event('click', { bubbles: true }));
    }).not.toThrow();

    expect(dialogEl.open).toBe(false);
  });

  test('a caption-dialog backdrop click (click-target-only, module absent) still closes it', () => {
    const doc = loadWithoutDialogDismiss();
    const dialogEl = doc.getElementById('caption-dialog-1');
    dialogEl.showModal();

    expect(() => {
      dialogEl.dispatchEvent(new doc.defaultView.Event('click', { bubbles: true }));
    }).not.toThrow();

    expect(dialogEl.open).toBe(false);
  });

  test('tapping outside an open comment ⋯ menu still closes it', () => {
    const doc = loadWithoutDialogDismiss();
    const menu = doc.querySelector('.comment-menu');
    expect(menu.open).toBe(true);

    expect(() => {
      doc.body.dispatchEvent(new doc.defaultView.Event('click', { bubbles: true }));
    }).not.toThrow();

    expect(menu.open).toBe(false);
  });
});
