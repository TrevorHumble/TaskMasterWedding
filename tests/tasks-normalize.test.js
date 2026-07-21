// tests/tasks-normalize.test.js
// Issue #682 review fix: src/services/tasks.js's WRITE-side owners —
// isValidMode/normalizeMode (mirrors the module's existing READ-side
// liveTaskWhere/isTaskLive ownership) and normalizeWorth. Before this fix,
// src/routes/admin.js's create and edit handlers each hand-coded their own
// "unknown special_mode -> ?" rule (create: unknown -> none; edit: unknown ->
// keep-current) and their own worth clamp, with no single place enforcing
// either rule — these tests pin the shared functions' own behavior directly,
// independent of either route.
//
// src/services/tasks.js is dependency-free (no `db`/config require — see its
// own file comment), so this suite needs no loadApp()/temp DB at all: a
// plain require is enough, and there is no REQUIRE ORDER constraint to
// follow (contrast tests/helpers/testApp.js's loadApp() note, which applies
// only to modules that read config/db at require time).
'use strict';

const tasks = require('../src/services/tasks');

describe('MODES / isValidMode', () => {
  it('MODES is exactly [none, hidden] today, and contains MODE_NONE/MODE_HIDDEN', () => {
    expect(tasks.MODES).toEqual([tasks.MODE_NONE, tasks.MODE_HIDDEN]);
  });

  it('isValidMode is true only for a MODES member, false for anything else', () => {
    expect(tasks.isValidMode('none')).toBe(true);
    expect(tasks.isValidMode('hidden')).toBe(true);
    expect(tasks.isValidMode('one_day')).toBe(false); // a FUTURE mode (#624) — not yet real
    expect(tasks.isValidMode('')).toBe(false);
    expect(tasks.isValidMode(undefined)).toBe(false);
    expect(tasks.isValidMode(null)).toBe(false);
    expect(tasks.isValidMode(123)).toBe(false);
  });
});

describe('normalizeMode', () => {
  it('a valid mode value passes through unchanged, regardless of fallback', () => {
    expect(tasks.normalizeMode('hidden', tasks.MODE_NONE)).toBe('hidden');
    expect(tasks.normalizeMode('none', tasks.MODE_HIDDEN)).toBe('none');
  });

  it('an unrecognized/missing value falls back to the CALLER-SUPPLIED fallback — not a hardcoded default', () => {
    // This is the exact inconsistency the review flagged: create's fallback
    // (MODE_NONE) and edit's fallback (the task's current mode) MUST both be
    // honored by the same function, not each hand-coded separately.
    expect(tasks.normalizeMode('not-a-real-mode', tasks.MODE_NONE)).toBe(tasks.MODE_NONE);
    expect(tasks.normalizeMode(undefined, tasks.MODE_NONE)).toBe(tasks.MODE_NONE);
    expect(tasks.normalizeMode('not-a-real-mode', tasks.MODE_HIDDEN)).toBe(tasks.MODE_HIDDEN);
    expect(tasks.normalizeMode(undefined, 'hidden')).toBe('hidden'); // edit's "keep current" case
  });
});

describe('normalizeWorth', () => {
  it('an in-range integer (as a number OR a numeric string, matching a real POST body) passes through', () => {
    expect(tasks.normalizeWorth(1, tasks.DEFAULT_WORTH)).toBe(1);
    expect(tasks.normalizeWorth(2, tasks.DEFAULT_WORTH)).toBe(2);
    expect(tasks.normalizeWorth(3, tasks.DEFAULT_WORTH)).toBe(3);
    expect(tasks.normalizeWorth('2', tasks.DEFAULT_WORTH)).toBe(2);
  });

  it('out-of-range, non-numeric, or missing values fall back to the CALLER-SUPPLIED fallback', () => {
    expect(tasks.normalizeWorth(0, tasks.DEFAULT_WORTH)).toBe(tasks.DEFAULT_WORTH);
    expect(tasks.normalizeWorth(4, tasks.DEFAULT_WORTH)).toBe(tasks.DEFAULT_WORTH);
    expect(tasks.normalizeWorth(99, tasks.DEFAULT_WORTH)).toBe(tasks.DEFAULT_WORTH);
    expect(tasks.normalizeWorth('not-a-number', tasks.DEFAULT_WORTH)).toBe(tasks.DEFAULT_WORTH);
    expect(tasks.normalizeWorth(undefined, tasks.DEFAULT_WORTH)).toBe(tasks.DEFAULT_WORTH);
    // edit's "keep current" case: fallback is the task's CURRENT worth, not
    // always DEFAULT_WORTH.
    expect(tasks.normalizeWorth('bogus', 3)).toBe(3);
  });
});
