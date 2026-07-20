// tests/e2e-guest-happy-path.test.js
// Issue #125: drives the real guest journey end-to-end (sign up -> submit a
// photo -> see points and a badge) against the assembled app, plus a
// concurrency smoke covering many guests submitting to the same task at once.
//
// Issue #244 retired the "scan a private link -> separate /onboard form"
// two-step this file originally drove: signup now happens in one POST /join
// (issue #240 folded name/avatar collection into it already), so AC1/AC2
// below sign up with one call instead of two.
//
// REQUIRE ORDER: loadApp() sets DATA_DIR/DB_PATH before config/db/services are
// required, matching tests/submission-intake.test.js and tests/gallery.test.js.
//
// SHARED APP/DB: better-sqlite3 (via src/db.js) is a cached module-level
// singleton, so calling loadApp() more than once in this process returns the
// SAME app/db instance. All three suites below therefore share one database.
// Each suite seeds its own distinct guests/tasks (random-suffixed titles and
// crypto.randomUUID() tokens) so the suites never read or write each other's
// rows; AC3's count is scoped to its own task id for the same reason (see the
// issue's note on why the concurrency count cannot be an unscoped global
// count).
'use strict';

const crypto = require('crypto');
const request = require('supertest');
const sharp = require('sharp');
const { loadApp, signInGuest } = require('./helpers/testApp');

let app;
let db;
let scoring;

// A tiny, real, valid JPEG (matches the proven pattern in
// tests/submission-intake.test.js) so photos.makeThumb (sharp) succeeds.
let validJpeg;

beforeAll(async () => {
  validJpeg = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .jpeg()
    .toBuffer();

  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;

  // Read authoritative state via the scoring service, required AFTER loadApp()
  // so it resolves against the same temp DATA_DIR/DB_PATH.
  scoring = require('../src/services/scoring');
});

// --- Small seeding helpers (local to this file; distinct random tokens/titles
// per call so suites never collide with each other's rows) --------------------

// AC3 (concurrency) seeds guest rows directly and signs each one in without
// ever calling POST /join — requireGuest only checks the signed gsid cookie,
// not any signup state, so the race under test stays isolated to the submit
// step itself. AC1/AC2 sign up for real through POST /join instead (below).
function insertGuest(name) {
  const token = `e2e-${crypto.randomUUID()}`;
  const id = db
    .prepare('INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 0)')
    .run(token, name).lastInsertRowid;
  return { id, token };
}

function insertTask(title) {
  return db.prepare('INSERT INTO tasks (title) VALUES (?)').run(title).lastInsertRowid;
}

// Seeds the BLOOM auto-badge catalog row. scripts/seed.js does not run in
// tests (per the issue background), and recomputeAutoBadges is a no-op when
// this row is absent, so AC2 must insert it itself.
function seedBloomBadge() {
  const existing = db.prepare('SELECT id FROM badges WHERE code = ?').get('BLOOM');
  if (existing) return existing.id;
  return db
    .prepare(
      `INSERT INTO badges (code, name, type, threshold, art_path, description)
       VALUES ('BLOOM', 'First Bloom', 'auto', 5, '/badges/bloom.svg', 'Completed 5 tasks.')`
    )
    .run().lastInsertRowid;
}

async function submitPhoto(agent, taskId, filename) {
  return agent
    .post(`/tasks/${taskId}/submit`)
    .attach('photo', validJpeg, { filename, contentType: 'image/jpeg' });
}

// ===========================================================================
// AC1: happy path — scan link -> onboard -> submit -> points + completed task
// shown on GET /.
// ===========================================================================
describe('AC1: guest happy path (sign up -> submit -> see points)', () => {
  it('shows 1 point and the completed task title on GET / after one submission', async () => {
    const title = `Happy Path Task ${crypto.randomUUID()}`;
    const taskId = insertTask(title);

    const agent = request.agent(app);

    // 1. Sign up: name + contact + PIN in one step, signs the guest in
    // immediately (POST /join sets the signed gsid cookie the agent resends).
    const joinRes = await agent
      .post('/join')
      .type('form')
      .send({
        name: 'Priya Shah',
        contact: `priya-${crypto.randomUUID()}@example.com`,
        pin: '4815',
      });
    expect(joinRes.status).toBe(302);
    // Issue #564: a fresh signup lands on the rules card first, not home —
    // this journey does not visit /how-to-play, which is fine: nothing below
    // gates on onboarded (no guest-facing wall exists for it).
    expect(joinRes.headers.location).toBe('/how-to-play');

    const guest = db.prepare('SELECT id FROM guests WHERE name = ?').get('Priya Shah');

    // 2. Submit a photo for the seeded active task.
    const submitRes = await submitPhoto(agent, taskId, 'ac1-photo.jpg');
    expect([302, 303]).toContain(submitRes.status);

    // 3. GET / shows the updated points and the completed task.
    const homeRes = await agent.get('/');
    expect(homeRes.status).toBe(200);
    expect(homeRes.text).toContain('<strong>1</strong> point');
    expect(homeRes.text).toContain(title);

    // Assert authoritative state via the scoring service too, not just the
    // rendered page — this would fail if points/completion were not actually
    // recorded (e.g. if the render showed a stale or hardcoded value).
    expect(scoring.getPoints(guest.id)).toBe(1);
    expect(scoring.getCompletedCount(guest.id)).toBe(1);
  });
});

// ===========================================================================
// AC2: BLOOM badge is absent after 4 distinct submissions and present after
// the 5th — a non-vacuous before/after check on both the rendered page and
// the guest_badges row.
// ===========================================================================
describe('AC2: BLOOM badge appears only after the 5th distinct completed task', () => {
  it('is absent after 4 submissions and present after the 5th', async () => {
    const bloomBadgeId = seedBloomBadge();
    const tasks = Array.from({ length: 5 }, (_unused, i) =>
      insertTask(`Badge Task ${i}-${crypto.randomUUID()}`)
    );

    const agent = request.agent(app);
    await agent
      .post('/join')
      .type('form')
      .send({ name: 'Sam Rivera', contact: `sam-${crypto.randomUUID()}@example.com`, pin: '9163' });
    const guest = db.prepare('SELECT id FROM guests WHERE name = ?').get('Sam Rivera');

    // Submit to the first 4 distinct tasks.
    for (let i = 0; i < 4; i++) {
      const res = await submitPhoto(agent, tasks[i], `badge-photo-${i}.jpg`);
      expect([302, 303]).toContain(res.status);
    }

    const afterFour = await agent.get('/');
    expect(afterFour.status).toBe(200);
    // Absent: neither the alt text nor the badge art src appears yet.
    expect(afterFour.text).not.toContain('alt="First Bloom badge"');
    expect(afterFour.text).not.toContain('src="/badges/bloom.svg"');
    expect(
      db
        .prepare('SELECT 1 FROM guest_badges WHERE guest_id = ? AND badge_id = ?')
        .get(guest.id, bloomBadgeId)
    ).toBeUndefined();
    expect(scoring.getCompletedCount(guest.id)).toBe(4);

    // Submit the 5th distinct task — crosses the BLOOM threshold (5).
    const fifthRes = await submitPhoto(agent, tasks[4], 'badge-photo-4.jpg');
    expect([302, 303]).toContain(fifthRes.status);

    const afterFive = await agent.get('/');
    expect(afterFive.status).toBe(200);
    expect(afterFive.text).toContain('alt="First Bloom badge"');
    expect(afterFive.text).toContain('src="/badges/bloom.svg"');
    expect(
      db
        .prepare('SELECT 1 FROM guest_badges WHERE guest_id = ? AND badge_id = ?')
        .get(guest.id, bloomBadgeId)
    ).toBeDefined();
    expect(scoring.getCompletedCount(guest.id)).toBe(5);
  });
});

// ===========================================================================
// AC3: concurrency smoke — 20 distinct guests submit to the SAME single task
// simultaneously through the real HTTP stack. No lost or mis-attributed write.
// ===========================================================================
describe('AC3: 20 concurrent guests submitting to one task', () => {
  it('records all 20 submissions as distinct, visible, correctly-attributed rows', async () => {
    const concurrencyTaskId = insertTask(`Concurrency Task ${crypto.randomUUID()}`);
    const guestCount = 20;

    const guests = Array.from({ length: guestCount }, (_unused, i) => insertGuest(`Guest ${i}`));

    // Establish one logged-in agent per guest BEFORE firing the concurrent
    // submissions, so the race under test is the submit step itself.
    // POST /join is intentionally NOT called here (unlike AC1/AC2):
    // requireGuest only checks the signed gsid cookie, not any signup state,
    // so a guest can submit without ever having signed up through the form —
    // signInGuest mints that cookie directly (issue #244; GET /j/:token no
    // longer sets it).
    const agents = guests.map((guest) => signInGuest(app, guest.token));

    const responses = await Promise.all(
      agents.map((agent, i) => submitPhoto(agent, concurrencyTaskId, `concurrent-${i}.jpg`))
    );

    // Every request must succeed at the HTTP layer (< 500) — no dropped or
    // crashed handler under interleaved load.
    for (const res of responses) {
      expect(res.status).toBeLessThan(500);
    }

    // Scoped to this suite's own task id: AC1/AC2 also insert visible
    // submissions into the same shared database, so an unscoped count would
    // be polluted by their rows.
    const countRow = db
      .prepare('SELECT COUNT(*) AS c FROM submissions WHERE task_id = ? AND taken_down = 0')
      .get(concurrencyTaskId);
    expect(countRow.c).toBe(guestCount);

    const rows = db
      .prepare('SELECT guest_id FROM submissions WHERE task_id = ? AND taken_down = 0')
      .all(concurrencyTaskId);
    const distinctGuestIds = new Set(rows.map((r) => r.guest_id));
    expect(distinctGuestIds.size).toBe(guestCount);

    // Every seeded guest is represented exactly once — no write was
    // attributed to the wrong guest.
    const expectedGuestIds = new Set(guests.map((g) => g.id));
    expect(distinctGuestIds).toEqual(expectedGuestIds);
  });
});
