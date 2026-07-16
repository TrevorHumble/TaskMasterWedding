// tests/tasks-page.test.js
// Covers issue #250 acceptance criteria — task list v2:
//   AC1 — no `white-space: nowrap` inside the `.task-desc` rule (the nowrap
//         span forced 566px-wide pages on 375px phones); asserted against the
//         shipped CSS since the suite has no browser harness
//   AC2 — chip labels render computed counts ("To do · 14", "Done · 19" — the
//         14 includes issue #409's starter tile, folded into todoCount since
//         this fixture guest has no avatar) and the default (to-do) view
//         shows every to-do title and no done task (issue #339 dropped the
//         trailing "Done" section from that view)
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
const { loadApp, signInGuest } = require('./helpers/testApp');

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
  signInGuest(app, TOKEN, agent);
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

  test('AC2: chips render "To do · 14" / "Done · 19" and the default view shows every to-do title and no done title (#339)', async () => {
    const res = await signedInTasks();

    // Issue #409's owner-redirected placement (second visual-loop edit,
    // 2026-07-14) moved the hardcoded "Upload your profile photo" starter
    // tile from a section above the filters to a real row INSIDE the to-do
    // list for this fixture guest (avatar_path is unset), and the tasks
    // route now folds it into todoCount too — so the 13 seeded todo rows
    // plus the tile read "To do · 14", not "· 13". doneCount is untouched:
    // the tile only ever occupies one side (to-do OR done), never both.
    expect(res.text).toContain('To do · 14');
    expect(res.text).toContain('Done · 19');

    // The to-do view no longer renders any done tasks or the trailing
    // "Done" section (#339) — the Done chip is the only place they show up.
    expect(res.text).not.toContain('Done task');
    expect(res.text).not.toContain('task-section-label');
    for (let i = 1; i <= TODO_COUNT; i++) {
      expect(res.text).toContain(`Todo task ${i}`);
    }
  });

  test("AC3: a done row shows the guest's /thumbs/ photo and no badge pills exist", async () => {
    const res = await signedInTasks('?view=done');

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

    // Scope to the real task list, after the chip filters. Issue #409's
    // owner-redirected placement (second visual-loop edit, 2026-07-14) made
    // the hardcoded "Upload your profile photo" starter tile a real FIRST
    // row INSIDE this same to-do list (this fixture guest has no avatar), so
    // it is itself a "task-row task-todo" row inside the scoped listHtml —
    // TODO_COUNT + 1 rows, not TODO_COUNT. It happens to satisfy the same
    // per-row assertions below ("+1 pt", no "See photos"), so no extra
    // exclusion logic is needed, just the updated count.
    const listStart = res.text.indexOf('class="task-filters"');
    expect(listStart).toBeGreaterThan(-1);
    const listHtml = res.text.slice(listStart);

    const rows = listHtml.split('task-row task-todo').slice(1);
    expect(rows.length).toBe(TODO_COUNT + 1);
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
