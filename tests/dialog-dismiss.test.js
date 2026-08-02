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
'use strict';

const path = require('path');
const { JSDOM } = require('jsdom');
const { loadApp, makeAdminAgent } = require('./helpers/testApp');

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
