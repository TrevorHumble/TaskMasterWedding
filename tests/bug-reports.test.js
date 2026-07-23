// tests/bug-reports.test.js
// Covers issue #245 (the guest "Report a bug" form) and issue #686 (the
// admin bug-report lifecycle: open / tracked-on-GitHub / closed):
//   AC1 (#245) — a signed-in guest's submission inserts a bug_reports row
//         (body, guest_id, page = referring path, status = 'open') and shows
//         the required thank-you flash
//   AC2 (#245) — a signed-out visitor GETting /bug-report is redirected
//         (302) to /join, not shown the form
//   AC5 (#245) — an empty body inserts no row and re-renders the form with
//         the required error copy
//   AC6 (#245) — a body over 1000 characters is stored truncated to exactly
//         1000
//   AC1 (#686) — the "Open issue" href targets GITHUB_REPO_URL + /issues/new
//         with the report text/guest/page/timestamp in its query params;
//         using it (POST /admin/bugs/:id/track) marks the report tracked
//   AC2 (#686) — POST /admin/bugs/:id/close from an OPEN report marks it
//         closed and it no longer counts as open
//   AC3 (#686) — POST /admin/bugs/:id/close from a TRACKED report also marks
//         it closed and it no longer counts as open
//   AC4 (#686) — the open-bugs count (openBugCount() and the rendered
//         dashboard) is honest given a mix of open/tracked/closed reports
//   AC5 (#686) — GET /admin/bugs renders the approved layout: open queue
//         (Open issue + Close), Handled section (On GitHub tag + Close for
//         tracked, struck-through for closed), no "Dashboard" back-link, and
//         the empty-open-queue copy
//
// The migration from `resolved` to `status` (issue #686 AC7) is covered
// separately in tests/bug-report-status-migration.test.js, which needs its
// own pre-migration on-disk database shape (mirrors
// tests/oneday-challenge-migration.test.js's own split).
//
// REQUIRE ORDER: config / db / app are required only via loadApp() — see
// tests/helpers/testApp.js "REQUIRE ORDER MATTERS".
'use strict';

const request = require('supertest');
const { loadApp, makeAdminAgent, signInGuest } = require('./helpers/testApp');

let app;
let db;
let adminAgent;
let openBugCount;

beforeAll(async () => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
  adminAgent = await makeAdminAgent(app);
  // Required only after loadApp() so it binds to the temp-DATA_DIR db (see
  // testApp.js's REQUIRE ORDER note).
  ({ openBugCount } = require('../src/db'));
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

function insertBugReport(guestId, { body, page, status, createdAt }) {
  return db
    .prepare(
      `INSERT INTO bug_reports (guest_id, body, page, status, created_at)
       VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')))`
    )
    .run(guestId, body, page, status || 'open', createdAt || null).lastInsertRowid;
}

function signedInAgent(token) {
  return signInGuest(app, token);
}

describe('AC1 (#245): a valid submission inserts a row and thanks the guest', () => {
  test('body, guest_id, page, and status=open are stored; flash shows the thank-you copy', async () => {
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
    expect(row.status).toBe('open');

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

describe('AC2 (#245): a signed-out visitor is gated', () => {
  test('GET /bug-report with no guest cookie redirects to /join (issue #241)', async () => {
    resetTables();

    const res = await request(app).get('/bug-report');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/join');
  });
});

describe('AC5 (#245): an empty body inserts no row and shows the required error', () => {
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

describe('AC6 (#245): a body over 1000 characters is truncated to exactly 1000', () => {
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

describe('AC1 (#686): the "Open issue" prefill href, and using it marks tracked', () => {
  test('the href targets GITHUB_REPO_URL + /issues/new with the report text, guest, page, and timestamp', async () => {
    resetTables();
    const guestId = insertGuest('gh-prefill-token', 'Ray');
    const id = insertBugReport(guestId, {
      body: 'Gallery wont load',
      page: '/gallery',
      status: 'open',
      createdAt: '2026-08-07 19:12:00',
    });

    const res = await adminAgent.get('/admin/bugs');
    expect(res.status).toBe(200);

    // The link out to GitHub's new-issue form (config.GITHUB_REPO_URL's
    // default, since this test never overrides the env var).
    expect(res.text).toContain(
      'https://github.com/TrevorHumble/TaskMasterWedding/issues/new?title='
    );

    // Title param: "Guest bug report: " + the report body (both raw strings
    // here contain no characters encodeURIComponent leaves as HTML-special,
    // so the rendered (HTML-escaped) attribute is byte-identical to this).
    const expectedTitleParam = encodeURIComponent('Guest bug report: Gallery wont load');
    expect(res.text).toContain('title=' + expectedTitleParam);

    // Body param: guest name, page, timestamp, and the report text itself.
    const expectedBodyText = [
      'Reported by **Ray** on /gallery',
      'At: 2026-08-07 19:12:00',
      '',
      'Gallery wont load',
      '',
      '_Filed from the wedding app bug queue._',
    ].join('\n');
    expect(res.text).toContain('body=' + encodeURIComponent(expectedBodyText));

    // "Using" the Open issue action marks the report tracked: the anchor's
    // onclick fires a background POST to /track for THIS report. Assert the
    // onclick is present and targets this id (EJS HTML-escapes the single
    // quotes to &#39;) — a future edit dropping the onclick would otherwise
    // leave the suite green while silently breaking "using it marks tracked".
    expect(res.text).toContain('sendBeacon(&#39;/admin/bugs/' + id + '/track&#39;)');
  });

  test('POST /admin/bugs/:id/track marks the report tracked and it leaves the open queue', async () => {
    resetTables();
    const guestId = insertGuest('track-token', 'Reporter');
    const id = insertBugReport(guestId, { body: 'Broken thing', page: '/gallery', status: 'open' });

    const trackRes = await adminAgent
      .post('/admin/bugs/' + id + '/track')
      .type('form')
      .send({});
    expect(trackRes.status).toBe(303);

    const row = db.prepare('SELECT status FROM bug_reports WHERE id = ?').get(id);
    expect(row.status).toBe('tracked');
    expect(openBugCount()).toBe(0);

    const listRes = await adminAgent.get('/admin/bugs');
    expect(listRes.text).toContain('No open bug reports.');
    expect(listRes.text).toContain('On GitHub');
  });

  test('an unknown id redirects with "Bug report not found." and writes nothing', async () => {
    resetTables();
    const res = await adminAgent.post('/admin/bugs/99999/track').type('form').send({});
    expect(res.headers.location).toContain(encodeURIComponent('Bug report not found.'));
    expect(db.prepare('SELECT COUNT(*) AS n FROM bug_reports').get().n).toBe(0);
  });
});

describe('AC2 (#686): close from open', () => {
  test('POST /admin/bugs/:id/close on an open report marks it closed, strikes it through, and it no longer counts as open', async () => {
    resetTables();
    const guestId = insertGuest('close-open-token', 'Reporter Four');
    const id = insertBugReport(guestId, {
      body: 'The gallery flickers on load',
      page: '/gallery',
      status: 'open',
    });

    const closeRes = await adminAgent
      .post('/admin/bugs/' + id + '/close')
      .type('form')
      .send({});
    expect(closeRes.status).toBe(303);

    const row = db.prepare('SELECT status FROM bug_reports WHERE id = ?').get(id);
    expect(row.status).toBe('closed');
    expect(openBugCount()).toBe(0);

    const listRes = await adminAgent.get('/admin/bugs');
    expect(listRes.status).toBe(200);
    expect(listRes.text).toContain('No open bug reports.');
    expect(listRes.text).toContain('The gallery flickers on load');
    expect(listRes.text).toContain('bug-closed');
    // A closed report no longer carries a close (or any) form action of its own.
    expect(listRes.text).not.toContain('/admin/bugs/' + id + '/close');
  });
});

describe('AC3 (#686): close from tracked', () => {
  test('a report already tracked (on GitHub) can still be closed, and stops counting as open', async () => {
    resetTables();
    const guestId = insertGuest('close-tracked-token', 'Reporter');
    const id = insertBugReport(guestId, {
      body: 'Points look wrong',
      page: '/leaderboard',
      status: 'tracked',
    });

    // Sanity: a tracked report is not counted open even before closing.
    expect(openBugCount()).toBe(0);

    const closeRes = await adminAgent
      .post('/admin/bugs/' + id + '/close')
      .type('form')
      .send({});
    expect(closeRes.status).toBe(303);

    const row = db.prepare('SELECT status FROM bug_reports WHERE id = ?').get(id);
    expect(row.status).toBe('closed');
    expect(openBugCount()).toBe(0);

    const listRes = await adminAgent.get('/admin/bugs');
    expect(listRes.text).toContain('Points look wrong');
    expect(listRes.text).toContain('bug-closed');
  });
});

describe('AC4 (#686): the open count is honest across every surface', () => {
  test('1 open + 1 tracked + 1 closed report -> openBugCount() and the dashboard stat both read 1', async () => {
    resetTables();
    const guestId = insertGuest('honest-count-token', 'Reporter');
    insertBugReport(guestId, { body: 'Open one', page: '/a', status: 'open' });
    insertBugReport(guestId, { body: 'Tracked one', page: '/b', status: 'tracked' });
    insertBugReport(guestId, { body: 'Closed one', page: '/c', status: 'closed' });

    expect(openBugCount()).toBe(1);

    const dashRes = await adminAgent.get('/admin');
    expect(dashRes.status).toBe(200);
    const bugCellMatch = dashRes.text.match(
      /<a class="stat" href="\/admin\/bugs">\s*<span class="stat-num[^"]*">(\d+)<\/span>\s*<span class="stat-label">Open bugs<\/span>/
    );
    expect(bugCellMatch).not.toBeNull();
    expect(bugCellMatch[1]).toBe('1');

    // The "Today" checklist's bug pin reads the same count.
    expect(dashRes.text).toContain('Look at 1 new bug report');
  });
});

describe('AC5 (#686): GET /admin/bugs renders the approved three-state layout', () => {
  test('open queue (Open issue + Close), Handled section (On GitHub tag + Close for tracked, struck-through for closed), no Dashboard back-link', async () => {
    resetTables();
    const guestId = insertGuest('layout-token', 'Layout Reporter');
    const openId = insertBugReport(guestId, {
      body: 'Open report body',
      page: '/x',
      status: 'open',
    });
    const trackedId = insertBugReport(guestId, {
      body: 'Tracked report body',
      page: '/y',
      status: 'tracked',
    });
    const closedId = insertBugReport(guestId, {
      body: 'Closed report body',
      page: '/z',
      status: 'closed',
    });

    const res = await adminAgent.get('/admin/bugs');
    expect(res.status).toBe(200);

    // Open queue: the open report's own "Open issue" link and Close form.
    expect(res.text).toContain('Open report body');
    expect(res.text).toContain('Open issue');
    expect(res.text).toContain('/admin/bugs/' + openId + '/close');

    // Handled section, gated present since tracked/closed reports exist.
    expect(res.text).toContain('<h2 class="section-title">Handled</h2>');

    // Tracked: "On GitHub" tag AND a Close action.
    expect(res.text).toContain('Tracked report body');
    expect(res.text).toContain('On GitHub');
    expect(res.text).toContain('/admin/bugs/' + trackedId + '/close');

    // Closed: struck-through (bug-closed class), no action of its own.
    expect(res.text).toContain('Closed report body');
    expect(res.text).toContain('bug-closed');
    expect(res.text).not.toContain('/admin/bugs/' + closedId + '/close');
    expect(res.text).not.toContain('/admin/bugs/' + closedId + '/track');

    // No "← Dashboard" back-link on this page (the header nav already links it).
    expect(res.text).not.toContain('&larr; Dashboard');
  });

  test('an empty open queue shows the required copy', async () => {
    resetTables();
    const guestId = insertGuest('empty-open-token', 'Reporter');
    insertBugReport(guestId, { body: 'Already closed', page: '/x', status: 'closed' });

    const res = await adminAgent.get('/admin/bugs');
    expect(res.status).toBe(200);
    expect(res.text).toContain('No open bug reports.');
  });
});
