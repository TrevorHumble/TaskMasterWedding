// tests/task-earnable-badge.test.js
// Issue #486: the guest task list shows each task's earnable badge — the
// badge art (custom or default, via issue #483's resolveTaskBadge) plus
// "Best photos earn [name] + bonus points" copy (issue #682/#652's owner-
// approved prize framing superseded the original "plus extra points"
// wording), with no fixed point number attached to that copy. Follows
// tests/tasks-page.test.js's loadApp()/signInGuest seeding conventions.
//
// REQUIRE ORDER: config / db / app are required only AFTER loadApp() sets
// DATA_DIR / DB_PATH. Do not hoist requires above the loadApp() call.
'use strict';

const { loadApp, signInGuest } = require('./helpers/testApp');

let app;
let db;
let taskBadges;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
  taskBadges = require('../src/services/task-badges');
});

const TOKEN = 'earnable-badge-token';

// One customized task (a distinct badge name + uploaded art) and one plain
// task left on the default ribbon — AC1 and AC2's givens side by side.
function seedField() {
  db.prepare('DELETE FROM submissions').run();
  db.prepare('DELETE FROM guests').run();
  db.prepare('DELETE FROM tasks').run();
  db.prepare('DELETE FROM badges').run();

  const guestId = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run(TOKEN, 'Badge Guest').lastInsertRowid;

  const customTaskId = db
    .prepare(`INSERT INTO tasks (title, description, sort_order) VALUES (?, ?, ?)`)
    .run('Golden move task', 'Strike the golden pose', 1).lastInsertRowid;
  taskBadges.setTaskBadge(customTaskId, {
    name: 'Golden Move',
    artPath: '/uploads/golden-move.jpg',
  });

  const plainTaskId = db
    .prepare(`INSERT INTO tasks (title, description, sort_order) VALUES (?, ?, ?)`)
    .run('Plain task', 'Nothing customized here', 2).lastInsertRowid;

  return { guestId, customTaskId, plainTaskId };
}

async function signedInTasks() {
  const agent = require('supertest').agent(app);
  signInGuest(app, TOKEN, agent);
  const res = await agent.get('/tasks');
  expect(res.status).toBe(200);
  return res;
}

describe('earnable badge on task list (#486)', () => {
  let customTaskId;
  let plainTaskId;

  beforeAll(() => {
    const seeded = seedField();
    customTaskId = seeded.customTaskId;
    plainTaskId = seeded.plainTaskId;
  });

  test('AC1: a task with a custom badge shows its name, art, and the extra-points copy', async () => {
    const res = await signedInTasks();

    const rowStart = res.text.indexOf(`/tasks/${customTaskId}`);
    expect(rowStart).toBeGreaterThan(-1);
    const rowEnd = res.text.indexOf('</li>', rowStart);
    const row = res.text.slice(rowStart, rowEnd);

    expect(row).toContain('Golden Move');
    expect(row).toContain('/uploads/golden-move.jpg');
    expect(row).toContain('+ bonus points');
  });

  test('AC2: a task with no custom badge shows the default-ribbon art and the same copy', async () => {
    const res = await signedInTasks();

    const rowStart = res.text.indexOf(`/tasks/${plainTaskId}`);
    expect(rowStart).toBeGreaterThan(-1);
    const rowEnd = res.text.indexOf('</li>', rowStart);
    const row = res.text.slice(rowStart, rowEnd);

    const defaultBadge = taskBadges.resolveTaskBadge(plainTaskId);
    expect(defaultBadge.art_path).toBe(taskBadges.DEFAULT_RIBBON_ART_PATH);
    expect(row).toContain(taskBadges.DEFAULT_RIBBON_ART_PATH);
    expect(row).toContain('+ bonus points');
  });

  test('AC3: the earnable-badge copy carries no fixed per-task point number', async () => {
    const res = await signedInTasks();

    // Isolate every task-earnable-copy span and confirm none contains a
    // digit — the "+1 pt" chevron reward lives in a sibling span
    // (task-points) untouched by this change, so this check must scope to
    // the badge copy itself rather than the whole row or it would trivially
    // fail against that pre-existing, unrelated element.
    const copyBlocks = res.text.match(/<span class="task-earnable-copy">[^<]*<\/span>/g) || [];
    expect(copyBlocks.length).toBeGreaterThanOrEqual(2);
    for (const block of copyBlocks) {
      expect(block).toMatch(/\+ bonus points/);
      expect(block).not.toMatch(/\d/);
    }
  });

  test('AC4: the earnable badge art uses the shared fixed-size .badge-art frame, not a raw sized img', async () => {
    const res = await signedInTasks();

    const rowStart = res.text.indexOf(`/tasks/${customTaskId}`);
    const rowEnd = res.text.indexOf('</li>', rowStart);
    const row = res.text.slice(rowStart, rowEnd);

    expect(row).toMatch(/<img class="badge-art"[^>]*src="\/uploads\/golden-move\.jpg"/);
  });
});
