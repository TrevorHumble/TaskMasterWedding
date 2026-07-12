// tests/upload-batch-label.test.js
// Issue #364: the memory batch upload control communicates the batch — a
// plural picker label and a truthful selected-file count — instead of
// looking like the single-photo task/avatar control.
//
//   AC1 — GET /memories/new renders the literal picker label
//         "Choose photos…" (plural), distinct from the singular control.
//   AC2 — uploadSelectionText(files, placeholder) returns "N photos selected"
//         for N>=2.
//   AC3 — uploadSelectionText returns the bare filename for exactly 1 file.
//   AC4 — uploadSelectionText returns the resting-state placeholder for 0
//         files (not "0 photos selected", not a stale filename).
//   AC5 (structural, no-JS baseline) — the rendered memory form has a real
//         server-rendered <input type="file" ... multiple> inside the
//         <form>, so the browser still opens the picker and the form still
//         posts every selected file with JS disabled.
//   AC6 — the task page (a single-photo caller) still renders the singular
//         "Choose a photo…" label — no regression from the shared
//         partial/script edit.
//
// REQUIRE ORDER: loadApp() must run before any require of config/db (see
// tests/helpers/testApp.js "REQUIRE ORDER MATTERS").
'use strict';

const crypto = require('crypto');
const request = require('supertest');
const { loadApp, signInGuest } = require('./helpers/testApp');
const { uploadSelectionText } = require('../src/public/js/upload-filename');

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

// An onboarded guest with no task needed — the memory form is guest-gated
// but task-independent (issue #247).
function insertGuest() {
  const { db: theDb } = ensureApp();
  const token = `batch-label-${crypto.randomUUID()}`;
  theDb
    .prepare('INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)')
    .run(token, 'Batch Label Guest');
  return token;
}

function insertGuestAndTask() {
  const { db: theDb } = ensureApp();
  const token = `batch-label-${crypto.randomUUID()}`;
  theDb
    .prepare('INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)')
    .run(token, 'Batch Label Task Guest');
  const taskId = theDb
    .prepare('INSERT INTO tasks (title) VALUES (?)')
    .run('Photo with the cake').lastInsertRowid;
  return { taskId, token };
}

async function makeGuestAgent(token) {
  const agent = request.agent(app);
  signInGuest(app, token, agent);
  return agent;
}

// ---------------------------------------------------------------------------
// AC1 + AC5: the rendered /memories/new control.
// ---------------------------------------------------------------------------
describe('AC1: memory picker renders the plural label', () => {
  it('GET /memories/new shows the literal "Choose photos…" picker label', async () => {
    ensureApp();
    const token = insertGuest();
    const agent = await makeGuestAgent(token);

    const res = await agent.get('/memories/new');
    expect(res.status).toBe(200);

    expect(res.text).toContain('Choose photos…');
    // Distinct from the singular control's copy — not merely a superstring
    // coincidence, the exact singular phrase must be absent.
    expect(res.text).not.toContain('Choose a photo…');
  });
});

describe('AC5 (no-JS baseline): the memory form posts real files without JS', () => {
  it('the picker is a server-rendered <input type="file" ... multiple> inside the memory <form>', async () => {
    ensureApp();
    const token = insertGuest();
    const agent = await makeGuestAgent(token);

    const res = await agent.get('/memories/new');
    expect(res.status).toBe(200);

    // Isolate the <form>…</form> so the assertion is scoped to something the
    // browser can actually submit with JS disabled, not just present
    // anywhere on the page.
    const formMatch = res.text.match(/<form[^>]*action="\/memories"[\s\S]*?<\/form>/);
    expect(formMatch).not.toBeNull();
    const formHtml = formMatch[0];

    // method=POST + multipart encoding are required for a real file POST.
    expect(formHtml).toMatch(/method="POST"/);
    expect(formHtml).toMatch(/enctype="multipart\/form-data"/);

    // The file input itself: real <input type="file">, name="photos", and
    // the multiple attribute so a no-JS browser dialog still allows a batch
    // pick and the browser still submits every chosen file on its own.
    const inputMatch = formHtml.match(/<input\s+type="file"[^>]*>/);
    expect(inputMatch).not.toBeNull();
    const inputHtml = inputMatch[0];
    expect(inputHtml).toMatch(/name="photos"/);
    expect(inputHtml).toMatch(/\bmultiple\b/);
  });
});

// ---------------------------------------------------------------------------
// AC2 + AC3 + AC4: the pure multi-select helper.
// ---------------------------------------------------------------------------
describe('uploadSelectionText() helper', () => {
  it('AC2: N>=2 files returns the literal "N photos selected"', () => {
    expect(
      uploadSelectionText(
        [{ name: 'a.jpg' }, { name: 'b.jpg' }, { name: 'c.jpg' }],
        'Choose photos…'
      )
    ).toBe('3 photos selected');
    expect(uploadSelectionText([{ name: 'a.jpg' }, { name: 'b.jpg' }], 'Choose photos…')).toBe(
      '2 photos selected'
    );
  });

  it('AC3: exactly 1 file returns that file\'s name, not "1 photos selected"', () => {
    const result = uploadSelectionText([{ name: 'sunset.jpg' }], 'Choose photos…');
    expect(result).toBe('sunset.jpg');
    expect(result).not.toBe('1 photos selected');
  });

  it('AC4: 0 files (cancel) returns the resting-state placeholder, not "0 photos selected"', () => {
    const result = uploadSelectionText([], 'Choose photos…');
    expect(result).toBe('Choose photos…');
    expect(result).not.toBe('0 photos selected');
  });

  it('AC4: a null/undefined FileList (no prior selection) also returns the placeholder', () => {
    expect(uploadSelectionText(null, 'Choose photos…')).toBe('Choose photos…');
    expect(uploadSelectionText(undefined, 'Choose photos…')).toBe('Choose photos…');
  });

  it('falls back to the default single-photo placeholder if no placeholder is supplied', () => {
    expect(uploadSelectionText([], '')).toBe('Choose a photo…');
    expect(uploadSelectionText([], undefined)).toBe('Choose a photo…');
  });

  // Confirms the branching actually matters: an inverted/collapsed
  // implementation (e.g. always counting, or never counting) fails this.
  it('the three branches (0 / 1 / N) are distinct outputs for distinct inputs', () => {
    const zero = uploadSelectionText([], 'Choose photos…');
    const one = uploadSelectionText([{ name: 'x.jpg' }], 'Choose photos…');
    const many = uploadSelectionText([{ name: 'x.jpg' }, { name: 'y.jpg' }], 'Choose photos…');
    expect(new Set([zero, one, many]).size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// AC6: the single-photo task control is unchanged.
// ---------------------------------------------------------------------------
describe('AC6: task page keeps the singular label (no regression)', () => {
  it('GET /tasks/:id still shows the literal "Choose a photo…" picker label', async () => {
    ensureApp();
    const { taskId, token } = insertGuestAndTask();
    const agent = await makeGuestAgent(token);

    const res = await agent.get(`/tasks/${taskId}`);
    expect(res.status).toBe(200);

    expect(res.text).toContain('Choose a photo…');
    expect(res.text).not.toContain('Choose photos…');
  });
});
