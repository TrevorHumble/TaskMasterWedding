// tests/lucky-task.test.js
// Issue #650 acceptance criteria 1-7 — the lucky task: a secret host-set
// bonus task per day, revealed only on completion.
//
// "Today" for both the guest submit path (src/services/submissions.js) and
// the admin setter's exclusivity guard (src/routes/admin.js's currentClock())
// comes from src/services/event-days.js's eventLocalDateString(timezone) —
// monkeypatched to a fixed date for this file's duration, the SAME
// shared-module-object technique tests/flash-engine.test.js and
// tests/oneday-challenge-engine.test.js already use. This only works because
// admin.js reads it through a live property lookup (eventDaysSvc.
// eventLocalDateString(...)), not a destructured constant captured at
// require time — see currentClock()'s own comment in src/routes/admin.js.
//
// REQUIRE ORDER: config/db/services are required only AFTER loadApp() sets
// DATA_DIR/DB_PATH — see tests/helpers/testApp.js.
'use strict';

const sharp = require('sharp');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { loadApp, makeAdminAgent, signInGuest } = require('./helpers/testApp');

let app;
let db;
let config;
let tasksSvc;
let submissions;
let photos;
let eventDaysSvc;
let adminAgent;
let uploadsDir;
let validJpeg;

const DAY1 = '2026-08-07'; // = YESTERDAY relative to FIXED_TODAY
const FIXED_TODAY = '2026-08-08';
const DAY3 = '2026-08-09'; // = TOMORROW relative to FIXED_TODAY

const BADGE = { badge_icon: 'favorite', badge_name: 'Test Badge' };

beforeAll(async () => {
  validJpeg = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 5, g: 5, b: 5 } },
  })
    .jpeg()
    .toBuffer();

  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;

  config = require('../config');
  tasksSvc = require('../src/services/tasks');
  submissions = require('../src/services/submissions');
  photos = require('../src/services/photos');
  eventDaysSvc = require('../src/services/event-days');
  uploadsDir = config.UPLOADS_DIR;

  adminAgent = await makeAdminAgent(app);
});

let originalEventLocalDateString;
beforeAll(() => {
  originalEventLocalDateString = eventDaysSvc.eventLocalDateString;
  eventDaysSvc.eventLocalDateString = () => FIXED_TODAY;
});
afterAll(() => {
  eventDaysSvc.eventLocalDateString = originalEventLocalDateString;
});

let seq = 0;
function insertGuest() {
  seq += 1;
  const token = `lucky-guest-${seq}-${crypto.randomUUID()}`;
  // Deliberately NOT "Lucky Guest" (AC2 review note): the masthead renders
  // res.locals.guest.name on every guest page, including GET /tasks, and
  // AC2's own tests assert the FULL rendered page text carries no "lucky"
  // substring at all -- a guest literally named "Lucky ..." would break that
  // assertion for a reason that has nothing to do with the secrecy rule
  // under test.
  const id = db
    .prepare(`INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)`)
    .run(token, 'Test Guest').lastInsertRowid;
  return { id, token };
}

// Task titles in this file deliberately avoid the substring "lucky" (same
// AC2 review note as insertGuest above) -- a task's HOST-CHOSEN title is
// guest-visible on every live task everywhere (the guest task list, the
// task detail page), so naming a fixture task "... Lucky ..." would make
// AC2's own page-text assertions fail for a naming reason, not a secrecy
// leak.
function insertTask({ title, worth = 1, luckyDate = null, luckyBonus = null } = {}) {
  seq += 1;
  return db
    .prepare(`INSERT INTO tasks (title, worth, lucky_date, lucky_bonus) VALUES (?, ?, ?, ?)`)
    .run(title || `Prize Task ${seq}`, worth, luckyDate, luckyBonus).lastInsertRowid;
}

function getTask(id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
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
// Engine unit checks: the SPECIAL_RULES lucky entry.
// ---------------------------------------------------------------------------
describe('the lucky SPECIAL_RULES entry', () => {
  const clock = { todayIso: FIXED_TODAY, nowMs: Date.parse(FIXED_TODAY + 'T12:00:00.000Z') };

  it('spokenFor: lucky_date today or later; paying: lucky_date === today with a valid 1-3 bonus', () => {
    expect(tasksSvc.whatSpecial({ lucky_date: FIXED_TODAY, lucky_bonus: 2 }, clock)).toBe('lucky');
    expect(tasksSvc.bonusForTask({ lucky_date: FIXED_TODAY, lucky_bonus: 2 }, clock)).toEqual({
      reason: 'lucky',
      amount: 2,
      banksOnReplace: false,
    });
  });

  it('spoken for but not paying yet: a FUTURE lucky_date', () => {
    expect(tasksSvc.whatSpecial({ lucky_date: DAY3, lucky_bonus: 2 }, clock)).toBe('lucky');
    expect(tasksSvc.bonusForTask({ lucky_date: DAY3, lucky_bonus: 2 }, clock)).toBeNull();
  });

  it('free again: a PAST lucky_date is not spoken for and not paying', () => {
    expect(tasksSvc.whatSpecial({ lucky_date: DAY1, lucky_bonus: 2 }, clock)).toBeNull();
    expect(tasksSvc.bonusForTask({ lucky_date: DAY1, lucky_bonus: 2 }, clock)).toBeNull();
  });

  it('a lucky_date today with an out-of-range or missing bonus does not pay (read-side pairing enforcement)', () => {
    expect(tasksSvc.bonusForTask({ lucky_date: FIXED_TODAY, lucky_bonus: null }, clock)).toBeNull();
    expect(tasksSvc.bonusForTask({ lucky_date: FIXED_TODAY, lucky_bonus: 4 }, clock)).toBeNull();
    expect(tasksSvc.bonusForTask({ lucky_date: FIXED_TODAY, lucky_bonus: 0 }, clock)).toBeNull();
  });

  it('daily wins the tie-break when a row is somehow both on-day and lucky-today', () => {
    const row = {
      special_date: FIXED_TODAY,
      special_bonus: 1,
      lucky_date: FIXED_TODAY,
      lucky_bonus: 3,
    };
    expect(tasksSvc.whatSpecial(row, clock)).toBe('daily');
    expect(tasksSvc.bonusForTask(row, clock)).toEqual({
      reason: 'oneday',
      amount: 1,
      banksOnReplace: undefined,
    });
  });

  it('the exported reason constants agree across modules (no missing #650 re-export)', () => {
    expect(submissions.BONUS_REASON_LUCKY).toBe(tasksSvc.BONUS_REASON_LUCKY);
    expect(tasksSvc.BONUS_REASON_LUCKY).toBe('lucky');
  });
});

// ---------------------------------------------------------------------------
// AC1: lucky submit banks the host's amount, guest-facing.
// ---------------------------------------------------------------------------
describe('AC1: lucky submit banks the host amount, and the success card reflects it', () => {
  it('a first-time submit on the lucky day banks worth + the secret bonus, reason "lucky"', async () => {
    // A decoy ordinary task the guest never completes (mirrors
    // tests/points-parity-756.test.js's own guard): scoring.js's
    // COMPLETIONIST metric excludes challenge tasks (special_date) but NOT a
    // plain lucky task, so with only ONE task in the whole database the
    // guest's single completion would vacuously complete 100% of live tasks
    // and earn COMPLETIONIST's own +1, breaking this test's point arithmetic.
    insertTask({ title: 'AC1 Decoy Ordinary Task', worth: 1 });
    const taskId = insertTask({
      title: 'AC1 Prize Task',
      worth: 2,
      luckyDate: FIXED_TODAY,
      luckyBonus: 3,
    });
    const guest = insertGuest();

    const agent = signInGuest(app, guest.token);
    const res = await agent
      .post(`/tasks/${taskId}/submit`)
      .attach('photo', validJpeg, { filename: 'ac1-lucky.jpg', contentType: 'image/jpeg' });
    expect([302, 303]).toContain(res.status);

    const row = getSubmission(guest.id, taskId);
    expect(row.bonus_amount).toBe(3);
    expect(row.bonus_reason).toBe('lucky');

    const page = await agent.get(res.headers.location);
    expect(page.text).toContain('You found the lucky task!');
    expect(page.text).toContain('2 + <strong>3 bonus</strong>');
    expect(page.text).toContain("You're at 5!");
    expect(page.text).not.toContain('Task complete!');
  });

  it('a submission to a non-lucky task renders the ordinary green card, no lucky wording anywhere', async () => {
    const taskId = insertTask({ title: 'AC1 Ordinary Task', worth: 1 });
    const guest = insertGuest();

    const agent = signInGuest(app, guest.token);
    const res = await agent
      .post(`/tasks/${taskId}/submit`)
      .attach('photo', validJpeg, { filename: 'ac1-ordinary.jpg', contentType: 'image/jpeg' });
    expect([302, 303]).toContain(res.status);

    const page = await agent.get(res.headers.location);
    expect(page.text).toContain('Task complete!');
    expect(page.text).not.toContain('You found the lucky task!');
    expect(page.text.toLowerCase()).not.toContain('lucky');
  });
});

// ---------------------------------------------------------------------------
// AC2: secret until someone wins it.
// ---------------------------------------------------------------------------
describe('AC2: nothing about a lucky task is guest-visible before its first win', () => {
  it('GET /tasks carries no "lucky" marker for a guest who has not completed it', async () => {
    insertTask({ title: 'AC2 Prize Task', worth: 1, luckyDate: FIXED_TODAY, luckyBonus: 2 });
    const guest = insertGuest();
    const agent = signInGuest(app, guest.token);

    const res = await agent.get('/tasks');
    expect(res.status).toBe(200);
    expect(res.text.toLowerCase()).not.toContain('lucky');
  });

  it('GET /tasks/:id carries no "lucky" marker for a guest who has not completed it', async () => {
    const taskId = insertTask({
      title: 'AC2 Prize Detail Task',
      worth: 1,
      luckyDate: FIXED_TODAY,
      luckyBonus: 2,
    });
    const guest = insertGuest();
    const agent = signInGuest(app, guest.token);

    const res = await agent.get(`/tasks/${taskId}`);
    expect(res.status).toBe(200);
    expect(res.text.toLowerCase()).not.toContain('lucky');
  });
});

// ---------------------------------------------------------------------------
// AC3: a re-upload (soft-takedown replace) is refused the bonus.
// ---------------------------------------------------------------------------
describe("AC3: a guest's own soft-takedown replace never banks the lucky bonus", () => {
  it('a guest who already had a submission before the lucky day, deletes it, and re-uploads on the lucky day banks nothing', async () => {
    const taskId = insertTask({ title: 'AC3 Task', worth: 1 });
    const guest = insertGuest();

    // First submission BEFORE the task becomes lucky (an ordinary completion).
    const first = writeOriginal(`ac3-first-${crypto.randomUUID()}.jpg`);
    const created = await submissions.submitPhoto({
      guestId: guest.id,
      taskId,
      file: first,
      caption: '',
    });
    expect(created.status).toBe('created');
    expect(getSubmission(guest.id, taskId).bonus_amount).toBe(0);

    // The host now makes it today's lucky task.
    db.prepare(`UPDATE tasks SET lucky_date = ?, lucky_bonus = ? WHERE id = ?`).run(
      FIXED_TODAY,
      3,
      taskId
    );

    // The guest's own soft takedown (photos.hideSubmission), then a re-upload
    // on the lucky day — a replace, never a fresh insert.
    const subId = getSubmission(guest.id, taskId).id;
    photos.hideSubmission(subId);

    const second = writeOriginal(`ac3-second-${crypto.randomUUID()}.jpg`);
    const replaced = await submissions.submitPhoto({
      guestId: guest.id,
      taskId,
      file: second,
      caption: '',
    });
    expect(replaced.status).toBe('replaced_hidden');
    expect(replaced.luckyBonus).toBeUndefined();

    const row = getSubmission(guest.id, taskId);
    expect(row.bonus_amount).toBe(0);
    expect(row.bonus_reason).toBeNull();
  });

  it('a REPLACED (not created) submission never renders the lucky success card, even on a task that is presently lucky', async () => {
    const taskId = insertTask({
      title: 'AC3 Card Task',
      worth: 1,
      luckyDate: FIXED_TODAY,
      luckyBonus: 2,
    });
    const guest = insertGuest();
    const agent = signInGuest(app, guest.token);

    await agent
      .post(`/tasks/${taskId}/submit`)
      .attach('photo', validJpeg, { filename: 'ac3-first.jpg', contentType: 'image/jpeg' });

    const res = await agent
      .post(`/tasks/${taskId}/submit`)
      .attach('photo', validJpeg, { filename: 'ac3-replace.jpg', contentType: 'image/jpeg' });
    expect([302, 303]).toContain(res.status);

    const page = await agent.get(res.headers.location);
    expect(page.text).not.toContain('You found the lucky task!');
    expect(page.text).not.toContain('success-clover');
  });
});

// ---------------------------------------------------------------------------
// AC4: host pick and replace.
// ---------------------------------------------------------------------------
describe('AC4: host pick and replace — one lucky task per day', () => {
  test('saving Lucky with a day and bonus persists lucky_date/lucky_bonus', async () => {
    const id = insertTask({ title: 'AC4 Pick' });
    await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC4 Pick',
      special_mode: 'lucky',
      lucky_date: DAY1,
      lucky_bonus: 2,
    });
    const task = getTask(id);
    expect(task.lucky_date).toBe(DAY1);
    expect(task.lucky_bonus).toBe(2);
  });

  test('making a SECOND task lucky for the same day clears the first, even if the first was hidden', async () => {
    const firstId = insertTask({ title: 'AC4 First Lucky' });
    await adminAgent.post(`/admin/tasks/${firstId}/edit`).type('form').send({
      title: 'AC4 First Lucky',
      special_mode: 'hidden',
    });
    // Give it a lucky pick via a direct write (mirrors "hidden with a lucky
    // pick intact" — the setter route would normally do this on a save whose
    // raw mode is 'lucky', but this test isolates the "second pick clears
    // the first" rule from that save shape).
    db.prepare(`UPDATE tasks SET lucky_date = ?, lucky_bonus = ? WHERE id = ?`).run(
      DAY1,
      1,
      firstId
    );

    const secondId = insertTask({ title: 'AC4 Second Lucky' });
    await adminAgent
      .post(`/admin/tasks/${secondId}/edit`)
      .type('form')
      .send({ title: 'AC4 Second Lucky', special_mode: 'lucky', lucky_date: DAY1, lucky_bonus: 3 });

    const first = getTask(firstId);
    const second = getTask(secondId);
    expect(second.lucky_date).toBe(DAY1);
    expect(second.lucky_bonus).toBe(3);
    expect(first.lucky_date).toBeNull();
    expect(first.lucky_bonus).toBeNull();
    // Still hidden afterwards — the clear touches only the lucky columns.
    expect(first.special_mode).toBe('hidden');
  });

  // issue #650 PR review fix (Finding I.2): the CREATE-path "one lucky task
  // per day" clear (src/routes/admin.js's POST /admin/tasks transaction) had
  // no test of its own -- only its EDIT twin (the test above) was covered.
  test('CREATE path: creating a new Lucky task for a day another task already holds clears the older pick, special_mode untouched', async () => {
    const existingId = insertTask({ title: 'AC4 Existing Lucky (create path)' });
    await adminAgent.post(`/admin/tasks/${existingId}/edit`).type('form').send({
      title: 'AC4 Existing Lucky (create path)',
      special_mode: 'hidden',
    });
    // Same isolation technique as the EDIT-path test above: give the
    // existing task its lucky pick via a direct write, so this test isolates
    // "creating a second lucky task clears the first" from that save shape.
    db.prepare(`UPDATE tasks SET lucky_date = ?, lucky_bonus = ? WHERE id = ?`).run(
      DAY1,
      1,
      existingId
    );

    await adminAgent
      .post('/admin/tasks')
      .type('form')
      .send({
        title: 'AC4 New Lucky Create',
        worth: 1,
        special_mode: 'lucky',
        lucky_date: DAY1,
        lucky_bonus: 3,
        ...BADGE,
      });

    const created = db.prepare('SELECT * FROM tasks WHERE title = ?').get('AC4 New Lucky Create');
    expect(created.lucky_date).toBe(DAY1);
    expect(created.lucky_bonus).toBe(3);

    const existing = getTask(existingId);
    expect(existing.lucky_date).toBeNull();
    expect(existing.lucky_bonus).toBeNull();
    // Still hidden afterwards — the clear touches only the lucky columns.
    expect(existing.special_mode).toBe('hidden');
  });
});

// ---------------------------------------------------------------------------
// issue #650 PR review fix (Finding F): hiding a lucky task silently parks
// the day's only lucky slot -- special_mode='hidden' with lucky_date intact
// is a supported state (a host picks Hidden on an already-lucky task without
// touching the lucky panel), and it leaves no guest-visible way to reach the
// bonus, no board chip, no checklist row. The cheapest fix in this file's
// Touches: the save's own success message names it.
// ---------------------------------------------------------------------------
describe('Finding F: hiding a lucky task tells the host its lucky slot is now unreachable', () => {
  test('saving Hidden on a task that carries a live lucky pick appends a warning to the success message', async () => {
    const id = insertTask({ title: 'Finding F Hide Lucky', luckyDate: DAY3, luckyBonus: 2 });
    const res = await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'Finding F Hide Lucky',
      special_mode: 'hidden',
      // Every save posts the lucky panel's last value regardless of which
      // Special option is chosen (AC6/AC7a's own note) -- reproduce that
      // shape rather than omitting the fields.
      lucky_date: DAY3,
      lucky_bonus: 2,
    });
    expect([302, 303]).toContain(res.status);

    const task = getTask(id);
    expect(task.special_mode).toBe('hidden');
    expect(task.lucky_date).toBe(DAY3);

    const msg = decodeURIComponent(res.headers.location);
    expect(msg).toContain("can't win the lucky bonus");
  });

  test('saving Hidden on a task with NO lucky pick keeps the plain success message', async () => {
    const id = insertTask({ title: 'Finding F Hide Ordinary' });
    const res = await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'Finding F Hide Ordinary',
      special_mode: 'hidden',
    });
    expect([302, 303]).toContain(res.status);

    const msg = decodeURIComponent(res.headers.location);
    expect(msg).not.toContain('lucky bonus');
  });
});

// ---------------------------------------------------------------------------
// AC5: cancel always works, even on a locked row.
// ---------------------------------------------------------------------------
describe('AC5: Special=None always clears the lucky pick, even when the one-day pair is locked', () => {
  test('a plain lucky task cancels cleanly via None', async () => {
    const id = insertTask({ title: 'AC5 Plain Cancel', luckyDate: DAY1, luckyBonus: 2 });
    await adminAgent
      .post(`/admin/tasks/${id}/edit`)
      .type('form')
      .send({ title: 'AC5 Plain Cancel', special_mode: 'none' });
    const task = getTask(id);
    expect(task.lucky_date).toBeNull();
    expect(task.lucky_bonus).toBeNull();
  });

  test('a task with BOTH a locked past one-day pair (guests posted) AND a lucky pick: None clears lucky_date, leaves special_date/special_bonus untouched, and tells the host both things happened', async () => {
    const id = insertTask({ title: 'AC5 Trap Task' });
    db.prepare(
      `UPDATE tasks SET special_mode = 'oneday', special_date = ?, special_bonus = ?,
                        lucky_date = ?, lucky_bonus = ?
         WHERE id = ?`
    ).run(DAY1, 1, DAY1, 2, id);
    // A submission locks the one-day pair.
    const guest = insertGuest();
    db.prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, 0)`
    ).run(guest.id, id, 'trap.jpg', 'trap.jpg.jpg');

    const res = await adminAgent
      .post(`/admin/tasks/${id}/edit`)
      .type('form')
      .send({ title: 'AC5 Trap Task', special_mode: 'none' });

    const task = getTask(id);
    // Lucky is gone.
    expect(task.lucky_date).toBeNull();
    expect(task.lucky_bonus).toBeNull();
    // The locked one-day pair survives unchanged, and so does the mode.
    expect(task.special_mode).toBe('oneday');
    expect(task.special_date).toBe(DAY1);
    expect(task.special_bonus).toBe(1);
    // The rest of the edit (title) was ALSO discarded — same "one
    // refuse-or-apply unit" the one-day lock already enforces.
    expect(task.title).toBe('AC5 Trap Task');

    const msg = decodeURIComponent(res.headers.location);
    expect(msg).toContain('Lucky task cancelled');
    expect(msg).toContain('locked');
  });

  test('a locked to-None save on a task that was NEVER lucky keeps today\'s message verbatim (no false "cancelled" claim)', async () => {
    const id = insertTask({ title: 'AC5 Never Lucky' });
    db.prepare(
      `UPDATE tasks SET special_mode = 'oneday', special_date = ?, special_bonus = ? WHERE id = ?`
    ).run(DAY1, 1, id);
    const guest = insertGuest();
    db.prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, 0)`
    ).run(guest.id, id, 'never.jpg', 'never.jpg.jpg');

    const res = await adminAgent
      .post(`/admin/tasks/${id}/edit`)
      .type('form')
      .send({ title: 'AC5 Never Lucky', special_mode: 'none' });

    const msg = decodeURIComponent(res.headers.location);
    expect(msg).not.toContain('Lucky task cancelled');
    expect(msg).toContain('locked');

    const task = getTask(id);
    expect(task.special_mode).toBe('oneday');
  });
});

// ---------------------------------------------------------------------------
// AC6: server-side round-trip (the DOM/popup half is
// tests/admin-tasks-script.test.js's job).
// ---------------------------------------------------------------------------
describe('AC6: a title-only save on a lucky task never loses the pick', () => {
  test('editing only the title on a lucky task leaves lucky_date/lucky_bonus untouched', async () => {
    const id = insertTask({ title: 'AC6 Original Title', luckyDate: DAY1, luckyBonus: 2 });
    // Every save posts lucky_date/lucky_bonus regardless of which Special
    // option is chosen (both radio groups are independent) -- mirror that
    // here by posting the SAME lucky_date/lucky_bonus alongside a title-only
    // change and special_mode='none' (the actual selected radio in this
    // scenario is None/Hidden/OneDay, never 'lucky' itself, since the host
    // did not touch the Special group at all; but the underlying lucky
    // inputs still post their last value). Because rawMode isn't 'lucky' or
    // 'none' here would normally leave the pair untouched -- but a
    // title-only edit through the real UI posts whatever special_mode WAS
    // selected, which for an already-lucky task is 'lucky' (openEdit()
    // checks the Lucky radio off data-lucky-date -- see
    // admin-tasks-script.test.js). Post that shape directly.
    const res = await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC6 Retitled',
      special_mode: 'lucky',
      lucky_date: DAY1,
      lucky_bonus: 2,
    });
    expect([302, 303]).toContain(res.status);

    const task = getTask(id);
    expect(task.title).toBe('AC6 Retitled');
    expect(task.lucky_date).toBe(DAY1);
    expect(task.lucky_bonus).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AC7: three refusals, all at save time, none of which write anything.
// ---------------------------------------------------------------------------
describe('AC7(a): an ordinary create with the (pre-selected, per plan step 6) Lucky radios never steals the day', () => {
  test('creating a task with Special=None does not touch lucky_date, even though the form always posts lucky_date/lucky_bonus fields', async () => {
    const existingId = insertTask({ title: 'AC7a Existing Lucky', luckyDate: DAY1, luckyBonus: 2 });

    await adminAgent
      .post('/admin/tasks')
      .type('form')
      .send({
        title: 'AC7a Ordinary Create',
        worth: 1,
        special_mode: 'none',
        // The lucky panel's radios are pre-selected in the create wizard's
        // markup (plan step 6's defaults) even while None is the chosen mode
        // -- posting them here reproduces that real shape.
        lucky_date: DAY1,
        lucky_bonus: 3,
        ...BADGE,
      });

    const created = db.prepare('SELECT * FROM tasks WHERE title = ?').get('AC7a Ordinary Create');
    expect(created.lucky_date).toBeNull();
    expect(created.lucky_bonus).toBeNull();

    // The existing lucky pick for that day is untouched.
    const existing = getTask(existingId);
    expect(existing.lucky_date).toBe(DAY1);
    expect(existing.lucky_bonus).toBe(2);
  });
});

describe('AC7(b): a bad lucky day or bonus is refused with a host-readable message, writing nothing', () => {
  test('create: a day outside the configured wedding dates is refused, no task row written', async () => {
    await adminAgent
      .post('/admin/tasks')
      .type('form')
      .send({
        title: 'AC7b Bad Date Create',
        worth: 1,
        special_mode: 'lucky',
        lucky_date: '2026-12-25',
        lucky_bonus: 2,
        ...BADGE,
      });
    const found = db.prepare('SELECT * FROM tasks WHERE title = ?').get('AC7b Bad Date Create');
    expect(found).toBeUndefined();
  });

  test('create: a bonus outside 1-3 is refused, no task row written', async () => {
    await adminAgent
      .post('/admin/tasks')
      .type('form')
      .send({
        title: 'AC7b Bad Bonus Create',
        worth: 1,
        special_mode: 'lucky',
        lucky_date: DAY1,
        lucky_bonus: 9,
        ...BADGE,
      });
    const found = db.prepare('SELECT * FROM tasks WHERE title = ?').get('AC7b Bad Bonus Create');
    expect(found).toBeUndefined();
  });

  test('edit: a bad lucky day is refused, the stored pick is unchanged', async () => {
    const id = insertTask({ title: 'AC7b Edit Task', luckyDate: DAY1, luckyBonus: 1 });
    const res = await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC7b Edit Task',
      special_mode: 'lucky',
      lucky_date: '2026-12-25',
      lucky_bonus: 2,
    });
    const task = getTask(id);
    expect(task.lucky_date).toBe(DAY1);
    expect(task.lucky_bonus).toBe(1);
    const msg = decodeURIComponent(res.headers.location);
    expect(msg.toLowerCase()).toContain('wedding day');
  });

  test('edit: a bad lucky bonus is refused, the stored pick is unchanged', async () => {
    const id = insertTask({ title: 'AC7b Edit Bonus Task', luckyDate: DAY1, luckyBonus: 1 });
    const res = await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC7b Edit Bonus Task',
      special_mode: 'lucky',
      lucky_date: DAY1,
      lucky_bonus: 0,
    });
    const task = getTask(id);
    expect(task.lucky_bonus).toBe(1);
    const msg = decodeURIComponent(res.headers.location);
    expect(msg.toLowerCase()).toContain('+1, +2, or +3');
  });
});

describe('AC7(c): exclusivity — a task cannot be one-day-only and lucky at once, in either direction', () => {
  test('a task already a live one-day-only challenge (dated today or later) refuses a Lucky save', async () => {
    const id = insertTask({ title: 'AC7c Already Oneday' });
    db.prepare(
      `UPDATE tasks SET special_mode = 'oneday', special_date = ?, special_bonus = ? WHERE id = ?`
    ).run(DAY3, 1, id);
    const res = await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC7c Already Oneday',
      special_mode: 'lucky',
      lucky_date: DAY1,
      lucky_bonus: 2,
    });
    const task = getTask(id);
    expect(task.lucky_date).toBeNull();
    expect(task.special_date).toBe(DAY3);
    const msg = decodeURIComponent(res.headers.location);
    expect(msg).toContain('already');
  });

  test('reverse: a task already lucky (live pick, today or later) refuses a One-day-only save', async () => {
    const id = insertTask({ title: 'AC7c Already Lucky', luckyDate: DAY3, luckyBonus: 2 });
    const res = await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC7c Already Lucky',
      special_mode: 'oneday',
      special_date: DAY1,
      special_bonus: 1,
    });
    const task = getTask(id);
    expect(task.special_date).toBeNull();
    expect(task.lucky_date).toBe(DAY3);
    const msg = decodeURIComponent(res.headers.location);
    expect(msg).toContain('already');
  });

  test('a task whose lucky day has PASSED is free again and takes a one-day-only save without refusal', async () => {
    const id = insertTask({ title: 'AC7c Passed Lucky', luckyDate: DAY1, luckyBonus: 2 });
    const res = await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC7c Passed Lucky',
      special_mode: 'oneday',
      special_date: DAY3,
      special_bonus: 1,
    });
    expect([302, 303]).toContain(res.status);
    const task = getTask(id);
    expect(task.special_mode).toBe('oneday');
    expect(task.special_date).toBe(DAY3);
  });

  // issue #650 PR review fix (Finding I.1): AC7(c)'s flash arm was
  // unasserted -- every case above exercises the one-day/lucky pair only.
  // currentClock()'s nowMs half (src/routes/admin.js) is the REAL wall clock
  // (this file only monkeypatches eventLocalDateString, never Date.now), so
  // the flash window is seeded around Date.now() at test-run time, not
  // FIXED_TODAY -- flashState() only cares about nowMs, never the event-local
  // calendar day.
  test('a task with a LIVE flash window refuses a Lucky save, lucky_date stays NULL', async () => {
    const id = insertTask({ title: 'AC7c Live Flash' });
    const flashStart = new Date(Date.now() - 60000).toISOString(); // started 1 min ago
    db.prepare(
      `UPDATE tasks SET flash_start_at = ?, flash_minutes = ?, flash_bonus = ? WHERE id = ?`
    ).run(flashStart, 60, 2, id);

    const res = await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC7c Live Flash',
      special_mode: 'lucky',
      lucky_date: DAY1,
      lucky_bonus: 2,
    });

    const task = getTask(id);
    expect(task.lucky_date).toBeNull();
    expect(task.lucky_bonus).toBeNull();
    const msg = decodeURIComponent(res.headers.location);
    expect(msg).toContain('already');
  });
});

// ---------------------------------------------------------------------------
// The admin board -> edit popup DATA CONTRACT (issue #650 re-check finding).
//
// src/public/js/admin-tasks.js decides which Special radio the edit popup
// checks by reading three attributes off the tapped card: data-special-kind
// (the server's whatSpecial() answer), data-lucky-date and data-lucky-bonus.
// Every test of that decision lives in tests/admin-tasks-script.test.js, which
// is a hand-built jsdom fixture -- it WRITES those attributes itself, so it
// cannot notice if GET /admin/tasks ever stops emitting them.
//
// Verified by mutation before this block was written: deleting
// `specialKind: tasks.whatSpecial(t, clock)` from src/routes/admin.js, or
// deleting the lucky_date/lucky_bonus row fields, left the ENTIRE suite green.
// The failure that hides behind that green: every card then serves
// data-special-kind="", the client's "nothing owns this task" arm fires, and a
// task owned by a live flash window or a future special_date opens on the
// Lucky radio -- so a host fixing a typo posts special_mode=lucky and the
// exclusivity guard refuses the save over a control they never touched. That
// is the exact defect the server-derived answer exists to prevent.
// ---------------------------------------------------------------------------
describe('GET /admin/tasks emits the data contract the edit popup reads', () => {
  function cardFor(html, taskId) {
    // The single <li> for this task, so an assertion cannot be satisfied by
    // some OTHER card on the board carrying the attribute.
    const start = html.indexOf(`data-task-id="${taskId}"`);
    expect(start).toBeGreaterThan(-1);
    const open = html.lastIndexOf('<li', start);
    const end = html.indexOf('</li>', start);
    return html.slice(open, end);
  }

  test('a lucky task carries its kind, day and bonus; a sealed challenge carries daily; an ordinary task carries neither', async () => {
    const luckyId = insertTask({ title: 'Contract Lucky' });
    await adminAgent
      .post(`/admin/tasks/${luckyId}/edit`)
      .type('form')
      .send({ title: 'Contract Lucky', special_mode: 'lucky', lucky_date: DAY3, lucky_bonus: 3 });

    const dailyId = insertTask({ title: 'Contract Daily' });
    await adminAgent.post(`/admin/tasks/${dailyId}/edit`).type('form').send({
      title: 'Contract Daily',
      special_mode: 'oneday',
      special_date: DAY3,
      special_bonus: 2,
    });

    const ordinaryId = insertTask({ title: 'Contract Ordinary' });

    const res = await adminAgent.get('/admin/tasks');
    expect(res.status).toBe(200);

    const luckyCard = cardFor(res.text, luckyId);
    expect(luckyCard).toContain('data-special-kind="lucky"');
    expect(luckyCard).toContain(`data-lucky-date="${DAY3}"`);
    expect(luckyCard).toContain('data-lucky-bonus="3"');

    // DAY3 is in the future relative to the pinned today, so the challenge is
    // sealed and daily owns the row -- the popup must show One day only, not
    // Lucky, and that hinges on this attribute being the SERVICE's answer.
    const dailyCard = cardFor(res.text, dailyId);
    expect(dailyCard).toContain('data-special-kind="daily"');

    const ordinaryCard = cardFor(res.text, ordinaryId);
    expect(ordinaryCard).toContain('data-special-kind=""');
    expect(ordinaryCard).toContain('data-lucky-date=""');
    expect(ordinaryCard).toContain('data-lucky-bonus=""');
  });

  test('a task owned by a LIVE FLASH window reports flash, not an empty kind', async () => {
    // The case the client whitelist depends on most: an empty kind would make
    // the popup check Lucky on a flash-owned row.
    const id = insertTask({ title: 'Contract Flash' });
    db.prepare(
      `UPDATE tasks SET flash_start_at = ?, flash_minutes = ?, flash_bonus = ?,
         lucky_date = ?, lucky_bonus = ? WHERE id = ?`
    ).run(new Date(Date.now() - 60000).toISOString(), 60, 2, DAY1, 2, id);

    const res = await adminAgent.get('/admin/tasks');
    expect(cardFor(res.text, id)).toContain('data-special-kind="flash"');
  });
});
