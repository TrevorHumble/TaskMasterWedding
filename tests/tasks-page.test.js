// tests/tasks-page.test.js
// Covers issue #250 acceptance criteria — task list v2:
//   AC1 — no `white-space: nowrap` inside the `.task-desc` rule (the nowrap
//         span forced 566px-wide pages on 375px phones); asserted against the
//         shipped CSS since the suite has no browser harness
//   AC2 — chip labels render computed counts ("To do · 13", "Done · 19") and
//         every undone title precedes the first done title in the default view
//   AC3 — a done row's completion indicator is the guest's own /thumbs/ photo;
//         no badge-todo / badge-done pills anywhere
//   AC4 — to-do rows carry "+1 pt" and no "See photos" anchor
//   AC5 — /tasks?view=done lists every done task and no undone titles
//
// REQUIRE ORDER: config / db / app are required only AFTER loadApp() sets
// DATA_DIR / DB_PATH. Do not hoist requires above the loadApp() call.
'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { loadApp } = require('./helpers/testApp');

let app;
let db;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
});

const TOKEN = 'tasks-page-token';
const TODO_COUNT = 13;
const DONE_COUNT = 19;

// Seed one guest with 13 undone and 19 done tasks (AC2's given). Done tasks
// get distinct submission timestamps so "most recent completions" is
// deterministic: "Done task 19" is the newest, then 18, then 17.
function seedField() {
  db.prepare('DELETE FROM submissions').run();
  db.prepare('DELETE FROM guests').run();
  db.prepare('DELETE FROM tasks').run();

  const guestId = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run(TOKEN, 'Page Guest').lastInsertRowid;

  const insertTask = db.prepare(
    `INSERT INTO tasks (title, description, sort_order) VALUES (?, ?, ?)`
  );
  const insertSub = db.prepare(
    `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, created_at)
     VALUES (?, ?, ?, ?, 0, ?)`
  );
  const base = Date.parse('2026-08-07T18:00:00Z');

  for (let i = 1; i <= TODO_COUNT; i++) {
    insertTask.run(`Todo task ${i}`, `Find and photograph undone thing number ${i}`, i);
  }
  for (let i = 1; i <= DONE_COUNT; i++) {
    const taskId = insertTask.run(
      `Done task ${i}`,
      `Already photographed thing number ${i}`,
      100 + i
    ).lastInsertRowid;
    const ts = new Date(base + i * 60000)
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d+Z$/, '');
    insertSub.run(guestId, taskId, `photo-${i}.jpg`, `thumb-${i}.jpg`, ts);
  }
  return guestId;
}

async function signedInTasks(query = '') {
  const agent = request.agent(app);
  await agent.get('/j/' + TOKEN);
  const res = await agent.get('/tasks' + query);
  expect(res.status).toBe(200);
  return res;
}

describe('tasks page v2 (#250)', () => {
  beforeAll(() => {
    seedField();
  });

  test('AC1: theme.css has no white-space: nowrap inside the .task-desc rule', () => {
    const css = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'public', 'css', 'theme.css'),
      'utf8'
    );
    // Every .task-desc declaration block, wherever it appears.
    const blocks = css.match(/\.task-desc[^{]*\{[^}]*\}/g) || [];
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block).not.toMatch(/white-space:\s*nowrap/);
    }
  });

  test('AC2: chips render "To do · 13" / "Done · 19" and all undone titles precede the first done title', async () => {
    const res = await signedInTasks();

    expect(res.text).toContain('To do · 13');
    expect(res.text).toContain('Done · 19');

    const firstDoneIdx = res.text.indexOf('Done task');
    expect(firstDoneIdx).toBeGreaterThan(-1);
    for (let i = 1; i <= TODO_COUNT; i++) {
      const idx = res.text.indexOf(`Todo task ${i}`);
      expect(idx).toBeGreaterThan(-1);
      expect(idx).toBeLessThan(firstDoneIdx);
    }
  });

  test('default view shows the 3 most recent completions under a DONE section label', async () => {
    const res = await signedInTasks();

    // Only the newest three done tasks render on the default view.
    const doneTitles = res.text.match(/Done task \d+/g) || [];
    expect(new Set(doneTitles)).toEqual(new Set(['Done task 19', 'Done task 18', 'Done task 17']));
    // The section label between the to-do list and the completions.
    expect(res.text).toContain('task-section-label');
  });

  test("AC3: a done row shows the guest's /thumbs/ photo and no badge pills exist", async () => {
    const res = await signedInTasks();

    // Isolate a done row and check its completion indicator is the photo.
    const doneRowStart = res.text.indexOf('task-row task-done');
    expect(doneRowStart).toBeGreaterThan(-1);
    const doneRow = res.text.slice(doneRowStart, res.text.indexOf('</li>', doneRowStart));
    expect(doneRow).toMatch(/<img src="\/thumbs\//);

    // The TO DO / DONE pills are gone from the whole page.
    expect(res.text).not.toContain('badge-todo');
    expect(res.text).not.toContain('badge-done');
  });

  test('AC4: to-do rows contain "+1 pt" and no "See photos" anchor', async () => {
    const res = await signedInTasks();

    const rows = res.text.split('task-row task-todo').slice(1);
    expect(rows.length).toBe(TODO_COUNT);
    for (const row of rows) {
      const rowMarkup = row.slice(0, row.indexOf('</li>'));
      expect(rowMarkup).toContain('+1 pt');
      expect(rowMarkup).not.toContain('See photos');
    }
    // No "See photos" link anywhere on the list page — it lives on the task
    // detail page now.
    expect(res.text).not.toContain('See photos');
  });

  test('AC5: /tasks?view=done lists all 19 done tasks and no undone titles', async () => {
    const res = await signedInTasks('?view=done');

    for (let i = 1; i <= DONE_COUNT; i++) {
      expect(res.text).toContain(`Done task ${i}`);
    }
    expect(res.text).not.toContain('Todo task');
  });
});
