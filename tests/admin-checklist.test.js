// tests/admin-checklist.test.js
// Issue #646 acceptance criteria for the host-checklist dashboard:
//   AC1 — approved screen renders: three-cell stat grid, full-width nudge
//         row, flat checklist, four setup links, in order; no day-section
//         headings; no em dash anywhere in the rendered copy.
//   AC2 — the nudge row's count/urgency wording.
//   AC3 — bugs pin above everything while open, and disappear when resolved.
//   AC4 — auto rows read reality: today's daily-challenge row opens/closes,
//         and rolls forward to tomorrow once today's is set.
//   AC5 — a manual item persists checked/unchecked across POST + reload.
//   AC6 — tips render only when nothing open or manual remains.
//   AC7 — a missing feature's backing column/table makes its row silently
//         absent, page still 200s.
//   AC8 — a signed-in guest cannot reach /admin.
//
// REQUIRE ORDER: config / db / app are required only via loadApp() — see
// tests/helpers/testApp.js "REQUIRE ORDER MATTERS".
'use strict';

const { loadApp, makeAdminAgent, signInGuest } = require('./helpers/testApp');

let app;
let db;
let adminAgent;
let hostChecklist;

beforeAll(async () => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
  adminAgent = await makeAdminAgent(app);
  // Required only after loadApp() so it binds to the temp-DATA_DIR db (see
  // testApp.js's REQUIRE ORDER note).
  hostChecklist = require('../src/services/host-checklist');
});

function resetTables() {
  db.prepare('DELETE FROM bug_reports').run();
  db.prepare('DELETE FROM submissions').run();
  db.prepare('DELETE FROM guests').run();
  db.prepare('DELETE FROM tasks').run();
  db.prepare('DELETE FROM settings').run();
}

function insertGuest(token, name) {
  return db
    .prepare('INSERT INTO guests (token, name) VALUES (?, ?)')
    .run(token, name || 'Guest ' + token).lastInsertRowid;
}

// `resolved` here means "not open" (issue #686 retired the resolved boolean
// in favor of the open/tracked/closed status column) — a resolved=true call
// writes status='closed' so this helper's callers, which only ever care
// about open-vs-not, need no changes of their own.
function insertBugReport(guestId, resolved) {
  db.prepare('INSERT INTO bug_reports (guest_id, body, page, status) VALUES (?, ?, ?, ?)').run(
    guestId,
    'It broke.',
    '/tasks/1',
    resolved ? 'closed' : 'open'
  );
}

function setEventConfig(timezone, startDate, endDate) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run('event_timezone', timezone);
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run('event_start_date', startDate);
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run('event_end_date', endDate);
}

describe('AC1: approved screen renders in order, no day headings, no em dash', () => {
  test('three stat cells, full-width nudge, flat checklist, four setup links, in that order', async () => {
    resetTables();

    const res = await adminAgent.get('/admin');
    expect(res.status).toBe(200);

    const statIdx = res.text.indexOf('<section class="stat-grid stat-grid-3">');
    const nudgeIdx = res.text.indexOf('class="stat-nudge');
    const checklistIdx = res.text.indexOf('<ul class="check-list">');
    const setupIdx = res.text.indexOf('<h2 class="section-heading">Setup</h2>');
    expect(statIdx).toBeGreaterThan(-1);
    expect(nudgeIdx).toBeGreaterThan(statIdx);
    expect(checklistIdx).toBeGreaterThan(nudgeIdx);
    expect(setupIdx).toBeGreaterThan(checklistIdx);

    // Exactly three <a class="stat"> cells (the fourth grid child is the
    // full-width nudge row, a different class).
    const statCells = res.text.match(/<a class="stat"/g) || [];
    expect(statCells.length).toBe(3);

    // Four setup links (three <a class="menu-link"> plus the slideshow
    // <button class="menu-link menu-link-button">).
    const setupBlock = res.text.slice(setupIdx);
    const menuRows = setupBlock.match(/<li class="menu-row">/g) || [];
    expect(menuRows.length).toBe(4);

    // No day-section headings (the pre-#646 day-by-day framing).
    expect(res.text).not.toMatch(/Friday|Saturday|Sunday/);

    // No em dash anywhere in the rendered page.
    expect(res.text).not.toContain('—');
  });
});

describe('AC2: the nudge row is honest about count and urgency', () => {
  test('an open bug report is urgent and the nudge counts every open row honestly', async () => {
    resetTables();
    const guestId = insertGuest('nudge-token', 'Reporter');
    insertBugReport(guestId, false);

    const res = await adminAgent.get('/admin');
    expect(res.status).toBe(200);
    // With no configuration saved: the pinned bug row, the config row (unset),
    // the flash row (nothing scheduled), and both unchecked manual rows — 5
    // total, only the bug row urgent. The daily-challenge rows are GATED on
    // configSet (see buildRows()) and are not built at all in this scenario,
    // so they contribute nothing here — do not read this "5" as including
    // them.
    expect(res.text).toMatch(
      /class="stat-nudge stat-nudge-urgent"[^>]*>\s*5 things need you, 1 urgent/
    );
  });

  test('zero open/manual rows render "0 things need you" with no urgent styling', async () => {
    resetTables();
    setEventConfig('America/Boise', '2026-08-07', '2026-08-09');
    // Set today's and tomorrow's daily challenge so those two open rows clear.
    const todayIso = require('../src/services/event-days').eventLocalDateString('America/Boise');
    const tomorrowIso = new Date(new Date(todayIso + 'T00:00:00Z').getTime() + 86400000)
      .toISOString()
      .slice(0, 10);
    db.prepare('INSERT INTO tasks (title, special_date, special_bonus) VALUES (?, ?, 1)').run(
      'Today challenge',
      todayIso
    );
    db.prepare('INSERT INTO tasks (title, special_date, special_bonus) VALUES (?, ?, 1)').run(
      'Tomorrow challenge',
      tomorrowIso
    );
    db.prepare(
      'INSERT INTO tasks (title, flash_start_at, flash_minutes, flash_bonus) VALUES (?, ?, 30, 2)'
    ).run('Flash task', '2026-08-08T19:30:00.000Z');
    // Both manual items checked.
    hostChecklist.setManualChecked('placecards', true);
    hostChecklist.setManualChecked('slideshow-live', true);

    const res = await adminAgent.get('/admin');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/class="stat-nudge"[^>]*>\s*0 things need you\s*</);
    expect(res.text).not.toContain('stat-nudge-urgent');
  });
});

describe('AC3: bugs pin above everything while open, and vanish once resolved', () => {
  test('an unresolved bug report is the first checklist row', async () => {
    resetTables();
    const guestId = insertGuest('pin-token', 'Reporter');
    insertBugReport(guestId, false);

    const res = await adminAgent.get('/admin');
    expect(res.status).toBe(200);
    const listMatch = res.text.match(/<ul class="check-list">([\s\S]*?)<\/ul>/);
    expect(listMatch).not.toBeNull();
    const firstRowMatch = listMatch[1].match(/<li class="check-row[^>]*>[\s\S]*?<\/li>/);
    expect(firstRowMatch[0]).toContain('Look at 1 new bug report');
    expect(firstRowMatch[0]).toContain('check-urgent');
  });

  test('zero unresolved bug reports render no bug row', async () => {
    resetTables();
    const res = await adminAgent.get('/admin');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('new bug report');
  });
});

describe('AC4: the daily-challenge auto row reads reality and rolls forward', () => {
  test("no task on today opens the row; setting one closes it and opens tomorrow's", async () => {
    resetTables();
    setEventConfig('America/Boise', '2026-08-07', '2026-08-09');

    let res = await adminAgent.get('/admin');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Set today&#39;s daily challenge');

    const todayIso = require('../src/services/event-days').eventLocalDateString('America/Boise');
    db.prepare('INSERT INTO tasks (title, special_date, special_bonus) VALUES (?, ?, 1)').run(
      'Today challenge',
      todayIso
    );

    res = await adminAgent.get('/admin');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('Set today&#39;s daily challenge');
    expect(res.text).toContain('Today&#39;s daily challenge is set');
    expect(res.text).toContain('Set tomorrow&#39;s daily challenge');
  });
});

describe('AC5: a manual item persists across POST + reload', () => {
  test('checking placecards persists checked, unchecking persists unchecked', async () => {
    resetTables();

    let res = await adminAgent.get('/admin');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Place-cards printed and on the tables');
    expect(hostChecklist.isManualChecked('placecards')).toBe(false);

    const postRes = await adminAgent.post('/admin/checklist/placecards/toggle');
    expect(postRes.status).toBe(303);
    expect(hostChecklist.isManualChecked('placecards')).toBe(true);

    res = await adminAgent.get('/admin');
    expect(res.status).toBe(200);
    // A checked manual item still renders (greyed, in the done bucket) and
    // remains toggleable — the same form-post shape flips it back.
    expect(res.text).toContain('Place-cards printed and on the tables');
    expect(res.text).toContain('check-row check-done');
    expect(res.text).toContain('action="/admin/checklist/placecards/toggle"');

    await adminAgent.post('/admin/checklist/placecards/toggle');
    expect(hostChecklist.isManualChecked('placecards')).toBe(false);
  });

  test('the accessible name distinguishes checked from unchecked (the visible glyph is aria-hidden)', async () => {
    resetTables();

    let res = await adminAgent.get('/admin');
    expect(res.text).toContain(
      'aria-label="Place-cards printed and on the tables, The app cannot see the tables, so this one is on you, not checked"'
    );

    hostChecklist.setManualChecked('placecards', true);
    res = await adminAgent.get('/admin');
    expect(res.text).toContain(
      'aria-label="Place-cards printed and on the tables, The app cannot see the tables, so this one is on you, checked"'
    );
  });

  test('two rapid double-tap posts of the same rendered (unchecked) state both land checked, not flip back', async () => {
    resetTables();
    expect(hostChecklist.isManualChecked('placecards')).toBe(false);

    // Both requests carry the SAME `checked=0` the page rendered with — the
    // real double-tap shape (two submits of one button before either
    // redirect lands), not two submits of two different page loads.
    await Promise.all([
      adminAgent.post('/admin/checklist/placecards/toggle').type('form').send({ checked: '0' }),
      adminAgent.post('/admin/checklist/placecards/toggle').type('form').send({ checked: '0' }),
    ]);

    expect(hostChecklist.isManualChecked('placecards')).toBe(true);
  });

  test('an unknown checklist id is refused without mutating state', async () => {
    resetTables();
    const res = await adminAgent.post('/admin/checklist/not-a-real-item/toggle');
    expect(res.status).toBe(303);
    expect(res.headers.location).toContain(encodeURIComponent('Unknown checklist item.'));
  });
});

describe('AC6: tips render only when nothing open or manual remains', () => {
  test('an open bug report suppresses tips; clearing everything else still shows tips only once truly empty', async () => {
    resetTables();
    const guestId = insertGuest('tip-token', 'Reporter');
    insertBugReport(guestId, false);

    let res = await adminAgent.get('/admin');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('Mix trivial tasks with hard ones');

    // Resolve the bug, but leave configuration/manual items untouched — tips
    // still gated by the still-open config row and manual rows.
    db.prepare(`UPDATE bug_reports SET status = 'closed'`).run();
    res = await adminAgent.get('/admin');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('Mix trivial tasks with hard ones');

    // Clear every remaining open/manual row: configuration, both daily
    // challenge days, and both manual items.
    setEventConfig('America/Boise', '2026-08-07', '2026-08-09');
    const todayIso = require('../src/services/event-days').eventLocalDateString('America/Boise');
    const tomorrowIso = new Date(new Date(todayIso + 'T00:00:00Z').getTime() + 86400000)
      .toISOString()
      .slice(0, 10);
    db.prepare('INSERT INTO tasks (title, special_date, special_bonus) VALUES (?, ?, 1)').run(
      'Today challenge',
      todayIso
    );
    db.prepare('INSERT INTO tasks (title, special_date, special_bonus) VALUES (?, ?, 1)').run(
      'Tomorrow challenge',
      tomorrowIso
    );
    db.prepare(
      'INSERT INTO tasks (title, flash_start_at, flash_minutes, flash_bonus) VALUES (?, ?, 30, 2)'
    ).run('Flash task', '2026-08-08T19:30:00.000Z');
    hostChecklist.setManualChecked('placecards', true);
    hostChecklist.setManualChecked('slideshow-live', true);

    res = await adminAgent.get('/admin');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Mix trivial tasks with hard ones');
    expect(res.text).toContain('Write tasks that push people to mingle');
    expect(res.text).toMatch(/class="stat-nudge"[^>]*>\s*0 things need you\s*</);
  });
});

describe('AC7: a missing feature degrades quietly', () => {
  test('dropping tasks.flash_start_at omits the flash row and still 200s', async () => {
    resetTables();
    // Simulate an unmerged flash feature by rebuilding `tasks` without the
    // flash columns this build normally carries — host-checklist.js must
    // detect the absence via PRAGMA table_info rather than assume it. The
    // original shape (with every column this suite's other tests rely on)
    // is restored in `finally` so no later test sees the truncated table.
    const fullTasksSql = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
      .get().sql;

    db.pragma('foreign_keys = OFF');
    try {
      db.exec('DROP TABLE tasks');
      db.exec(`
        CREATE TABLE tasks (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          title          TEXT    NOT NULL,
          description    TEXT    NOT NULL DEFAULT '',
          sort_order     INTEGER NOT NULL DEFAULT 0,
          worth          INTEGER NOT NULL DEFAULT 1,
          special_mode   TEXT    NOT NULL DEFAULT 'none',
          special_date   TEXT,
          special_bonus  INTEGER,
          created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
        )
      `);

      let threw = null;
      let res;
      try {
        res = await adminAgent.get('/admin');
      } catch (err) {
        threw = err;
      }
      expect(threw).toBeNull();
      expect(res.status).toBe(200);
      expect(res.text).not.toContain('flash task');
      expect(res.text).not.toContain('Flash task');
    } finally {
      db.exec('DROP TABLE tasks');
      db.exec(fullTasksSql);
      db.pragma('foreign_keys = ON');
    }
  });
});

describe('AC8: a signed-in guest cannot reach /admin', () => {
  test('GET /admin as a guest never renders the dashboard', async () => {
    resetTables();
    insertGuest('guest-not-admin', 'Just A Guest');
    const guestAgent = signInGuest(app, 'guest-not-admin');

    const res = await guestAgent.get('/admin');
    expect(res.status).not.toBe(200);
    expect(res.text || '').not.toContain('Your checklist');
  });
});
