// tests/upload-ux.test.js
// Issue #254: fix the double-escaped "UPLOAD &AMP; COMPLETE" button label, add
// in-flight upload feedback (disabled button + "Uploading…" label), a
// client-side downscale before send, and drop the duplicated "Choose a
// photo" label.
//
//   AC1 — rendered task page: button text is exactly "Upload & complete";
//         no "&AMP;" / "&amp;amp;" anywhere in the page source.
//   AC2 — structural: task.ejs carries data-uploading-label="Uploading…";
//         upload.js's submit handler sets `disabled`.
//   AC3 — behavioral: dispatching submit on the task form sets the button's
//         `disabled` property true (jsdom).
//   AC4 — a 4000x3000 image downscales: decoded long edge <= 2000, output
//         smaller than input (injected fake canvas/image env — no real
//         canvas backend is available under vitest+jsdom).
//   AC5 — an 800x600 image under 2.5MB is returned unchanged (identity).
//   AC6 — "Choose a photo" appears at most once on the rendered page.
//
// REQUIRE ORDER: loadApp() must run before any require of config/db (see
// tests/helpers/testApp.js "REQUIRE ORDER MATTERS").
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const { JSDOM } = require('jsdom');
const { loadApp, signInGuest } = require('./helpers/testApp');

const TASK_EJS_PATH = path.join(__dirname, '..', 'src', 'views', 'task.ejs');
// Issue #611: the upload form (and its data-uploading-label hook) moved out
// of task.ejs into its own shared partial, included from three mutually
// exclusive branches of task.ejs (never-submitted, host-takedown, and the
// replace disclosure) — see that partial's own header comment.
const TASK_UPLOAD_FORM_EJS_PATH = path.join(
  __dirname,
  '..',
  'src',
  'views',
  'partials',
  'task-upload-form.ejs'
);
const UPLOAD_JS_PATH = path.join(__dirname, '..', 'src', 'public', 'js', 'upload.js');
const TASK_EJS_SOURCE = fs.readFileSync(TASK_EJS_PATH, 'utf8');
const TASK_UPLOAD_FORM_EJS_SOURCE = fs.readFileSync(TASK_UPLOAD_FORM_EJS_PATH, 'utf8');
const UPLOAD_JS_SOURCE = fs.readFileSync(UPLOAD_JS_PATH, 'utf8');

// loadApp() pulls in src/app.js -> src/services/photos.js -> sharp. It is
// scoped to only the two describes below that need a running app (AC1, AC6)
// so the pure-logic describes (AC2-AC5) are independent of the native sharp
// binary being loadable in the current environment.
let app;
let db;

function ensureApp() {
  if (!app) {
    const loaded = loadApp();
    app = loaded.app;
    db = loaded.db;
  }
  return { app, db };
}

function insertGuestAndTask() {
  const { db: theDb } = ensureApp();
  const token = `upload-ux-${crypto.randomUUID()}`;
  const guestId = theDb
    .prepare('INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)')
    .run(token, 'Upload UX Guest').lastInsertRowid;
  const taskId = theDb
    .prepare('INSERT INTO tasks (title) VALUES (?)')
    .run('Photo with the cake').lastInsertRowid;
  return { guestId, taskId, token };
}

async function makeGuestAgent(token) {
  const agent = request.agent(app);
  signInGuest(app, token, agent);
  return agent;
}

// ---------------------------------------------------------------------------
// AC1: the escaping fix, traced on the rendered page.
// ---------------------------------------------------------------------------
describe('AC1: button label renders once-escaped', () => {
  it('an undone task page shows "Upload & complete" with no double/triple escape', async () => {
    const { taskId, token } = insertGuestAndTask();
    const agent = await makeGuestAgent(token);

    const res = await agent.get(`/tasks/${taskId}`);
    expect(res.status).toBe(200);

    // The bug: `<%= 'Upload &amp; complete' %>` double-escapes the source
    // "&" to "&AMP;" in the rendered HTML. Assert it is gone.
    expect(res.text).not.toMatch(/&AMP;/);
    expect(res.text).not.toMatch(/&amp;amp;/);

    // The fix: a single raw "Upload & complete" fed through <%= %> renders
    // as exactly one "&amp;" in HTML source, which browsers display as "&".
    const buttonMatch = res.text.match(
      /<button[^>]*class="btn btn-block"[^>]*>([\s\S]*?)<\/button>/
    );
    expect(buttonMatch).not.toBeNull();
    expect(buttonMatch[1].trim()).toBe('Upload &amp; complete');
  });
});

// ---------------------------------------------------------------------------
// AC2: structural hooks exist in both source files.
// ---------------------------------------------------------------------------
describe('AC2: uploading-state hooks exist in source', () => {
  it('the task upload form carries data-uploading-label="Uploading…" on the submit button', () => {
    // Issue #611 moved the form (and this attribute) out of task.ejs into
    // partials/task-upload-form.ejs; task.ejs itself no longer contains it.
    expect(TASK_UPLOAD_FORM_EJS_SOURCE).toContain('data-uploading-label="Uploading…"');
    expect(TASK_EJS_SOURCE).not.toContain('data-uploading-label="Uploading…"');
  });

  it('upload.js sets the submit button disabled in its submit handler', () => {
    // The disable itself lives in the shared setUploadingState helper (the
    // task and memory submit handlers both call it rather than setting
    // `disabled` inline) — assert the helper does it AND that the task
    // form's submit handler invokes the helper.
    expect(UPLOAD_JS_SOURCE).toMatch(/function setUploadingState[\s\S]*?btn\.disabled\s*=\s*true/);
    expect(UPLOAD_JS_SOURCE).toMatch(
      /function initTaskSubmit\(\)[\s\S]*?setUploadingState\(submitBtn, uploadingLabel\)/
    );
  });
});

// ---------------------------------------------------------------------------
// Shared jsdom harness for every describe below that loads the real
// src/public/js/upload.js and drives the task form. Defined once here rather
// than per-describe: the readyState wait in particular is subtle enough that
// two copies would drift apart the first time jsdom's timing changes.
// ---------------------------------------------------------------------------
/** The task form's markup, reduced to the ids and attributes upload.js reads. */
function buildTaskFormDom() {
  return new JSDOM(
    `<form id="task-form" action="/tasks/1/submit" method="POST" enctype="multipart/form-data">
         <input type="file" id="photo" name="photo" />
         <img id="upload-preview" hidden />
         <p id="upload-error" hidden></p>
         <button type="submit" data-uploading-label="Uploading…">Upload &amp; complete</button>
       </form>`,
    { url: 'http://localhost/' }
  );
}

/**
 * Point the globals upload.js reads at `dom`, returning a restore().
 *
 * `windowOverride` swaps in a stand-in for `global.window` while leaving
 * `document`/`navigator` bound to the real jsdom ones. The success path
 * assigns `window.location = '<task path>'`, which jsdom's real Location
 * setter treats as cross-document navigation it does not implement: it logs
 * "Not implemented: navigation to another Document" and leaves `location`
 * untouched, so a test cannot tell "navigated" from "did nothing". upload.js
 * only ever reads `window.csrfHeader` and assigns `window.location` — never
 * anything tied to Window/Document identity — so a plain object makes that
 * assignment an ordinary property write a test can assert on.
 */
function installDomGlobals(dom, windowOverride) {
  const keys = ['window', 'document', 'navigator'];
  const saved = {};
  keys.forEach((key) => {
    saved[key] = Object.getOwnPropertyDescriptor(global, key);
    let value;
    if (key === 'window') {
      value = windowOverride || dom.window;
    } else {
      value = dom.window[key];
    }
    Object.defineProperty(global, key, { value, configurable: true, writable: true });
  });
  return function restore() {
    keys.forEach((key) => {
      if (saved[key]) {
        Object.defineProperty(global, key, saved[key]);
      } else {
        delete global[key];
      }
    });
  };
}

// jsdom's readyState transition to "complete" is asynchronous even for a
// static HTML string, so upload.js's `document.readyState === 'loading'`
// guard may defer init() to a DOMContentLoaded listener that fires after
// a synchronous test body returns. Wait for it before dispatching, so
// the submit listener is guaranteed bound.
function waitForReady(dom) {
  if (dom.window.document.readyState !== 'loading') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    dom.window.document.addEventListener('DOMContentLoaded', resolve, { once: true });
  });
}

// ---------------------------------------------------------------------------
// AC3: dispatching submit disables the button (jsdom, real module).
// ---------------------------------------------------------------------------
describe('AC3: submitting the task form disables the button', () => {
  it('disabled becomes true synchronously on submit', async () => {
    const dom = buildTaskFormDom();
    const restore = installDomGlobals(dom);

    // Downstream of the synchronous disable, the handler chains into
    // downscale/fetch/navigation. Stub fetch so nothing hits the network;
    // the AC only concerns the synchronous state change, but a real
    // rejection is fine too since the .catch re-enables asynchronously
    // (after this test's assertion already ran).
    const savedFetch = global.fetch;
    global.fetch = () => Promise.reject(new Error('network disabled in test'));

    try {
      delete require.cache[require.resolve('../src/public/js/upload.js')];
      require('../src/public/js/upload.js');
      await waitForReady(dom);

      const form = dom.window.document.getElementById('task-form');
      const button = form.querySelector('button[type="submit"]');
      expect(button.disabled).toBe(false);

      form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));

      expect(button.disabled).toBe(true);
      expect(button.textContent).toBe('Uploading…');
    } finally {
      global.fetch = savedFetch;
      restore();
    }
  });

  it('idempotent binding: loading the script twice does not double-fire fetch on one submit', async () => {
    const dom = buildTaskFormDom();
    const restore = installDomGlobals(dom);

    const savedFetch = global.fetch;
    const savedFormData = global.FormData;
    const fetchCalls = [];
    global.fetch = (...args) => {
      fetchCalls.push(args);
      return Promise.resolve({ ok: true, url: 'http://localhost/tasks/1' });
    };
    global.FormData = dom.window.FormData;

    try {
      // Mirrors task.ejs: the same script tag runs twice per page load
      // (direct <script> + footer's pageScript mechanism).
      delete require.cache[require.resolve('../src/public/js/upload.js')];
      require('../src/public/js/upload.js');
      delete require.cache[require.resolve('../src/public/js/upload.js')];
      require('../src/public/js/upload.js');
      await waitForReady(dom);

      const form = dom.window.document.getElementById('task-form');
      form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));

      // Let the promise chain (downscale-fallback -> fetch) settle.
      await new Promise((resolve) => setTimeout(resolve, 20));
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(fetchCalls.length).toBe(1);
    } finally {
      global.fetch = savedFetch;
      global.FormData = savedFormData;
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #362 fix 2: initPreview() must also be idempotent — task.ejs and
// me-edit.ejs load upload.js twice (direct tag + footer's pageScript), same
// as the submit binding covered by AC3 above.
// ---------------------------------------------------------------------------
describe('#362: initPreview is idempotent across a double script load', () => {
  it('two loads + one file selection creates exactly one preview object URL', async () => {
    const dom = new JSDOM(
      `<input type="file" id="photo" />
       <img id="upload-preview" hidden />`,
      { url: 'http://localhost/' }
    );
    const keys = ['window', 'document', 'navigator'];
    const saved = {};
    keys.forEach((key) => {
      saved[key] = Object.getOwnPropertyDescriptor(global, key);
      const value = key === 'window' ? dom.window : dom.window[key];
      Object.defineProperty(global, key, { value, configurable: true, writable: true });
    });

    const savedCreate = global.URL.createObjectURL;
    const savedRevoke = global.URL.revokeObjectURL;
    let createCalls = 0;
    global.URL.createObjectURL = () => {
      createCalls += 1;
      return 'blob:fake-' + createCalls;
    };
    global.URL.revokeObjectURL = () => {};

    try {
      // Mirrors task.ejs/me-edit.ejs: the same script tag runs twice per page load.
      delete require.cache[require.resolve('../src/public/js/upload.js')];
      require('../src/public/js/upload.js');
      delete require.cache[require.resolve('../src/public/js/upload.js')];
      require('../src/public/js/upload.js');

      // jsdom's readyState transition is async even for a static HTML
      // string, so init() (bound via DOMContentLoaded) may not have run yet
      // — wait for it before dispatching (same pattern as the AC3 tests).
      if (dom.window.document.readyState === 'loading') {
        await new Promise((resolve) => {
          dom.window.document.addEventListener('DOMContentLoaded', resolve, { once: true });
        });
      }

      const input = dom.window.document.getElementById('photo');
      const file = new dom.window.File(['fake image bytes'], 'photo.jpg', { type: 'image/jpeg' });
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

      // If the listener were double-bound, one change event would fire two
      // createObjectURL calls instead of one.
      expect(createCalls).toBe(1);
    } finally {
      global.URL.createObjectURL = savedCreate;
      global.URL.revokeObjectURL = savedRevoke;
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
// Issue #990 AC2: initPreview's selector widens to also bind #photos (the
// memory form's multi-file picker), same element/behavior as #photo/#avatar.
// ---------------------------------------------------------------------------
describe('#990 AC2: initPreview binds #photos on the memory form', () => {
  it('selecting a file on #photos shows the preview (no #photo/#avatar on the page)', async () => {
    const dom = new JSDOM(
      `<form action="/memories" method="POST" enctype="multipart/form-data" class="task-upload-form">
         <div class="preview-wrap"><img id="upload-preview" hidden /></div>
         <input type="file" id="photos" name="photos" multiple />
         <button type="submit" data-uploading-label="Sharing…">Share</button>
       </form>`,
      { url: 'http://localhost/' }
    );
    const restore = installDomGlobals(dom);

    const savedCreate = global.URL.createObjectURL;
    const savedRevoke = global.URL.revokeObjectURL;
    global.URL.createObjectURL = () => 'blob:fake-photos';
    global.URL.revokeObjectURL = () => {};

    try {
      delete require.cache[require.resolve('../src/public/js/upload.js')];
      require('../src/public/js/upload.js');
      await waitForReady(dom);

      const input = dom.window.document.getElementById('photos');
      const preview = dom.window.document.getElementById('upload-preview');
      expect(preview.hidden).toBe(true);

      const file = new dom.window.File(['fake bytes'], 'first.jpg', { type: 'image/jpeg' });
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

      expect(preview.hidden).toBe(false);
      expect(preview.src).toBe('blob:fake-photos');
    } finally {
      global.URL.createObjectURL = savedCreate;
      global.URL.revokeObjectURL = savedRevoke;
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #990 AC4/AC5: the memory form's submit/pageshow uploading-state
// handlers (initMemorySubmit), scoped to #photos and NOT fetch-intercepted
// (unlike the task form's initTaskSubmit) — a native submit that only
// toggles the button, plus a pageshow reset for bfcache back-navigation.
// ---------------------------------------------------------------------------
describe('#990 AC4/AC5: memory form submit disables the button; pageshow resets it', () => {
  function buildMemoryDom() {
    return new JSDOM(
      `<form action="/memories" method="POST" enctype="multipart/form-data" class="task-upload-form">
         <div class="preview-wrap"><img id="upload-preview" hidden /></div>
         <input type="file" id="photos" name="photos" multiple />
         <button type="submit" data-uploading-label="Sharing…">Share</button>
       </form>`,
      { url: 'http://localhost/' }
    );
  }

  it('AC4: dispatching submit disables the button and swaps its label to "Sharing…", without calling fetch', async () => {
    const dom = buildMemoryDom();
    const restore = installDomGlobals(dom);
    const savedFetch = global.fetch;
    let fetchCalled = false;
    global.fetch = () => {
      fetchCalled = true;
      return Promise.reject(new Error('initMemorySubmit must not fetch'));
    };

    try {
      delete require.cache[require.resolve('../src/public/js/upload.js')];
      require('../src/public/js/upload.js');
      await waitForReady(dom);

      const form = dom.window.document.querySelector('form');
      const button = form.querySelector('button[type="submit"]');
      expect(button.disabled).toBe(false);
      expect(button.textContent).toBe('Share');

      // The handler under test (initMemorySubmit) must never intercept this
      // submit — AC6 requires the native multipart POST to proceed
      // untouched. This listener runs AFTER initMemorySubmit's own (it's
      // added second, so it observes the event's state left by every
      // earlier listener) — capture defaultPrevented into a variable BEFORE
      // this listener calls its own preventDefault (needed only so jsdom's
      // lack of real navigation doesn't throw), so the capture reflects
      // whether the handler under test intercepted it, not this listener's
      // own call below.
      let defaultPreventedBeforeOwnCall;
      form.addEventListener('submit', (evt) => {
        defaultPreventedBeforeOwnCall = evt.defaultPrevented;
        evt.preventDefault();
      });
      form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));

      expect(button.disabled).toBe(true);
      expect(button.textContent).toBe('Sharing…');
      expect(fetchCalled).toBe(false);
      // The load-bearing assertion for this AC: the native POST is never
      // intercepted by the handler under test.
      expect(defaultPreventedBeforeOwnCall).toBe(false);
    } finally {
      global.fetch = savedFetch;
      restore();
    }
  });

  it('AC5: a pageshow event (bfcache restore) resets the button to enabled/"Share"', async () => {
    const dom = buildMemoryDom();
    const restore = installDomGlobals(dom);

    try {
      delete require.cache[require.resolve('../src/public/js/upload.js')];
      require('../src/public/js/upload.js');
      await waitForReady(dom);

      const form = dom.window.document.querySelector('form');
      const button = form.querySelector('button[type="submit"]');

      // Simulate the in-flight state a prior submit left behind.
      button.disabled = true;
      button.textContent = 'Sharing…';
      button.classList.add('btn-uploading');

      // A real bfcache restore fires pageshow with persisted:true (the
      // signal upload.js's handler gates on); a plain Event has no such
      // property by default, so set it explicitly to simulate the restore.
      const pageshowEvt = new dom.window.Event('pageshow', { bubbles: true });
      pageshowEvt.persisted = true;
      dom.window.dispatchEvent(pageshowEvt);

      expect(button.disabled).toBe(false);
      expect(button.textContent).toBe('Share');
      expect(button.classList.contains('btn-uploading')).toBe(false);
    } finally {
      restore();
    }
  });

  it('a non-persisted pageshow (an ordinary fresh page load) leaves an in-flight button alone', async () => {
    const dom = buildMemoryDom();
    const restore = installDomGlobals(dom);

    try {
      delete require.cache[require.resolve('../src/public/js/upload.js')];
      require('../src/public/js/upload.js');
      await waitForReady(dom);

      const form = dom.window.document.querySelector('form');
      const button = form.querySelector('button[type="submit"]');

      button.disabled = true;
      button.textContent = 'Sharing…';
      button.classList.add('btn-uploading');

      // Ordinary pageshow (persisted defaults to falsy, as it does on a
      // fresh, non-bfcache load) must NOT reset the button.
      dom.window.dispatchEvent(new dom.window.Event('pageshow', { bubbles: true }));

      expect(button.disabled).toBe(true);
      expect(button.textContent).toBe('Sharing…');
    } finally {
      restore();
    }
  });

  it('a second submit while already in flight is a no-op (idempotent, no double-toggle)', async () => {
    const dom = buildMemoryDom();
    const restore = installDomGlobals(dom);

    try {
      delete require.cache[require.resolve('../src/public/js/upload.js')];
      require('../src/public/js/upload.js');
      await waitForReady(dom);

      const form = dom.window.document.querySelector('form');
      const button = form.querySelector('button[type="submit"]');
      form.addEventListener('submit', (evt) => evt.preventDefault());

      form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      expect(button.textContent).toBe('Sharing…');

      // A second submit (e.g. a double-tap before the browser's own POST
      // navigates away) must not re-run the disable logic or throw.
      expect(() => {
        form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      }).not.toThrow();
      expect(button.textContent).toBe('Sharing…');
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// AC4 + AC5: the pure downscale logic, with an injected fake image/canvas
// env (no canvas backend under vitest+jsdom — see the implementer handoff).
// ---------------------------------------------------------------------------
describe('AC4 + AC5: downscaleImage and its extracted pure helpers', () => {
  let computeTargetSize;
  let shouldDownscale;
  let downscaleImage;

  beforeAll(() => {
    // A plain require (no DOM globals needed) exercises the CommonJS export
    // path, mirroring upload-filename.js's dual-mode guard.
    delete require.cache[require.resolve('../src/public/js/upload.js')];
    ({
      computeTargetSize,
      shouldDownscale,
      downscaleImage,
    } = require('../src/public/js/upload.js'));
  });

  it('computeTargetSize caps the long edge at maxEdge, preserving aspect ratio', () => {
    expect(computeTargetSize(4000, 3000, 2000)).toEqual({ width: 2000, height: 1500 });
    // A portrait image: long edge is height.
    expect(computeTargetSize(1500, 3000, 2000)).toEqual({ width: 1000, height: 2000 });
  });

  it('computeTargetSize leaves an already-small image unchanged (no upscale)', () => {
    expect(computeTargetSize(800, 600, 2000)).toEqual({ width: 800, height: 600 });
  });

  it('shouldDownscale is true when a dimension exceeds maxEdge, even under maxBytes', () => {
    const opts = { maxEdge: 2000, maxBytes: 2.5 * 1024 * 1024 };
    expect(shouldDownscale(4000, 3000, 1024, opts)).toBe(true);
    expect(shouldDownscale(800, 600, 1024, opts)).toBe(false);
  });

  it('AC4: a 4000x3000 image downscales to a long edge <= 2000 and a smaller byte size', async () => {
    const inputFile = { name: 'IMG_0001.jpg', size: 6 * 1024 * 1024 }; // 6MB phone photo
    const fakeImage = { width: 4000, height: 3000 };
    const fakeBlob = { size: 900 * 1024 }; // 900KB — smaller than the 6MB input
    const drawImage = vi.fn();
    const fakeCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
    };

    const env = {
      loadImage: () => Promise.resolve(fakeImage),
      createCanvas: (w, h) => {
        fakeCanvas.width = w;
        fakeCanvas.height = h;
        return fakeCanvas;
      },
      toBlob: () => Promise.resolve(fakeBlob),
      createFile: (parts, name, opts) => ({ name, type: opts.type, size: fakeBlob.size, parts }),
    };

    const result = await downscaleImage(inputFile, {}, env);

    // The canvas was created at the capped target size — this IS the
    // decoded long edge of the output blob (drawImage rendered into it).
    expect(Math.max(fakeCanvas.width, fakeCanvas.height)).toBe(2000);
    expect(fakeCanvas.width).toBeLessThanOrEqual(2000);
    expect(fakeCanvas.height).toBeLessThanOrEqual(2000);
    expect(drawImage).toHaveBeenCalledWith(fakeImage, 0, 0, 2000, 1500);

    // Output is a different object (re-encoded), not the original file...
    expect(result).not.toBe(inputFile);
    // ...and it is smaller than the input, as AC4 requires.
    expect(result.size).toBeLessThan(inputFile.size);
    expect(result.type).toBe('image/jpeg');
  });

  it('AC5: an 800x600 image under 2.5MB is returned unchanged (identity)', async () => {
    const inputFile = { name: 'small.jpg', size: 1.2 * 1024 * 1024 }; // under 2.5MB
    const fakeImage = { width: 800, height: 600 };
    const createCanvas = vi.fn();
    const toBlob = vi.fn();

    const env = {
      loadImage: () => Promise.resolve(fakeImage),
      createCanvas,
      toBlob,
      createFile: vi.fn(),
    };

    const result = await downscaleImage(inputFile, {}, env);

    // Identity check — the exact same File object comes back, no re-encode.
    expect(result).toBe(inputFile);
    expect(createCanvas).not.toHaveBeenCalled();
    expect(toBlob).not.toHaveBeenCalled();
  });

  it('falls back to the original file if the re-encode does not actually shrink it', async () => {
    // A pathological case: dimensions are over maxEdge but the re-encoded
    // blob comes out no smaller (e.g. an already-compressed source).
    const inputFile = { name: 'already-small.jpg', size: 500 * 1024 };
    const fakeImage = { width: 4000, height: 3000 };
    const fakeBlob = { size: 600 * 1024 }; // bigger than the 500KB input

    const env = {
      loadImage: () => Promise.resolve(fakeImage),
      createCanvas: () => ({ getContext: () => ({ drawImage: vi.fn() }) }),
      toBlob: () => Promise.resolve(fakeBlob),
      createFile: vi.fn(),
    };

    const result = await downscaleImage(inputFile, {}, env);
    expect(result).toBe(inputFile);
  });
});

// ---------------------------------------------------------------------------
// Issue #932: the submit handler's fetch-resolution branching.
//   AC1 — a followed-redirect success (`type: 'basic', ok: true`) navigates
//         as success: no error text, and the submit button is never
//         returned to its idle state (so a second click can't fire).
//   AC2 — 404/413/429/403 render the owner-approved copy exactly and (like
//         every other non-ok status) re-enable the button with its original
//         label via the shared `.catch`; an unmapped status (500) keeps
//         today's generic fallback copy.
//   AC3 — a genuine network failure (fetch rejects) renders the generic
//         copy and re-enables the button with its original label, whatever
//         wording the engine's own rejection carries.
//
// These drive the shared harness above (buildTaskFormDom / installDomGlobals /
// waitForReady). AC1 needs the harness's window-override: see installDomGlobals'
// own comment for why jsdom cannot observe the success navigation otherwise.
// ---------------------------------------------------------------------------
describe('#932: submit handler maps fetch outcomes to actionable copy', () => {
  // No file is selected in these DOMs (the #photo input has no files), so
  // the handler's `prepared` promise resolves immediately with `null` --
  // downscaleImage never runs -- and two macrotask ticks is enough for the
  // fetch -> then/catch chain to settle (same wait pattern as the
  // idempotent-binding test above).
  async function submitAndSettle(dom) {
    const form = dom.window.document.getElementById('task-form');
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  /** Loads a fresh upload.js against `dom` with fetchImpl stubbed, returns
   * the elements under test plus a restore() that undoes every global patch. */
  async function setUp(dom, fetchImpl) {
    const fakeWindow = { location: '' };
    const restoreGlobals = installDomGlobals(dom, fakeWindow);
    const savedFetch = global.fetch;
    const savedFormData = global.FormData;
    global.fetch = fetchImpl;
    global.FormData = dom.window.FormData;

    delete require.cache[require.resolve('../src/public/js/upload.js')];
    require('../src/public/js/upload.js');
    await waitForReady(dom);

    const form = dom.window.document.getElementById('task-form');
    return {
      form,
      button: form.querySelector('button[type="submit"]'),
      errorEl: dom.window.document.getElementById('upload-error'),
      fakeWindow,
      restore() {
        global.fetch = savedFetch;
        global.FormData = savedFormData;
        restoreGlobals();
      },
    };
  }

  it('AC1: a followed-redirect success (type basic, ok true) navigates and never re-enables the button', async () => {
    const dom = buildTaskFormDom();
    const { form, button, errorEl, fakeWindow, restore } = await setUp(dom, () =>
      Promise.resolve({ type: 'basic', ok: true, status: 200 })
    );
    try {
      await submitAndSettle(dom);

      // Success navigation: the handler assigns window.location to the
      // form's action with "/submit" stripped -- "/tasks/1/submit" -> "/tasks/1".
      expect(fakeWindow.location).toBe('/tasks/1');
      expect(form.getAttribute('action')).toBe('/tasks/1/submit');

      // No error text rendered.
      expect(errorEl.hidden).toBe(true);
      expect(errorEl.textContent).toBe('');

      // The button is never returned to its idle state on success -- it
      // stays disabled in its uploading label, so a second click can't
      // re-fire the submit while the real navigation is in flight.
      expect(button.disabled).toBe(true);
      expect(button.textContent).toBe('Uploading…');
    } finally {
      restore();
    }
  });

  it.each([
    [404, "This task isn't available anymore."],
    [413, 'That photo is too large. Try a smaller one.'],
    [403, 'Session hiccup. Refresh this page and try again.'],
  ])(
    'AC2: a %i response renders the owner-approved message and re-enables the button',
    async (status, expectedMessage) => {
      const dom = buildTaskFormDom();
      const { button, errorEl, restore } = await setUp(dom, () =>
        Promise.resolve({ type: 'basic', ok: false, status })
      );
      try {
        await submitAndSettle(dom);

        expect(errorEl.hidden).toBe(false);
        expect(errorEl.textContent).toBe(expectedMessage);

        // Every non-ok case shares this one .catch: original label restored,
        // re-clickable.
        expect(button.disabled).toBe(false);
        expect(button.textContent).toBe('Upload & complete');
      } finally {
        restore();
      }
    }
  );

  // The 429 copy quotes no configured limit — that fact belongs to config.js,
  // and the shared upload/profile budget means no single number describes
  // "uploads" anyway. It reads the wait the server actually computed and sent
  // (src/middleware/rate-limit.js's Retry-After), so these cases pin the
  // header-to-words mapping, including what happens when a proxy sends a 429
  // with no usable header at all.
  it.each([
    ['240', 'about 4 minutes'],
    ['600', 'about 10 minutes'],
    ['61', 'about 2 minutes'],
    ['60', 'about a minute'],
    ['1', 'about a minute'],
    [null, 'a few minutes'],
    ['', 'a few minutes'],
    ['0', 'a few minutes'],
    ['-30', 'a few minutes'],
    ['Wed, 21 Oct 2026 07:28:00 GMT', 'a few minutes'],
  ])(
    'AC2: a 429 carrying Retry-After %s tells the guest to wait %s',
    async (retryAfter, expectedPhrase) => {
      const dom = buildTaskFormDom();
      const { button, errorEl, restore } = await setUp(dom, () =>
        Promise.resolve({
          type: 'basic',
          ok: false,
          status: 429,
          headers: { get: (name) => (name === 'Retry-After' ? retryAfter : null) },
        })
      );
      try {
        await submitAndSettle(dom);

        expect(errorEl.hidden).toBe(false);
        expect(errorEl.textContent).toBe(
          `Too many uploads in a row. Please wait ${expectedPhrase}. Our little site needs a breather. Thanks!`
        );
        // No configured limit is quoted, whatever the header said.
        expect(errorEl.textContent).not.toMatch(/\b20\b/);

        expect(button.disabled).toBe(false);
        expect(button.textContent).toBe('Upload & complete');
      } finally {
        restore();
      }
    }
  );

  it('AC2: a 429 with no headers object at all still renders readable copy', async () => {
    const dom = buildTaskFormDom();
    const { button, errorEl, restore } = await setUp(dom, () =>
      Promise.resolve({ type: 'basic', ok: false, status: 429 })
    );
    try {
      await submitAndSettle(dom);

      expect(errorEl.hidden).toBe(false);
      expect(errorEl.textContent).toBe(
        'Too many uploads in a row. Please wait a few minutes. Our little site needs a breather. Thanks!'
      );

      expect(button.disabled).toBe(false);
      expect(button.textContent).toBe('Upload & complete');
    } finally {
      restore();
    }
  });

  // A status naming an Object.prototype member must not resolve up the
  // prototype chain and print a function's source into the page.
  it('AC2: a status colliding with an inherited property keeps the generic copy', async () => {
    const dom = buildTaskFormDom();
    const { errorEl, restore } = await setUp(dom, () =>
      Promise.resolve({ type: 'basic', ok: false, status: 'toString' })
    );
    try {
      await submitAndSettle(dom);

      expect(errorEl.hidden).toBe(false);
      expect(errorEl.textContent).toBe('That photo could not be uploaded. Please try again.');
    } finally {
      restore();
    }
  });

  it('AC2: an unmapped status (500) keeps the generic fallback copy and re-enables the button', async () => {
    const dom = buildTaskFormDom();
    const { button, errorEl, restore } = await setUp(dom, () =>
      Promise.resolve({ type: 'basic', ok: false, status: 500 })
    );
    try {
      await submitAndSettle(dom);

      expect(errorEl.hidden).toBe(false);
      expect(errorEl.textContent).toBe('That photo could not be uploaded. Please try again.');

      expect(button.disabled).toBe(false);
      expect(button.textContent).toBe('Upload & complete');
    } finally {
      restore();
    }
  });

  // A dropped connection rejects with the ENGINE's own wording, not ours:
  // Chrome throws `TypeError: Failed to fetch`, Firefox `NetworkError when
  // attempting to fetch resource`, Safari `Load failed`. The generic copy has
  // to win over every one of them (issue #932) -- a guest must never be shown
  // browser diagnostics -- so these cases assert a message-BEARING rejection,
  // which is what a real network failure actually produces. A message-less
  // Error covers the degenerate case.
  it.each([
    ['Chrome', new TypeError('Failed to fetch')],
    ['Firefox', new TypeError('NetworkError when attempting to fetch resource')],
    ['Safari', new TypeError('Load failed')],
    ['no message', new Error()],
  ])(
    'AC3: a %s network failure renders the generic copy, never the engine text, and re-enables the button',
    async (_engine, rejection) => {
      const dom = buildTaskFormDom();
      const { button, errorEl, restore } = await setUp(dom, () => Promise.reject(rejection));
      try {
        await submitAndSettle(dom);

        expect(errorEl.hidden).toBe(false);
        expect(errorEl.textContent).toBe('That photo could not be uploaded. Please try again.');

        expect(button.disabled).toBe(false);
        expect(button.textContent).toBe('Upload & complete');
      } finally {
        restore();
      }
    }
  );

  // The same guard, from the other side: a bug in the handler's own chain
  // arrives at the .catch as an ordinary TypeError with a developer-facing
  // message. It must read as the generic failure too, not as a stack-trace
  // fragment printed into the page.
  it('AC3: an internal TypeError in the chain renders the generic copy, not the developer text', async () => {
    const dom = buildTaskFormDom();
    const { button, errorEl, restore } = await setUp(dom, () => {
      throw new TypeError("Cannot read properties of undefined (reading 'append')");
    });
    try {
      await submitAndSettle(dom);

      expect(errorEl.hidden).toBe(false);
      expect(errorEl.textContent).toBe('That photo could not be uploaded. Please try again.');

      expect(button.disabled).toBe(false);
      expect(button.textContent).toBe('Upload & complete');
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// AC6: "Choose a photo" is no longer duplicated on the task page.
// ---------------------------------------------------------------------------
describe('AC6: no duplicated "Choose a photo" label', () => {
  it('the standalone label appears at most once (the picker button only)', async () => {
    const { taskId, token } = insertGuestAndTask();
    const agent = await makeGuestAgent(token);

    const res = await agent.get(`/tasks/${taskId}`);
    expect(res.status).toBe(200);

    const occurrences = (res.text.match(/Choose a photo/g) || []).length;
    expect(occurrences).toBe(1);
  });

  it('task.ejs no longer has the separate form-label span above the picker', () => {
    expect(TASK_EJS_SOURCE).not.toMatch(/<span class="form-label">Choose a photo<\/span>/);
  });
});
