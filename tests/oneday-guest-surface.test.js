// tests/oneday-guest-surface.test.js
// Issue #754 AC1-AC6: the one-day-only GUEST surface — the mystery box gives
// up nothing (AC1), the one-box ceiling (AC2), the countdown target honors
// the event's configured timezone (AC3), a live-today challenge renders the
// approved gold flag/struck price and a past-day challenge falls back to an
// ordinary row (AC4), the detail/submit routes 404 a sealed task exactly like
// an inactive one (AC5), and the three guest-facing counts (/tasks chips,
// home progress bar, /how-to-play task count) all exclude a challenge the
// one-box ceiling suppresses (AC6).
//
// "Today" for every route under test comes from
// src/services/event-days.js's eventLocalDateString(getEventConfig().timezone)
// — monkeypatched to a fixed date for the duration of this file, the same
// shared-module-object technique tests/oneday-challenge-engine.test.js (#753)
// and tests/submission-intake.test.js already use, so these tests do not
// depend on the real wall-clock date landing on the fixture's task dates.
//
// REQUIRE ORDER: config / db / app / services are required only AFTER
// loadApp() sets DATA_DIR / DB_PATH env vars.
'use strict';

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadApp, signInGuest, suppressAnnouncementsForGuest } = require('./helpers/testApp');

let app;
let db;
let config;
let eventDaysSvc;
let dbModule;
let uploadsDir;
let validJpeg;

const FIXED_TODAY = '2026-08-07';
const TOMORROW = '2026-08-08';
const LATER = '2026-08-09';
const YESTERDAY = '2026-08-06';

beforeAll(async () => {
  validJpeg = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 9, g: 9, b: 9 } },
  })
    .jpeg()
    .toBuffer();

  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;

  config = require('../config');
  eventDaysSvc = require('../src/services/event-days');
  dbModule = require('../src/db');
  uploadsDir = config.UPLOADS_DIR;
});

let originalEventLocalDateString;
beforeAll(() => {
  // Shared-module-object monkeypatch (see file header): guest.js holds a
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
  const token = `oneday-guest-${seq}-${crypto.randomUUID()}`;
  const avatarPath = avatarSet ? 'avatar.jpg' : null;
  const id = db
    .prepare('INSERT INTO guests (token, name, avatar_path) VALUES (?, ?, ?)')
    .run(token, 'Oneday Guest', avatarPath).lastInsertRowid;
  return { id, token };
}

// Issue #778: a challenge dated FIXED_TODAY is exactly what the recap's
// unseal announcement source (src/services/notifications.js) fires on for
// any guest whose checkpoint predates that day's event-local start — which a
// freshly-inserted guest's checkpoint (their own created_at, at real-clock
// test-run time, itself well before the FIXED_TODAY fixture per this file's
// own header comment) always does. That is CORRECT #778 behavior, but it
// means the task's own title also appears once in the recap strip/panel,
// ahead of the real `<li class="task-row...` list this file's raw
// `indexOf`/`lastIndexOf` scoping assumes is the ONLY place a title can
// appear. The two tests below whose fixture task is dated FIXED_TODAY call
// tests/helpers/testApp.js's suppressAnnouncementsForGuest right after
// insertGuest() to advance the checkpoint safely past both FIXED_TODAY's
// event-local day-start AND real Date.now(), so the recap has nothing new to
// announce and this file's row-isolation stays scoped to the task list
// alone, unrelated to what those two tests actually assert. (Shared with
// tests/flash-guest-surface.test.js, which hits the identical interaction —
// moved off a per-file copy in PR review.)

function insertTask({
  title,
  worth = 1,
  specialDate = null,
  specialBonus = null,
  sortOrder = 1,
} = {}) {
  seq += 1;
  const mode = specialDate ? 'oneday' : 'none';
  return db
    .prepare(
      `INSERT INTO tasks (title, worth, special_mode, special_date, special_bonus, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(title || `Task ${seq}`, worth, mode, specialDate, specialBonus, sortOrder).lastInsertRowid;
}

function signedInAgent(token) {
  return signInGuest(app, token);
}

function writeOriginal(filename) {
  const absPath = path.join(uploadsDir, filename);
  fs.writeFileSync(absPath, validJpeg);
  return absPath;
}

// ---------------------------------------------------------------------------
// AC1: the mystery box gives up nothing.
// ---------------------------------------------------------------------------
describe('AC1: a sealed challenge renders only lock/countdown/+? pts, no title/day/description/badge', () => {
  test('locked row markup and page-level guarantees', async () => {
    resetTables();
    const guest = insertGuest({ avatarSet: false }); // starter row still renders, to prove priority order
    const ordinaryId = insertTask({ title: 'Ordinary Task', sortOrder: 5 });
    const sealedId = insertTask({
      title: 'Sparkler Send-off Photo',
      specialDate: TOMORROW,
      specialBonus: 2,
      sortOrder: 1,
    });
    void ordinaryId;

    const agent = await signedInAgent(guest.token);
    const res = await agent.get('/tasks');
    expect(res.status).toBe(200);

    // Not the title anywhere on the page (the mystery-box secrecy guarantee).
    expect(res.text).not.toContain('Sparkler Send-off Photo');

    // Isolate the locked row.
    const start = res.text.indexOf('task-row task-todo task-locked');
    expect(start).toBeGreaterThan(-1);
    const row = res.text.slice(start, res.text.indexOf('</li>', start));

    expect(row).toContain('Unlocks in');
    expect(row).toContain('+? pts');
    expect(row).toContain('task-lock-icon');
    // No day label, no description, no earnable-badge line.
    expect(row).not.toContain('task-desc');
    expect(row).not.toContain('task-earnable-badge');
    expect(row).not.toContain('task-title-text');
    // Not a link — the detail page 404s until its day.
    expect(row).not.toMatch(/<a\b/);
    // Points sit in the same right-hand column class family as every other row.
    expect(row).toContain('task-points');

    // Sorts above the starter row and the ordinary task.
    const starterIdx = res.text.indexOf('Upload your profile photo');
    const ordinaryIdx = res.text.indexOf('Ordinary Task');
    expect(start).toBeLessThan(starterIdx === -1 ? Infinity : starterIdx);
    expect(start).toBeLessThan(ordinaryIdx);

    // The unlock instant IS present (the countdown needs it) — that is
    // "when", never "what", so its presence is not a failure.
    expect(row).toContain('data-unlock-at="');
    void sealedId;
  });
});

// ---------------------------------------------------------------------------
// AC2: one box, ever.
// ---------------------------------------------------------------------------
describe('AC2: exactly one locked row renders when two or more sealed challenges exist', () => {
  test('only the challenge unlocking soonest renders; the other is nowhere in the markup', async () => {
    resetTables();
    const guest = insertGuest();
    insertTask({
      title: 'Soonest Sealed Challenge',
      specialDate: TOMORROW,
      specialBonus: 1,
      sortOrder: 1,
    });
    insertTask({
      title: 'Later Sealed Challenge',
      specialDate: LATER,
      specialBonus: 1,
      sortOrder: 2,
    });

    const agent = await signedInAgent(guest.token);
    const res = await agent.get('/tasks');
    expect(res.status).toBe(200);

    const lockedMatches = res.text.match(/task-row task-todo task-locked/g) || [];
    expect(lockedMatches.length).toBe(1);
    // Neither title ever renders (mystery box), but the later challenge's
    // presence is proven absent via the single-locked-row count above and
    // the total-count assertion in AC6 below.
    expect(res.text).not.toContain('Soonest Sealed Challenge');
    expect(res.text).not.toContain('Later Sealed Challenge');
  });

  test('ties on the same special_date break by the host sort_order/id, same as the query order', async () => {
    resetTables();
    const guest = insertGuest();
    const laterSortId = insertTask({
      title: 'Tie B (later sort_order)',
      specialDate: TOMORROW,
      specialBonus: 1,
      sortOrder: 9,
    });
    const earlierSortId = insertTask({
      title: 'Tie A (earlier sort_order)',
      specialDate: TOMORROW,
      specialBonus: 1,
      sortOrder: 2,
    });

    // The comparator in src/routes/guest.js's suppressedChallengeIds (issue
    // #754 review fix — the total tie-break comparator) says the survivor on
    // a special_date tie is the earlier sort_order (Tie A) — but WHICH
    // challenge survives is not
    // observable through this HTTP surface: the mystery box gives up no title
    // for either tied challenge (AC1), so Tie A's locked row and Tie B's
    // locked row render byte-identical markup. This assertion only proves
    // exactly one locked row rendered (the one-box ceiling holds); the
    // tie-break itself rests entirely on the comparator, unverified by any
    // test at this level.
    const agent = await signedInAgent(guest.token);
    const res = await agent.get('/tasks');
    const lockedMatches = res.text.match(/task-row task-todo task-locked/g) || [];
    expect(lockedMatches.length).toBe(1);
    void laterSortId;
    void earlierSortId;
  });
});

// ---------------------------------------------------------------------------
// Issue #754 review fix: a regex-invalid special_date must never enter the
// one-box ceiling's sealed set. isSealed does a plain string comparison, and
// a malformed value like '2026-08-1' string-compares ABOVE a valid
// '2026-08-06' ('1' > '0' character-by-character) — without the
// isValidDateString guard on the ceiling, that garbage row would win the
// tie-break and suppress the one real sealed challenge, leaving the guest
// with no mystery box at all even though a real one-day-only challenge
// exists.
// ---------------------------------------------------------------------------
describe('issue #754 review fix: the one-box ceiling ignores a regex-invalid special_date', () => {
  test('a malformed special_date never suppresses a real sealed challenge', async () => {
    resetTables();
    const guest = insertGuest();
    // Invalid shape ('2026-08-1', not 'YYYY-MM-DD') — renders as an ORDINARY
    // row per isDatedChallenge's own guard (MINOR I), so it must never also
    // enter the ceiling's sealed set.
    db.prepare(
      `INSERT INTO tasks (title, worth, special_mode, special_date, special_bonus, sort_order)
       VALUES (?, ?, 'oneday', ?, ?, ?)`
    ).run('Malformed Date Task', 1, '2026-08-1', 1, 1);
    insertTask({
      title: 'Real Sealed Challenge',
      specialDate: TOMORROW,
      specialBonus: 1,
      sortOrder: 2,
    });

    const agent = await signedInAgent(guest.token);
    const res = await agent.get('/tasks');
    expect(res.status).toBe(200);

    // The real sealed challenge still renders its locked row — it must not
    // be suppressed by the malformed row winning the string-comparison
    // tie-break.
    const lockedMatches = res.text.match(/task-row task-todo task-locked/g) || [];
    expect(lockedMatches.length).toBe(1);
    expect(res.text).not.toContain('Real Sealed Challenge');
    // The malformed row falls back to an ordinary, non-secret row (its title
    // IS expected to show — it is not a real challenge).
    expect(res.text).toContain('Malformed Date Task');
  });
});

// ---------------------------------------------------------------------------
// AC3: the countdown target honors the event's configured timezone.
// ---------------------------------------------------------------------------
describe('AC3: data-unlock-at resolves to dayOpensAt() in the EVENT-configured timezone', () => {
  test('a non-UTC, non-default timezone produces the exact instant dayOpensAt computes for it', async () => {
    resetTables();
    const guest = insertGuest();
    insertTask({ title: 'Timezone Challenge', specialDate: TOMORROW, specialBonus: 1 });

    const originalConfig = dbModule.getEventConfig();
    dbModule.setEventConfig({
      timezone: 'Pacific/Auckland',
      startDate: originalConfig.startDate,
      endDate: originalConfig.endDate,
    });
    try {
      const agent = await signedInAgent(guest.token);
      const res = await agent.get('/tasks');
      expect(res.status).toBe(200);

      const match = res.text.match(/data-unlock-at="([^"]+)"/);
      expect(match).not.toBeNull();
      const expected = eventDaysSvc.dayOpensAt(TOMORROW, 'Pacific/Auckland').toISOString();
      expect(match[1]).toBe(expected);

      // Sanity: this must NOT equal the naive UTC-midnight instant, or the
      // test would pass even if guest.js silently ignored the configured
      // timezone.
      expect(match[1]).not.toBe(`${TOMORROW}T00:00:00.000Z`);
    } finally {
      dbModule.setEventConfig(originalConfig);
    }
  });

  // Issue #754 review fix, MINOR H: AC3 promises the countdown is correct on
  // load with JavaScript off — src/views/partials/task-todo-row.ejs computes
  // cdD/cdH/cdM/cdS server-side from `Date.now()` at render time, and nothing
  // before this asserted those rendered digits actually match the remaining
  // time to data-unlock-at.
  test('the rendered data-cd digits match the time remaining to data-unlock-at at render time', async () => {
    resetTables();
    const guest = insertGuest();
    insertTask({ title: 'Digits Challenge', specialDate: TOMORROW, specialBonus: 1 });

    const agent = await signedInAgent(guest.token);
    const beforeMs = Date.now();
    const res = await agent.get('/tasks');
    const afterMs = Date.now();
    expect(res.status).toBe(200);

    const unlockMatch = res.text.match(/data-unlock-at="([^"]+)"/);
    expect(unlockMatch).not.toBeNull();
    const unlockMs = new Date(unlockMatch[1]).getTime();

    // The partial computes msLeft from Date.now() at some instant between
    // beforeMs and afterMs — bound the acceptable digits by both endpoints
    // rather than pinning one exact instant, so this assertion is not flaky
    // against real wall-clock render time.
    function partsAt(nowMs) {
      const msLeft = Math.max(0, unlockMs - nowMs);
      return {
        d: Math.floor(msLeft / 86400000),
        h: Math.floor(msLeft / 3600000) % 24,
        m: Math.floor(msLeft / 60000) % 60,
        s: Math.floor(msLeft / 1000) % 60,
      };
    }
    const earliest = partsAt(afterMs); // less time left (later "now")
    const latest = partsAt(beforeMs); // more time left (earlier "now")

    function renderedDigit(part) {
      const m = res.text.match(new RegExp('data-cd="' + part + '">0*(\\d+)<'));
      expect(m).not.toBeNull();
      return Number(m[1]);
    }

    // TOMORROW is many hours out, so a request this fast cannot roll the day
    // digit; hours/minutes/seconds could straddle a boundary between
    // beforeMs/afterMs, so those accept either endpoint's value.
    expect(renderedDigit('d')).toBe(latest.d);
    expect([earliest.h, latest.h]).toContain(renderedDigit('h'));
    expect([earliest.m, latest.m]).toContain(renderedDigit('m'));
    expect([earliest.s, latest.s]).toContain(renderedDigit('s'));
  });
});

// ---------------------------------------------------------------------------
// AC4: live on its day; ordinary once the day has passed.
// ---------------------------------------------------------------------------
describe('AC4: a today-dated challenge renders the gold flag + struck price and outranks a sealed challenge; a past-dated one is ordinary', () => {
  test('worth 2 / bonus 3 today: gold flag, struck-through +2, total +5, sorts above a sealed challenge', async () => {
    resetTables();
    const guest = insertGuest();
    suppressAnnouncementsForGuest(db, guest.id);
    insertTask({ title: 'Sealed Tomorrow', specialDate: TOMORROW, specialBonus: 1, sortOrder: 1 });
    insertTask({
      title: 'Today Challenge',
      worth: 2,
      specialDate: FIXED_TODAY,
      specialBonus: 3,
      sortOrder: 2,
    });

    const agent = await signedInAgent(guest.token);
    const res = await agent.get('/tasks');
    expect(res.status).toBe(200);

    const todayIdx = res.text.indexOf('Today Challenge');
    expect(todayIdx).toBeGreaterThan(-1);
    const rowStart = res.text.lastIndexOf('<li class="task-row', todayIdx);
    const row = res.text.slice(rowStart, res.text.indexOf('</li>', rowStart));

    expect(row).toContain('task-today-flag');
    expect(row).toContain('+3 pts Today Only');
    expect(row).toContain('task-points-was');
    expect(row).toContain('>+2<'); // struck-through base worth
    expect(row).toContain('+5 pts'); // worth + bonus total

    // Sorts above the sealed (locked) row.
    const lockedIdx = res.text.indexOf('task-row task-todo task-locked');
    expect(lockedIdx).toBeGreaterThan(-1);
    expect(todayIdx).toBeLessThan(lockedIdx);
  });

  test('a challenge whose day has passed renders as an ordinary row: no flag, no struck price, no priority position', async () => {
    resetTables();
    const guest = insertGuest({ avatarSet: false }); // starter row present, to prove no priority placement
    const ordinaryId = insertTask({ title: 'Zzz Ordinary Task', worth: 1, sortOrder: 999 });
    insertTask({
      title: 'Passed Challenge',
      worth: 2,
      specialDate: YESTERDAY,
      specialBonus: 3,
      sortOrder: 1,
    });
    void ordinaryId;

    const agent = await signedInAgent(guest.token);
    const res = await agent.get('/tasks');
    expect(res.status).toBe(200);

    const passedIdx = res.text.indexOf('Passed Challenge');
    expect(passedIdx).toBeGreaterThan(-1);
    const rowStart = res.text.lastIndexOf('<li class="task-row', passedIdx);
    const row = res.text.slice(rowStart, res.text.indexOf('</li>', rowStart));

    expect(row).not.toContain('task-today-flag');
    expect(row).not.toContain('task-points-was');
    expect(row).toContain('+2 pts'); // base worth only, no bonus

    // Takes no priority position: it renders in host sort_order among the
    // ordinary tasks, i.e. AFTER the lower-sort_order ordinary task even
    // though sort_order alone would put it first — because tasks.ejs's
    // specialRank() (issue #762 review fix -- the single owner of both
    // membership and order, replacing the old onedayPriority/specialPriority
    // flag) ranks it at the shared ORDINARY_RANK floor, it lands in
    // ordinaryTodo, sorted after priorityTodo/starter. Concretely: it must
    // not appear before the starter row (this guest has no avatar, so the
    // starter row renders first).
    const starterIdx = res.text.indexOf('Upload your profile photo');
    expect(starterIdx).toBeGreaterThan(-1);
    expect(starterIdx).toBeLessThan(passedIdx);
  });

  test('a challenge dated today with a NULL special_bonus (legacy row) renders as an ordinary row, never "+null"/"+NaN"', async () => {
    resetTables();
    const guest = insertGuest();
    suppressAnnouncementsForGuest(db, guest.id);
    // chk_special_pairing blocks a normal INSERT of this shape; simulate the
    // documented legacy row the same way tests/oneday-challenge-engine.test.js
    // does (issue #753 review fix background).
    db.pragma('ignore_check_constraints = ON');
    let taskId;
    try {
      taskId = db
        .prepare(
          `INSERT INTO tasks (title, worth, special_mode, special_date, special_bonus, sort_order)
           VALUES (?, ?, 'oneday', ?, NULL, 1)`
        )
        .run('Legacy No-Bonus Challenge', 2, FIXED_TODAY).lastInsertRowid;
    } finally {
      db.pragma('ignore_check_constraints = OFF');
    }

    const agent = await signedInAgent(guest.token);
    const res = await agent.get('/tasks');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('+null');
    expect(res.text).not.toContain('NaN');

    const idx = res.text.indexOf('Legacy No-Bonus Challenge');
    expect(idx).toBeGreaterThan(-1);
    const rowStart = res.text.lastIndexOf('<li class="task-row', idx);
    const row = res.text.slice(rowStart, res.text.indexOf('</li>', rowStart));
    expect(row).not.toContain('task-today-flag');
    expect(row).toContain('+2 pt'); // base worth only
    void taskId;
  });
});

// ---------------------------------------------------------------------------
// AC5: the lock is a real gate.
// ---------------------------------------------------------------------------
describe('AC5: GET /tasks/:id and POST /tasks/:id/submit both 404 a sealed task', () => {
  test('GET /tasks/:id for a sealed task 404s, exactly like an inactive one', async () => {
    resetTables();
    const guest = insertGuest();
    const sealedId = insertTask({
      title: 'Sealed Detail Target',
      specialDate: TOMORROW,
      specialBonus: 1,
    });

    const agent = await signedInAgent(guest.token);
    const res = await agent.get('/tasks/' + sealedId);
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('Sealed Detail Target');
  });

  test('POST /tasks/:id/submit for a sealed task 404s and stores no submission', async () => {
    resetTables();
    const guest = insertGuest();
    const sealedId = insertTask({
      title: 'Sealed Submit Target',
      specialDate: TOMORROW,
      specialBonus: 1,
    });

    const agent = await signedInAgent(guest.token);
    const filePath = writeOriginal(`sealed-submit-${crypto.randomUUID()}.jpg`);
    const res = await agent.post('/tasks/' + sealedId + '/submit').attach('photo', filePath);

    expect(res.status).toBe(404);
    const row = db
      .prepare('SELECT * FROM submissions WHERE guest_id = ? AND task_id = ?')
      .get(guest.id, sealedId);
    expect(row).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Issue #754 review fix: a guest who already holds a row for a NOW-sealed
// task (e.g. re-dated into the future after they completed it — #755's
// refusal rule is the primary guard against this, this is the
// defence-in-depth path) may still reach the detail page and replace their
// photo, in both the visible and taken-down-by-a-host shapes.
// ---------------------------------------------------------------------------
describe('issue #754 review fix: replace-on-a-sealed-task stays reachable for a guest who already has a row', () => {
  test('a guest with a VISIBLE submission on a sealed task can replace their photo', async () => {
    resetTables();
    const guest = insertGuest();
    const sealedId = insertTask({
      title: 'Sealed Replace Target',
      specialDate: TOMORROW,
      specialBonus: 1,
    });
    db.prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, 'old.jpg', 'old-thumb.jpg', 0)`
    ).run(guest.id, sealedId);

    const agent = await signedInAgent(guest.token);

    // The detail page is reachable (not 404) and offers the Replace form.
    const detailRes = await agent.get('/tasks/' + sealedId);
    expect(detailRes.status).toBe(200);
    expect(detailRes.text).toContain('Replace photo');

    // Replacing the photo does not 404 and does not delete the fresh upload
    // without writing it — the row's photo_path actually changes.
    const filePath = writeOriginal(`sealed-replace-${crypto.randomUUID()}.jpg`);
    const submitRes = await agent.post('/tasks/' + sealedId + '/submit').attach('photo', filePath);
    expect(submitRes.status).toBe(302);
    expect(submitRes.headers.location).toBe('/tasks/' + sealedId);

    const row = db
      .prepare('SELECT photo_path FROM submissions WHERE guest_id = ? AND task_id = ?')
      .get(guest.id, sealedId);
    expect(row.photo_path).not.toBe('old.jpg');
  });

  test('a guest whose photo was taken down on a now-sealed task still sees the #190 "with the hosts" page and can resubmit', async () => {
    resetTables();
    const guest = insertGuest();
    const sealedId = insertTask({
      title: 'Sealed Takedown Target',
      specialDate: TOMORROW,
      specialBonus: 1,
    });
    db.prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, 'old.jpg', 'old-thumb.jpg', 1)`
    ).run(guest.id, sealedId);

    const agent = await signedInAgent(guest.token);

    // Without this fall-through, hasVisibleSubmission is false (taken_down
    // !== 0) and the page 404s, losing the #190 state entirely.
    const detailRes = await agent.get('/tasks/' + sealedId);
    expect(detailRes.status).toBe(200);
    expect(detailRes.text).toContain('Your photo is with the hosts');

    const filePath = writeOriginal(`sealed-takedown-resubmit-${crypto.randomUUID()}.jpg`);
    const submitRes = await agent.post('/tasks/' + sealedId + '/submit').attach('photo', filePath);
    expect(submitRes.status).toBe(302);
    expect(submitRes.headers.location).toBe('/tasks/' + sealedId);
  });
});

// ---------------------------------------------------------------------------
// Issue #754 review fix (MAJOR A / hasSubmission fall-through, unpinned
// before this): a challenge the guest has already completed must be excluded
// from the one-box ceiling AND stay reachable, even though its special_date
// is still in the future. Every other AC2/AC5 test's submission lands on an
// ORDINARY task, so a regression dropping the `!t.done` exclusion in
// suppressedChallengeIds or the `!hasSubmission` fall-through in GET
// /tasks/:id left the whole suite green — these two tests fail if either
// clause is removed (verified by hand while writing them).
// ---------------------------------------------------------------------------
describe('issue #754 review fix: a completed sealed challenge stays reachable and out of the ceiling', () => {
  test('a submission against a still-sealed (future-dated) task renders on ?view=done, and its detail page is reachable', async () => {
    resetTables();
    const guest = insertGuest();
    const completedSealedId = insertTask({
      title: 'Completed Sealed Challenge',
      specialDate: TOMORROW,
      specialBonus: 2,
      sortOrder: 1,
    });
    db.prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, 'p.jpg', 't.jpg', 0)`
    ).run(guest.id, completedSealedId);

    const agent = await signedInAgent(guest.token);

    const doneRes = await agent.get('/tasks?view=done');
    expect(doneRes.status).toBe(200);
    expect(doneRes.text).toContain('Completed Sealed Challenge');

    const detailRes = await agent.get('/tasks/' + completedSealedId);
    expect(detailRes.status).toBe(200);
  });

  test('a second, still-incomplete sealed challenge still renders its own locked row alongside the completed one', async () => {
    resetTables();
    const guest = insertGuest();
    const completedSealedId = insertTask({
      title: 'Completed Sealed Challenge',
      specialDate: TOMORROW,
      specialBonus: 2,
      sortOrder: 1,
    });
    insertTask({
      title: 'Still Locked Sealed Challenge',
      specialDate: LATER,
      specialBonus: 1,
      sortOrder: 2,
    });
    db.prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, 'p.jpg', 't.jpg', 0)`
    ).run(guest.id, completedSealedId);

    const agent = await signedInAgent(guest.token);
    const res = await agent.get('/tasks');
    expect(res.status).toBe(200);

    // The completed challenge never occupies the one-box ceiling's single
    // slot (MAJOR A), so the still-incomplete sealed challenge renders its
    // own locked row rather than being suppressed by a completed challenge
    // that itself never shows as locked.
    const lockedMatches = res.text.match(/task-row task-todo task-locked/g) || [];
    expect(lockedMatches.length).toBe(1);
    expect(res.text).not.toContain('Completed Sealed Challenge');
    expect(res.text).not.toContain('Still Locked Sealed Challenge');
  });
});

// ---------------------------------------------------------------------------
// AC6: the three counts exclude a suppressed challenge.
// ---------------------------------------------------------------------------
describe('AC6: /tasks chips, home progress bar, and /how-to-play task count all exclude a suppressed sealed challenge', () => {
  test('a suppressed challenge is excluded everywhere; the surviving (rendered) locked row IS still counted', async () => {
    resetTables();
    const guest = insertGuest({ avatarSet: true }); // starter already done, keeps counts simple
    insertTask({ title: 'Ordinary A', sortOrder: 1 });
    insertTask({ title: 'Ordinary B', sortOrder: 2 });
    insertTask({ title: 'Soonest Sealed', specialDate: TOMORROW, specialBonus: 1, sortOrder: 3 });
    insertTask({
      title: 'Later Sealed (suppressed)',
      specialDate: LATER,
      specialBonus: 1,
      sortOrder: 4,
    });

    const agent = await signedInAgent(guest.token);

    // 2 ordinary + 1 rendered locked = 3 to-do; the starter (avatar already
    // set) is the guest's only done row -> 1 done, 4 total. The suppressed
    // challenge inflates none of these.
    const tasksRes = await agent.get('/tasks');
    expect(tasksRes.status).toBe(200);
    expect(tasksRes.text).toContain('To do · 3');
    expect(tasksRes.text).toContain('Done · 1');

    // Home progress bar: totalTasks = 3 live (post-ceiling) + the starter's
    // own 1 = 4, not 5 (which the suppressed challenge would add).
    const homeRes = await agent.get('/');
    expect(homeRes.status).toBe(200);
    expect(homeRes.text).toContain('1 of 4');

    // /how-to-play task count does NOT include the starter (issue #754
    // AC6: the three counts are not required to agree with each other) —
    // "3 photo tasks", never "4" (which the suppressed challenge would add).
    const howToRes = await agent.get('/how-to-play');
    expect(howToRes.status).toBe(200);
    expect(howToRes.text).toContain('3 photo tasks');
    expect(howToRes.text).not.toContain('4 photo tasks');
  });

  test('the "finished every task" state is still reachable when a suppressed challenge exists', async () => {
    resetTables();
    const guest = insertGuest({ avatarSet: true });
    const onlyTaskId = insertTask({ title: 'Only Reachable Task', sortOrder: 1 });
    insertTask({ title: 'Soonest Sealed', specialDate: TOMORROW, specialBonus: 1, sortOrder: 2 });
    insertTask({ title: 'Suppressed Sealed', specialDate: LATER, specialBonus: 1, sortOrder: 3 });

    db.prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, 'p.jpg', 't.jpg', 0)`
    ).run(guest.id, onlyTaskId);

    const agent = await signedInAgent(guest.token);
    const res = await agent.get('/tasks');
    expect(res.status).toBe(200);
    // Not "all done" — the rendered (soonest) locked row is still a real
    // to-do row the guest has not finished, so the all-done banner must NOT
    // show even though the one reachable ordinary task is complete.
    expect(res.text).not.toContain('You&rsquo;ve finished every task');
    expect(res.text).toContain('To do · 1');
    expect(res.text).toContain('Done · 2'); // the ordinary task + the starter (avatar set)
  });
});
