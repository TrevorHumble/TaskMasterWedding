// tests/bug-reports.test.js
// Covers issue #245 acceptance criteria — the guest "Report a bug" form and
// the admin bug queue:
//   AC1 — a signed-in guest's submission inserts a bug_reports row (body,
//         guest_id, page = referring path, resolved=0) and shows the
//         required thank-you flash
//   AC2 — a signed-out visitor GETting /bug-report is redirected (302) to
//         /join, not shown the form
//   AC3 — GET /admin/bugs renders an unresolved report's body, the
//         reporting guest's name, and a resolve form posting to the right URL
//   AC4 — POST /admin/bugs/:id/resolve flips resolved to 1 and the report
//         renders in the collapsed Resolved section on the next GET
//   AC5 — an empty body inserts no row and re-renders the form with the
//         required error copy
//   AC6 — a body over 1000 characters is stored truncated to exactly 1000
//
// REQUIRE ORDER: config / db / app are required only via loadApp() — see
// tests/helpers/testApp.js "REQUIRE ORDER MATTERS".
'use strict';

const request = require('supertest');
const { loadApp, makeAdminAgent, signInGuest } = require('./helpers/testApp');

let app;
let db;
let adminAgent;

beforeAll(async () => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
  adminAgent = await makeAdminAgent(app);
});

// Wipe every row these tests touch so one test's fixtures never leak into
// the next (each test re-seeds exactly what it needs).
function resetTables() {
  db.prepare('DELETE FROM bug_reports').run();
  db.prepare('DELETE FROM guests').run();
}

function insertGuest(token, name) {
  return db
    .prepare('INSERT INTO guests (token, name) VALUES (?, ?)')
    .run(token, name || 'Guest ' + token).lastInsertRowid;
}

function signedInAgent(token) {
  return signInGuest(app, token);
}

describe('AC1: a valid submission inserts a row and thanks the guest', () => {
  test('body, guest_id, page, and resolved=0 are stored; flash shows the thank-you copy', async () => {
    resetTables();
    const guestId = insertGuest('ac1-token', 'Reporter One');
    const agent = await signedInAgent('ac1-token');

    const res = await agent
      .post('/bug-report')
      .set('Referer', 'http://localhost:3000/tasks/7')
      .send({ body: 'Upload button does nothing' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');

    const row = db.prepare('SELECT * FROM bug_reports WHERE guest_id = ?').get(guestId);
    expect(row).toBeTruthy();
    expect(row.body).toBe('Upload button does nothing');
    expect(row.guest_id).toBe(guestId);
    expect(row.page).toBe('/tasks/7');
    expect(row.resolved).toBe(0);

    // Flash is a signed cookie; follow the redirect to see it rendered.
    const follow = await agent.get('/');
    expect(follow.text).toContain('Thanks — the Wedding Masters have been told.');
  });

  test('a missing Referer header stores page as null', async () => {
    resetTables();
    const guestId = insertGuest('ac1-noref-token', 'No Referer Guest');
    const agent = await signedInAgent('ac1-noref-token');

    await agent.post('/bug-report').send({ body: 'Something broke, no referer sent' });

    const row = db.prepare('SELECT * FROM bug_reports WHERE guest_id = ?').get(guestId);
    expect(row.page).toBeNull();
  });
});

describe('AC2: a signed-out visitor is gated', () => {
  test('GET /bug-report with no guest cookie redirects to /join (issue #241)', async () => {
    resetTables();

    const res = await request(app).get('/bug-report');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/join');
  });
});

describe('AC3: GET /admin/bugs renders an unresolved report', () => {
  test('the response contains the body, the guest name, and the resolve form action', async () => {
    resetTables();
    const guestId = insertGuest('ac3-token', 'Reporter Three');
    const id = db
      .prepare(`INSERT INTO bug_reports (guest_id, body, page, resolved) VALUES (?, ?, ?, 0)`)
      .run(guestId, 'Upload button does nothing', '/tasks/2').lastInsertRowid;

    const res = await adminAgent.get('/admin/bugs');

    expect(res.status).toBe(200);
    expect(res.text).toContain('Upload button does nothing');
    expect(res.text).toContain('Reporter Three');
    expect(res.text).toContain('/admin/bugs/' + id + '/resolve');
  });
});

describe('AC4: POST /admin/bugs/:id/resolve marks a report resolved', () => {
  test('resolved flips to 1 and the report moves to the collapsed Resolved section', async () => {
    resetTables();
    const guestId = insertGuest('ac4-token', 'Reporter Four');
    const id = db
      .prepare(`INSERT INTO bug_reports (guest_id, body, page, resolved) VALUES (?, ?, ?, 0)`)
      .run(guestId, 'The gallery flickers on load', '/gallery').lastInsertRowid;

    const resolveRes = await adminAgent
      .post('/admin/bugs/' + id + '/resolve')
      .type('form')
      .send({});
    expect(resolveRes.status).toBe(303);

    const row = db.prepare('SELECT resolved FROM bug_reports WHERE id = ?').get(id);
    expect(row.resolved).toBe(1);

    const listRes = await adminAgent.get('/admin/bugs');
    expect(listRes.status).toBe(200);
    // The unresolved queue is empty; the report shows only in the resolved copy.
    expect(listRes.text).toContain('No open bug reports.');
    expect(listRes.text).toContain('The gallery flickers on load');
    // A resolved report no longer carries a resolve form of its own.
    expect(listRes.text).not.toContain('/admin/bugs/' + id + '/resolve');
  });

  test('an unknown id redirects with "Bug report not found." and writes nothing', async () => {
    resetTables();
    const res = await adminAgent.post('/admin/bugs/99999/resolve').type('form').send({});
    expect(res.headers.location).toContain(encodeURIComponent('Bug report not found.'));
    expect(db.prepare('SELECT COUNT(*) AS n FROM bug_reports').get().n).toBe(0);
  });
});

describe('AC5: an empty body inserts no row and shows the required error', () => {
  test('empty string body', async () => {
    resetTables();
    insertGuest('ac5-token', 'Reporter Five');
    const agent = await signedInAgent('ac5-token');

    const res = await agent.post('/bug-report').send({ body: '' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('Tell us what went wrong first.');
    expect(db.prepare('SELECT COUNT(*) AS n FROM bug_reports').get().n).toBe(0);
  });

  test('whitespace-only body is treated as empty', async () => {
    resetTables();
    insertGuest('ac5-ws-token', 'Reporter Five B');
    const agent = await signedInAgent('ac5-ws-token');

    const res = await agent.post('/bug-report').send({ body: '   \n\t  ' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('Tell us what went wrong first.');
    expect(db.prepare('SELECT COUNT(*) AS n FROM bug_reports').get().n).toBe(0);
  });
});

describe('AC6: a body over 1000 characters is truncated to exactly 1000', () => {
  test('1001 "a" characters store as a 1000-character string', async () => {
    resetTables();
    const guestId = insertGuest('ac6-token', 'Reporter Six');
    const agent = await signedInAgent('ac6-token');

    const longBody = 'a'.repeat(1001);
    await agent.post('/bug-report').send({ body: longBody });

    const row = db.prepare('SELECT body FROM bug_reports WHERE guest_id = ?').get(guestId);
    expect(row.body.length).toBe(1000);
    expect(row.body).toBe('a'.repeat(1000));
  });
});
