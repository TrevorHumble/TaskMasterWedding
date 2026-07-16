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
const UPLOAD_JS_PATH = path.join(__dirname, '..', 'src', 'public', 'js', 'upload.js');
const TASK_EJS_SOURCE = fs.readFileSync(TASK_EJS_PATH, 'utf8');
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
  it('task.ejs carries data-uploading-label="Uploading…" on the submit button', () => {
    expect(TASK_EJS_SOURCE).toContain('data-uploading-label="Uploading…"');
  });

  it('upload.js sets the submit button disabled in its submit handler', () => {
    expect(UPLOAD_JS_SOURCE).toMatch(/submitBtn\.disabled\s*=\s*true/);
  });
});

// ---------------------------------------------------------------------------
// AC3: dispatching submit disables the button (jsdom, real module).
// ---------------------------------------------------------------------------
describe('AC3: submitting the task form disables the button', () => {
  function installDomGlobals(dom) {
    const keys = ['window', 'document', 'navigator'];
    const saved = {};
    keys.forEach((key) => {
      saved[key] = Object.getOwnPropertyDescriptor(global, key);
      const value = key === 'window' ? dom.window : dom.window[key];
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
  // this synchronous test body returns. Wait for it before dispatching, so
  // the submit listener is guaranteed bound.
  function waitForReady(dom) {
    if (dom.window.document.readyState !== 'loading') {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      dom.window.document.addEventListener('DOMContentLoaded', resolve, { once: true });
    });
  }

  it('disabled becomes true synchronously on submit', async () => {
    const dom = new JSDOM(
      `<form id="task-form" action="/tasks/1/submit" method="POST" enctype="multipart/form-data">
         <input type="file" id="photo" name="photo" />
         <img id="upload-preview" hidden />
         <p id="upload-error" hidden></p>
         <button type="submit" data-uploading-label="Uploading…">Upload &amp; complete</button>
       </form>`,
      { url: 'http://localhost/' }
    );
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
    const dom = new JSDOM(
      `<form id="task-form" action="/tasks/1/submit" method="POST" enctype="multipart/form-data">
         <input type="file" id="photo" name="photo" />
         <img id="upload-preview" hidden />
         <p id="upload-error" hidden></p>
         <button type="submit" data-uploading-label="Uploading…">Upload &amp; complete</button>
       </form>`,
      { url: 'http://localhost/' }
    );
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
