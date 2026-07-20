// tests/how-to-play.test.js
// Covers issue #246 acceptance criteria — the "How to play" rules card:
//   AC1 — the active-task count is LIVE: 32 active tasks -> "32 photo
//         missions"; deactivating one -> "31 photo missions" on the next render
//   AC2 (issue #663) — the CTA always reads "See your list of tasks" and
//         links to /tasks (the task board), regardless of undone tasks,
//         never an individual /tasks/<id>
//   AC3 — ?first=1 shows "Skip for now"; a plain GET /how-to-play does not.
//         (Issue #244 retired the separate POST /onboard step that used to
//         redirect here with ?first=1 after signup — nothing currently lands
//         on this page with that query string automatically, so this now
//         only pins the query-param behavior itself, plus a regression check
//         that POST /onboard is the 302-to-/join redirect #244 made it.)
//   AC4 — the required literal copy is present
//   AC5 — a signed-out visitor is redirected (302) to /join, not shown the card
//
// REQUIRE ORDER: config / db / app are required only via loadApp() — see
// tests/helpers/testApp.js "REQUIRE ORDER MATTERS".
'use strict';

const request = require('supertest');
const { loadApp, signInGuest } = require('./helpers/testApp');

let app;
let db;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
});

// Wipe every row these tests touch so one test's fixtures never leak into
// the next (each test re-seeds exactly what it needs).
function resetTables() {
  db.prepare('DELETE FROM submissions').run();
  db.prepare('DELETE FROM tasks').run();
  db.prepare('DELETE FROM guests').run();
}

function insertGuest(token, onboarded) {
  return db
    .prepare('INSERT INTO guests (token, name, onboarded) VALUES (?, ?, ?)')
    .run(token, 'Guest ' + token, onboarded ? 1 : 0).lastInsertRowid;
}

function insertTask(title, sortOrder, isActive) {
  const live = isActive === undefined ? true : !!isActive;
  return db
    .prepare('INSERT INTO tasks (title, sort_order, special_mode) VALUES (?, ?, ?)')
    .run(title, sortOrder, live ? 'none' : 'hidden').lastInsertRowid;
}

function markDone(guestId, taskId) {
  db.prepare(
    `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
     VALUES (?, ?, 'p.jpg', 't.jpg', 0)`
  ).run(guestId, taskId);
}

function signedInAgent(token) {
  return signInGuest(app, token);
}

describe('AC1: taskCount is a live count of active tasks', () => {
  test('32 active tasks render "32 photo missions"; deactivating one renders "31 photo missions"', async () => {
    resetTables();
    const guestId = insertGuest('ac1-token', true);
    const taskIds = [];
    for (let i = 1; i <= 32; i++) {
      taskIds.push(insertTask('Task ' + i, i));
    }
    void guestId;

    const agent = await signedInAgent('ac1-token');

    const before = await agent.get('/how-to-play');
    expect(before.status).toBe(200);
    expect(before.text).toContain('32 photo missions');

    db.prepare("UPDATE tasks SET special_mode = 'hidden' WHERE id = ?").run(taskIds[0]);

    const after = await agent.get('/how-to-play');
    expect(after.status).toBe(200);
    expect(after.text).toContain('31 photo missions');
    expect(after.text).not.toContain('32 photo missions');
  });
});

describe('AC2 (issue #663): closing button always links to /tasks, never an individual task', () => {
  test('with undone tasks present, the button still reads "See your list of tasks" and links to /tasks, not the lowest-sort_order undone task', async () => {
    resetTables();
    const guestId = insertGuest('ac2-first-token', true);
    const taskDoneLow = insertTask('Done, low order', 1);
    const taskUndoneNext = insertTask('Undone, next order', 2); // would have won under the old first-undone logic
    insertTask('Undone, later order', 3);
    markDone(guestId, taskDoneLow);

    const agent = await signedInAgent('ac2-first-token');
    const res = await agent.get('/how-to-play');

    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/tasks">See your list of tasks</a>');
    // Never an individual task href, old or new.
    expect(res.text).not.toContain('href="/tasks/' + taskUndoneNext + '"');
    expect(res.text).not.toContain('href="/tasks/' + taskDoneLow + '"');
    expect(res.text).not.toMatch(/href="\/tasks\/\d+"/);
  });

  test('with zero undone tasks, the button still links to /tasks', async () => {
    resetTables();
    const guestId = insertGuest('ac2-zero-token', true);
    const taskId = insertTask('The only task', 1);
    markDone(guestId, taskId);

    const agent = await signedInAgent('ac2-zero-token');
    const res = await agent.get('/how-to-play');

    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/tasks">See your list of tasks</a>');
    expect(res.text).not.toMatch(/href="\/tasks\/\d+"/);
  });

  test('with no tasks posted at all (taskCount 0), the button still links to /tasks', async () => {
    resetTables();
    insertGuest('ac2-notasks-token', true);

    const agent = await signedInAgent('ac2-notasks-token');
    const res = await agent.get('/how-to-play');

    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/tasks">See your list of tasks</a>');
    expect(res.text).toContain('0 photo missions');
  });
});

describe('AC3: the ?first=1 Skip link, and the retired /onboard redirect', () => {
  test('GET /how-to-play?first=1 shows "Skip for now"', async () => {
    resetTables();
    const token = 'ac3-first-token';
    insertGuest(token, true);

    const agent = signedInAgent(token);
    const res = await agent.get('/how-to-play?first=1');

    expect(res.status).toBe(200);
    expect(res.text).toContain('Skip for now');
  });

  test('regression: POST /onboard is a 302 to /join, not to /how-to-play (issue #244)', async () => {
    resetTables();
    const token = 'ac3-onboard-token';
    insertGuest(token, false);

    const agent = signedInAgent(token);
    const onboardRes = await agent.post('/onboard').field('name', 'Fresh Guest');
    expect(onboardRes.status).toBe(302);
    expect(onboardRes.headers.location).toBe('/join');
  });

  test('a plain GET /how-to-play (no ?first=1) does not show "Skip for now"', async () => {
    resetTables();
    const token = 'ac3-plain-token';
    insertGuest(token, true);

    const agent = await signedInAgent(token);
    const res = await agent.get('/how-to-play');

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('Skip for now');
  });
});

describe('AC4: required literal copy', () => {
  test('the rendered page contains every required literal string', async () => {
    resetTables();
    const token = 'ac4-token';
    insertGuest(token, true);
    insertTask('Some task', 1);

    const agent = await signedInAgent(token);
    const res = await agent.get('/how-to-play');

    expect(res.status).toBe(200);
    expect(res.text).toContain('How to play');
    expect(res.text).toContain('Help Lilly and Axel remember their day.');
    expect(res.text).toContain('Share every memory');
    expect(res.text).toContain("Earn the masters' favor");
  });
});

describe('AC5: signed-out visitor is gated', () => {
  test('GET /how-to-play with no guest cookie redirects to /join (issue #241)', async () => {
    resetTables();

    const res = await request(app).get('/how-to-play');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/join');
  });
});
