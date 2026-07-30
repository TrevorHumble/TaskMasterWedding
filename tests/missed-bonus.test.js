// tests/missed-bonus.test.js
// Issue #926 AC7: tasks.missedBonusForTask(taskRow, clock) — the single owner
// of "did a bonus slip away here, and how much was it" that
// src/routes/guest.js's bonusMissed/bonusMissedAmount derive from, gated on
// amount > 0, never re-deriving "expired" per special type.
//
// src/services/tasks.js is dependency-free (no `db`/config require — see its
// own file comment), so this suite needs no loadApp()/temp DB at all: a plain
// require is enough, matching tests/tasks-normalize.test.js's and
// tests/flash-engine.test.js's own pure-unit conventions for this module.
'use strict';

const tasksSvc = require('../src/services/tasks');

const TODAY = '2026-08-07';
const YESTERDAY = '2026-08-06';
const TOMORROW = '2026-08-08';
const NOW_MS = Date.parse('2026-08-07T12:00:00.000Z');

// ---------------------------------------------------------------------------
// AC7's table, one test per row (plus a couple of adjacent shapes worth
// pinning alongside the literal row -- e.g. lucky's "regardless of dates"
// clause names more than the single "past" case the table row states).
// ---------------------------------------------------------------------------
describe('missedBonusForTask (issue #926 AC7 table)', () => {
  const clock = { todayIso: TODAY, nowMs: NOW_MS };

  it('flash armed, window fully elapsed, flash_bonus 3: {reason: "flash", amount: 3}', () => {
    const row = { flash_start_at: '2026-08-07T09:00:00.000Z', flash_minutes: 30, flash_bonus: 3 }; // ended 09:30, well before NOW_MS (noon)
    expect(tasksSvc.missedBonusForTask(row, clock)).toEqual({ reason: 'flash', amount: 3 });
  });

  it('flash armed, window live right now: null', () => {
    const row = { flash_start_at: '2026-08-07T11:30:00.000Z', flash_minutes: 60, flash_bonus: 3 }; // active until 12:30
    expect(tasksSvc.missedBonusForTask(row, clock)).toBeNull();
  });

  it('flash armed, window merely scheduled: null', () => {
    const row = { flash_start_at: '2026-08-07T13:00:00.000Z', flash_minutes: 30, flash_bonus: 3 };
    expect(tasksSvc.missedBonusForTask(row, clock)).toBeNull();
  });

  it('one-day challenge, special_date strictly past, special_bonus 2: {reason: "oneday", amount: 2}', () => {
    const row = { special_date: YESTERDAY, special_bonus: 2 };
    expect(tasksSvc.missedBonusForTask(row, clock)).toEqual({ reason: 'oneday', amount: 2 });
  });

  it('one-day challenge, special_date strictly past, special_bonus NULL (legacy row): {reason: null, amount: 0} -- route renders no marker', () => {
    const row = { special_date: YESTERDAY, special_bonus: null };
    expect(tasksSvc.missedBonusForTask(row, clock)).toEqual({ reason: null, amount: 0 });
  });

  it('one-day challenge, special_date today: null', () => {
    const row = { special_date: TODAY, special_bonus: 2 };
    expect(tasksSvc.missedBonusForTask(row, clock)).toBeNull();
  });

  it('one-day challenge, special_date in the future: null', () => {
    const row = { special_date: TOMORROW, special_bonus: 2 };
    expect(tasksSvc.missedBonusForTask(row, clock)).toBeNull();
  });

  it('lucky task, lucky_date past: null -- never missed, regardless of dates', () => {
    const row = { lucky_date: YESTERDAY, lucky_bonus: 2 };
    expect(tasksSvc.missedBonusForTask(row, clock)).toBeNull();
  });

  it('lucky task, lucky_date today: null -- confirms "regardless of dates", not just the past case', () => {
    const row = { lucky_date: TODAY, lucky_bonus: 2 };
    expect(tasksSvc.missedBonusForTask(row, clock)).toBeNull();
  });

  it('lucky task, lucky_date in the future: null', () => {
    const row = { lucky_date: TOMORROW, lucky_bonus: 2 };
    expect(tasksSvc.missedBonusForTask(row, clock)).toBeNull();
  });

  it('malformed special_date (regex-invalid shape, e.g. a missing digit): null', () => {
    const row = { special_date: '2026-08-1', special_bonus: 2 }; // day is one digit, not two
    expect(tasksSvc.missedBonusForTask(row, clock)).toBeNull();
  });

  it('malformed special_date (not date-shaped at all): null', () => {
    const row = { special_date: 'not-a-date', special_bonus: 2 };
    expect(tasksSvc.missedBonusForTask(row, clock)).toBeNull();
  });

  it('malformed special_date (regex-SHAPED but not a real calendar date -- issue #926 review fix, MINOR m1): null', () => {
    // '2026-01-99' matches \d{4}-\d{2}-\d{2} (isValidDateString would say
    // yes), but day 99 names no real date. The daily rule's `missed`
    // predicate now checks isRealDateString, not the shape-only check, so
    // this must answer null rather than doing a string compare against a
    // value that was never a real day.
    const row = { special_date: '2026-01-99', special_bonus: 2 };
    expect(tasksSvc.missedBonusForTask(row, clock)).toBeNull();
  });

  it('a row BOTH a passed one-day challenge and an expired flash: the one-day result -- precedence mirrors the live walk', () => {
    const row = {
      special_date: YESTERDAY,
      special_bonus: 2,
      flash_start_at: '2026-08-07T09:00:00.000Z',
      flash_minutes: 30, // expired well before noon
      flash_bonus: 3,
    };
    expect(tasksSvc.missedBonusForTask(row, clock)).toEqual({ reason: 'oneday', amount: 2 });
  });

  it('an ordinary task (no special of any kind): null', () => {
    expect(tasksSvc.missedBonusForTask({}, clock)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC7's last two table rows: an invalid clock throws rather than silently
// answering "not missed" -- matching the discipline isSealed()/isOnDay()
// already apply to their own todayIso parameter. A silent false here would
// let every passed daily challenge quietly lose its marker with no error
// anywhere the caller could ever see.
// ---------------------------------------------------------------------------
describe('missedBonusForTask throws on an invalid clock, matching the sibling live walk', () => {
  // A row that WOULD be missed under a valid clock -- so a test that fails to
  // throw would be caught by a wrong RETURN VALUE too, not just a missing
  // exception, if the throw were ever silently dropped.
  const missableRow = { special_date: YESTERDAY, special_bonus: 2 };

  it('throws when clock.nowMs is missing', () => {
    expect(() => tasksSvc.missedBonusForTask(missableRow, { todayIso: TODAY })).toThrow(/nowMs/);
  });

  it('throws when clock.nowMs is NaN', () => {
    expect(() => tasksSvc.missedBonusForTask(missableRow, { todayIso: TODAY, nowMs: NaN })).toThrow(
      /nowMs/
    );
  });

  it('throws when clock itself is missing entirely', () => {
    expect(() => tasksSvc.missedBonusForTask(missableRow, undefined)).toThrow(/nowMs/);
  });

  it('throws when clock.todayIso is missing (nowMs alone is not enough)', () => {
    expect(() => tasksSvc.missedBonusForTask(missableRow, { nowMs: NOW_MS })).toThrow(/todayIso/);
  });

  it('throws when clock.todayIso is regex-invalid (not YYYY-MM-DD)', () => {
    expect(() =>
      tasksSvc.missedBonusForTask(missableRow, { todayIso: '2026-8-7', nowMs: NOW_MS })
    ).toThrow(/todayIso/);
  });

  it('throws when clock.todayIso is not a string at all', () => {
    expect(() =>
      tasksSvc.missedBonusForTask(missableRow, { todayIso: null, nowMs: NOW_MS })
    ).toThrow(/todayIso/);
  });

  it('the todayIso check runs before any SPECIAL_RULES walk -- an invalid clock throws even for a row that would otherwise report no miss', () => {
    expect(() =>
      tasksSvc.missedBonusForTask({}, { todayIso: 'not-a-date', nowMs: NOW_MS })
    ).toThrow(/todayIso/);
  });

  it('does not throw, and returns a real answer, for a valid clock', () => {
    expect(() =>
      tasksSvc.missedBonusForTask(missableRow, { todayIso: TODAY, nowMs: NOW_MS })
    ).not.toThrow();
  });
});
