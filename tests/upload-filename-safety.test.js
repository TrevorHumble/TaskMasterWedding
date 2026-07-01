// tests/upload-filename-safety.test.js
//
// Proves that a client-supplied upload filename cannot inject a path segment
// into the stored photo_path or thumb_path columns.
//
// The load-bearing claim: multer's diskStorage `filename` callback ignores
// `file.originalname` entirely and returns `randomFilename(ext)` — 16 hex
// chars + '-' + timestamp + allowlisted extension.  No matter what filename
// the client provides in the multipart Content-Disposition header, the stored
// DB value is app-generated.  This test fails if that guarantee ever breaks.
//
// REQUIRE ORDER: loadApp() must run before any require of config, db, or app.
'use strict';

const path = require('path');
const request = require('supertest');
const sharp = require('sharp');
const { loadApp } = require('./helpers/testApp');

// Regex that every app-generated filename must match.
// Mirrors the allowlist in src/services/photos.js (ORIGINAL_RE).
const SAFE_NAME_RE = /^[0-9a-f]{16}-\d+\.[a-z0-9]+$/;

let app;
let db;
let guestToken;
let guestId;
let taskId;

// A minimal valid JPEG that sharp will accept for thumbnail generation.
// Built at load time; the same buffer is used for both test cases.
let validJpeg;

beforeAll(async () => {
  // Build a 2x2 RGB JPEG — just big enough for sharp to ingest.
  validJpeg = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 3,
      background: { r: 1, g: 2, b: 3 },
    },
  })
    .jpeg()
    .toBuffer();

  const result = loadApp();
  app = result.app;
  db = result.db;

  // Seed a guest.  onboarded=1 so GET /j/:token redirects to / not /onboard.
  guestToken = 'upload-safety-token';
  guestId = db
    .prepare(`INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)`)
    .run(guestToken, 'Safety Tester').lastInsertRowid;

  // Seed an active task.
  taskId = db
    .prepare(`INSERT INTO tasks (title, is_active) VALUES (?, 1)`)
    .run('Upload Safety Task').lastInsertRowid;
});

/**
 * Return a supertest agent that has the gsid cookie set (authenticated guest).
 * GET /j/:token sets the signed cookie and redirects; the agent stores it.
 */
async function makeGuestAgent() {
  const agent = request.agent(app);
  // Follow the redirect; the cookie is stored on the agent automatically.
  await agent.get('/j/' + guestToken).redirects(1);
  return agent;
}

/**
 * Read the submission row written for this guest+task pair.
 * Returns { photo_path, thumb_path } or undefined if no row.
 */
function readSubmission(gId, tId) {
  return db
    .prepare('SELECT photo_path, thumb_path FROM submissions WHERE guest_id = ? AND task_id = ?')
    .get(gId, tId);
}

/**
 * Submit a photo upload as the authenticated guest and return the stored row.
 * Deletes the existing submission row first so each test case gets a fresh one
 * (the route does INSERT OR REPLACE semantics, but we want clean reads).
 */
async function submitPhoto(agent, filename) {
  // Remove any prior submission for this guest+task so the row is unambiguous.
  db.prepare('DELETE FROM submissions WHERE guest_id = ? AND task_id = ?').run(guestId, taskId);

  const res = await agent
    .post(`/tasks/${taskId}/submit`)
    .attach('photo', validJpeg, { filename: filename, contentType: 'image/jpeg' });

  // The route redirects on success; anything other than a redirect or 200 is a
  // sign the test setup is wrong (not the application behavior under test).
  if (res.status !== 302 && res.status !== 303 && res.status !== 200) {
    throw new Error(
      `Unexpected response ${res.status} for filename "${filename}". ` +
        `Check guest auth, task seed, or multer config. Body: ${res.text.slice(0, 200)}`
    );
  }

  return readSubmission(guestId, taskId);
}

// ---------------------------------------------------------------------------
// Case 1: forward-slash traversal payload
// ---------------------------------------------------------------------------
it('forward-slash traversal: stored name is app-generated, not the client filename', async () => {
  const agent = await makeGuestAgent();
  const traversalFilename = '../../../../etc/passwd.jpg';

  const row = await submitPhoto(agent, traversalFilename);

  expect(row).toBeDefined();

  // photo_path and thumb_path must match the app's random-name pattern.
  expect(row.photo_path).toMatch(SAFE_NAME_RE);
  expect(row.thumb_path).toMatch(/^[0-9a-f]{16}-\d+\.[a-z0-9]+\.[a-z0-9]+$/);

  // None of the dangerous characters from the client filename may appear.
  expect(row.photo_path).not.toContain('/');
  expect(row.photo_path).not.toContain('\\');
  expect(row.photo_path).not.toContain('..');
  expect(row.photo_path).not.toContain('passwd');

  expect(row.thumb_path).not.toContain('/');
  expect(row.thumb_path).not.toContain('\\');
  expect(row.thumb_path).not.toContain('..');
  expect(row.thumb_path).not.toContain('passwd');

  // Confirm the assertion above would fail if originalname were passed through:
  // If the stored value were the client's filename, SAFE_NAME_RE would not match
  // because "../../../../etc/passwd.jpg" contains "/" and "..".
  expect(SAFE_NAME_RE.test(traversalFilename)).toBe(false);
});

// ---------------------------------------------------------------------------
// Case 2: backslash traversal payload
// ---------------------------------------------------------------------------
it('backslash traversal: stored name is app-generated, not the client filename', async () => {
  const agent = await makeGuestAgent();
  const backslashFilename = '..\\..\\evil.jpg';

  const row = await submitPhoto(agent, backslashFilename);

  expect(row).toBeDefined();

  expect(row.photo_path).toMatch(SAFE_NAME_RE);
  expect(row.thumb_path).toMatch(/^[0-9a-f]{16}-\d+\.[a-z0-9]+\.[a-z0-9]+$/);

  expect(row.photo_path).not.toContain('/');
  expect(row.photo_path).not.toContain('\\');
  expect(row.photo_path).not.toContain('..');
  expect(row.photo_path).not.toContain('evil');

  expect(row.thumb_path).not.toContain('/');
  expect(row.thumb_path).not.toContain('\\');
  expect(row.thumb_path).not.toContain('..');
  expect(row.thumb_path).not.toContain('evil');

  // Same falsifiability check.
  expect(SAFE_NAME_RE.test(backslashFilename)).toBe(false);
});
