// tests/flash-guest-surface.test.js
// Issue #762 criteria 1-3, 7-8: the flash GUEST surface -- only an open
// window shows a marker (AC1), one marker per row even when a task is both
// dated today AND flash-active, with the price tag paying what
// bonusForTask() actually banks (AC2), the marker matches the approved
// pixels -- literal classes, bolt/copy/clock, struck price tag, a bounded
// server-side --flash-left (AC3), the flashed row's stack position (AC7),
// and no phase-1 scaffold ships in any of the four touched files (AC8).
//
// Mirrors tests/oneday-guest-surface.test.js's structure and its
// monkeypatch-eventDays.eventLocalDateString technique for pinning
// "today" -- criterion 2's tie-break needs a task dated exactly today.
//
// UNLIKE tests/flash-engine.test.js's submitPhoto tests, GET /tasks
// (src/routes/guest.js) builds its own clock as `{ todayIso, nowMs: Date.now()
// }` with no injectable nowMs seam -- there is nothing in this route's
// Touches for #762 to inject one into (the issue explicitly scopes "any
// write path" and any new seam out -- see "Deliberately not in scope").
// Every flash-window fixture below is therefore anchored to the REAL wall
// clock (`Date.now() - N minutes`, `Date.now() + N minutes`) with generous
// margins, the same discipline tests/flash-engine.test.js's "no clock arg"
// test already established for production's own call shape.
//
// REQUIRE ORDER: config / db / app are required only AFTER loadApp() sets
// DATA_DIR / DB_PATH env vars.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadApp, signInGuest } = require('./helpers/testApp');

let app;
let db;
let eventDaysSvc;
let tasksSvc;

const FIXED_TODAY = '2026-08-07';
const TOMORROW = '2026-08-08';

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;

  eventDaysSvc = require('../src/services/event-days');
  tasksSvc = require('../src/services/tasks');
});

let originalEventLocalDateString;
beforeAll(() => {
  // Shared-module-object monkeypatch (see tests/oneday-guest-surface.test.js's
  // own header comment for why this technique, not a mock): guest.js holds a
  // reference to this same module object, so patching the property here
  // takes effect for every route under test without re-requiring anything.
  originalEventLocalDateString = eventDaysSvc.eventLocalDateString;
  eventDaysSvc.eventLocalDateString = () => FIXED_TODAY;
});
afterAll(() => {
  eventDaysSvc.eventLocalDateString = originalEventLocalDateString;
});

function resetTables() {
  db.prepare('DELETE FROM submissions').run();
  db.prepare('DELETE FROM tasks').run();
  db.prepare('DELETE FROM guests').run();
}

let seq = 0;
function insertGuest({ avatarSet = true } = {}) {
  seq += 1;
  const token = `flash-guest-surface-${seq}-${crypto.randomUUID()}`;
  const avatarPath = avatarSet ? 'avatar.jpg' : null;
  const id = db
    .prepare('INSERT INTO guests (token, name, avatar_path) VALUES (?, ?, ?)')
    .run(token, 'Flash Surface Guest', avatarPath).lastInsertRowid;
  return { id, token };
}

function insertTask({
  title,
  worth = 1,
  specialDate = null,
  specialBonus = null,
  flashStartAt = null,
  flashMinutes = null,
  flashBonus = null,
  sortOrder = 1,
} = {}) {
  seq += 1;
  const mode = specialDate ? 'oneday' : 'none';
  return db
    .prepare(
      `INSERT INTO tasks
         (title, worth, special_mode, special_date, special_bonus,
          flash_start_at, flash_minutes, flash_bonus, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      title || `Flash Surface Task ${seq}`,
      worth,
      mode,
      specialDate,
      specialBonus,
      flashStartAt,
      flashMinutes,
      flashBonus,
      sortOrder
    ).lastInsertRowid;
}

function signedInAgent(token) {
  return signInGuest(app, token);
}

function isolateRow(text, needle) {
  const idx = text.indexOf(needle);
  expect(idx).toBeGreaterThan(-1);
  const rowStart = text.lastIndexOf('<li class="task-row', idx);
  expect(rowStart).toBeGreaterThan(-1);
  return { idx, row: text.slice(rowStart, text.indexOf('</li>', rowStart)) };
}

// ---------------------------------------------------------------------------
// Criterion 1: only an open window shows.
// ---------------------------------------------------------------------------
describe('criterion 1: only an active flash carries a marker; a scheduled one is indistinguishable from ordinary', () => {
  test('active flash renders the marker; scheduled flash renders no start/end/bonus anywhere in the markup', async () => {
    resetTables();
    const guest = insertGuest();
    const activeStart = new Date(Date.now() - 2 * 60000).toISOString(); // started 2 min ago
    const scheduledStart = new Date(Date.now() + 15 * 60000).toISOString(); // starts in 15 min
    insertTask({
      title: 'Active Flash Task',
      flashStartAt: activeStart,
      flashMinutes: 10,
      flashBonus: 2,
      sortOrder: 1,
    });
    insertTask({
      title: 'Scheduled Flash Task',
      flashStartAt: scheduledStart,
      flashMinutes: 10,
      flashBonus: 3,
      sortOrder: 2,
    });
    insertTask({ title: 'Ordinary Task', sortOrder: 3 });

    const agent = await signedInAgent(guest.token);
    const res = await agent.get('/tasks');
    expect(res.status).toBe(200);

    const active = isolateRow(res.text, 'Active Flash Task');
    expect(active.row).toContain('task-flash-flag');
    expect(active.row).toContain('task-flash task-flash-drain');
    expect(active.row).toContain('+2 pts right now');

    const scheduled = isolateRow(res.text, 'Scheduled Flash Task');
    expect(scheduled.row).not.toContain('task-flash');
    expect(scheduled.row).not.toContain('data-ends-at');
    expect(scheduled.row).not.toContain('data-total-ms');
    expect(scheduled.row).not.toContain('+3 pts right now');
    // Ordinary price tag only -- no struck-through base, no raised total.
    expect(scheduled.row).not.toContain('task-points-was');
    expect(scheduled.row).toContain('+1 pt');

    // The scheduled task's own start instant is not present ANYWHERE on the
    // page -- not just absent from its own row.
    expect(res.text).not.toContain(scheduledStart);
  });
});

// ---------------------------------------------------------------------------
// Criterion 2: one marker per row, and it is the one that will actually pay.
// ---------------------------------------------------------------------------
describe('criterion 2: a task both dated today and flash-active renders exactly one marker -- the daily one', () => {
  test('the Today Only flag wins the tie, the flash pill is suppressed, and the price tag pays the daily bonus only', async () => {
    resetTables();
    const guest = insertGuest();
    const activeStart = new Date(Date.now() - 60000).toISOString(); // active right now
    insertTask({
      title: 'Both Special Task',
      worth: 1,
      specialDate: FIXED_TODAY,
      specialBonus: 2,
      flashStartAt: activeStart,
      flashMinutes: 10,
      flashBonus: 3,
      sortOrder: 1,
    });

    const agent = await signedInAgent(guest.token);
    const res = await agent.get('/tasks');
    expect(res.status).toBe(200);

    const { row } = isolateRow(res.text, 'Both Special Task');

    // Exactly one marker: Today Only, not flash.
    expect(row).toContain('task-today-flag');
    expect(row).toContain('+2 pts Today Only');
    expect(row).not.toContain('task-flash-flag');
    expect(row).not.toContain('task-flash-bolt');
    expect(row).not.toContain('+3 pts right now');

    // The price tag pays what bonusForTask() actually banks: worth 1 +
    // daily's special_bonus 2 = 3 -- never worth + flash's bonus (1 + 3 = 4).
    expect(row).toContain('task-points-was');
    expect(row).toContain('>+1<');
    expect(row).toContain('+3 pts');
    expect(row).not.toContain('+4 pts');
  });
});

// ---------------------------------------------------------------------------
// Review fix (MAJOR, design-philosophy gate): flashActive/flashBonus must be
// read from tasks.bonusForTask() -- the declared single owner of "is
// anything paying, and if so what" -- not hand-composed in guest.js from
// whatSpecial()+flashState(). This test pins the NEW behaviour, not just the
// old outcome: it proves the route actually consults bonusForTask by making
// bonusForTask stop paying (simulating a future guard on the flash rule's
// `paying`, the exact failure scenario the review finding named) while
// flashState/whatSpecial alone would still say the window is active. A route
// that still hand-composed flashActive the pre-fix way would render the
// marker anyway; this test fails if that regression is reintroduced.
// ---------------------------------------------------------------------------
describe('review fix: flashActive/flashBonus are read from tasks.bonusForTask, not re-derived from whatSpecial+flashState', () => {
  let originalBonusForTask;

  afterEach(() => {
    if (originalBonusForTask) {
      tasksSvc.bonusForTask = originalBonusForTask;
      originalBonusForTask = null;
    }
  });

  test('when bonusForTask stops paying for a well-formed, presently-active flash row, the route renders no marker at all', async () => {
    resetTables();
    const guest = insertGuest();
    const activeStart = new Date(Date.now() - 60000).toISOString();
    insertTask({
      title: 'Bonus Gate Task',
      worth: 1,
      flashStartAt: activeStart,
      flashMinutes: 10,
      flashBonus: 2,
      sortOrder: 1,
    });

    // Sanity: flashState/whatSpecial alone WOULD say this row is active and
    // spoken for by 'flash' -- so a route that still hand-composed
    // flashActive from those two functions (the pre-fix shape) would render
    // the marker below regardless of what bonusForTask says.
    const taskRow = db.prepare('SELECT * FROM tasks WHERE title = ?').get('Bonus Gate Task');
    const nowMs = Date.now();
    expect(tasksSvc.flashState(taskRow, nowMs)).toBe('active');
    expect(tasksSvc.whatSpecial(taskRow, { todayIso: FIXED_TODAY, nowMs })).toBe(
      tasksSvc.SPECIAL_FLASH
    );

    // Simulate a future guard on the flash rule's `paying` (SPECIAL_RULES,
    // src/services/tasks.js) by making the single owner stop paying.
    originalBonusForTask = tasksSvc.bonusForTask;
    tasksSvc.bonusForTask = () => null;

    const agent = await signedInAgent(guest.token);
    const res = await agent.get('/tasks');
    expect(res.status).toBe(200);

    const { row } = isolateRow(res.text, 'Bonus Gate Task');
    expect(row).not.toContain('task-flash-flag');
    expect(row).not.toContain('task-flash');
    expect(row).not.toContain('+2 pts right now');
    // Falls back to the plain, unraised price tag -- the ordinary shape.
    expect(row).toContain('+1 pt');
    expect(row).not.toContain('task-points-was');
  });

  // Review fix, follow-up: the FIRST test above pins where flashActive comes
  // from, but nothing in it would fail if flashBonus were reverted from
  // bonusDecision.amount back to reading the flash_bonus column directly --
  // stubbing bonusForTask to return null makes flashBonus irrelevant (the
  // pill never renders either way). This test closes that gap: it stubs
  // bonusForTask to PAY a different amount than the column holds, so a
  // column-read flashBonus and a bonusDecision-read flashBonus diverge and
  // only one of them can make the assertions below pass.
  test('when bonusForTask pays an amount that differs from the flash_bonus column, the rendered pill and price tag follow bonusForTask, not the column', async () => {
    resetTables();
    const guest = insertGuest();
    const activeStart = new Date(Date.now() - 60000).toISOString();
    insertTask({
      title: 'Bonus Amount Task',
      worth: 1,
      flashStartAt: activeStart,
      flashMinutes: 10,
      flashBonus: 2, // the column -- deliberately NOT what bonusForTask will report below
      sortOrder: 1,
    });

    originalBonusForTask = tasksSvc.bonusForTask;
    tasksSvc.bonusForTask = () => ({ reason: tasksSvc.BONUS_REASON_FLASH, amount: 7 });

    const agent = await signedInAgent(guest.token);
    const res = await agent.get('/tasks');
    expect(res.status).toBe(200);

    const { row } = isolateRow(res.text, 'Bonus Amount Task');
    expect(row).toContain('task-flash-flag');
    expect(row).toContain('+7 pts right now'); // bonusDecision.amount, not the column's 2
    expect(row).not.toContain('+2 pts right now');
    expect(row).toContain('task-points-was');
    expect(row).toContain('>+1<');
    expect(row).toContain('+8 pts'); // worth 1 + bonusDecision.amount 7
    expect(row).not.toContain('+3 pts'); // worth 1 + the column's flash_bonus 2 -- must not appear
  });
});

// ---------------------------------------------------------------------------
// Criterion 3: the marker matches the approved pixels.
// ---------------------------------------------------------------------------
describe('criterion 3: the active marker carries the approved classes, copy, clock, price tag, and a bounded --flash-left', () => {
  test('task-flash task-flash-drain, bolt+copy+clock, struck price tag, and 0-100 --flash-left', async () => {
    resetTables();
    const guest = insertGuest();
    const startAt = new Date(Date.now() - 5 * 60000).toISOString(); // 5 min into a 30 min window
    insertTask({
      title: 'Flash Pixel Row',
      worth: 2,
      flashStartAt: startAt,
      flashMinutes: 30,
      flashBonus: 3,
      sortOrder: 1,
    });

    const agent = await signedInAgent(guest.token);
    const res = await agent.get('/tasks');
    expect(res.status).toBe(200);

    const { row } = isolateRow(res.text, 'Flash Pixel Row');

    // Literal classes -- both required (issue #762 criterion 3).
    expect(row).toContain('task-flash task-flash-drain');

    // Bolt glyph, copy, live clock.
    expect(row).toContain('task-flash-bolt');
    expect(row).toContain('+3 pts right now');
    expect(row).toMatch(/task-flash-clock">\d{1,2}:\d{2}(:\d{2})?</);

    // Price tag: struck-through base worth, then worth + flash_bonus.
    expect(row).toContain('task-points-was');
    expect(row).toContain('>+2<');
    expect(row).toContain('+5 pts');

    // A Today Only row's own gold treatment is untouched by this marker's
    // class -- this row carries no task-today-flag/task-today class at all.
    expect(row).not.toContain('task-today-flag');
    expect(row).not.toContain('task-today"');

    // --flash-left is set server-side on first paint: floored at 0, capped
    // at 100, no lower bound above 0 (a real fraction, not a placeholder).
    const flashLeftMatch = row.match(/--flash-left:\s*(\d+)%/);
    expect(flashLeftMatch).not.toBeNull();
    const pct = Number(flashLeftMatch[1]);
    expect(pct).toBeGreaterThanOrEqual(0);
    expect(pct).toBeLessThanOrEqual(100);
    // ~5 of 30 minutes elapsed -> roughly 83% left; loose bound avoids flake
    // from render-time drift.
    expect(pct).toBeGreaterThan(70);
    expect(pct).toBeLessThan(95);

    expect(row).toMatch(/data-ends-at="[^"]+"/);
    expect(row).toContain('data-total-ms="1800000"'); // 30 min in ms
  });
});

// ---------------------------------------------------------------------------
// Criterion 7: the flashed row sorts where the owner approved.
// ---------------------------------------------------------------------------
describe('criterion 7: stack order -- flash, then today, then locked, then the starter row, then ordinary tasks', () => {
  test('a rank function, not a boolean chain, places every special row in the approved order', async () => {
    resetTables();
    const guest = insertGuest({ avatarSet: false }); // starter row still to-do
    insertTask({ title: 'Ordinary Task', sortOrder: 10 });
    insertTask({ title: 'Locked Challenge', specialDate: TOMORROW, specialBonus: 1, sortOrder: 1 });
    insertTask({
      title: 'Today Challenge',
      specialDate: FIXED_TODAY,
      specialBonus: 2,
      sortOrder: 2,
    });
    const flashStart = new Date(Date.now() - 60000).toISOString();
    insertTask({
      title: 'Flash Task',
      flashStartAt: flashStart,
      flashMinutes: 10,
      flashBonus: 2,
      sortOrder: 3,
    });

    const agent = await signedInAgent(guest.token);
    const res = await agent.get('/tasks');
    expect(res.status).toBe(200);

    const flashIdx = res.text.indexOf('Flash Task');
    const todayIdx = res.text.indexOf('Today Challenge');
    const lockedIdx = res.text.indexOf('task-row task-todo task-locked');
    const starterIdx = res.text.indexOf('Upload your profile photo');
    const ordinaryIdx = res.text.indexOf('Ordinary Task');

    expect(flashIdx).toBeGreaterThan(-1);
    expect(todayIdx).toBeGreaterThan(-1);
    expect(lockedIdx).toBeGreaterThan(-1);
    expect(starterIdx).toBeGreaterThan(-1);
    expect(ordinaryIdx).toBeGreaterThan(-1);

    expect(flashIdx).toBeLessThan(todayIdx);
    expect(todayIdx).toBeLessThan(lockedIdx);
    expect(lockedIdx).toBeLessThan(starterIdx);
    expect(starterIdx).toBeLessThan(ordinaryIdx);
  });
});

// ---------------------------------------------------------------------------
// Criterion 8: no phase-1 scaffold ships.
// ---------------------------------------------------------------------------
describe('criterion 8: no phase-1 scaffold ships in any of the four touched files', () => {
  test('no scaffold marker, no faked row, no flashVariant local, no cache-buster, no stale rejected-treatment comment', () => {
    const touchedFiles = [
      'src/views/tasks.ejs',
      'src/views/partials/task-todo-row.ejs',
      'src/public/js/task-countdown.js',
      'src/public/css/theme.css',
    ];

    for (const relPath of touchedFiles) {
      const source = fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
      expect(source).not.toMatch(/PHASE-1 PREVIEW SCAFFOLD/);
      expect(source).not.toMatch(/flashVariant/);
      expect(source).not.toMatch(/\?v=<%=\s*Date\.now\(\)\s*%>/);
      expect(source).not.toMatch(/two variants/i);
      expect(source).not.toMatch(/ONLY\s+`?--place-1`?/);
      expect(source).not.toMatch(/switching back to --place-1 is a one-line change/);
    }
  });
});
