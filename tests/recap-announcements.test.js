// tests/recap-announcements.test.js
// Issue #778 — recap announcements (split from #644): a task going live, a
// one-day-only challenge unsealing, a flash window opening. All three are
// DERIVED at read time from task state — see src/services/notifications.js's
// "Announcements" section and DESIGN.md's "Recap" ADR for the design.
//
// AC1 — a task going live announces it (unhide via edit, and create-as-live).
// AC2 — only real liveness transitions announce (no-op edits, hide, delete).
// AC3 — creating hidden does not announce (flood case: 20 hidden creates).
// AC4 — a challenge unseals without a scheduled job.
// AC5 — an expired flash does not announce; an open one does.
// AC6 — a task announced live, then hidden again, never announces.
//
// REQUIRE ORDER: loadApp() must run before any require that pulls in config
// or db (see tests/helpers/testApp.js).
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const { loadApp, makeAdminAgent, signInGuest } = require('./helpers/testApp');

let app;
let db;
let adminAgent;
let notifications;
let eventDaysSvc;

const TIMEZONE = 'America/Boise'; // src/db.js's getEventConfig fallback.
const TODAY = '2026-08-07'; // matches the default event's DAY1 (fixture-only — see tests/flash-admin-surface.test.js's own comment for why this convention is safe: it need never equal the REAL wall-clock "today," since every test in this file that cares about "today" passes an explicit clock rather than relying on the default one).

beforeAll(async () => {
  const result = loadApp();
  app = result.app;
  db = result.db;
  adminAgent = await makeAdminAgent(app);
  notifications = require('../src/services/notifications');
  eventDaysSvc = require('../src/services/event-days');
});

// One badge_icon every create-route POST in this file carries — badge is
// required server-side (issue #682 AC-A), unrelated to what this file tests.
const BADGE = { badge_icon: 'favorite', badge_name: 'Announce Test Badge' };

let seq = 0;

/**
 * Insert a task row directly (bypassing the admin routes) so a test can pin
 * an exact prior state — including live_since, which no admin route lets a
 * test set directly — before exercising the real write seam under test.
 * Mirrors tests/flash-admin-surface.test.js's insertTask helper.
 */
function insertTask(overrides) {
  seq += 1;
  const cols = Object.assign(
    {
      title: `Announce Task ${seq}`,
      worth: 1,
      special_mode: 'none',
      special_date: null,
      special_bonus: null,
      flash_start_at: null,
      flash_minutes: null,
      flash_bonus: null,
      live_since: null,
    },
    overrides
  );
  return db
    .prepare(
      `INSERT INTO tasks
         (title, worth, special_mode, special_date, special_bonus,
          flash_start_at, flash_minutes, flash_bonus, live_since)
       VALUES (@title, @worth, @special_mode, @special_date, @special_bonus,
               @flash_start_at, @flash_minutes, @flash_bonus, @live_since)`
    )
    .run(cols).lastInsertRowid;
}

function getTask(id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

function insertGuest() {
  seq += 1;
  const token = `announce-guest-${seq}-${crypto.randomUUID()}`;
  const id = db
    .prepare('INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)')
    .run(token, 'Announce Guest').lastInsertRowid;
  return { id, token };
}

// Same technique recap.test.js uses: back-date the guest's created_at (the
// checkpoint, since recap_checked_at is NULL until they first open the
// recap) well clear of any timestamp a test writes, so "newer than
// checkpoint" is never a same-second race.
function backdateGuest(guestId, createdAt) {
  db.prepare(`UPDATE guests SET created_at = ? WHERE id = ?`).run(createdAt, guestId);
}

// A row's `parts` field is a structured array, not pre-built HTML — join it
// back to plain text the way a guest would read it (mirrors recap.test.js's
// own partsText helper).
function partsText(parts) {
  return (parts || []).map((part) => part.text).join('');
}

function announceRowFor(rows, title) {
  return rows.filter((r) => r.kind === 'announce' && partsText(r.parts).includes(title));
}

// ---------------------------------------------------------------------------
// AC1 — a task going live announces it.
// ---------------------------------------------------------------------------
describe('AC1: a task going live announces it', () => {
  it('created hidden, then made live via POST /admin/tasks/:id/edit, announces exactly once, linking to /tasks', async () => {
    const guest = insertGuest();
    backdateGuest(guest.id, '2020-01-01 00:00:00');
    const taskId = insertTask({ title: 'AC1 Hidden Then Live', special_mode: 'hidden' });
    expect(getTask(taskId).live_since).toBeNull();

    const res = await adminAgent
      .post(`/admin/tasks/${taskId}/edit`)
      .type('form')
      .send({ title: 'AC1 Hidden Then Live', special_mode: 'none' });
    expect([302, 303]).toContain(res.status);

    const task = getTask(taskId);
    expect(task.special_mode).toBe('none');
    expect(task.live_since).not.toBeNull();

    const rows = notifications.getRecap(guest.id).rows;
    const announceRows = announceRowFor(rows, 'AC1 Hidden Then Live');
    expect(announceRows).toHaveLength(1);
    expect(announceRows[0].href).toBe('/tasks');
  });

  it('made live via the /active un-hide toggle, also announces exactly once', async () => {
    const guest = insertGuest();
    backdateGuest(guest.id, '2020-01-01 00:00:00');
    const taskId = insertTask({ title: 'AC1 Toggle Then Live', special_mode: 'hidden' });

    const res = await adminAgent.post(`/admin/tasks/${taskId}/active`);
    expect([302, 303]).toContain(res.status);

    const task = getTask(taskId);
    expect(task.special_mode).not.toBe('hidden');
    expect(task.live_since).not.toBeNull();

    const rows = notifications.getRecap(guest.id).rows;
    expect(announceRowFor(rows, 'AC1 Toggle Then Live')).toHaveLength(1);
  });

  it('created already live (not hidden) after the guest joined, announces exactly once', async () => {
    const guest = insertGuest();
    backdateGuest(guest.id, '2020-01-01 00:00:00');

    const res = await adminAgent
      .post('/admin/tasks')
      .type('form')
      .send(Object.assign({ title: 'AC1 Created Live', special_mode: 'none' }, BADGE));
    expect([302, 303]).toContain(res.status);

    const task = db.prepare('SELECT * FROM tasks WHERE title = ?').get('AC1 Created Live');
    expect(task.live_since).not.toBeNull();

    const rows = notifications.getRecap(guest.id).rows;
    const announceRows = announceRowFor(rows, 'AC1 Created Live');
    expect(announceRows).toHaveLength(1);
    expect(announceRows[0].href).toBe('/tasks');
  });
});

// ---------------------------------------------------------------------------
// AC2 — only real liveness transitions announce a task as newly live.
// ---------------------------------------------------------------------------
describe('AC2: only real liveness transitions announce', () => {
  it('editing title/worth on an already-live task leaves live_since unchanged and adds no new announcement', async () => {
    const guest = insertGuest();
    const taskId = insertTask({
      title: 'AC2 No Liveness Change',
      special_mode: 'none',
      live_since: '2020-06-01 00:00:00',
    });
    // Announcements are GLOBAL broadcasts (issue #778 Design), not scoped to
    // one guest — a fresh guest's checkpoint can legitimately pick up a
    // DIFFERENT task's live-transition from elsewhere in this test file's
    // shared database. So the "no announcement" assertions here are scoped
    // to THIS task by title, never a bare total unread count.
    backdateGuest(guest.id, '2025-01-01 00:00:00'); // AFTER live_since -- already "seen"
    expect(announceRowFor(notifications.getRecap(guest.id).rows, 'AC2 No Liveness Change')).toHaveLength(
      0
    );

    await adminAgent
      .post(`/admin/tasks/${taskId}/edit`)
      .type('form')
      .send({ title: 'AC2 No Liveness Change (renamed)', worth: '3', special_mode: 'none' });

    const task = getTask(taskId);
    expect(task.live_since).toBe('2020-06-01 00:00:00'); // byte-identical, not just "still non-null"
    expect(
      announceRowFor(notifications.getRecap(guest.id).rows, 'AC2 No Liveness Change')
    ).toHaveLength(0);
  });

  it('moving special_date to a day other than today does not bump live_since or announce', async () => {
    const guest = insertGuest();
    const taskId = insertTask({
      title: 'AC2 Date Move Not Today',
      special_mode: 'none',
      live_since: '2020-06-01 00:00:00',
    });
    backdateGuest(guest.id, '2025-01-01 00:00:00');

    // A configured wedding day (resolveSpecialPairWrite's own validation
    // requires one of these), just not TODAY -- the "other day" case AC2
    // itself names, matching tests/flash-admin-surface.test.js's DAY3
    // fixture convention for the identical reason.
    const OTHER_CONFIGURED_DAY = '2026-08-09';
    await adminAgent.post(`/admin/tasks/${taskId}/edit`).type('form').send({
      title: 'AC2 Date Move Not Today',
      special_mode: 'oneday',
      special_date: OTHER_CONFIGURED_DAY,
      special_bonus: '2',
    });

    const task = getTask(taskId);
    expect(task.special_mode).toBe('oneday');
    expect(task.special_date).toBe(OTHER_CONFIGURED_DAY);
    expect(task.live_since).toBe('2020-06-01 00:00:00'); // unchanged: liveness never flipped

    // No announce from either source, for THIS task: not a live-transition
    // (live_since didn't move) and not an unseal (OTHER_CONFIGURED_DAY is
    // not "today" under the default clock this call uses).
    expect(
      announceRowFor(notifications.getRecap(guest.id).rows, 'AC2 Date Move Not Today')
    ).toHaveLength(0);
  });

  it('hiding a live task renders no announcement row (it would have, had it stayed live)', async () => {
    const guest = insertGuest();
    backdateGuest(guest.id, '2020-01-01 00:00:00');
    const taskId = insertTask({ title: 'AC2 Hide Live Task', special_mode: 'none' });
    await adminAgent
      .post(`/admin/tasks/${taskId}/edit`)
      .type('form')
      .send({ title: 'AC2 Hide Live Task', worth: '2', special_mode: 'none' });
    // Sanity: with live_since still null (worth-only edit never bumps it),
    // and the task genuinely live, force a bump so the "would have shown"
    // half of this test is meaningful.
    db.prepare(`UPDATE tasks SET live_since = '2020-06-01 00:00:00' WHERE id = ?`).run(taskId);
    expect(announceRowFor(notifications.getRecap(guest.id).rows, 'AC2 Hide Live Task')).toHaveLength(
      1
    );

    await adminAgent
      .post(`/admin/tasks/${taskId}/edit`)
      .type('form')
      .send({ title: 'AC2 Hide Live Task', special_mode: 'hidden' });
    expect(announceRowFor(notifications.getRecap(guest.id).rows, 'AC2 Hide Live Task')).toHaveLength(
      0
    );
  });

  it('deleting a task renders no announcement row', async () => {
    const guest = insertGuest();
    backdateGuest(guest.id, '2020-01-01 00:00:00');
    const taskId = insertTask({
      title: 'AC2 Delete Live Task',
      special_mode: 'none',
      live_since: '2020-06-01 00:00:00',
    });
    expect(
      announceRowFor(notifications.getRecap(guest.id).rows, 'AC2 Delete Live Task')
    ).toHaveLength(1);

    const res = await adminAgent.post(`/admin/tasks/${taskId}/delete`);
    expect([302, 303]).toContain(res.status);
    expect(getTask(taskId)).toBeUndefined();
    expect(
      announceRowFor(notifications.getRecap(guest.id).rows, 'AC2 Delete Live Task')
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC3 — creating hidden does not announce (the flood case).
// ---------------------------------------------------------------------------
describe('AC3: creating hidden does not announce', () => {
  it('twenty tasks created special_mode=hidden yield zero announcement rows for a guest opening the recap', async () => {
    const guest = insertGuest();
    backdateGuest(guest.id, '2020-01-01 00:00:00');

    for (let i = 0; i < 20; i++) {
      const res = await adminAgent
        .post('/admin/tasks')
        .type('form')
        .send(Object.assign({ title: `AC3 Hidden Setup ${i}`, special_mode: 'hidden' }, BADGE));
      expect([302, 303]).toContain(res.status);
    }

    const nullCount = db
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE title LIKE 'AC3 Hidden Setup%' AND live_since IS NULL`)
      .get().n;
    expect(nullCount).toBe(20);

    const rows = notifications.getRecap(guest.id).rows;
    expect(rows.some((r) => r.kind === 'announce' && partsText(r.parts).includes('AC3 Hidden Setup'))).toBe(
      false
    );
  });
});

// ---------------------------------------------------------------------------
// AC4 — a challenge unseals without a scheduled job.
// ---------------------------------------------------------------------------
describe('AC4: a challenge unseals without a scheduled job', () => {
  it('special_date === today yields one announcement row linking to /tasks, computed at read time', () => {
    const guest = insertGuest();
    backdateGuest(guest.id, '2020-01-01 00:00:00');
    insertTask({
      title: 'AC4 Today Challenge',
      special_mode: 'oneday',
      special_date: TODAY,
      special_bonus: 2,
    });

    const dayStartMs = eventDaysSvc.dayOpensAt(TODAY, TIMEZONE).getTime();
    const clock = { todayIso: TODAY, nowMs: dayStartMs + 60000, timezone: TIMEZONE };

    const rows = notifications.getRecap(guest.id, { clock }).rows;
    const announceRows = announceRowFor(rows, 'AC4 Today Challenge');
    expect(announceRows).toHaveLength(1);
    expect(announceRows[0].href).toBe('/tasks');
    expect(notifications.getUnreadCount(guest.id, clock)).toBeGreaterThanOrEqual(1);
  });

  it('special_date pointing at a DIFFERENT day yields no announcement row (inverts the positive case above)', () => {
    const guest = insertGuest();
    backdateGuest(guest.id, '2020-01-01 00:00:00');
    insertTask({
      title: 'AC4 Other Day Challenge',
      special_mode: 'oneday',
      special_date: '2026-08-08',
      special_bonus: 2,
    });

    const dayStartMs = eventDaysSvc.dayOpensAt(TODAY, TIMEZONE).getTime();
    const clock = { todayIso: TODAY, nowMs: dayStartMs + 60000, timezone: TIMEZONE };

    const rows = notifications.getRecap(guest.id, { clock }).rows;
    expect(rows.some((r) => partsText(r.parts).includes('AC4 Other Day Challenge'))).toBe(false);
  });

  it('a guest who already opened the recap today (checkpoint past the day start) no longer sees the unseal row', () => {
    const guest = insertGuest();
    const dayStartMs = eventDaysSvc.dayOpensAt(TODAY, TIMEZONE).getTime();
    // Checkpoint 1 minute AFTER today's event-local start -- already checked
    // today, so the unseal is no longer news (ephemeral by construction).
    backdateGuest(
      guest.id,
      new Date(dayStartMs + 60000).toISOString().slice(0, 19).replace('T', ' ')
    );
    insertTask({
      title: 'AC4 Already Checked Today',
      special_mode: 'oneday',
      special_date: TODAY,
      special_bonus: 2,
    });

    const clock = { todayIso: TODAY, nowMs: dayStartMs + 120000, timezone: TIMEZONE };
    const rows = notifications.getRecap(guest.id, { clock }).rows;
    expect(rows.some((r) => partsText(r.parts).includes('AC4 Already Checked Today'))).toBe(false);
  });

  it('no setInterval or other scheduled job drives announcement derivation', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'services', 'notifications.js'),
      'utf8'
    );
    expect(source).not.toContain('setInterval');
    expect(source).not.toContain('setTimeout');
  });
});

// ---------------------------------------------------------------------------
// AC5 — an expired flash does not announce; an open one does.
// ---------------------------------------------------------------------------
describe('AC5: an expired flash does not announce; an open one does', () => {
  it('an expired flash window renders no announcement row', () => {
    const guest = insertGuest();
    backdateGuest(guest.id, '2020-01-01 00:00:00');
    const start = new Date('2026-08-07T10:00:00.000Z');
    insertTask({
      title: 'AC5 Expired Flash',
      special_mode: 'none',
      flash_start_at: start.toISOString(),
      flash_minutes: 20,
      flash_bonus: 2,
    });

    const nowMs = start.getTime() + 21 * 60000; // 1 minute past the 20-minute window
    const clock = { todayIso: TODAY, nowMs, timezone: TIMEZONE };

    const rows = notifications.getRecap(guest.id, { clock }).rows;
    expect(rows.some((r) => partsText(r.parts).includes('AC5 Expired Flash'))).toBe(false);
  });

  it('a currently-open flash window renders exactly one announcement row', () => {
    const guest = insertGuest();
    backdateGuest(guest.id, '2020-01-01 00:00:00');
    const start = new Date('2026-08-07T10:00:00.000Z');
    insertTask({
      title: 'AC5 Open Flash',
      special_mode: 'none',
      flash_start_at: start.toISOString(),
      flash_minutes: 20,
      flash_bonus: 2,
    });

    const nowMs = start.getTime() + 5 * 60000; // 5 minutes in, still open
    const clock = { todayIso: TODAY, nowMs, timezone: TIMEZONE };

    const rows = notifications.getRecap(guest.id, { clock }).rows;
    const announceRows = announceRowFor(rows, 'AC5 Open Flash');
    expect(announceRows).toHaveLength(1);
    expect(announceRows[0].href).toBe('/tasks');
    // The copy names the actionable bonus AND window length (issue #778's
    // own approved copy, "Flash on now — +3 for 20 minutes") -- a bare "a
    // flash bonus is open" with neither number is not enough to steer a
    // guest toward it.
    expect(partsText(announceRows[0].parts)).toContain('+2');
    expect(partsText(announceRows[0].parts)).toContain('20 minutes');
  });

  it('an open flash the guest already checked since before it opened is not "new" again (inverts the open case above)', () => {
    const guest = insertGuest();
    const start = new Date('2026-08-07T10:00:00.000Z');
    // Checkpoint AFTER the flash's own start instant -- already seen.
    backdateGuest(guest.id, '2026-08-07 10:10:00');
    insertTask({
      title: 'AC5 Already Seen Flash',
      special_mode: 'none',
      flash_start_at: start.toISOString(),
      flash_minutes: 20,
      flash_bonus: 2,
    });

    const nowMs = start.getTime() + 12 * 60000; // still open
    const clock = { todayIso: TODAY, nowMs, timezone: TIMEZONE };

    const rows = notifications.getRecap(guest.id, { clock }).rows;
    expect(rows.some((r) => partsText(r.parts).includes('AC5 Already Seen Flash'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC6 — a task announced live, then hidden again, never announces.
// ---------------------------------------------------------------------------
describe('AC6: a task announced live, then hidden again, never announces', () => {
  it('a task that WAS announcing (checkpoint predates live_since) stops announcing the moment it is hidden', async () => {
    const guest = insertGuest();
    backdateGuest(guest.id, '2020-01-01 00:00:00');
    const taskId = insertTask({ title: 'AC6 Announced Then Hidden', special_mode: 'hidden' });

    await adminAgent
      .post(`/admin/tasks/${taskId}/edit`)
      .type('form')
      .send({ title: 'AC6 Announced Then Hidden', special_mode: 'none' });
    // Confirm it genuinely was announcing first -- otherwise "then hidden"
    // proves nothing.
    expect(
      announceRowFor(notifications.getRecap(guest.id).rows, 'AC6 Announced Then Hidden')
    ).toHaveLength(1);

    await adminAgent
      .post(`/admin/tasks/${taskId}/edit`)
      .type('form')
      .send({ title: 'AC6 Announced Then Hidden', special_mode: 'hidden' });

    expect(
      announceRowFor(notifications.getRecap(guest.id).rows, 'AC6 Announced Then Hidden')
    ).toHaveLength(0);
    // The stale stamp itself is untouched by hiding (only a real liveness
    // TRANSITION ever writes live_since) -- it is the liveTaskWhere gate on
    // the read side, not a cleared column, that suppresses the row.
    expect(getTask(taskId).live_since).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Edge case: getRecap/getUnreadCount with checkpoint === null (checkpointFor's
// contract: only a nonexistent guest id) — the announcements source must
// degrade the same way the other three sources already do, never throw.
// ---------------------------------------------------------------------------
describe('Edge case: no checkpoint (nonexistent guest id)', () => {
  it('both degrade to empty rather than throwing', () => {
    expect(notifications.getUnreadCount(999999999)).toBe(0);
    expect(notifications.getRecap(999999999).rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Migration: tasks.live_since (issue #778 plan step 1).
// ---------------------------------------------------------------------------
describe('Migration: tasks.live_since', () => {
  it('the column exists, defaults NULL, and the guard is idempotent on a second call', () => {
    const cols = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
    expect(cols).toContain('live_since');

    const dbModule = require('../src/db');
    expect(() => dbModule.ensureTaskLiveSinceColumn()).not.toThrow();

    // A task inserted with no live_since column supplied at all (the plain
    // shape most of this codebase's OTHER test files' insertTask helpers
    // already use) keeps it NULL -- exactly the "never spuriously announce a
    // pre-existing live task" contract issue #778's plan step 1 states.
    const id = db.prepare(`INSERT INTO tasks (title) VALUES (?)`).run('Migration Bare Insert')
      .lastInsertRowid;
    expect(getTask(id).live_since).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End-to-end: the strip and panel render an announce row through the real
// request pipeline (session.js's getUnreadCount call, render-locals.js's
// getRecap call), not just the notifications service in isolation.
// ---------------------------------------------------------------------------
describe('End-to-end: an announce row survives the real request pipeline', () => {
  it('a signed-in guest sees the announce row and its count via GET /', async () => {
    const guest = insertGuest();
    backdateGuest(guest.id, '2020-01-01 00:00:00');
    const taskId = insertTask({ title: 'E2E Live Task', special_mode: 'hidden' });
    await adminAgent
      .post(`/admin/tasks/${taskId}/edit`)
      .type('form')
      .send({ title: 'E2E Live Task', special_mode: 'none' });

    const agent = request.agent(app);
    signInGuest(app, guest.token, agent);
    const res = await agent.get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('recap-row-announce');
    expect(res.text).toContain('The hosts made <strong>E2E Live Task</strong> live');
    // Not asserting an exact count: this guest's 2020-01-01 checkpoint also
    // picks up every OTHER task earlier describe blocks in this file made
    // live (announcements are global broadcasts, not scoped to one guest —
    // see the "Announcements" section of src/services/notifications.js) —
    // asserting a specific total here would make this test's outcome depend
    // on execution order across describe blocks. The strip/chip DO reflect a
    // real positive count (never a stale zero) — matched via the plural-
    // agnostic "N new notification(s)" shape, and cross-checked against the
    // service's own count for this exact guest/request-shaped clock.
    expect(res.text).toMatch(/\d+ new notifications?/);
    expect(notifications.getUnreadCount(guest.id)).toBeGreaterThanOrEqual(1);
  });
});
