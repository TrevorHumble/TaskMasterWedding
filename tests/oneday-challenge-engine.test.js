// tests/oneday-challenge-engine.test.js
// Issue #753 AC3-AC7: the one-day-only challenge engine — the seal rule
// (one owner, opens on the day itself), the submit gate that refuses a
// sealed task, the banked on-day bonus (paid once, kept across a later
// replace), takedown/restore moving both halves of the score together, and
// Completionist ignoring every challenge task.
//
// "Today" for submitPhoto's seal/bonus decision comes from
// src/services/event-days.js's eventLocalDateString(getEventConfig().timezone)
// — called with NO pinned instant, so it reads the real wall clock. Rather
// than depend on the actual test-run date landing inside the fixture's
// task dates, AC4/AC5's tests monkeypatch event-days.eventLocalDateString to
// a fixed '2026-08-07' for the duration of this file (restored in
// afterAll), the same monkeypatch-the-shared-module-object technique
// tests/submission-intake.test.js AC7 uses for scoring.recomputeAfterSubmissionChange
// — submissions.js calls `eventDays.eventLocalDateString(...)` as a property
// access at call time, so patching the property on the shared module object
// takes effect without re-requiring anything.
//
// REQUIRE ORDER: config / db / services are required only AFTER loadApp()
// sets DATA_DIR / DB_PATH env vars, matching tests/submission-intake.test.js.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { loadApp } = require('./helpers/testApp');

let db;
let config;
let tasksSvc;
let submissions;
let scoring;
let badges;
let photos;
let eventDaysSvc;
let uploadsDir;
let validJpeg;

const FIXED_TODAY = '2026-08-07';
const TOMORROW = '2026-08-08';
const YESTERDAY = '2026-08-06';

beforeAll(async () => {
  validJpeg = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 5, g: 5, b: 5 } },
  })
    .jpeg()
    .toBuffer();

  const loaded = loadApp();
  db = loaded.db;

  config = require('../config');
  tasksSvc = require('../src/services/tasks');
  submissions = require('../src/services/submissions');
  scoring = require('../src/services/scoring');
  badges = require('../src/services/badges');
  photos = require('../src/services/photos');
  eventDaysSvc = require('../src/services/event-days');
  uploadsDir = config.UPLOADS_DIR;
});

let seq = 0;
function insertGuest() {
  seq += 1;
  return db
    .prepare('INSERT INTO guests (token, name) VALUES (?, ?)')
    .run(`oneday-guest-${seq}-${crypto.randomUUID()}`, 'Oneday Guest').lastInsertRowid;
}

function insertTask({ worth = 1, specialDate = null, specialBonus = null, mode = null } = {}) {
  seq += 1;
  const specialMode = mode || (specialDate ? 'oneday' : 'none');
  return db
    .prepare(
      `INSERT INTO tasks (title, worth, special_mode, special_date, special_bonus)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(`Oneday Task ${seq}`, worth, specialMode, specialDate, specialBonus).lastInsertRowid;
}

function writeOriginal(filename) {
  const absPath = path.join(uploadsDir, filename);
  fs.writeFileSync(absPath, validJpeg);
  return { filename, path: absPath };
}

function getSubmission(guestId, taskId) {
  return db
    .prepare('SELECT * FROM submissions WHERE guest_id = ? AND task_id = ?')
    .get(guestId, taskId);
}

// ---------------------------------------------------------------------------
// AC3: the seal rule has one owner, and opens on the day itself.
// ---------------------------------------------------------------------------
describe('AC3: isSealed/sealedTaskWhere agree — tomorrow sealed, today and yesterday open', () => {
  it('the JS predicate: only the task dated tomorrow is sealed', () => {
    const tomorrow = { special_date: TOMORROW };
    const today = { special_date: FIXED_TODAY };
    const yesterday = { special_date: YESTERDAY };
    const ordinary = { special_date: null };

    expect(tasksSvc.isSealed(tomorrow, FIXED_TODAY)).toBe(true);
    expect(tasksSvc.isSealed(today, FIXED_TODAY)).toBe(false);
    expect(tasksSvc.isSealed(yesterday, FIXED_TODAY)).toBe(false);
    expect(tasksSvc.isSealed(ordinary, FIXED_TODAY)).toBe(false);
  });

  it('the SQL fragment returns the exact same three answers as the JS predicate, on a real query', () => {
    const tomorrowId = insertTask({ specialDate: TOMORROW, specialBonus: 1 });
    const todayId = insertTask({ specialDate: FIXED_TODAY, specialBonus: 1 });
    const yesterdayId = insertTask({ specialDate: YESTERDAY, specialBonus: 1 });
    const ordinaryId = insertTask();

    const sealedIds = db
      .prepare(`SELECT id FROM tasks WHERE ${tasksSvc.sealedTaskWhere('', FIXED_TODAY)}`)
      .all()
      .map((r) => r.id);

    expect(sealedIds).toContain(tomorrowId);
    expect(sealedIds).not.toContain(todayId);
    expect(sealedIds).not.toContain(yesterdayId);
    expect(sealedIds).not.toContain(ordinaryId);
  });

  it('sealedTaskWhere is parenthesized so NOT applies to the whole fragment, not just its first half (review fix)', () => {
    // Regression for the unparenthesized-fragment bug: `WHERE live AND NOT
    // <fragment>` used to parse as `NOT (special_date IS NOT NULL)` ANDed
    // with the SECOND half outside the NOT, matching zero rows no matter
    // what was seeded -- exactly the shape #754's guest task list exclusion
    // use will build.
    const tomorrowId = insertTask({ specialDate: TOMORROW, specialBonus: 1 });
    const todayId = insertTask({ specialDate: FIXED_TODAY, specialBonus: 1 });
    const yesterdayId = insertTask({ specialDate: YESTERDAY, specialBonus: 1 });
    const ordinaryId = insertTask();

    const unsealedIds = db
      .prepare(
        `SELECT id FROM tasks WHERE ${tasksSvc.liveTaskWhere('')} AND NOT ${tasksSvc.sealedTaskWhere('', FIXED_TODAY)}`
      )
      .all()
      .map((r) => r.id);

    expect(unsealedIds).not.toContain(tomorrowId);
    expect(unsealedIds).toContain(todayId);
    expect(unsealedIds).toContain(yesterdayId);
    expect(unsealedIds).toContain(ordinaryId);
  });

  it('sealedTaskWhere refuses a malformed todayIso rather than building bad SQL', () => {
    expect(() => tasksSvc.sealedTaskWhere('t', '08/07/2026')).toThrow();
    expect(() => tasksSvc.sealedTaskWhere('t', undefined)).toThrow();
  });

  it('isSealed fails the same way sealedTaskWhere does on a malformed todayIso, instead of silently reading false (review fix)', () => {
    const tomorrow = { special_date: TOMORROW };
    expect(() => tasksSvc.isSealed(tomorrow, '08/07/2026')).toThrow();
    expect(() => tasksSvc.isSealed(tomorrow, undefined)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// MINOR 7 (review fix): isChallenge/challengeTaskWhere, the shared "is this
// task a one-day-only challenge" owner #754/#756 both need.
// ---------------------------------------------------------------------------
describe('isChallenge/challengeTaskWhere agree, and badges.js now consumes the SQL one', () => {
  it('the JS predicate: true only for a task carrying a special_date', () => {
    expect(tasksSvc.isChallenge({ special_date: FIXED_TODAY })).toBe(true);
    expect(tasksSvc.isChallenge({ special_date: null })).toBe(false);
    expect(tasksSvc.isChallenge({})).toBe(false);
  });

  it('the SQL fragment agrees with the JS predicate on a real query', () => {
    const challengeId = insertTask({ specialDate: FIXED_TODAY, specialBonus: 1 });
    const ordinaryId = insertTask();

    const challengeIds = db
      .prepare(`SELECT id FROM tasks WHERE ${tasksSvc.challengeTaskWhere('')}`)
      .all()
      .map((r) => r.id);

    expect(challengeIds).toContain(challengeId);
    expect(challengeIds).not.toContain(ordinaryId);
  });
});

// ---------------------------------------------------------------------------
// AC4-AC6: submitPhoto's gate and the banked bonus. "Today" is pinned to
// FIXED_TODAY for this whole block via the monkeypatch described at the top
// of this file.
// ---------------------------------------------------------------------------
describe('AC4-AC6: sealed submit refusal, banked on-day bonus, replace, takedown/restore', () => {
  let originalEventLocalDateString;

  beforeAll(() => {
    originalEventLocalDateString = eventDaysSvc.eventLocalDateString;
    eventDaysSvc.eventLocalDateString = () => FIXED_TODAY;
  });

  afterAll(() => {
    eventDaysSvc.eventLocalDateString = originalEventLocalDateString;
  });

  it('AC4: a task dated tomorrow refuses a submit — task_inactive, no row, original file cleaned up', async () => {
    const guestId = insertGuest();
    const taskId = insertTask({ worth: 2, specialDate: TOMORROW, specialBonus: 2 });
    const file = writeOriginal(`ac4-${crypto.randomUUID()}.jpg`);

    const result = await submissions.submitPhoto({ guestId, taskId, file, caption: '' });

    expect(result.status).toBe('task_inactive');
    expect(getSubmission(guestId, taskId)).toBeUndefined();
    expect(fs.existsSync(file.path)).toBe(false);
  });

  it('AC5: on-day submit pays worth + bonus, bonus_amount is banked with reason "oneday"', async () => {
    const guestId = insertGuest();
    const taskId = insertTask({ worth: 2, specialDate: FIXED_TODAY, specialBonus: 3 });
    const file = writeOriginal(`ac5-onday-${crypto.randomUUID()}.jpg`);

    const result = await submissions.submitPhoto({ guestId, taskId, file, caption: '' });

    expect(result.status).toBe('created');
    expect(scoring.getPoints(guestId)).toBe(5); // worth 2 + bonus 3

    const row = getSubmission(guestId, taskId);
    expect(row.bonus_amount).toBe(3);
    expect(row.bonus_reason).toBe('oneday');
  });

  it('AC5: off-day submit (task dated yesterday, still live/unsealed) pays worth only, bonus_amount 0', async () => {
    const guestId = insertGuest();
    const taskId = insertTask({ worth: 2, specialDate: YESTERDAY, specialBonus: 3 });
    const file = writeOriginal(`ac5-offday-${crypto.randomUUID()}.jpg`);

    const result = await submissions.submitPhoto({ guestId, taskId, file, caption: '' });

    expect(result.status).toBe('created');
    expect(scoring.getPoints(guestId)).toBe(2); // worth only, no bonus

    const row = getSubmission(guestId, taskId);
    expect(row.bonus_amount).toBe(0);
    expect(row.bonus_reason).toBeNull();
  });

  it('AC5: replacing the on-day photo the next day keeps the banked bonus (does not overwrite or zero it)', async () => {
    const guestId = insertGuest();
    const taskId = insertTask({ worth: 2, specialDate: FIXED_TODAY, specialBonus: 3 });

    const first = writeOriginal(`ac5-replace-first-${crypto.randomUUID()}.jpg`);
    const created = await submissions.submitPhoto({ guestId, taskId, file: first, caption: '' });
    expect(created.status).toBe('created');
    expect(scoring.getPoints(guestId)).toBe(5);

    // "The next day": today moves past the task's special_date, but the row
    // must keep its already-banked bonus rather than losing it.
    eventDaysSvc.eventLocalDateString = () => TOMORROW;
    try {
      const second = writeOriginal(`ac5-replace-second-${crypto.randomUUID()}.jpg`);
      const replaced = await submissions.submitPhoto({
        guestId,
        taskId,
        file: second,
        caption: '',
      });
      expect(replaced.status).toBe('replaced');
      expect(scoring.getPoints(guestId)).toBe(5); // unchanged — still worth + banked bonus

      const row = getSubmission(guestId, taskId);
      expect(row.bonus_amount).toBe(3);
      expect(row.bonus_reason).toBe('oneday');
      expect(row.photo_path).toBe(second.filename); // the new photo really did replace the old
    } finally {
      eventDaysSvc.eventLocalDateString = () => FIXED_TODAY;
    }
  });

  it('AC6: takedown removes BOTH worth and bonus from getPoints() and the leaderboard row; restore returns both', async () => {
    const guestId = insertGuest();
    const taskId = insertTask({ worth: 2, specialDate: FIXED_TODAY, specialBonus: 3 });
    const file = writeOriginal(`ac6-${crypto.randomUUID()}.jpg`);

    await submissions.submitPhoto({ guestId, taskId, file, caption: '' });
    expect(scoring.getPoints(guestId)).toBe(5);
    const leaderboardRow = () => scoring.leaderboard().find((r) => r.id === guestId);
    expect(leaderboardRow().points).toBe(5);

    const subId = getSubmission(guestId, taskId).id;
    photos.hideSubmission(subId);
    expect(scoring.getPoints(guestId)).toBe(0);
    expect(leaderboardRow().points).toBe(0);

    photos.restoreSubmission(subId);
    expect(scoring.getPoints(guestId)).toBe(5);
    expect(leaderboardRow().points).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Review fix (MAJOR 1): tasks.special_date/special_bonus pairing. A half-set
// challenge (special_date set, special_bonus NULL) used to crash every
// submit on that task with SQLITE_CONSTRAINT_NOTNULL, and on a replace could
// leave the new photo committed while the guest was told the save failed.
// ---------------------------------------------------------------------------
describe('special_date/special_bonus pairing (schema CHECK + write-site coalesce)', () => {
  let originalEventLocalDateString;

  beforeAll(() => {
    // submitPhoto's isOnDay/isSealed decisions read "today" from event-days
    // -- pin it the same way the AC4-AC6 block above does, so this block
    // does not depend on the real wall-clock date landing on FIXED_TODAY.
    originalEventLocalDateString = eventDaysSvc.eventLocalDateString;
    eventDaysSvc.eventLocalDateString = () => FIXED_TODAY;
  });

  afterAll(() => {
    eventDaysSvc.eventLocalDateString = originalEventLocalDateString;
  });

  it('the schema rejects a half-populated insert: special_date set, special_bonus left NULL', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO tasks (title, worth, special_mode, special_date, special_bonus)
           VALUES (?, ?, 'oneday', ?, NULL)`
        )
        .run('Half-set challenge', 2, FIXED_TODAY)
    ).toThrow(/CHECK/i);
  });

  it('the schema equally rejects the mirror-image half-populated insert: special_bonus set, special_date left NULL', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO tasks (title, worth, special_mode, special_date, special_bonus)
           VALUES (?, ?, 'none', NULL, ?)`
        )
        .run('Bonus with no date', 2, 3)
    ).toThrow(/CHECK/i);
  });

  it('a replace on a task whose special_bonus is NULL despite carrying a special_date (a legacy/hand-edited row the CHECK cannot retroactively fix) does not crash submitPhoto, and does not leave a half-applied state', async () => {
    const guestId = insertGuest();

    // Simulate a row that predates chk_special_pairing (or was hand-edited
    // straight in the DB file) -- ignore_check_constraints is the only way
    // SQLite allows constructing this shape at all now that the CHECK is in
    // place, exactly proving the write-site coalesce is real defense, not
    // dead code guarding an unreachable input.
    db.pragma('ignore_check_constraints = ON');
    let taskId;
    try {
      taskId = db
        .prepare(
          `INSERT INTO tasks (title, worth, special_mode, special_date, special_bonus)
           VALUES (?, ?, 'oneday', ?, NULL)`
        )
        .run('Legacy half-set challenge', 2, FIXED_TODAY).lastInsertRowid;
    } finally {
      db.pragma('ignore_check_constraints = OFF');
    }

    // An existing submission already on this row (as if banked before the
    // row went bad), so the call below exercises the REPLACE branch, not
    // insert -- the branch the finding calls out as the worse failure mode
    // (photo already swapped when the throw used to happen).
    const originalFile = writeOriginal(`pairing-original-${crypto.randomUUID()}.jpg`);
    db.prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, bonus_amount, bonus_reason)
       VALUES (?, ?, ?, ?, 0, 0, NULL)`
    ).run(guestId, taskId, originalFile.filename, originalFile.filename + '.jpg');

    const newFile = writeOriginal(`pairing-replace-${crypto.randomUUID()}.jpg`);
    const result = await submissions.submitPhoto({
      guestId,
      taskId,
      file: newFile,
      caption: '',
    });

    expect(result.status).toBe('replaced');

    const row = getSubmission(guestId, taskId);
    // Not half-applied: the photo really did swap...
    expect(row.photo_path).toBe(newFile.filename);
    // ...AND the coalesced bonus write landed consistently rather than the
    // photo swap committing while the bank write threw and rolled back only
    // itself -- both halves of the same atomic write agree.
    expect(row.bonus_amount).toBe(0);
    // Review fix: a coalesced-to-0 bonus must not carry a 'oneday' reason --
    // #649/#650 read bonus_reason by literal, and a reason with no amount
    // behind it would tell them a rule paid out when nothing was banked.
    expect(row.bonus_reason).toBeNull();
    expect(scoring.getPoints(guestId)).toBe(2); // worth only; coalesced bonus is 0, not a crash
  });
});

// ---------------------------------------------------------------------------
// AC7: Completionist ignores every challenge task.
// ---------------------------------------------------------------------------
describe('AC7: Completionist excludes tasks carrying a special_date', () => {
  function hideEveryTask() {
    db.prepare("UPDATE tasks SET special_mode = 'hidden'").run();
  }

  it('creating a one-day-only challenge does not strip Completionist from a guest who already covers every ordinary task', () => {
    hideEveryTask();

    const guestId = insertGuest();
    const ordinaryTaskId = insertTask();
    db.prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, 0)`
    ).run(guestId, ordinaryTaskId, `ac7-${seq}.jpg`, `ac7-${seq}.jpg.jpg`);

    // Guest covers every currently-live, non-challenge task -> qualifies.
    expect(badges.METRIC_BADGES.COMPLETIONIST(guestId)).toBe(true);

    // A host creates tomorrow's challenge — live (special_mode = 'oneday' is
    // not 'hidden'), but the guest has no submission for it and never will
    // until it opens.
    insertTask({ specialDate: TOMORROW, specialBonus: 1 });

    expect(badges.METRIC_BADGES.COMPLETIONIST(guestId)).toBe(true);
  });

  it('a guest who has NOT completed the challenge is never blocked from Completionist by it', () => {
    hideEveryTask();

    const guestId = insertGuest();
    const ordinaryTaskId = insertTask();
    insertTask({ specialDate: FIXED_TODAY, specialBonus: 1 }); // today's challenge, uncompleted

    db.prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, 0)`
    ).run(guestId, ordinaryTaskId, `ac7b-${seq}.jpg`, `ac7b-${seq}.jpg.jpg`);

    expect(badges.METRIC_BADGES.COMPLETIONIST(guestId)).toBe(true);
  });
});
