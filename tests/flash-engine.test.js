// tests/flash-engine.test.js
// Issue #761 criteria 2-7: the flash engine -- the window state rule
// (flashState, one owner, four states), the shape validator
// (isValidFlashInstant), the exclusivity guard (whatSpecial), the banked
// in-window bonus (submitPhoto), and the corrected MODES doc comment.
//
// Mirrors tests/oneday-challenge-engine.test.js's structure and its two-clock
// discipline (see that file's header comment): the FLASH clock is the nowMs
// seam submissions.submitPhoto now takes as an explicit, optional parameter
// -- injected directly, never mocked -- while the event-local DAY clock
// (todayIso) is not reachable through that seam and keeps the
// monkeypatch-eventDays.eventLocalDateString technique the one-day-only
// suite already uses. Criterion 4's on-day-wins tie-break needs BOTH clocks
// controlled at once: without the day monkeypatch, isOnDay is false on every
// real run date and the tie-break test would silently exercise the
// flash-only path instead of the thing it exists to prove.
//
// REQUIRE ORDER: config / db / services are required only AFTER loadApp()
// sets DATA_DIR / DB_PATH env vars, matching tests/submission-intake.test.js
// and tests/oneday-challenge-engine.test.js.
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
let photos;
let eventDaysSvc;
let uploadsDir;
let validJpeg;

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
  photos = require('../src/services/photos');
  eventDaysSvc = require('../src/services/event-days');
  uploadsDir = config.UPLOADS_DIR;
});

let seq = 0;
function insertGuest() {
  seq += 1;
  return db
    .prepare('INSERT INTO guests (token, name) VALUES (?, ?)')
    .run(`flash-guest-${seq}-${crypto.randomUUID()}`, 'Flash Guest').lastInsertRowid;
}

function insertTask({
  worth = 1,
  specialDate = null,
  specialBonus = null,
  mode = null,
  flashStartAt = null,
  flashMinutes = null,
  flashBonus = null,
} = {}) {
  seq += 1;
  const specialMode = mode || (specialDate ? 'oneday' : 'none');
  return db
    .prepare(
      `INSERT INTO tasks
         (title, worth, special_mode, special_date, special_bonus,
          flash_start_at, flash_minutes, flash_bonus)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      `Flash Task ${seq}`,
      worth,
      specialMode,
      specialDate,
      specialBonus,
      flashStartAt,
      flashMinutes,
      flashBonus
    ).lastInsertRowid;
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
// Criterion 2: flashState is the one owner of the window rule, with four
// states, and never throws on a malformed row.
// ---------------------------------------------------------------------------
describe('criterion 2: flashState -- one owner, four states, half-open window', () => {
  const START = '2026-08-07T18:00:00.000Z';
  const startMs = Date.parse(START);
  const minutes = 10;
  const endMs = startMs + minutes * 60000;
  const validRow = { flash_start_at: START, flash_minutes: minutes, flash_bonus: 2 };

  it('before start: scheduled', () => {
    expect(tasksSvc.flashState(validRow, startMs - 1)).toBe('scheduled');
  });

  it('exactly at start: active', () => {
    expect(tasksSvc.flashState(validRow, startMs)).toBe('active');
  });

  it('inside the window: active', () => {
    expect(tasksSvc.flashState(validRow, startMs + 5 * 60000)).toBe('active');
  });

  it('exactly at start + duration: expired -- the window is half-open [S, S+D)', () => {
    expect(tasksSvc.flashState(validRow, endMs)).toBe('expired');
  });

  it('after the window: expired', () => {
    expect(tasksSvc.flashState(validRow, endMs + 1)).toBe('expired');
  });

  it('every degenerate row answers "none", never throws, never "expired" from a NaN comparison', () => {
    const cases = [
      undefined,
      null,
      {},
      { flash_start_at: START }, // partially populated
      { flash_start_at: START, flash_minutes: minutes }, // partially populated
      { ...validRow, flash_minutes: 0 },
      { ...validRow, flash_minutes: -5 },
      { ...validRow, flash_minutes: 2.5 }, // fractional
      { ...validRow, flash_bonus: 0 },
      { ...validRow, flash_bonus: 4 },
      { ...validRow, flash_start_at: '2026-08-07T18:30:00-06:00' }, // valid ISO-8601, wrong (local-offset) shape
      { ...validRow, flash_start_at: '2026-02-31T00:00:00.000Z' }, // pinned shape, impossible date
    ];
    for (const row of cases) {
      expect(() => tasksSvc.flashState(row, startMs)).not.toThrow();
      expect(tasksSvc.flashState(row, startMs)).toBe('none');
    }
  });
});

// ---------------------------------------------------------------------------
// Review fix: flashState must validate its OWN clock parameter, not
// just the row -- an invalid nowMs is a caller bug, not a legitimate
// database shape, and must throw rather than silently misreading the window
// (an undefined/NaN nowMs used to make both comparisons false and read
// 'expired' for a genuinely active flash; a null nowMs coerced to 0 and read
// 'scheduled').
// ---------------------------------------------------------------------------
describe('flashState throws on a malformed nowMs instead of silently misreading the window', () => {
  const validRow = {
    flash_start_at: '2026-08-07T18:00:00.000Z',
    flash_minutes: 10,
    flash_bonus: 2,
  };

  it('throws on undefined nowMs', () => {
    expect(() => tasksSvc.flashState(validRow, undefined)).toThrow(/nowMs/);
  });

  it('throws on null nowMs', () => {
    expect(() => tasksSvc.flashState(validRow, null)).toThrow(/nowMs/);
  });

  it('throws on NaN nowMs', () => {
    expect(() => tasksSvc.flashState(validRow, NaN)).toThrow(/nowMs/);
  });

  it('does not throw on a real epoch-millisecond nowMs', () => {
    expect(() => tasksSvc.flashState(validRow, Date.now())).not.toThrow();
  });
});

describe('isValidFlashInstant: the pinned shape, exported for #763', () => {
  it('accepts the pinned YYYY-MM-DDTHH:MM:SS.sssZ form', () => {
    expect(tasksSvc.isValidFlashInstant('2026-08-07T18:00:00.000Z')).toBe(true);
  });

  it('rejects a local-offset instant, a date-only string, and a non-string', () => {
    expect(tasksSvc.isValidFlashInstant('2026-08-07T18:30:00-06:00')).toBe(false);
    expect(tasksSvc.isValidFlashInstant('2026-08-07')).toBe(false);
    expect(tasksSvc.isValidFlashInstant(null)).toBe(false);
    expect(tasksSvc.isValidFlashInstant(undefined)).toBe(false);
    expect(tasksSvc.isValidFlashInstant(1754589600000)).toBe(false);
  });

  it('rejects a pinned-shape string naming an impossible date (review fix -- the exported validator now checks the real date too, not just the shape)', () => {
    expect(tasksSvc.isValidFlashInstant('2026-02-31T00:00:00.000Z')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Criterion 3: whatSpecial is the one owner of task exclusivity.
// ---------------------------------------------------------------------------
describe('criterion 3: whatSpecial -- one owner of exclusivity, daily wins ties', () => {
  const TODAY = '2026-08-07';
  const TOMORROW = '2026-08-08';
  const YESTERDAY = '2026-08-06';
  const NOW_MS = Date.parse('2026-08-07T12:00:00.000Z');
  const clock = { todayIso: TODAY, nowMs: NOW_MS };

  it('a challenge dated tomorrow (sealed) is "daily"', () => {
    expect(tasksSvc.whatSpecial({ special_date: TOMORROW }, clock)).toBe('daily');
  });

  it('a challenge dated today (on-day) is "daily"', () => {
    expect(tasksSvc.whatSpecial({ special_date: TODAY }, clock)).toBe('daily');
  });

  it('a challenge dated yesterday (past, free again) is null', () => {
    expect(tasksSvc.whatSpecial({ special_date: YESTERDAY }, clock)).toBeNull();
  });

  it('a flash scheduled to start later today is "flash"', () => {
    const row = { flash_start_at: '2026-08-07T13:00:00.000Z', flash_minutes: 30, flash_bonus: 2 };
    expect(tasksSvc.whatSpecial(row, clock)).toBe('flash');
  });

  it('a flash presently active is "flash"', () => {
    const row = { flash_start_at: '2026-08-07T11:30:00.000Z', flash_minutes: 60, flash_bonus: 2 };
    expect(tasksSvc.whatSpecial(row, clock)).toBe('flash');
  });

  it('a flash whose window already expired (free again) is null', () => {
    const row = { flash_start_at: '2026-08-07T09:00:00.000Z', flash_minutes: 30, flash_bonus: 2 };
    expect(tasksSvc.whatSpecial(row, clock)).toBeNull();
  });

  it('a task somehow both on-day and in-window is "daily" -- matching submitPhoto\'s banking tie-break', () => {
    const row = {
      special_date: TODAY,
      flash_start_at: '2026-08-07T11:30:00.000Z',
      flash_minutes: 60,
      flash_bonus: 2,
    };
    expect(tasksSvc.whatSpecial(row, clock)).toBe('daily');
  });

  it('an ordinary task (neither) is null', () => {
    expect(tasksSvc.whatSpecial({}, clock)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Review fix: the paying-side decision (tasks.bonusForTask) is derived from
// the SAME SPECIAL_RULES list whatSpecial walks, and the two can never
// disagree -- including on the row shape that used to make them disagree
// before this fix (a task sealed for a FUTURE day with a simultaneously
// active flash window).
// ---------------------------------------------------------------------------
describe('bonusForTask -- the paying-side decision, never disagreeing with whatSpecial', () => {
  const TODAY = '2026-08-07';
  const TOMORROW = '2026-08-08';
  const NOW_MS = Date.parse('2026-08-07T12:00:00.000Z');
  const clock = { todayIso: TODAY, nowMs: NOW_MS };

  it('a challenge dated today (on-day): whatSpecial "daily", bonusForTask non-null too -- daily is both spoken-for AND paying', () => {
    const row = { special_date: TODAY };
    expect(tasksSvc.whatSpecial(row, clock)).toBe('daily');
    expect(tasksSvc.bonusForTask(row, clock)).not.toBeNull();
  });

  it('a flash presently active, no daily: whatSpecial "flash", bonusForTask banks the flash bonus too', () => {
    const row = { flash_start_at: '2026-08-07T11:30:00.000Z', flash_minutes: 60, flash_bonus: 2 };
    expect(tasksSvc.whatSpecial(row, clock)).toBe('flash');
    expect(tasksSvc.bonusForTask(row, clock)).toEqual({ amount: 2, reason: 'flash' });
  });

  it('a flash merely SCHEDULED (not yet started): whatSpecial "flash" (spoken for), bonusForTask null (not paying yet)', () => {
    const row = { flash_start_at: '2026-08-07T13:00:00.000Z', flash_minutes: 30, flash_bonus: 2 };
    expect(tasksSvc.whatSpecial(row, clock)).toBe('flash');
    expect(tasksSvc.bonusForTask(row, clock)).toBeNull();
  });

  it(
    'THE DIVERGENT CASE this fix closes: a challenge sealed for a FUTURE day, ' +
      'with a simultaneously active flash window -- whatSpecial says "daily" (sealed ' +
      'wins), and bonusForTask must agree by paying NOTHING (daily owns the row but is ' +
      'not on-day yet; flash is never even consulted), never the flash amount',
    () => {
      const row = {
        special_date: TOMORROW, // sealed, not on-day -- daily is spoken-for but not paying
        flash_start_at: '2026-08-07T11:30:00.000Z',
        flash_minutes: 60,
        flash_bonus: 2, // active right now
      };
      expect(tasksSvc.whatSpecial(row, clock)).toBe('daily');
      expect(tasksSvc.bonusForTask(row, clock)).toBeNull();
    }
  );

  it('a task somehow both on-day and in-window: whatSpecial "daily", bonusForTask banks daily\'s (zero) amount -- matching submitPhoto\'s tie-break, never the flash amount', () => {
    const row = {
      special_date: TODAY,
      flash_start_at: '2026-08-07T11:30:00.000Z',
      flash_minutes: 60,
      flash_bonus: 2,
    };
    expect(tasksSvc.whatSpecial(row, clock)).toBe('daily');
    // daily owns the row and pays $0 (no special_bonus set on this row) --
    // NOT flash's $2, which would surface as {amount: 2, reason: 'flash'} if
    // the walk incorrectly fell through past 'daily'.
    expect(tasksSvc.bonusForTask(row, clock)).toEqual({ amount: 0, reason: null });
  });

  it('an ordinary task (neither): whatSpecial null, bonusForTask null', () => {
    expect(tasksSvc.whatSpecial({}, clock)).toBeNull();
    expect(tasksSvc.bonusForTask({}, clock)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Review fix: bonusForTask is the single owner of "what does the
// presently-paying rule bank" -- the column it reads and the reason it
// returns, replacing submissions.js's hand-written kind-string switch.
// ---------------------------------------------------------------------------
describe('bonusForTask -- the banking descriptor for whichever rule is paying', () => {
  const TODAY = '2026-08-07';
  const NOW_MS = Date.parse('2026-08-07T12:00:00.000Z');
  const clock = { todayIso: TODAY, nowMs: NOW_MS };

  it('a paying daily rule returns {amount: special_bonus, reason: "oneday"}', () => {
    const row = { special_date: TODAY, special_bonus: 2 };
    expect(tasksSvc.bonusForTask(row, clock)).toEqual({ amount: 2, reason: 'oneday' });
  });

  it('a paying flash rule returns {amount: flash_bonus, reason: "flash"}', () => {
    const row = { flash_start_at: '2026-08-07T11:30:00.000Z', flash_minutes: 60, flash_bonus: 3 };
    expect(tasksSvc.bonusForTask(row, clock)).toEqual({ amount: 3, reason: 'flash' });
  });

  it('a legacy daily row with special_date set but special_bonus NULL coalesces amount to 0 and reason to null (issue #761 review fix -- no reason beside a zero amount)', () => {
    const row = { special_date: TODAY, special_bonus: null };
    expect(tasksSvc.bonusForTask(row, clock)).toEqual({ amount: 0, reason: null });
  });

  it('nothing paying (ordinary task) returns null', () => {
    expect(tasksSvc.bonusForTask({}, clock)).toBeNull();
  });

  it('spoken-for but not yet paying (flash merely scheduled) returns null', () => {
    const row = { flash_start_at: '2026-08-07T13:00:00.000Z', flash_minutes: 30, flash_bonus: 2 };
    expect(tasksSvc.bonusForTask(row, clock)).toBeNull();
  });

  it('the divergent case: sealed-future + active-flash returns null, never the flash amount', () => {
    const row = {
      special_date: '2026-08-08',
      flash_start_at: '2026-08-07T11:30:00.000Z',
      flash_minutes: 60,
      flash_bonus: 3,
    };
    expect(tasksSvc.bonusForTask(row, clock)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Review fix (all three reviewers): tasks.js is the single owner of the
// bonus_reason literals bonusForTask() writes; submissions.js re-exports the
// SAME constants rather than declaring an independent copy that could drift.
// This test is what makes that invariant enforced rather than asserted in
// prose -- it fails the moment the two modules' vocabularies disagree, e.g.
// if a future 'lucky' rule were added to SPECIAL_RULES without a matching
// export reaching submissions.js.
// ---------------------------------------------------------------------------
describe('review fix: the write-side reason and the exported constant agree', () => {
  const TODAY = '2026-08-07';
  const NOW_MS = Date.parse('2026-08-07T12:00:00.000Z');
  const clock = { todayIso: TODAY, nowMs: NOW_MS };

  it('an active flash row banks a reason equal to submissions.BONUS_REASON_FLASH', () => {
    const row = { flash_start_at: '2026-08-07T11:30:00.000Z', flash_minutes: 60, flash_bonus: 3 };
    expect(tasksSvc.bonusForTask(row, clock).reason).toBe(submissions.BONUS_REASON_FLASH);
  });

  it('an on-day daily row banks a reason equal to submissions.BONUS_REASON_ONEDAY', () => {
    const row = { special_date: TODAY, special_bonus: 2 };
    expect(tasksSvc.bonusForTask(row, clock).reason).toBe(submissions.BONUS_REASON_ONEDAY);
  });

  it('submissions.js re-exports the SAME string instances tasks.js declares, not independent copies', () => {
    expect(submissions.BONUS_REASON_ONEDAY).toBe(tasksSvc.BONUS_REASON_ONEDAY);
    expect(submissions.BONUS_REASON_FLASH).toBe(tasksSvc.BONUS_REASON_FLASH);
  });
});

// ---------------------------------------------------------------------------
// Review fix: findSpecialRule validates clock.nowMs BEFORE walking
// SPECIAL_RULES, not lazily inside flashState(). Before this fix, 'daily''s
// own spokenFor never touches clock.nowMs (only clock.todayIso), so an
// invalid nowMs only surfaced as a throw once the walk actually reached
// 'flash''s spokenFor -- meaning the SAME caller mistake (a clock object
// built with todayIso but no nowMs) silently passed for a sealed or
// on-day row (the walk stops at 'daily' and never reaches 'flash') while
// throwing for an ordinary or flash-armed row. #763's dropped-nowMs bug on
// a challenge-dated task would have passed its own test while 500ing the
// host's save on an ordinary task -- decided entirely by which row the
// caller happened to pass, never by whether the caller's clock was valid.
// ---------------------------------------------------------------------------
describe('findSpecialRule validates clock.nowMs before the walk, regardless of which rule the row would match', () => {
  const TODAY = '2026-08-07';
  const TOMORROW = '2026-08-08';
  const partialClock = { todayIso: TODAY }; // nowMs missing entirely

  const rows = [
    ['a sealed row (future special_date)', { special_date: TOMORROW }],
    ['an on-day row (special_date === today)', { special_date: TODAY }],
    ['an ordinary row (no special_date, no flash)', {}],
    [
      'a flash-armed row',
      { flash_start_at: '2026-08-07T11:30:00.000Z', flash_minutes: 60, flash_bonus: 2 },
    ],
  ];

  it.each(rows)('whatSpecial throws given a partial clock (no nowMs) for %s', (_label, row) => {
    expect(() => tasksSvc.whatSpecial(row, partialClock)).toThrow(/nowMs/);
  });

  it.each(rows)('bonusForTask throws given a partial clock (no nowMs) for %s', (_label, row) => {
    expect(() => tasksSvc.bonusForTask(row, partialClock)).toThrow(/nowMs/);
  });
});

// ---------------------------------------------------------------------------
// Criterion 6: the stale MODES doc comment is corrected.
// ---------------------------------------------------------------------------
describe('criterion 6: the stale lockstep note is corrected', () => {
  it('the MODES doc comment no longer tells the reader flash needs a special_mode CHECK widen or new radio markup', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/services/tasks.js'), 'utf8');
    expect(source).not.toMatch(/Lucky\/flash[\s\S]{0,40}still\s+require the same by-hand updates/);
    // Loosened from an exact-wording match (issue #761 review fix): pinning
    // the full sentence means any harmless rewording of this prose turns
    // the suite red. Assert the load-bearing CLAIM instead -- the MODES
    // comment names flash and states it does not extend the MODES list --
    // rather than the exact phrasing that makes the claim.
    expect(source).toMatch(/flash[\s\S]{0,120}does\s+not\s+extend\s+this\s+list/i);
  });
});

// ---------------------------------------------------------------------------
// Criteria 4 & 5: submitPhoto's in-window banking, replace-preserves-bonus,
// takedown/restore moving both halves, with NO new scoring code.
// ---------------------------------------------------------------------------
describe('criteria 4-5: submitPhoto banks the in-window flash bonus, no new scoring code', () => {
  const FIXED_TODAY = '2026-08-07';
  let originalEventLocalDateString;

  beforeAll(() => {
    // Pinned so isOnDay/isSealed (consulted internally by submitPhoto
    // regardless of whether a given test's task carries a special_date) are
    // never handed a real-wall-clock surprise -- same technique
    // tests/oneday-challenge-engine.test.js uses.
    originalEventLocalDateString = eventDaysSvc.eventLocalDateString;
    eventDaysSvc.eventLocalDateString = () => FIXED_TODAY;
  });

  afterAll(() => {
    eventDaysSvc.eventLocalDateString = originalEventLocalDateString;
  });

  it('AC4: an in-window submit banks worth + flash bonus with reason "flash"; an out-of-window submit does not', async () => {
    const startAt = '2026-08-07T12:00:00.000Z';
    const startMs = Date.parse(startAt);
    const taskId = insertTask({ worth: 2, flashStartAt: startAt, flashMinutes: 10, flashBonus: 3 });

    const inWindowGuest = insertGuest();
    const inWindowFile = writeOriginal(`flash-inwindow-${crypto.randomUUID()}.jpg`);
    const inWindow = await submissions.submitPhoto({
      guestId: inWindowGuest,
      taskId,
      file: inWindowFile,
      caption: '',
      nowMs: startMs + 5 * 60000,
    });
    expect(inWindow.status).toBe('created');
    expect(scoring.getPoints(inWindowGuest)).toBe(5); // worth 2 + flash bonus 3
    const inWindowRow = getSubmission(inWindowGuest, taskId);
    expect(inWindowRow.bonus_amount).toBe(3);
    expect(inWindowRow.bonus_reason).toBe('flash');

    const outOfWindowGuest = insertGuest();
    const outOfWindowFile = writeOriginal(`flash-outwindow-${crypto.randomUUID()}.jpg`);
    const outOfWindow = await submissions.submitPhoto({
      guestId: outOfWindowGuest,
      taskId,
      file: outOfWindowFile,
      caption: '',
      nowMs: startMs + 10 * 60000, // exactly the end instant -- expired, half-open window
    });
    expect(outOfWindow.status).toBe('created');
    expect(scoring.getPoints(outOfWindowGuest)).toBe(2); // worth only
    const outOfWindowRow = getSubmission(outOfWindowGuest, taskId);
    expect(outOfWindowRow.bonus_amount).toBe(0);
    expect(outOfWindowRow.bonus_reason).toBeNull();
  });

  it('AC4: on-day wins when a task is somehow both on-day and in-window -- exactly one bonus banks, never both', async () => {
    const startAt = '2026-08-07T12:00:00.000Z';
    const startMs = Date.parse(startAt);
    const taskId = insertTask({
      worth: 1,
      specialDate: FIXED_TODAY,
      specialBonus: 2,
      flashStartAt: startAt,
      flashMinutes: 10,
      flashBonus: 3,
    });
    const guestId = insertGuest();
    const file = writeOriginal(`flash-tiebreak-${crypto.randomUUID()}.jpg`);
    const result = await submissions.submitPhoto({
      guestId,
      taskId,
      file,
      caption: '',
      nowMs: startMs + 60000, // flash is also active right now
    });

    expect(result.status).toBe('created');
    expect(scoring.getPoints(guestId)).toBe(3); // worth 1 + oneday bonus 2 -- NOT +3 flash on top
    const row = getSubmission(guestId, taskId);
    expect(row.bonus_amount).toBe(2);
    expect(row.bonus_reason).toBe('oneday');
  });

  it(
    'review fix, THE DIVERGENT CASE: a task sealed for a FUTURE day, with a ' +
      'simultaneously active flash window, submitted by a guest who already holds a row ' +
      "(the seal gate's existing-row fall-through) -- must bank NOTHING, matching " +
      'whatSpecial\'s "daily" answer, never fall through to banking "flash"',
    async () => {
      // A second, never-completed task (deliberate, not incidental): with
      // only ONE task in the whole database, completing it also makes this
      // guest hold COMPLETIONIST (100% of live tasks), which adds its own
      // +1 to getPoints() and would make the assertion below order-dependent
      // on how many other tasks earlier tests in this file happened to
      // insert. Inserting a second task this guest never touches keeps the
      // getPoints() assertion below deterministic regardless of run order or
      // test filtering.
      insertTask({ worth: 1 });

      // Ordinary task, no special/flash yet -- a guest submits normally,
      // creating the "existing" row the seal gate's fall-through needs.
      const taskId = insertTask({ worth: 1 });
      const guestId = insertGuest();
      const firstFile = writeOriginal(`flash-divergent-first-${crypto.randomUUID()}.jpg`);
      const created = await submissions.submitPhoto({
        guestId,
        taskId,
        file: firstFile,
        caption: '',
      });
      expect(created.status).toBe('created');
      expect(getSubmission(guestId, taskId).bonus_amount).toBe(0);

      // The task is re-dated into the future (sealed as of FIXED_TODAY) AND
      // simultaneously armed with an active flash window -- the exact shape
      // that used to make whatSpecial() and the old hand-written banking
      // precedence disagree.
      const startAt = '2026-08-07T12:00:00.000Z';
      const startMs = Date.parse(startAt);
      db.prepare(
        `UPDATE tasks SET special_mode = 'oneday', special_date = ?, special_bonus = ?,
                          flash_start_at = ?, flash_minutes = ?, flash_bonus = ?
           WHERE id = ?`
      ).run('2026-08-08', 2, startAt, 10, 3, taskId);

      // whatSpecial() agrees this row is spoken for by 'daily' (sealed wins),
      // never 'flash', for this exact clock.
      const taskRow = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
      expect(tasksSvc.whatSpecial(taskRow, { todayIso: FIXED_TODAY, nowMs: startMs + 60000 })).toBe(
        'daily'
      );

      // The guest replaces their photo while the flash window is active. The
      // seal gate falls through because `existing` is truthy -- submitPhoto
      // must bank NOTHING (daily owns the row but isn't on-day yet), never
      // bank 'flash'.
      const secondFile = writeOriginal(`flash-divergent-second-${crypto.randomUUID()}.jpg`);
      const replaced = await submissions.submitPhoto({
        guestId,
        taskId,
        file: secondFile,
        caption: '',
        nowMs: startMs + 60000, // flash is active right now
      });
      expect(replaced.status).toBe('replaced');
      const row = getSubmission(guestId, taskId);
      expect(row.bonus_amount).toBe(0);
      expect(row.bonus_reason).toBeNull();
      expect(scoring.getPoints(guestId)).toBe(1); // worth only -- no bonus of any kind
    }
  );

  it('AC5: replacing the photo after the window has closed keeps the banked flash bonus -- neither overwritten nor zeroed', async () => {
    const startAt = '2026-08-07T12:00:00.000Z';
    const startMs = Date.parse(startAt);
    const endMs = startMs + 10 * 60000;
    const taskId = insertTask({ worth: 2, flashStartAt: startAt, flashMinutes: 10, flashBonus: 3 });
    const guestId = insertGuest();

    const first = writeOriginal(`flash-replace-first-${crypto.randomUUID()}.jpg`);
    const created = await submissions.submitPhoto({
      guestId,
      taskId,
      file: first,
      caption: '',
      nowMs: startMs + 2 * 60000,
    });
    expect(created.status).toBe('created');
    expect(scoring.getPoints(guestId)).toBe(5);

    const second = writeOriginal(`flash-replace-second-${crypto.randomUUID()}.jpg`);
    const replaced = await submissions.submitPhoto({
      guestId,
      taskId,
      file: second,
      caption: '',
      nowMs: endMs + 60000, // well after the window closed
    });
    expect(replaced.status).toBe('replaced');
    expect(scoring.getPoints(guestId)).toBe(5); // unchanged

    const row = getSubmission(guestId, taskId);
    expect(row.bonus_amount).toBe(3);
    expect(row.bonus_reason).toBe('flash');
    expect(row.photo_path).toBe(second.filename);
  });

  it('AC5: takedown removes BOTH worth and the flash bonus from getPoints() and the leaderboard row; restore returns both, with no new scoring code', async () => {
    const startAt = '2026-08-07T12:00:00.000Z';
    const startMs = Date.parse(startAt);
    const taskId = insertTask({ worth: 2, flashStartAt: startAt, flashMinutes: 10, flashBonus: 3 });
    const guestId = insertGuest();
    const file = writeOriginal(`flash-takedown-${crypto.randomUUID()}.jpg`);

    await submissions.submitPhoto({
      guestId,
      taskId,
      file,
      caption: '',
      nowMs: startMs + 1000,
    });
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
// Criterion 7: a scheduled flash needs no trigger; the clock is a seam.
// ---------------------------------------------------------------------------
describe('criterion 7: a scheduled flash needs no trigger, and nowMs is a seam not a mock', () => {
  const FIXED_TODAY = '2026-08-07';
  let originalEventLocalDateString;

  beforeAll(() => {
    originalEventLocalDateString = eventDaysSvc.eventLocalDateString;
    eventDaysSvc.eventLocalDateString = () => FIXED_TODAY;
  });

  afterAll(() => {
    eventDaysSvc.eventLocalDateString = originalEventLocalDateString;
  });

  it('before the start instant: no bonus. After it, with no admin action, no task edit, and no process run in between: bonus banks', async () => {
    const startAt = '2026-08-07T15:00:00.000Z';
    const startMs = Date.parse(startAt);
    const taskId = insertTask({ worth: 1, flashStartAt: startAt, flashMinutes: 20, flashBonus: 2 });

    const beforeGuest = insertGuest();
    const beforeFile = writeOriginal(`flash-before-start-${crypto.randomUUID()}.jpg`);
    const beforeResult = await submissions.submitPhoto({
      guestId: beforeGuest,
      taskId,
      file: beforeFile,
      caption: '',
      nowMs: startMs - 1,
    });
    expect(beforeResult.status).toBe('created');
    expect(scoring.getPoints(beforeGuest)).toBe(1);
    expect(getSubmission(beforeGuest, taskId).bonus_amount).toBe(0);
    expect(getSubmission(beforeGuest, taskId).bonus_reason).toBeNull();

    // A different guest submits after the start instant. Nothing about the
    // task row changed and nothing ran in between -- the window simply
    // became true to read.
    const afterGuest = insertGuest();
    const afterFile = writeOriginal(`flash-after-start-${crypto.randomUUID()}.jpg`);
    const afterResult = await submissions.submitPhoto({
      guestId: afterGuest,
      taskId,
      file: afterFile,
      caption: '',
      nowMs: startMs,
    });
    expect(afterResult.status).toBe('created');
    expect(scoring.getPoints(afterGuest)).toBe(3); // worth 1 + flash bonus 2
    expect(getSubmission(afterGuest, taskId).bonus_amount).toBe(2);
    expect(getSubmission(afterGuest, taskId).bonus_reason).toBe('flash');
  });

  it('a submit made with no clock argument at all still banks the flash bonus, reading the real current time as production does', async () => {
    // A REAL flash window straddling the REAL clock (review fix):
    // before this fix, the equivalent test used a task with NO flash armed,
    // so its assertions ('created', getPoints 1) held no matter what the
    // default clock resolved to -- src/services/submissions.js's `Number.
    // isFinite(nowMs) ? nowMs : Date.now()` fallback could have been changed
    // to `: 0` (or anything else) and every assertion would still pass,
    // while in production (src/routes/guest.js passes no nowMs) a flash
    // bonus would never bank for a real guest, silently. A 10-minute window
    // centered on "now" is deterministic -- no flake -- and this task DOES
    // have flash armed, so a broken default clock makes this test fail.
    const startAt = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
    const taskId = insertTask({ worth: 1, flashStartAt: startAt, flashMinutes: 10, flashBonus: 2 });
    const guestId = insertGuest();
    const file = writeOriginal(`flash-no-clock-arg-${crypto.randomUUID()}.jpg`);

    // NOTE: no nowMs key at all -- this is the production call shape
    // (src/routes/guest.js's POST /tasks/:id/submit handler).
    const result = await submissions.submitPhoto({ guestId, taskId, file, caption: '' });

    expect(result.status).toBe('created');
    const row = getSubmission(guestId, taskId);
    expect(row.bonus_amount).toBe(2);
    expect(row.bonus_reason).toBe('flash');
    expect(scoring.getPoints(guestId)).toBe(3); // worth 1 + flash bonus 2
  });

  it('nowMs: 0 is honored as a real clock, never replaced by the default (issue #761 review fix)', async () => {
    // A flash window anchored at the epoch itself -- the only way to prove
    // nowMs: 0 (falsy but not nullish) was actually USED rather than
    // silently swapped for Date.now(): the real wall clock is nowhere near
    // 1970, so if `nowMs: 0` had fallen through to the default, this window
    // would read 'scheduled' (or 'expired'), never 'active', and no bonus
    // would bank.
    const taskId = insertTask({
      worth: 1,
      flashStartAt: '1970-01-01T00:00:00.000Z',
      flashMinutes: 10,
      flashBonus: 2,
    });
    const guestId = insertGuest();
    const file = writeOriginal(`flash-zero-clock-${crypto.randomUUID()}.jpg`);

    const result = await submissions.submitPhoto({ guestId, taskId, file, caption: '', nowMs: 0 });

    expect(result.status).toBe('created');
    const row = getSubmission(guestId, taskId);
    expect(row.bonus_amount).toBe(2);
    expect(row.bonus_reason).toBe('flash');
    expect(scoring.getPoints(guestId)).toBe(3); // worth 1 + flash bonus 2
  });

  it('nowMs: NaN rejects (issue #761 review fix) -- a caller-computed garbage clock must throw, never silently substitute the real clock', async () => {
    const taskId = insertTask({ worth: 1 });
    const guestId = insertGuest();
    const file = writeOriginal(`flash-nan-clock-${crypto.randomUUID()}.jpg`);

    await expect(
      submissions.submitPhoto({ guestId, taskId, file, caption: '', nowMs: NaN })
    ).rejects.toThrow(/nowMs/);
  });
});

// ---------------------------------------------------------------------------
// Plan step 3: the insert-branch tightening. The existing one-day-only suite
// only exercises this legacy shape on the REPLACE branch
// (tests/oneday-challenge-engine.test.js:345-398); without this test the
// tightening on the INSERT branch ships unasserted.
// ---------------------------------------------------------------------------
describe('plan step 3: the insert branch never writes a reason beside a zero amount', () => {
  const FIXED_TODAY = '2026-08-07';
  let originalEventLocalDateString;

  beforeAll(() => {
    originalEventLocalDateString = eventDaysSvc.eventLocalDateString;
    eventDaysSvc.eventLocalDateString = () => FIXED_TODAY;
  });

  afterAll(() => {
    eventDaysSvc.eventLocalDateString = originalEventLocalDateString;
  });

  it('a FIRST submit (insert, not replace) on a legacy row whose special_bonus is NULL despite special_date = today banks amount 0 with reason NULL', async () => {
    // chk_special_pairing refuses this shape for a NEW insert; simulate a
    // row that predates the constraint (or was hand-edited) the same way
    // tests/oneday-challenge-engine.test.js's own pairing test does.
    db.pragma('ignore_check_constraints = ON');
    let taskId;
    try {
      taskId = db
        .prepare(
          `INSERT INTO tasks (title, worth, special_mode, special_date, special_bonus)
           VALUES (?, ?, 'oneday', ?, NULL)`
        )
        .run('Legacy half-set challenge (insert branch)', 2, FIXED_TODAY).lastInsertRowid;
    } finally {
      db.pragma('ignore_check_constraints = OFF');
    }

    const guestId = insertGuest();
    const file = writeOriginal(`legacy-insert-branch-${crypto.randomUUID()}.jpg`);
    const result = await submissions.submitPhoto({ guestId, taskId, file, caption: '' });

    expect(result.status).toBe('created');
    const row = getSubmission(guestId, taskId);
    expect(row.bonus_amount).toBe(0);
    expect(row.bonus_reason).toBeNull();
    expect(scoring.getPoints(guestId)).toBe(2); // worth only
  });
});
