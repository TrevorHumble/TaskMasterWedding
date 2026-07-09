// tests/admin-guest-management.test.js
// Issue #181: admin guest-management routes need tests that assert real
// response/DB outcomes, not just that a handler ran. Covers create, bulk
// create (with its junk/cap guards), edit (rename + pin/unpin), delete
// (missing-file resilience), and bonus points (add/subtract/reject).
//
// REQUIRE ORDER: loadApp() must run before any require that pulls in config
// or db (see tests/helpers/testApp.js).
'use strict';

const { loadApp, makeAdminAgent } = require('./helpers/testApp');

let app;
let db;
let adminAgent;
let scoring;

beforeAll(async () => {
  const result = loadApp();
  app = result.app;
  db = result.db;
  adminAgent = await makeAdminAgent(app);
  // Required only now: scoring.js requires ../db, which reads config.DATA_DIR
  // at module-load time. Requiring it before loadApp() sets DATA_DIR would
  // bind it to the real project data/app.db instead of this test's temp DB.
  scoring = require('../src/services/scoring');
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
describe('POST /admin/guests — create one guest', () => {
  it('trims the name, generates a 32-char hex token, and redirects with a message', async () => {
    const res = await adminAgent.post('/admin/guests').type('form').send({ name: ' Aunt Carol ' });

    expect(res.status).toBe(303);
    expect(res.headers.location).toMatch(/^\/admin\/guests\?msg=/);

    const row = db.prepare('SELECT * FROM guests WHERE name = ?').get('Aunt Carol');
    expect(row).toBeTruthy();
    expect(row.token).toMatch(/^[0-9a-f]{32}$/);
  });

  it('an empty body creates a nameless guest (legal — the place-card flow depends on it)', async () => {
    const before = db.prepare("SELECT COUNT(*) AS n FROM guests WHERE name = ''").get().n;
    await adminAgent.post('/admin/guests').type('form').send({});
    const after = db.prepare("SELECT COUNT(*) AS n FROM guests WHERE name = ''").get().n;
    expect(after).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------
// Bulk create
// ---------------------------------------------------------------------------
describe('POST /admin/guests/bulk', () => {
  it('creates exactly N guests with distinct tokens and a matching message', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM guests').get().n;
    const res = await adminAgent.post('/admin/guests/bulk').type('form').send({ count: '3' });

    const after = db.prepare('SELECT COUNT(*) AS n FROM guests').get().n;
    expect(after).toBe(before + 3);
    expect(res.headers.location).toContain(encodeURIComponent('Created 3'));

    const tokens = db
      .prepare('SELECT token FROM guests ORDER BY id DESC LIMIT 3')
      .all()
      .map((r) => r.token);
    expect(new Set(tokens).size).toBe(3);
  });

  it.each(['0', 'abc'])(
    'rejects junk count %s — no rows created, message says "1 or more"',
    async (count) => {
      const before = db.prepare('SELECT COUNT(*) AS n FROM guests').get().n;
      const res = await adminAgent.post('/admin/guests/bulk').type('form').send({ count });

      const after = db.prepare('SELECT COUNT(*) AS n FROM guests').get().n;
      expect(after).toBe(before);
      expect(res.headers.location).toContain(encodeURIComponent('1 or more'));
    }
  );

  it('caps a request for 501 at exactly 500 new rows', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM guests').get().n;
    await adminAgent.post('/admin/guests/bulk').type('form').send({ count: '501' });
    const after = db.prepare('SELECT COUNT(*) AS n FROM guests').get().n;
    expect(after).toBe(before + 500);
  });
});

// ---------------------------------------------------------------------------
// Edit (rename + pin/unpin)
// ---------------------------------------------------------------------------
describe('POST /admin/guests/:id/edit', () => {
  it('unknown id redirects with "Guest not found." and creates no row', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM guests').get().n;
    const res = await adminAgent
      .post('/admin/guests/99999/edit')
      .type('form')
      .send({ name: 'Nobody' });

    expect(res.headers.location).toContain(encodeURIComponent('Guest not found.'));
    expect(db.prepare('SELECT COUNT(*) AS n FROM guests').get().n).toBe(before);
  });

  it('pin/unpin round-trips: checkbox on sets pinned=1, absent field unpins to 0', async () => {
    const guestId = db
      .prepare('INSERT INTO guests (token, name) VALUES (?, ?)')
      .run('pintoken0000000000000000000000', 'Lilly').lastInsertRowid;

    await adminAgent
      .post(`/admin/guests/${guestId}/edit`)
      .type('form')
      .send({ name: 'Lilly', pinned: 'on' });
    expect(db.prepare('SELECT pinned FROM guests WHERE id = ?').get(guestId).pinned).toBe(1);

    // An unchecked checkbox posts no `pinned` field at all — this is the unpin signal.
    await adminAgent.post(`/admin/guests/${guestId}/edit`).type('form').send({ name: 'Lilly' });
    expect(db.prepare('SELECT pinned FROM guests WHERE id = ?').get(guestId).pinned).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Bonus points
// ---------------------------------------------------------------------------
describe('POST /admin/guests/:id/points', () => {
  it('adds then subtracts, agreeing with scoring.getPoints', async () => {
    const guestId = db
      .prepare('INSERT INTO guests (token, name) VALUES (?, ?)')
      .run('pointstoken000000000000000000a', 'Point Guest').lastInsertRowid;

    let res = await adminAgent
      .post(`/admin/guests/${guestId}/points`)
      .type('form')
      .send({ delta: '5' });
    expect(
      db.prepare('SELECT bonus_points FROM guests WHERE id = ?').get(guestId).bonus_points
    ).toBe(5);
    expect(scoring.getPoints(guestId)).toBe(5);
    expect(res.headers.location).toContain(encodeURIComponent('Awarded 5'));

    res = await adminAgent
      .post(`/admin/guests/${guestId}/points`)
      .type('form')
      .send({ delta: '-2' });
    expect(
      db.prepare('SELECT bonus_points FROM guests WHERE id = ?').get(guestId).bonus_points
    ).toBe(3);
    expect(scoring.getPoints(guestId)).toBe(3);
    expect(res.headers.location).toContain(encodeURIComponent('Removed 2'));
  });

  it.each(['0', 'abc'])(
    'rejects delta=%s — bonus_points unchanged, message says "non-zero"',
    async (delta) => {
      const guestId = db
        .prepare('INSERT INTO guests (token, name) VALUES (?, ?)')
        .run(`rejtoken${delta}00000000000000000`.slice(0, 32), 'Reject Guest').lastInsertRowid;

      const res = await adminAgent
        .post(`/admin/guests/${guestId}/points`)
        .type('form')
        .send({ delta });

      expect(
        db.prepare('SELECT bonus_points FROM guests WHERE id = ?').get(guestId).bonus_points
      ).toBe(0);
      expect(res.headers.location).toContain(encodeURIComponent('non-zero'));
    }
  );

  it('unknown guest id redirects with "Guest not found."', async () => {
    const res = await adminAgent
      .post('/admin/guests/999999/points')
      .type('form')
      .send({ delta: '5' });
    expect(res.headers.location).toContain(encodeURIComponent('Guest not found.'));
  });
});

// ---------------------------------------------------------------------------
// Delete — survives a missing file on disk
// ---------------------------------------------------------------------------
describe('POST /admin/guests/:id/delete — missing photo file on disk', () => {
  it('deletes the guest and their submission even though the file is already gone', async () => {
    const taskId = db
      .prepare('INSERT INTO tasks (title) VALUES (?)')
      .run('Missing-file Task').lastInsertRowid;
    const guestId = db
      .prepare('INSERT INTO guests (token, name) VALUES (?, ?)')
      .run('missingfiletoken00000000000000a', 'Missing File Guest').lastInsertRowid;
    const submissionId = db
      .prepare(
        `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
         VALUES (?, ?, ?, ?, 0)`
      )
      .run(
        guestId,
        taskId,
        'does-not-exist-on-disk.jpg',
        'does-not-exist-on-disk.jpg.jpg'
      ).lastInsertRowid;

    const res = await adminAgent.post(`/admin/guests/${guestId}/delete`).type('form').send({});

    expect(res.status).toBe(303);
    expect(db.prepare('SELECT id FROM guests WHERE id = ?').get(guestId)).toBeUndefined();
    expect(db.prepare('SELECT id FROM submissions WHERE id = ?').get(submissionId)).toBeUndefined();
  });
});
