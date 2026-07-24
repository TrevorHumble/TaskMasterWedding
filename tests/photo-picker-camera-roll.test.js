// tests/photo-picker-camera-roll.test.js
// Issue #880: the task-photo upload input no longer forces the device camera
// via the HTML `capture` attribute — removing it restores the OS default
// picker (library-first, camera still offered) on both iOS Safari and
// Android Chrome. The view-side fix (src/views/task.ejs,
// src/views/partials/upload-field.ejs) was already made and frozen under a
// recorded phase-1 visual approval; this file is the durable proof of it.
//
//   AC1 — the rendered task page's #photo input carries no `capture`
//         attribute, while accept="image/*", name="photo", and required
//         all still render.
//   AC2 — the partial ignores a `capture` local passed in (no emission), and
//         its source contains neither the emission string `capture="` nor a
//         `typeof capture` branch.
//   AC3 — the other three pickers (join, profile-edit, memory-upload) keep
//         exactly their own optional upload-field attributes and never gain
//         `capture`.
//   AC4 — the guest can still complete a task through the unchanged upload
//         path: POST a small valid image, redirect, exactly one submissions
//         row for that guest+task.
//
// REQUIRE ORDER: loadApp() must run before any require of config/db (see
// tests/helpers/testApp.js "REQUIRE ORDER MATTERS").
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const ejs = require('ejs');
const sharp = require('sharp');
const { loadApp, signInGuest } = require('./helpers/testApp');

const UPLOAD_FIELD_PATH = path.join(
  __dirname,
  '..',
  'src',
  'views',
  'partials',
  'upload-field.ejs'
);
const UPLOAD_FIELD_SOURCE = fs.readFileSync(UPLOAD_FIELD_PATH, 'utf8');

let app;
let db;
let validJpeg;

beforeAll(async () => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;

  // A tiny, real, valid JPEG so photos.makeThumb (sharp) succeeds — same
  // pattern as tests/e2e-guest-happy-path.test.js.
  validJpeg = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 5, g: 6, b: 7 } },
  })
    .jpeg()
    .toBuffer();
});

function insertGuest() {
  const token = `camera-roll-${crypto.randomUUID()}`;
  const guestId = db
    .prepare('INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)')
    .run(token, 'Camera Roll Guest').lastInsertRowid;
  return { guestId, token };
}

function insertGuestAndTask(taskTitle) {
  const { guestId, token } = insertGuest();
  const taskId = db.prepare('INSERT INTO tasks (title) VALUES (?)').run(taskTitle).lastInsertRowid;
  return { guestId, taskId, token };
}

function extractInput(html, id) {
  // A single-attribute-per-line, self-closing <input ... /> tag, matching
  // how upload-field.ejs renders it.
  const re = new RegExp(`<input[^>]*id="${id}"[^>]*/>`, 's');
  const match = html.match(re);
  return match ? match[0] : null;
}

// ---------------------------------------------------------------------------
// AC1: the rendered task page carries no `capture` attribute.
// ---------------------------------------------------------------------------
describe('AC1: the task upload input no longer forces the camera', () => {
  it('GET /tasks/:id for an uncompleted task renders #photo with no capture attribute', async () => {
    const { taskId, token } = insertGuestAndTask('AC1 camera-roll task');
    const agent = signInGuest(app, token);

    const res = await agent.get(`/tasks/${taskId}`);
    expect(res.status).toBe(200);

    const inputTag = extractInput(res.text, 'photo');
    expect(inputTag).not.toBeNull();

    // The defect this issue fixes: `capture="environment"` forced the rear
    // camera and suppressed the library picker. It must be gone.
    expect(inputTag).not.toMatch(/\bcapture\s*=/);

    // The rest of the control is untouched by the fix.
    expect(inputTag).toContain('accept="image/*"');
    expect(inputTag).toMatch(/\brequired\b/);
    expect(inputTag).toContain('name="photo"');
  });
});

// ---------------------------------------------------------------------------
// AC2: the partial itself can no longer emit the attribute, even if asked.
// ---------------------------------------------------------------------------
describe('AC2: the partial can no longer emit the capture attribute', () => {
  it('rendering the partial directly with a capture local produces no capture= in the output', async () => {
    const html = await ejs.renderFile(UPLOAD_FIELD_PATH, {
      id: 'x',
      name: 'x',
      capture: 'environment',
    });
    expect(html).not.toMatch(/\bcapture\s*=/);
  });

  it("the partial's source contains neither the emission string nor a typeof capture branch", () => {
    // Asserts the FIX, not just an incidental absence: the emission literal
    // and the conditional branch that used to gate it are both gone from
    // source. Does NOT assert the word "capture" is absent altogether — step
    // 2 of the issue requires a header-comment note that names it in prose.
    expect(UPLOAD_FIELD_SOURCE).not.toContain('capture="');
    expect(UPLOAD_FIELD_SOURCE).not.toMatch(/typeof capture/);
  });

  it("the header comment's Locals block no longer documents capture as a supported local", () => {
    // Slice ONLY the list of supported locals — from "Locals:" to the start
    // of the deliberate "NOT a local" note that follows it. Bounding on the
    // comment terminator ("%>") instead would swallow that note, and the
    // assertion below would then pass or fail on how the prose happens to be
    // line-wrapped: re-wrapping so a line begins "capture is a directive…"
    // would trip /^\s*capture\b/m and report capture as a documented local
    // when it is not.
    const localsStart = UPLOAD_FIELD_SOURCE.indexOf('Locals:');
    const noteStart = UPLOAD_FIELD_SOURCE.indexOf('NOT a local, deliberately:');
    expect(localsStart).toBeGreaterThan(-1);
    expect(noteStart).toBeGreaterThan(localsStart);

    const localsBlock = UPLOAD_FIELD_SOURCE.slice(localsStart, noteStart);
    expect(localsBlock).not.toMatch(/^\s*capture\b/m);

    // Guard the slice itself: the locals list must still document the locals
    // the partial does support, so a future edit that moves or renames the
    // note cannot silently shrink this to an empty, vacuously-passing string.
    expect(localsBlock).toMatch(/^\s*accept\b/m);
    expect(localsBlock).toMatch(/^\s*required\b/m);
    expect(localsBlock).toMatch(/^\s*multiple\b/m);
  });
});

// ---------------------------------------------------------------------------
// AC3: the other three pickers keep exactly their own attributes.
// ---------------------------------------------------------------------------
describe('AC3: the other three pickers keep their own attributes and never gain capture', () => {
  it('join.ejs: the avatar input carries accept only, no required/multiple/capture', async () => {
    const res = await request(app).get('/join');
    expect(res.status).toBe(200);

    const inputTag = extractInput(res.text, 'avatar');
    expect(inputTag).not.toBeNull();
    expect(inputTag).toContain('accept="image/jpeg,image/png,image/webp"');
    expect(inputTag).not.toMatch(/\brequired\b/);
    expect(inputTag).not.toMatch(/\bmultiple\b/);
    expect(inputTag).not.toMatch(/\bcapture\s*=/);
  });

  it('me-edit.ejs: the avatar input carries accept only, no required/multiple/capture', async () => {
    // No task needed: /me/edit is a profile page, not a task page.
    const { token } = insertGuest();
    const agent = signInGuest(app, token);

    const res = await agent.get('/me/edit');
    expect(res.status).toBe(200);

    const inputTag = extractInput(res.text, 'avatar');
    expect(inputTag).not.toBeNull();
    expect(inputTag).toContain('accept="image/*"');
    expect(inputTag).not.toMatch(/\brequired\b/);
    expect(inputTag).not.toMatch(/\bmultiple\b/);
    expect(inputTag).not.toMatch(/\bcapture\s*=/);
  });

  it('memory-new.ejs: the photos input carries accept, required, and multiple, no capture', async () => {
    // No task needed: a memory upload is not tied to a task (task_id IS NULL).
    const { token } = insertGuest();
    const agent = signInGuest(app, token);

    const res = await agent.get('/memories/new');
    expect(res.status).toBe(200);

    const inputTag = extractInput(res.text, 'photos');
    expect(inputTag).not.toBeNull();
    expect(inputTag).toContain('accept="image/jpeg,image/png,image/webp"');
    expect(inputTag).toMatch(/\brequired\b/);
    expect(inputTag).toMatch(/\bmultiple\b/);
    expect(inputTag).not.toMatch(/\bcapture\s*=/);
  });
});

// ---------------------------------------------------------------------------
// AC4: the guest can still complete a task through the unchanged upload path.
// ---------------------------------------------------------------------------
describe('AC4: the guest can still complete a task', () => {
  it('POST a small valid image redirects to the task page and records exactly one submission', async () => {
    const { guestId, taskId, token } = insertGuestAndTask('AC4 submit task');
    const agent = signInGuest(app, token);

    // No CSRF token: src/middleware/csrf.js's isTestEnv() legacy-bypass
    // grandfather clause forgives a no-token request in the test env — the
    // same pattern tests/e2e-guest-happy-path.test.js's submitPhoto helper
    // relies on. This test asserts nothing about CSRF.
    const res = await agent
      .post(`/tasks/${taskId}/submit`)
      .attach('photo', validJpeg, { filename: 'ac4-photo.jpg', contentType: 'image/jpeg' });

    expect([302, 303]).toContain(res.status);
    expect(res.headers.location).toBe(`/tasks/${taskId}`);

    const count = db
      .prepare('SELECT COUNT(*) AS n FROM submissions WHERE guest_id = ? AND task_id = ?')
      .get(guestId, taskId).n;
    expect(count).toBe(1);
  });
});
