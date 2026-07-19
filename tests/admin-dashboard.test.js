// tests/admin-dashboard.test.js
// Covers issue #256 acceptance criteria — the admin dashboard's six-stat
// grid, activity pulse line, and menu-list action rows (phase-2 wiring of
// the owner-approved phase-1 view onto real data):
//   AC1 — 2 unresolved bug reports render a stat cell showing "2", labeled
//         "Open bug reports", wrapped in an anchor to /admin/bugs; the grid
//         holds exactly six stat anchors (no empty cell).
//   AC2 — 0 unresolved bug reports render "0" without the danger color class.
//   AC3 — the newest visible submission's guest name appears on the pulse
//         line ("Last photo ... <name>").
//   AC4 — the action rows render as a single <ul class="menu-list"> of
//         exactly five <li class="menu-row"> rows, labels in the specified
//         order, each with a .menu-icon, none carrying a bespoke
//         primary/emphasis modifier class.
// Plus a unit test for src/services/relative-time.js's relativeTime().
//
// REQUIRE ORDER: config / db / app are required only via loadApp() — see
// tests/helpers/testApp.js "REQUIRE ORDER MATTERS".
'use strict';

const { loadApp, makeAdminAgent } = require('./helpers/testApp');
const { relativeTime } = require('../src/services/relative-time');

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
  db.prepare('DELETE FROM submissions').run();
  db.prepare('DELETE FROM guests').run();
  db.prepare('DELETE FROM tasks').run();
}

function insertGuest(token, name) {
  return db
    .prepare('INSERT INTO guests (token, name) VALUES (?, ?)')
    .run(token, name || 'Guest ' + token).lastInsertRowid;
}

function insertBugReport(guestId, resolved) {
  db.prepare(
    'INSERT INTO bug_reports (guest_id, body, page, resolved) VALUES (?, ?, ?, ?)'
  ).run(guestId, 'It broke.', '/tasks/1', resolved ? 1 : 0);
}

function insertTask(title) {
  return db.prepare('INSERT INTO tasks (title) VALUES (?)').run(title).lastInsertRowid;
}

function insertSubmission(guestId, taskId, takenDown, createdAt) {
  db.prepare(
    `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(guestId, taskId, 'p.jpg', 't.jpg', takenDown ? 1 : 0, createdAt);
}

describe('AC1: open bug reports render as the sixth stat cell', () => {
  test('2 unresolved bug reports show "2" in an anchor to /admin/bugs; six stat anchors total', async () => {
    resetTables();
    const guestId = insertGuest('ac1-token', 'Reporter One');
    insertBugReport(guestId, false);
    insertBugReport(guestId, false);
    // A resolved report must NOT count toward the open total.
    insertBugReport(guestId, true);

    const res = await adminAgent.get('/admin');
    expect(res.status).toBe(200);

    const statAnchors = res.text.match(/<a class="stat"/g) || [];
    expect(statAnchors.length).toBe(6);

    const bugCellMatch = res.text.match(
      /<a class="stat" href="\/admin\/bugs">\s*<span class="stat-num[^"]*">(\d+)<\/span>\s*<span class="stat-label">Open bug reports<\/span>/
    );
    expect(bugCellMatch).not.toBeNull();
    expect(bugCellMatch[1]).toBe('2');
  });
});

describe('AC2: zero open bug reports render without the danger color class', () => {
  test('0 unresolved bug reports show "0" with no stat-num-danger class', async () => {
    resetTables();

    const res = await adminAgent.get('/admin');
    expect(res.status).toBe(200);

    const bugCellMatch = res.text.match(
      /<a class="stat" href="\/admin\/bugs">\s*<span class="([^"]*)">0<\/span>\s*<span class="stat-label">Open bug reports<\/span>/
    );
    expect(bugCellMatch).not.toBeNull();
    expect(bugCellMatch[1]).toBe('stat-num');
    expect(bugCellMatch[1]).not.toContain('stat-num-danger');
  });
});

describe('AC3: the pulse line names the newest visible submission\'s guest', () => {
  test('newest visible submission by Ellie Patel renders "Last photo ... Ellie Patel"', async () => {
    resetTables();
    const taskId = insertTask('Selfie with the cake');
    const olderGuestId = insertGuest('ac3-older', 'Someone Earlier');
    const newerGuestId = insertGuest('ac3-newer', 'Ellie Patel');
    const takenDownGuestId = insertGuest('ac3-hidden', 'Hidden Guest');

    insertSubmission(olderGuestId, taskId, false, '2026-07-19 10:00:00');
    // A taken-down submission newer than Ellie's must NOT win the pulse line.
    const hiddenTaskId = insertTask('Hidden task');
    insertSubmission(takenDownGuestId, hiddenTaskId, true, '2026-07-19 12:00:00');
    insertSubmission(newerGuestId, taskId, false, '2026-07-19 11:00:00');

    const res = await adminAgent.get('/admin');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Last photo[\s\S]*?Ellie Patel/);
  });

  test('no visible submissions render the empty-state pulse copy', async () => {
    resetTables();

    const res = await adminAgent.get('/admin');
    expect(res.status).toBe(200);
    expect(res.text).toContain('No photos yet — the QR cards are ready when you are.');
  });
});

describe('AC4: action rows render as a single cohesive menu-list', () => {
  test('exactly five menu-row rows, exact label order, each with a menu-icon, no modifier class', async () => {
    resetTables();

    const res = await adminAgent.get('/admin');
    expect(res.status).toBe(200);

    const rowMatches = res.text.match(/<li class="menu-row">/g) || [];
    expect(rowMatches.length).toBe(5);

    const listMatch = res.text.match(/<ul class="menu-list">([\s\S]*?)<\/ul>/);
    expect(listMatch).not.toBeNull();
    const listHtml = listMatch[1];

    // Exactly one <ul class="menu-list"> block in the whole page.
    expect(res.text.match(/<ul class="menu-list">/g).length).toBe(1);

    // Labels, in order.
    const labels = [...listHtml.matchAll(/<span class="menu-label">([^<]*)<\/span>/g)].map(
      (m) => m[1]
    );
    expect(labels).toEqual([
      'Photos &amp; takedowns',
      'Manage tasks',
      'Manage guests',
      'Print QR place-cards',
      'Download export (ZIP + spreadsheet)',
    ]);

    // Every row has a menu-icon.
    const iconCount = (listHtml.match(/class="menu-icon"/g) || []).length;
    expect(iconCount).toBe(5);

    // No bespoke primary/emphasis modifier class on any row's link — every
    // .menu-link in this list carries exactly the base class, nothing else
    // (unlike guest-home.ejs's menu-link-muted / menu-link-button variants).
    const linkClassLists = [...listHtml.matchAll(/<a class="([^"]*)"/g)].map((m) => m[1]);
    expect(linkClassLists.length).toBe(5);
    linkClassLists.forEach((classList) => {
      expect(classList).toBe('menu-link');
    });
  });
});

describe('relativeTime', () => {
  test('a timestamp 4 minutes old renders "4 minutes ago"', () => {
    const fourMinutesAgo = new Date(Date.now() - 4 * 60 * 1000);
    expect(relativeTime(fourMinutesAgo)).toBe('4 minutes ago');
  });

  test('singular: a timestamp 1 minute old renders "1 minute ago"', () => {
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000);
    expect(relativeTime(oneMinuteAgo)).toBe('1 minute ago');
  });

  test('a timestamp under 60 seconds old renders "just now" (0/negative delta clamp)', () => {
    expect(relativeTime(new Date())).toBe('just now');
    // A clock-skewed future timestamp must clamp to "just now", not go negative.
    expect(relativeTime(new Date(Date.now() + 60 * 1000))).toBe('just now');
  });

  test('a SQLite datetime(\'now\')-shaped UTC string parses correctly, not as local time', () => {
    // Mirrors the exact shape src/db.js's created_at columns store.
    const nowUtc = new Date();
    const sqliteShape = nowUtc
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d+Z$/, '');
    expect(relativeTime(sqliteShape)).toBe('just now');
  });

  test('null/invalid input returns an empty string, not "NaN ... ago"', () => {
    expect(relativeTime(null)).toBe('');
    expect(relativeTime(undefined)).toBe('');
    expect(relativeTime('not a date')).toBe('');
  });
});
