// tests/task-worth-engine.test.js
// Issue #727 — task `worth` (1-3) and `special_mode` (none/hidden) become real
// stored facts, with ONE active-task owner (src/services/tasks.js) every
// reader consults. Covers:
//   AC1 — worth pays through both read paths: scoring.getPoints(guestId) and
//         that guest's leaderboard() row agree, and a takedown/restore of the
//         worth-carrying photo moves its worth (+bonus) out and back in. The
//         fixture uses TWO visible submissions (a worth-3 task with a
//         non-zero photo_bonus, and a worth-2 task) so a leaderboard
//         tasks-join that accidentally fanned out SUM(photo_bonus) would be
//         observable (per the design's no-fan-out note).
//   AC2 — a task hidden via the existing toggle route is absent from
//         GET /tasks, GET /tasks/:id 404s, submitPhoto refuses it
//         (task_inactive), and COMPLETIONIST ignores it — all four flowing
//         from tasks.liveTaskWhere/isTaskLive, no second hand-written predicate.
//   AC5 — GET /tasks renders each to-do card's worth (a worth-3 task renders
//         "+3 pts").
//
// AC3 (the ensureTaskWorthAndMode migration) is covered by
// tests/task-worth-mode-migration.test.js — it needs a genuinely pre-#727
// tasks table (is_active, no worth/special_mode), which loadApp()'s
// always-fresh schema can't produce, so it follows the dedicated-file
// pre-migration pattern of tests/badge-submission-cascade.test.js instead of
// living here.
//
// AC4 (existing create/edit/toggle/delete routes still work against the new
// schema; toggle writes special_mode; create/toggle/delete still fire
// recomputeAfterTaskChange, #701-style) is already exercised end-to-end by
// tests/admin-tasks-crud.test.js (toggle asserts the special_mode column
// directly) and tests/task-badge-recompute.test.js (recompute through the
// routes) once those suites were converted off is_active — no new test is
// added here to avoid duplicating that coverage.
//
// REQUIRE ORDER: config / db / app are required only via loadApp() — see
// tests/helpers/testApp.js "REQUIRE ORDER MATTERS".
'use strict';

const { loadApp, makeAdminAgent, signInGuest } = require('./helpers/testApp');

let app;
let db;
let scoring;
let badges;
let submissions;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
  scoring = require('../src/services/scoring');
  badges = require('../src/services/badges');
  submissions = require('../src/services/submissions');
});

let seq = 0;

function insertGuest(name) {
  seq += 1;
  const token = `worth-engine-${seq}`;
  const id = db
    .prepare('INSERT INTO guests (token, name) VALUES (?, ?)')
    .run(token, name).lastInsertRowid;
  return { id, token };
}

function insertTask(title, worth = 1) {
  return db.prepare('INSERT INTO tasks (title, worth) VALUES (?, ?)').run(title, worth)
    .lastInsertRowid;
}

function insertSubmission(guestId, taskId, opts = {}) {
  seq += 1;
  return db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, photo_bonus)
       VALUES (?, ?, ?, ?, 0, ?)`
    )
    .run(guestId, taskId, `wp${seq}.jpg`, `wt${seq}.jpg`, opts.photoBonus || 0).lastInsertRowid;
}

// Hides every currently-live task so a test's own controlled fixture is the
// only thing COMPLETIONIST/leaderboard math sees — same convention
// tests/badge-engine.test.js and tests/task-badge-recompute.test.js use.
function hideEveryTask() {
  db.prepare("UPDATE tasks SET special_mode = 'hidden'").run();
}

describe('AC1: worth pays through getPoints and leaderboard(), and a takedown/restore moves it', () => {
  it('a worth-3 task (with photo_bonus) + a worth-2 task score 3+2+bonus on both paths; takedown/restore moves the worth-3 amount', () => {
    const { id: guestId } = insertGuest('AC1 Worth Guest');
    const worth3Task = insertTask('AC1 Worth-3 Task', 3);
    const worth2Task = insertTask('AC1 Worth-2 Task', 2);
    const worth3SubId = insertSubmission(guestId, worth3Task, { photoBonus: 4 });
    insertSubmission(guestId, worth2Task);

    const fullTotal = 3 + 2 + 4; // worth3 + worth2 + worth3's photo_bonus

    expect(scoring.getPoints(guestId)).toBe(fullTotal);
    const leaderboardRow = () => scoring.leaderboard().find((r) => r.id === guestId);
    expect(leaderboardRow().points).toBe(fullTotal);

    // Takedown the worth-3 photo: its worth (3) AND its bonus (4) leave both
    // getPoints and the leaderboard row, leaving only the worth-2 task's 2.
    db.prepare('UPDATE submissions SET taken_down = 1 WHERE id = ?').run(worth3SubId);
    expect(scoring.getPoints(guestId)).toBe(2);
    expect(leaderboardRow().points).toBe(2);

    // Restore: both terms return, back to the full total.
    db.prepare('UPDATE submissions SET taken_down = 0 WHERE id = ?').run(worth3SubId);
    expect(scoring.getPoints(guestId)).toBe(fullTotal);
    expect(leaderboardRow().points).toBe(fullTotal);
  });
});

describe('AC2: a hidden task is absent from four surfaces via the one active-task owner', () => {
  it('GET /tasks omits it, GET /tasks/:id 404s, submitPhoto refuses it, and COMPLETIONIST ignores it', async () => {
    hideEveryTask();

    const adminAgent = await makeAdminAgent(app, 'worth-ac2-pw');
    const coveredTask = insertTask('AC2 Covered Task');
    const hideableTask = insertTask('AC2 Hideable Task');
    const guest = insertGuest('AC2 Guest');
    const agent = signInGuest(app, guest.token);

    insertSubmission(guest.id, coveredTask);

    // Before hiding: the guest covers coveredTask but not hideableTask, so
    // COMPLETIONIST does not yet hold — this is the baseline the toggle below
    // is expected to flip.
    expect(badges.METRIC_BADGES.COMPLETIONIST(guest.id)).toBe(false);

    // Hide it via the real, existing toggle route (writes special_mode).
    await adminAgent.post(`/admin/tasks/${hideableTask}/active`).type('form').send({});
    expect(
      db.prepare('SELECT special_mode FROM tasks WHERE id = ?').get(hideableTask).special_mode
    ).toBe('hidden');

    // 1. Absent from GET /tasks — the guest never submitted to hideableTask,
    // so a live task would show up in the default to-do view; it must not.
    const listRes = await agent.get('/tasks');
    expect(listRes.status).toBe(200);
    expect(listRes.text).not.toContain('AC2 Hideable Task');

    // 2. GET /tasks/:id 404s.
    const detailRes = await agent.get(`/tasks/${hideableTask}`);
    expect(detailRes.status).toBe(404);

    // 3. submitPhoto refuses it with task_inactive (checked before any file
    // work, so a fake, never-written filename is safe here).
    const result = await submissions.submitPhoto({
      guestId: guest.id,
      taskId: hideableTask,
      file: { filename: 'ac2-never-written.jpg', path: __filename },
      caption: '',
    });
    expect(result.status).toBe('task_inactive');

    // 4. COMPLETIONIST ignores the hidden task: the guest now covers every
    // remaining LIVE task (just coveredTask), so it qualifies.
    expect(badges.METRIC_BADGES.COMPLETIONIST(guest.id)).toBe(true);
  });
});

// Ties the points-label assertion to the SPECIFIC task's row rather than a
// bare substring search — tasks.ejs's hardcoded starter tile also renders
// "+1 pt" (issue #409, unrelated to this issue), so a plain toContain('+1
// pt') would pass even if a real task's t.worth rendering were broken.
function worthLabelForTask(html, taskTitle) {
  const titleIdx = html.indexOf(taskTitle);
  expect(titleIdx).toBeGreaterThan(-1);
  const pointsIdx = html.indexOf('task-points">', titleIdx);
  expect(pointsIdx).toBeGreaterThan(-1);
  const chunk = html.slice(pointsIdx, pointsIdx + 60);
  const match = chunk.match(/\+\d+ pts?/);
  return match ? match[0] : null;
}

describe("AC5: GET /tasks renders each to-do card's worth", () => {
  it('a worth-3 task renders "+3 pts"; a worth-1 task renders "+1 pt" (singular, byte-identical to the pre-#727 label)', async () => {
    const guest = insertGuest('AC5 Worth Guest');
    const agent = signInGuest(app, guest.token);
    insertTask('AC5 Worth-3 Task', 3);
    insertTask('AC5 Worth-1 Task', 1);

    const res = await agent.get('/tasks');
    expect(res.status).toBe(200);
    expect(worthLabelForTask(res.text, 'AC5 Worth-3 Task')).toBe('+3 pts');
    expect(worthLabelForTask(res.text, 'AC5 Worth-1 Task')).toBe('+1 pt');
  });
});
