// tests/guest-blocked.test.js
// Issue #1092: guests.blocked, enforced at sign-in (POST /login) and on every
// request (attachGuest).
//
// The one thing worth stating up front, because it explains every setup block
// below: this issue ships the column, the migration and the enforcement, but
// nothing that SETS the flag. That is #1093's host control, so every test
// here flips `blocked` with a raw UPDATE rather than through a route, and
// that is the design, not a shortcut around a missing helper.
'use strict';

const request = require('supertest');
const sharp = require('sharp');
const { loadApp, signInGuest } = require('./helpers/testApp');
const migrationsGuests = require('../src/db/migrations-guests');

let app;
let db;

beforeAll(() => {
  const result = loadApp();
  app = result.app;
  db = result.db;
});

function insertGuestRow({ token, name, contact, contactType, pin, blocked = 0 }) {
  return db
    .prepare(
      `INSERT INTO guests (token, name, onboarded, contact, contact_type, pin, blocked)
       VALUES (?, ?, 1, ?, ?, ?, ?)`
    )
    .run(token, name, contact, contactType, pin, blocked).lastInsertRowid;
}

function cookiesOf(res) {
  return [].concat(res.headers['set-cookie'] || []);
}

function findCookie(res, name) {
  return cookiesOf(res).find((c) => c.startsWith(name + '='));
}

describe('AC1: a blocked guest is treated as signed-out on every request', () => {
  it("GET / with a blocked guest's valid cookie -> 302 /join with a clearing Set-Cookie", async () => {
    insertGuestRow({
      token: 'blocked-ac1-token',
      name: 'Blocked Guest',
      contact: 'blocked-ac1@example.com',
      contactType: 'email',
      pin: '1234',
      blocked: 1,
    });

    const agent = signInGuest(app, 'blocked-ac1-token');
    const res = await agent.get('/');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/join');
    const gsid = findCookie(res, 'gsid');
    expect(gsid).toBeTruthy();
    expect(gsid).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it('an unblocked guest with the SAME shape of cookie is served normally (control)', async () => {
    insertGuestRow({
      token: 'unblocked-ac1-token',
      name: 'Fine Guest',
      contact: 'unblocked-ac1@example.com',
      contactType: 'email',
      pin: '1234',
      blocked: 0,
    });

    const agent = signInGuest(app, 'unblocked-ac1-token');
    const res = await agent.get('/');

    expect(res.status).toBe(200);
    expect(res.text).toContain('Fine Guest');
  });
});

describe('AC2: a blocked guest cannot log in even with correct credentials', () => {
  it('POST /login with correct contact+PIN -> 401, no cookie, contact preserved, exact message', async () => {
    insertGuestRow({
      token: 'blocked-ac2-token',
      name: 'Blocked Login Guest',
      contact: 'blocked@example.com',
      contactType: 'email',
      pin: '1234',
      blocked: 1,
    });

    const res = await request(app)
      .post('/login')
      .type('form')
      .send({ contact: 'blocked@example.com', pin: '1234' });

    expect(res.status).toBe(401);
    expect(findCookie(res, 'gsid')).toBeUndefined();
    expect(res.text).toContain('value="blocked@example.com"');
    expect(res.text).toContain('This account has been blocked. Please find one of the hosts.');
  });

  it("does not clear that contact's login throttle (a blocked guest cannot use correct creds to reset it)", async () => {
    insertGuestRow({
      token: 'blocked-ac2-throttle-token',
      name: 'Blocked Throttle Guest',
      contact: 'blocked-throttle@example.com',
      contactType: 'email',
      pin: '5555',
      blocked: 1,
    });

    // Record a failure against this contact directly via the module's own
    // test seam (tests/guest-login.test.js's own pattern), so this assertion
    // does not depend on POST /login's wrong-PIN branch also being correct.
    const authRouter = require('../src/routes/auth');
    authRouter._recordGuestLoginFailureForTest('blocked-throttle@example.com', Date.now());
    const before = authRouter._guestLockoutEntryForTest('blocked-throttle@example.com');
    expect(before).toBeTruthy();

    await request(app)
      .post('/login')
      .type('form')
      .send({ contact: 'blocked-throttle@example.com', pin: '5555' });

    const after = authRouter._guestLockoutEntryForTest('blocked-throttle@example.com');
    // Still tracked (not deleted by the correct-credential branch below the
    // blocked check) and still carries the fail this test recorded.
    expect(after).toBeTruthy();
    expect(after.fails).toBe(before.fails);
  });
});

describe('AC3: an unblocked guest has no new failure mode', () => {
  it('signs in and uploads a photo unchanged', async () => {
    const agent = request.agent(app);
    const joinRes = await agent
      .post('/join')
      .type('form')
      .send({ name: 'Ordinary Guest', contact: 'ordinary-ac3@example.com', pin: '2468' });
    expect(joinRes.status).toBe(302);
    expect(findCookie(joinRes, 'gsid')).toBeTruthy();

    const taskId = db
      .prepare(`INSERT INTO tasks (title) VALUES (?)`)
      .run('AC3 task').lastInsertRowid;

    const validJpeg = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 40, g: 80, b: 120 } },
    })
      .jpeg()
      .toBuffer();

    const uploadRes = await agent
      .post('/tasks/' + taskId + '/submit')
      .attach('photo', validJpeg, { filename: 'ac3.jpg', contentType: 'image/jpeg' });

    // Assert WHERE the redirect goes, not just that one happened. A blocked
    // guest's upload also answers 302 (attachGuest sends them to /join), so a
    // bare status check passes identically whether this criterion holds or
    // whether attachGuest wrongly blocks everyone. The destination is the
    // only thing that tells those two apart.
    expect(uploadRes.status).toBe(302);
    expect(uploadRes.headers.location).toBe('/tasks/' + taskId);

    // And the photo actually landed: a real decodable JPEG, so the row exists
    // rather than the upload failing silently somewhere past the redirect.
    const guestRow = db
      .prepare(`SELECT id FROM guests WHERE contact = ?`)
      .get('ordinary-ac3@example.com');
    const submission = db
      .prepare(`SELECT COUNT(*) AS n FROM submissions WHERE task_id = ? AND guest_id = ?`)
      .get(taskId, guestRow.id);
    expect(submission.n).toBe(1);
  });
});

describe('AC4/AC5: ensureBlockedColumn migration', () => {
  // The two tests below drive ensureBlockedColumn directly against throwaway
  // tables. This one covers the half they cannot: that src/db.js actually
  // CALLS it at module load, against the real schema. Without the boot wiring
  // the helper would be defined, exported, tested green, and never run on any
  // real database.
  it('has already run against the real app database by the time the app loads', () => {
    const cols = db.prepare('PRAGMA table_info(guests)').all();
    const blocked = cols.find((c) => c.name === 'blocked');
    expect(blocked).toBeTruthy();
    expect(blocked.notnull).toBe(1);
    expect(blocked.dflt_value).toBe('0');
  });

  it('adds the column and backfills every pre-existing row to blocked = 0', () => {
    // The app's own database already ran this migration at require time (via
    // src/db.js), so it cannot exercise the pre-migration case. Build a
    // throwaway in-memory database with the guests table shaped WITHOUT the
    // column, seed rows, then run the migration directly against it.
    const Database = require('better-sqlite3');
    const testDb = new Database(':memory:');
    testDb.exec(`
      CREATE TABLE guests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT NOT NULL,
        name TEXT NOT NULL
      )
    `);
    testDb.prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`).run('t1', 'Guest One');
    testDb.prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`).run('t2', 'Guest Two');

    expect(() => migrationsGuests.ensureBlockedColumn(testDb)).not.toThrow();

    const cols = testDb.prepare('PRAGMA table_info(guests)').all();
    expect(cols.some((c) => c.name === 'blocked')).toBe(true);

    const rows = testDb.prepare('SELECT blocked FROM guests').all();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.blocked === 0)).toBe(true);

    testDb.close();
  });

  it('running the migration again is a no-op that changes no row, including blocked = 1', () => {
    const Database = require('better-sqlite3');
    const testDb = new Database(':memory:');
    testDb.exec(`
      CREATE TABLE guests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT NOT NULL,
        name TEXT NOT NULL
      )
    `);
    testDb.prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`).run('t3', 'Guest Three');
    migrationsGuests.ensureBlockedColumn(testDb);
    testDb.prepare(`UPDATE guests SET blocked = 1 WHERE token = ?`).run('t3');

    expect(() => migrationsGuests.ensureBlockedColumn(testDb)).not.toThrow();

    const row = testDb.prepare('SELECT blocked FROM guests WHERE token = ?').get('t3');
    expect(row.blocked).toBe(1);

    testDb.close();
  });
});

describe("AC6: a blocked guest's existing contributions are unaffected", () => {
  it('their photo and standing still render on the gallery and leaderboard', async () => {
    const guestId = insertGuestRow({
      token: 'blocked-ac6-token',
      name: 'Contributor Guest',
      contact: 'blocked-ac6@example.com',
      contactType: 'email',
      pin: '9999',
      blocked: 1,
    });
    const taskId = db
      .prepare(`INSERT INTO tasks (title) VALUES (?)`)
      .run('AC6 task').lastInsertRowid;
    db.prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, 0)`
    ).run(guestId, taskId, 'blocked-ac6.jpg', 'blocked-ac6-thumb.jpg');
    db.prepare('UPDATE guests SET bonus_points = 5 WHERE id = ?').run(guestId);

    // /gallery and /leaderboard are requireGuest-gated (src/routes/
    // community.js), so viewing them needs SOME signed-in guest, but never
    // the blocked contributor's own session, which is exactly the point:
    // a different, unblocked guest views the shared pages and must still
    // see the blocked guest's past photo and standing.
    insertGuestRow({
      token: 'blocked-ac6-viewer-token',
      name: 'Viewer Guest',
      contact: 'blocked-ac6-viewer@example.com',
      contactType: 'email',
      pin: '1111',
      blocked: 0,
    });
    const viewer = signInGuest(app, 'blocked-ac6-viewer-token');

    // The "By person" view (?view=user) is where a guest's name renders as a
    // section heading: the "Recent" default view groups by photo, not by
    // contributor.
    const gallery = await viewer.get('/gallery?view=user');
    expect(gallery.status).toBe(200);
    expect(gallery.text).toContain('Contributor Guest');

    const leaderboard = await viewer.get('/leaderboard');
    expect(leaderboard.status).toBe(200);
    expect(leaderboard.text).toContain('Contributor Guest');
  });
});
