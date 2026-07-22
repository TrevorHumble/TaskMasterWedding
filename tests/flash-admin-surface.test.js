// tests/flash-admin-surface.test.js
// Issue #763 acceptance criteria — the flash HOST surface: arm now on either
// path (AC1), arm for later and it opens unattended (AC2), cancel in both
// states (AC3), invalid input refused not coerced (AC4), specials never
// stack in any direction (AC5), the edit popup tells the truth about
// current state (AC6, projection half — the client half lives in
// tests/admin-tasks-script.test.js), the DST-exact date math (AC7, in
// tests/event-days.test.js), and the stepper (AC8, in
// tests/admin-tasks-script.test.js).
//
// Default event config (src/db.js's getEventConfig fallback) is
// timezone=America/Boise, startDate=2026-08-07, endDate=2026-08-09 — so
// DAY1/DAY2/DAY3 below are the three configured day chips, and (per this
// sandbox's real wall clock, itself mid-2026) all three fall in the real
// FUTURE relative to Date.now() at test-run time, same assumption
// tests/lucky-task.test.js's own "AC7c Live Flash" test already makes for
// arming a flash around the real clock with generous margins.
//
// src/routes/admin.js's currentClock() builds nowMs from a bare Date.now()
// with no injectable seam (same limitation tests/flash-guest-surface.test.js
// documents for guest.js) — every flash window fixture below is anchored to
// the REAL wall clock with generous margins, and the direct
// submissions.submitPhoto() calls (which DO take an injectable nowMs) prove
// the banking/no-op logic exactly at the instants that matter.
//
// REQUIRE ORDER: loadApp() must run before any require that pulls in config
// or db (see tests/helpers/testApp.js).
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { loadApp, makeAdminAgent } = require('./helpers/testApp');

let app;
let db;
let adminAgent;
let config;
let tasksSvc;
let eventDaysSvc;
let submissions;
let scoring;
let uploadsDir;
let validJpeg;

const DAY1 = '2026-08-07';
const DAY2 = '2026-08-08';
const DAY3 = '2026-08-09';
const TIMEZONE = 'America/Boise';

beforeAll(async () => {
  validJpeg = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 9, g: 9, b: 9 } },
  })
    .jpeg()
    .toBuffer();

  const result = loadApp();
  app = result.app;
  db = result.db;
  adminAgent = await makeAdminAgent(app);

  config = require('../config');
  tasksSvc = require('../src/services/tasks');
  eventDaysSvc = require('../src/services/event-days');
  submissions = require('../src/services/submissions');
  scoring = require('../src/services/scoring');
  uploadsDir = config.UPLOADS_DIR;
});

// One badge_icon every create POST in this file carries — badge is required
// server-side (issue #682 AC-A), unrelated to what this file tests.
const BADGE = { badge_icon: 'favorite', badge_name: 'Flash Test Badge' };

let seq = 0;
function insertTask(overrides) {
  seq += 1;
  const cols = Object.assign(
    {
      title: `Flash Admin Task ${seq}`,
      worth: 1,
      special_mode: 'none',
      special_date: null,
      special_bonus: null,
      lucky_date: null,
      lucky_bonus: null,
      flash_start_at: null,
      flash_minutes: null,
      flash_bonus: null,
    },
    overrides
  );
  return db
    .prepare(
      `INSERT INTO tasks
         (title, worth, special_mode, special_date, special_bonus,
          lucky_date, lucky_bonus, flash_start_at, flash_minutes, flash_bonus)
       VALUES (@title, @worth, @special_mode, @special_date, @special_bonus,
               @lucky_date, @lucky_bonus, @flash_start_at, @flash_minutes, @flash_bonus)`
    )
    .run(cols).lastInsertRowid;
}

function getTask(id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

function insertGuest() {
  seq += 1;
  return db
    .prepare('INSERT INTO guests (token, name) VALUES (?, ?)')
    .run(`flash-admin-guest-${seq}-${crypto.randomUUID()}`, 'Flash Admin Guest').lastInsertRowid;
}

function writeOriginal() {
  seq += 1;
  const filename = `flash-admin-${seq}-${crypto.randomUUID()}.jpg`;
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
// AC1: arm now, on either path — create and edit both wired to the same
// resolver, and a guest submitting immediately banks the bonus.
// ---------------------------------------------------------------------------
describe('AC1: arm now, on either path', () => {
  test('POST /admin/tasks (create) with Starts=Now arms the flash immediately', async () => {
    // A decoy, unrelated, incomplete task (issue #763 test hygiene, not part
    // of the acceptance criterion): without one, the guest below would
    // complete 100% of existing tasks with this single submission and pick
    // up the COMPLETIONIST auto-badge's own +1 award point, inflating the
    // expected total by a source that has nothing to do with flash banking.
    insertTask({ title: 'AC1 Decoy Task' });

    const before = Date.now();
    const res = await adminAgent
      .post('/admin/tasks')
      .type('form')
      .send({
        title: 'AC1 Create Now',
        worth: 2,
        special_mode: 'flash',
        flash_bonus: 3,
        flash_minutes: 30,
        flash_start_mode: 'now',
        ...BADGE,
      });
    expect([302, 303]).toContain(res.status);

    const task = db.prepare('SELECT * FROM tasks WHERE title = ?').get('AC1 Create Now');
    expect(task.flash_bonus).toBe(3);
    expect(task.flash_minutes).toBe(30);
    expect(tasksSvc.isValidFlashInstant(task.flash_start_at)).toBe(true);
    const startMs = Date.parse(task.flash_start_at);
    // A generous window either side of "before"/"now" rather than a strict
    // >= (this repo's own established idiom for a real-wall-clock-anchored
    // assertion — see e.g. tests/lucky-task.test.js's "AC7c Live Flash"): the
    // system clock's own coarse resolution can make two Date.now() calls a
    // few milliseconds apart read out of strict order.
    expect(startMs).toBeGreaterThanOrEqual(before - 1000);
    expect(startMs).toBeLessThanOrEqual(Date.now() + 2000);
    expect(tasksSvc.flashState(task, Date.now())).toBe('active');
    // The task's own special_mode is never the 'flash' sentinel (tasks.js's
    // MODES comment) — a raw 'flash' create falls back to MODE_NONE.
    expect(task.special_mode).toBe('none');

    // A guest submitting right now banks worth (2) + flash bonus (3) = 5.
    const guestId = insertGuest();
    const result = await submissions.submitPhoto({
      guestId,
      taskId: task.id,
      file: writeOriginal(),
      caption: '',
      nowMs: Date.now(),
    });
    expect(result.status).toBe('created');
    expect(scoring.getPoints(guestId)).toBe(5);
    const sub = getSubmission(guestId, task.id);
    expect(sub.bonus_reason).toBe('flash');
    expect(sub.bonus_amount).toBe(3);
  });

  test('POST /admin/tasks/:id/edit with Starts=Now arms the flash on an EXISTING task, and the admin board shows it flashed', async () => {
    const id = insertTask({ title: 'AC1 Edit Now' });
    await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC1 Edit Now',
      special_mode: 'flash',
      flash_bonus: 1,
      flash_minutes: 15,
      flash_start_mode: 'now',
    });

    const task = getTask(id);
    expect(task.flash_bonus).toBe(1);
    expect(task.flash_minutes).toBe(15);
    expect(tasksSvc.flashState(task, Date.now())).toBe('active');

    const html = (await adminAgent.get('/admin/tasks')).text;
    const cardStart = html.indexOf(`data-task-id="${id}"`);
    const card = html.slice(cardStart, cardStart + 2000);
    expect(card).toContain('data-flash-state="active"');
    expect(card).toContain('admin-chip-flash"');
    expect(card).toContain('min left');
  });
});

// ---------------------------------------------------------------------------
// AC2: arm for later — nothing is flashed until the instant passes, with no
// host action and no process running in between (flashState is purely
// read-time derived).
// ---------------------------------------------------------------------------
describe('AC2: arm for later, unattended', () => {
  test('Pick a time computes the instant via event-days.eventLocalInstant in the configured timezone, and it is SCHEDULED, not open, right after saving', async () => {
    const id = insertTask({ title: 'AC2 Scheduled' });
    await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC2 Scheduled',
      special_mode: 'flash',
      flash_bonus: 2,
      flash_minutes: 20,
      flash_start_mode: 'later',
      flash_date: DAY3,
      flash_time: '19:00',
    });

    const task = getTask(id);
    const expected = eventDaysSvc.eventLocalInstant(DAY3, TIMEZONE, 19, 0).toISOString();
    expect(task.flash_start_at).toBe(expected);
    expect(task.flash_bonus).toBe(2);
    expect(task.flash_minutes).toBe(20);
    expect(tasksSvc.flashState(task, Date.now())).toBe('scheduled');
  });

  test('once the scheduled instant passes, with NO host action taken in between, the window is open and a submit banks', async () => {
    const id = insertTask({ title: 'AC2 Opens Unattended' });
    await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC2 Opens Unattended',
      worth: 1,
      special_mode: 'flash',
      flash_bonus: 2,
      flash_minutes: 20,
      flash_start_mode: 'later',
      flash_date: DAY3,
      flash_time: '19:00',
    });
    const task = getTask(id);
    const startMs = Date.parse(task.flash_start_at);

    // No admin request runs between arming and this submit — flashState is
    // purely a function of (row, nowMs), never a write-on-expiry job.
    const guestId = insertGuest();
    const result = await submissions.submitPhoto({
      guestId,
      taskId: id,
      file: writeOriginal(),
      caption: '',
      nowMs: startMs + 1000, // one second after the scheduled instant
    });
    expect(result.status).toBe('created');
    const sub = getSubmission(guestId, id);
    expect(sub.bonus_reason).toBe('flash');
    expect(sub.bonus_amount).toBe(2);

    // One millisecond BEFORE the scheduled instant, nothing banks.
    const earlyGuest = insertGuest();
    const earlyResult = await submissions.submitPhoto({
      guestId: earlyGuest,
      taskId: id,
      file: writeOriginal(),
      caption: '',
      nowMs: startMs - 1,
    });
    expect(earlyResult.status).toBe('created');
    const earlySub = getSubmission(earlyGuest, id);
    expect(earlySub.bonus_amount).toBe(0);
    expect(earlySub.bonus_reason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC3: cancel works in both states, and never touches an already-banked
// bonus.
// ---------------------------------------------------------------------------
describe('AC3: cancel, in both states', () => {
  test('cancelling a SCHEDULED flash means it never opens', async () => {
    const id = insertTask({
      title: 'AC3 Cancel Scheduled',
      flash_start_at: new Date(Date.now() + 3600000).toISOString(), // 1h from now
      flash_minutes: 30,
      flash_bonus: 2,
    });
    await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC3 Cancel Scheduled',
      special_mode: 'flash',
      flash_cancel: '1',
    });

    const task = getTask(id);
    expect(task.flash_start_at).toBeNull();
    expect(task.flash_minutes).toBeNull();
    expect(task.flash_bonus).toBeNull();
  });

  test('cancelling an ACTIVE window closes it immediately: a subsequent submit banks nothing, and the already-banked bonus survives in getPoints() and leaderboard()', async () => {
    const id = insertTask({
      title: 'AC3 Cancel Active',
      worth: 1,
      flash_start_at: new Date(Date.now() - 60000).toISOString(), // started 1 min ago
      flash_minutes: 60,
      flash_bonus: 3,
    });

    // Bank one submission WHILE it is active.
    const bankedGuest = insertGuest();
    const banked = await submissions.submitPhoto({
      guestId: bankedGuest,
      taskId: id,
      file: writeOriginal(),
      caption: '',
      nowMs: Date.now(),
    });
    expect(banked.status).toBe('created');
    expect(scoring.getPoints(bankedGuest)).toBe(4); // worth 1 + flash bonus 3

    // Cancel via the edit route.
    await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC3 Cancel Active',
      special_mode: 'flash',
      flash_cancel: '1',
    });
    const task = getTask(id);
    expect(task.flash_start_at).toBeNull();
    expect(task.flash_bonus).toBeNull();
    expect(task.flash_minutes).toBeNull();

    // Already-banked bonus is untouched.
    expect(scoring.getPoints(bankedGuest)).toBe(4);
    const board = scoring.leaderboard();
    const row = board.find((r) => r.id === bankedGuest);
    expect(row.points).toBe(4);

    // A submit AFTER cancel (different guest) banks nothing extra.
    const afterGuest = insertGuest();
    const after = await submissions.submitPhoto({
      guestId: afterGuest,
      taskId: id,
      file: writeOriginal(),
      caption: '',
      nowMs: Date.now(),
    });
    expect(after.status).toBe('created');
    expect(scoring.getPoints(afterGuest)).toBe(1); // worth only, no bonus
  });

  test('cancel short-circuits every other flash field — an empty/invalid duration and a blank Pick-a-time still cancel cleanly', async () => {
    const id = insertTask({
      title: 'AC3 Cancel Ignores Bad Fields',
      flash_start_at: new Date(Date.now() + 60000).toISOString(),
      flash_minutes: 15,
      flash_bonus: 1,
    });
    const res = await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC3 Cancel Ignores Bad Fields',
      special_mode: 'flash',
      flash_cancel: '1',
      flash_bonus: '', // would be invalid_bonus if validated
      flash_minutes: '0', // would be invalid_minutes if validated
      flash_start_mode: 'later',
      flash_date: '',
      flash_time: '', // would be invalid_time/invalid_day if validated
    });
    expect([302, 303]).toContain(res.status);
    const task = getTask(id);
    expect(task.flash_start_at).toBeNull();
    expect(task.flash_bonus).toBeNull();
    expect(task.flash_minutes).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC4: invalid input is refused, not coerced — stored values left unchanged.
// ---------------------------------------------------------------------------
describe('AC4: invalid input is refused, not coerced', () => {
  function armedBaseline(title) {
    return insertTask({
      title,
      flash_start_at: new Date(Date.now() + 3600000).toISOString(),
      flash_minutes: 10,
      flash_bonus: 2,
    });
  }

  test('missing minutes is refused, task unchanged', async () => {
    const id = armedBaseline('AC4 Missing Minutes');
    const res = await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC4 Missing Minutes',
      special_mode: 'flash',
      flash_bonus: 2,
      flash_start_mode: 'now',
    });
    const task = getTask(id);
    expect(task.flash_minutes).toBe(10);
    expect(decodeURIComponent(res.headers.location)).toMatch(/minute/i);
  });

  test('zero minutes is refused', async () => {
    const id = armedBaseline('AC4 Zero Minutes');
    await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC4 Zero Minutes',
      special_mode: 'flash',
      flash_bonus: 2,
      flash_minutes: 0,
      flash_start_mode: 'now',
    });
    expect(getTask(id).flash_minutes).toBe(10);
  });

  test('negative minutes is refused', async () => {
    const id = armedBaseline('AC4 Negative Minutes');
    await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC4 Negative Minutes',
      special_mode: 'flash',
      flash_bonus: 2,
      flash_minutes: -5,
      flash_start_mode: 'now',
    });
    expect(getTask(id).flash_minutes).toBe(10);
  });

  test('non-integer minutes is refused', async () => {
    const id = armedBaseline('AC4 Decimal Minutes');
    await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC4 Decimal Minutes',
      special_mode: 'flash',
      flash_bonus: 2,
      flash_minutes: '7.5',
      flash_start_mode: 'now',
    });
    expect(getTask(id).flash_minutes).toBe(10);
  });

  test('bonus outside 1-3 is refused (0 and 4)', async () => {
    const id = armedBaseline('AC4 Bad Bonus');
    await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC4 Bad Bonus',
      special_mode: 'flash',
      flash_bonus: 0,
      flash_minutes: 10,
      flash_start_mode: 'now',
    });
    expect(getTask(id).flash_bonus).toBe(2);

    await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC4 Bad Bonus',
      special_mode: 'flash',
      flash_bonus: 4,
      flash_minutes: 11, // differ so this can't accidentally read as a no-op
      flash_start_mode: 'now',
    });
    expect(getTask(id).flash_bonus).toBe(2);
    expect(getTask(id).flash_minutes).toBe(10);
  });

  test('a scheduled date that is not a configured event day is refused', async () => {
    const id = armedBaseline('AC4 Bad Day');
    await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC4 Bad Day',
      special_mode: 'flash',
      flash_bonus: 3,
      flash_minutes: 40,
      flash_start_mode: 'later',
      flash_date: '2026-12-25', // outside the configured Aug 7-9 range
      flash_time: '19:00',
    });
    const task = getTask(id);
    expect(task.flash_minutes).toBe(10);
    expect(task.flash_bonus).toBe(2);
  });

  test('a missing time when Starts=Pick a time is refused, never silently arms at midnight', async () => {
    const id = armedBaseline('AC4 Missing Time');
    const res = await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC4 Missing Time',
      special_mode: 'flash',
      flash_bonus: 3,
      flash_minutes: 40,
      flash_start_mode: 'later',
      flash_date: DAY3,
      flash_time: '', // the field carries no `required` -- posts ""
    });
    expect([302, 303]).toContain(res.status); // never a 500
    const task = getTask(id);
    expect(task.flash_minutes).toBe(10);
    // Never silently coerced to midnight either.
    expect(task.flash_start_at).not.toMatch(/T07:00:00\.000Z$/); // Boise midnight in UTC
  });

  test('a malformed time when Starts=Pick a time is refused', async () => {
    const id = armedBaseline('AC4 Malformed Time');
    await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC4 Malformed Time',
      special_mode: 'flash',
      flash_bonus: 3,
      flash_minutes: 40,
      flash_start_mode: 'later',
      flash_date: DAY3,
      flash_time: 'not-a-time',
    });
    expect(getTask(id).flash_minutes).toBe(10);
  });

  test('a scheduled instant already in the past is refused', async () => {
    // Reconfigure the wedding dates to a range clearly in the past relative
    // to the real wall clock (this sandbox's real Date.now() is mid-2026 --
    // see this file's header comment), restored afterward so it cannot leak
    // into any later test in this file.
    const original = require('../src/db').getEventConfig();
    await adminAgent.post('/admin/config').type('form').send({
      timezone: TIMEZONE,
      start_date: '2026-01-01',
      end_date: '2026-01-03',
    });

    const id = armedBaseline('AC4 Past Instant');
    await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC4 Past Instant',
      special_mode: 'flash',
      flash_bonus: 3,
      flash_minutes: 40,
      flash_start_mode: 'later',
      flash_date: '2026-01-02',
      flash_time: '09:00',
    });
    const task = getTask(id);
    expect(task.flash_minutes).toBe(10); // unchanged -- refused

    await adminAgent.post('/admin/config').type('form').send({
      timezone: original.timezone,
      start_date: original.startDate,
      end_date: original.endDate,
    });
  });

  test('arming a flash on a HIDDEN task is refused -- guests could never reach it', async () => {
    const id = insertTask({ title: 'AC4 Hidden Task', special_mode: 'hidden' });
    const res = await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC4 Hidden Task',
      special_mode: 'flash',
      flash_bonus: 2,
      flash_minutes: 15,
      flash_start_mode: 'now',
    });
    const task = getTask(id);
    expect(task.flash_start_at).toBeNull();
    expect(task.flash_bonus).toBeNull();
    expect(decodeURIComponent(res.headers.location)).toMatch(/hidden/i);
  });

  test('the CREATE path is NOT refused for not_live: a raw special_mode=flash normalizes to MODE_NONE (live) on create, so the task saves with its flash trio intact', async () => {
    const res = await adminAgent
      .post('/admin/tasks')
      .type('form')
      .send({
        title: 'AC4 Create Hidden Flash',
        special_mode: 'flash', // falls back to MODE_NONE -- so this is actually LIVE
        flash_bonus: 2,
        flash_minutes: 15,
        flash_start_mode: 'now',
        ...BADGE,
      });
    // A 'flash' raw mode on CREATE normalizes to MODE_NONE (live) -- so this
    // one is NOT refused for not_live; assert it succeeds instead, closing
    // the loop that not_live can genuinely never fire on create.
    expect([302, 303]).toContain(res.status);
    const task = db.prepare('SELECT * FROM tasks WHERE title = ?').get('AC4 Create Hidden Flash');
    expect(task.flash_bonus).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AC5: specials never stack, in any direction.
// ---------------------------------------------------------------------------
describe('AC5: specials never stack, in any direction', () => {
  test('arming a flash on a task that is already a LIVE one-day-only challenge is refused', async () => {
    const id = insertTask({
      title: 'AC5 Already Oneday',
      special_mode: 'oneday',
      special_date: DAY3, // future -- sealed, spoken for
      special_bonus: 1,
    });
    const res = await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC5 Already Oneday',
      special_mode: 'flash',
      flash_bonus: 2,
      flash_minutes: 15,
      flash_start_mode: 'now',
    });
    const task = getTask(id);
    expect(task.flash_start_at).toBeNull();
    expect(task.special_date).toBe(DAY3); // one-day pair also unchanged
    expect(decodeURIComponent(res.headers.location)).toContain('already');
  });

  test('arming a flash on the LUCKY task is refused', async () => {
    const id = insertTask({
      title: 'AC5 Already Lucky',
      lucky_date: DAY3, // future -- spoken for
      lucky_bonus: 2,
    });
    const res = await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC5 Already Lucky',
      special_mode: 'flash',
      flash_bonus: 2,
      flash_minutes: 15,
      flash_start_mode: 'now',
    });
    const task = getTask(id);
    expect(task.flash_start_at).toBeNull();
    expect(task.lucky_date).toBe(DAY3);
    expect(decodeURIComponent(res.headers.location)).toContain('already');
  });

  test('setting a challenge date on a task with a SCHEDULED flash is refused', async () => {
    const id = insertTask({
      title: 'AC5 Flash Blocks Oneday',
      flash_start_at: new Date(Date.now() + 3600000).toISOString(),
      flash_minutes: 30,
      flash_bonus: 1,
    });
    const res = await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC5 Flash Blocks Oneday',
      special_mode: 'oneday',
      special_date: DAY1,
      special_bonus: 1,
    });
    const task = getTask(id);
    expect(task.special_date).toBeNull();
    expect(task.flash_minutes).toBe(30); // flash trio also unchanged
    expect(decodeURIComponent(res.headers.location)).toContain('already');
  });

  test('setting the lucky pick on a task with an ACTIVE flash is refused', async () => {
    const id = insertTask({
      title: 'AC5 Flash Blocks Lucky',
      flash_start_at: new Date(Date.now() - 60000).toISOString(),
      flash_minutes: 60,
      flash_bonus: 2,
    });
    const res = await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC5 Flash Blocks Lucky',
      special_mode: 'lucky',
      lucky_date: DAY1,
      lucky_bonus: 2,
    });
    const task = getTask(id);
    expect(task.lucky_date).toBeNull();
    expect(task.flash_minutes).toBe(60);
    expect(decodeURIComponent(res.headers.location)).toContain('already');
  });
});

// ---------------------------------------------------------------------------
// The no-op rule: a save that changes no flash field must not restart a
// running window; any save that DOES change bonus/duration, or that uses
// Pick a time, is a real re-arm; an EXPIRED flash is always a real re-arm.
// ---------------------------------------------------------------------------
describe('the no-op rule (issue #763 "Wire format" section)', () => {
  test('a title-only resave of an ACTIVE flash, with Starts=Now and the SAME bonus/minutes, leaves flash_start_at exactly as stored', async () => {
    const storedStart = new Date(Date.now() - 3 * 60000).toISOString(); // 3 min ago
    const id = insertTask({
      title: 'NoOp Active',
      flash_start_at: storedStart,
      flash_minutes: 30,
      flash_bonus: 2,
    });
    await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'NoOp Active Renamed',
      special_mode: 'flash',
      flash_bonus: 2,
      flash_minutes: 30,
      flash_start_mode: 'now',
    });
    const task = getTask(id);
    expect(task.flash_start_at).toBe(storedStart); // untouched, not re-derived
    expect(task.title).toBe('NoOp Active Renamed');
  });

  test('a title-only resave of a SCHEDULED flash, same bonus/minutes, Starts=Now: the scheduled instant is untouched, still SCHEDULED', async () => {
    const storedStart = new Date(Date.now() + 3600000).toISOString();
    const id = insertTask({
      title: 'NoOp Scheduled',
      flash_start_at: storedStart,
      flash_minutes: 20,
      flash_bonus: 1,
    });
    await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'NoOp Scheduled',
      special_mode: 'flash',
      flash_bonus: 1,
      flash_minutes: 20,
      flash_start_mode: 'now',
    });
    const task = getTask(id);
    expect(task.flash_start_at).toBe(storedStart);
    expect(tasksSvc.flashState(task, Date.now())).toBe('scheduled');
  });

  test('a DIFFERENT bonus/duration is a REAL re-arm, not a no-op -- flash_start_at moves to a fresh "now" instant', async () => {
    const storedStart = new Date(Date.now() - 3 * 60000).toISOString();
    const id = insertTask({
      title: 'RealRearm DifferentBonus',
      flash_start_at: storedStart,
      flash_minutes: 30,
      flash_bonus: 2,
    });
    const before = Date.now();
    await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'RealRearm DifferentBonus',
      special_mode: 'flash',
      flash_bonus: 3, // different
      flash_minutes: 30,
      flash_start_mode: 'now',
    });
    const task = getTask(id);
    expect(task.flash_start_at).not.toBe(storedStart);
    expect(Date.parse(task.flash_start_at)).toBeGreaterThanOrEqual(before - 1000);
    expect(task.flash_bonus).toBe(3);
  });

  test('Pick a time is ALWAYS a real re-arm, even with the identical bonus/minutes', async () => {
    const storedStart = new Date(Date.now() + 3600000).toISOString();
    const id = insertTask({
      title: 'RealRearm PickTime',
      flash_start_at: storedStart,
      flash_minutes: 20,
      flash_bonus: 1,
    });
    await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'RealRearm PickTime',
      special_mode: 'flash',
      flash_bonus: 1,
      flash_minutes: 20,
      flash_start_mode: 'later',
      flash_date: DAY2,
      flash_time: '08:00',
    });
    const task = getTask(id);
    const expected = eventDaysSvc.eventLocalInstant(DAY2, TIMEZONE, 8, 0).toISOString();
    expect(task.flash_start_at).toBe(expected);
    expect(task.flash_start_at).not.toBe(storedStart);
  });

  test('an EXPIRED flash is always a real re-arm -- resaving the identical bonus/minutes arms it fresh, not a no-op', async () => {
    const expiredStart = new Date(Date.now() - 3600000).toISOString(); // started 1h ago
    const id = insertTask({
      title: 'RealRearm Expired',
      flash_start_at: expiredStart,
      flash_minutes: 10, // ended 50 minutes ago
      flash_bonus: 2,
    });
    expect(tasksSvc.flashState(getTask(id), Date.now())).toBe('expired');

    const before = Date.now();
    await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'RealRearm Expired',
      special_mode: 'flash',
      flash_bonus: 2, // identical to stored
      flash_minutes: 10, // identical to stored
      flash_start_mode: 'now',
    });
    const task = getTask(id);
    expect(task.flash_start_at).not.toBe(expiredStart);
    expect(Date.parse(task.flash_start_at)).toBeGreaterThanOrEqual(before - 1000);
    expect(tasksSvc.flashState(task, Date.now())).toBe('active');
  });

  test('the create path has no stored trio to compare against, so its very first arm is never treated as a no-op', async () => {
    const before = Date.now();
    const res = await adminAgent
      .post('/admin/tasks')
      .type('form')
      .send({
        title: 'NoOp Create Path',
        special_mode: 'flash',
        flash_bonus: 1,
        flash_minutes: 5,
        flash_start_mode: 'now',
        ...BADGE,
      });
    expect([302, 303]).toContain(res.status);
    const task = db.prepare('SELECT * FROM tasks WHERE title = ?').get('NoOp Create Path');
    expect(task.flash_bonus).toBe(1);
    expect(Date.parse(task.flash_start_at)).toBeGreaterThanOrEqual(before - 1000);
  });
});

// ---------------------------------------------------------------------------
// The GET /admin/tasks projection (data contract for admin-tasks.js's
// openEdit(), verified in full by tests/admin-tasks-script.test.js's own
// hand-built fixture) — this section proves the SERVER SIDE actually emits
// the attributes that fixture assumes.
// ---------------------------------------------------------------------------
describe('GET /admin/tasks flash projection', () => {
  function cardFor(html, taskId) {
    const start = html.indexOf(`data-task-id="${taskId}"`);
    expect(start).toBeGreaterThan(-1);
    return html.slice(Math.max(0, start - 200), start + 2000);
  }

  test('an active flash emits data-flash-state="active", the trio, and a strip label with minutes left', async () => {
    const id = insertTask({
      title: 'Projection Active',
      flash_start_at: new Date(Date.now() - 60000).toISOString(),
      flash_minutes: 10,
      flash_bonus: 3,
    });
    const html = (await adminAgent.get('/admin/tasks')).text;
    const card = cardFor(html, id);
    expect(card).toContain('data-flash-state="active"');
    expect(card).toContain('data-flash-bonus="3"');
    expect(card).toContain('data-flash-minutes="10"');
    expect(card).toMatch(/data-flash-strip-label="Live now — \d+ min left"/);
  });

  test('a scheduled flash emits data-flash-state="scheduled" and a "Starts at" strip label with the board-style time', async () => {
    const startAt = eventDaysSvc.eventLocalInstant(DAY3, TIMEZONE, 19, 0).toISOString();
    const id = insertTask({
      title: 'Projection Scheduled',
      flash_start_at: startAt,
      flash_minutes: 20,
      flash_bonus: 1,
    });
    const html = (await adminAgent.get('/admin/tasks')).text;
    const card = cardFor(html, id);
    expect(card).toContain('data-flash-state="scheduled"');
    expect(card).toContain('data-flash-strip-label="Starts at 7:00 PM"');
    expect(card).toContain('Flash at 7:00 PM'); // the board chip
  });

  test('an ordinary task emits data-flash-state="none" and no flash chip', async () => {
    const id = insertTask({ title: 'Projection None' });
    const html = (await adminAgent.get('/admin/tasks')).text;
    const card = cardFor(html, id);
    expect(card).toContain('data-flash-state="none"');
    expect(card).not.toContain('admin-chip-flash');
  });
});
