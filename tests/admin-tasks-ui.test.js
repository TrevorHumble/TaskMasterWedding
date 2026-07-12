// tests/admin-tasks-ui.test.js
// Covers issue #258 acceptance criteria — the tasks admin page as phone-first
// cards with move-to-top and add-to-top.
//
//   AC1 — each task renders as a card (no <table>), full-width title/textarea
//         rules in theme.css, Active + Delete controls inside the card
//   AC2 — POST reorder direction=top puts the task first; Location ends #task-<id>
//   AC3 — add-task with Add to top checked renders first; unchecked renders last
//   AC4 — single-step reorder redirect Location contains #task-<id>
//   AC5 — guest /tasks shows the moved-to-top task first (shared sort_order)
//
// REQUIRE ORDER: loadApp() must run before any require that pulls in config
// or db (see tests/helpers/testApp.js).
'use strict';

const fs = require('fs');
const path = require('path');
const { loadApp, makeAdminAgent, signInGuest } = require('./helpers/testApp');

const THEME_CSS = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'public', 'css', 'theme.css'),
  'utf8'
);

let app;
let db;
let adminAgent;

// 32 tasks, sort_order 0..31. taskIds[i] is the task at initial position i.
const taskIds = [];

beforeAll(async () => {
  const result = loadApp();
  app = result.app;
  db = result.db;
  adminAgent = await makeAdminAgent(app);

  const insert = db.prepare('INSERT INTO tasks (title, sort_order) VALUES (?, ?)');
  for (let i = 0; i < 32; i++) {
    taskIds.push(insert.run('Task number ' + (i + 1), i).lastInsertRowid);
  }

  db.prepare('INSERT INTO guests (token, name) VALUES (?, ?)').run('guesttoken', 'Guest One');
});

// Task ids in the order the admin page renders their cards.
function renderedOrder(html) {
  return [...html.matchAll(/<article class="task-admin-card[^"]*" id="task-(\d+)">/g)].map((m) =>
    parseInt(m[1], 10)
  );
}

// ---------------------------------------------------------------------------
// AC1 — cards replace the table; width rules; controls in the card
// ---------------------------------------------------------------------------
describe('AC1: task cards replace the table', () => {
  it('renders a card per task, no <table>, with Active and Delete in the card', async () => {
    const res = await adminAgent.get('/admin/tasks');
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/<table/i);
    expect(renderedOrder(res.text).length).toBe(32);

    // One card carries the edit form, active toggle, and delete form together.
    const firstCard = res.text.match(/<article class="task-admin-card[\s\S]*?<\/article>/)[0];
    expect(firstCard).toMatch(/action="\/admin\/tasks\/\d+\/active"/);
    expect(firstCard).toMatch(/action="\/admin\/tasks\/\d+\/delete"/);
    expect(firstCard).toMatch(/data-confirm=/);
    expect(firstCard).toMatch(/name="title"/);
    expect(firstCard).toMatch(/<textarea name="description" rows="3">/);
  });

  it('theme.css gives the title input and textarea ≥ 90% of the card width', () => {
    const idx = THEME_CSS.indexOf(".task-edit-form input[type='text']");
    expect(idx).toBeGreaterThan(-1);
    const body = THEME_CSS.slice(THEME_CSS.indexOf('{', idx) + 1, THEME_CSS.indexOf('}', idx));
    const width = body.match(/width:\s*(\d+)%/);
    expect(width).not.toBeNull();
    expect(parseInt(width[1], 10)).toBeGreaterThanOrEqual(90);
    // The same rule block covers the textarea.
    expect(THEME_CSS.slice(idx, THEME_CSS.indexOf('{', idx))).toContain('.task-edit-form textarea');
  });
});

// ---------------------------------------------------------------------------
// AC2 — direction=top from position 30 of 32
// ---------------------------------------------------------------------------
describe('AC2: move to top', () => {
  it('task at position 30 lands first and the redirect anchors to its card', async () => {
    const target = taskIds[29]; // position 30 of 32
    const res = await adminAgent
      .post('/admin/tasks/reorder')
      .type('form')
      .send({ id: target, direction: 'top' });

    expect(res.status).toBe(303);
    expect(res.headers.location.endsWith('#task-' + target)).toBe(true);

    const page = await adminAgent.get('/admin/tasks');
    expect(renderedOrder(page.text)[0]).toBe(target);
  });
});

// ---------------------------------------------------------------------------
// AC3 — Add to top checkbox on the add-task form
// ---------------------------------------------------------------------------
describe('AC3: add-to-top checkbox', () => {
  it('checked: the new task renders before all existing tasks', async () => {
    await adminAgent
      .post('/admin/tasks')
      .type('form')
      .send({ title: 'Dance floor at 10', add_to_top: '1' });

    const page = await adminAgent.get('/admin/tasks');
    const order = renderedOrder(page.text);
    const created = db.prepare('SELECT id FROM tasks WHERE title = ?').get('Dance floor at 10').id;
    expect(order[0]).toBe(created);
  });

  it('unchecked: the new task renders last', async () => {
    await adminAgent.post('/admin/tasks').type('form').send({ title: 'Sunset group photo' });

    const page = await adminAgent.get('/admin/tasks');
    const order = renderedOrder(page.text);
    const created = db.prepare('SELECT id FROM tasks WHERE title = ?').get('Sunset group photo').id;
    expect(order[order.length - 1]).toBe(created);
  });
});

// ---------------------------------------------------------------------------
// AC4 — single-step reorder anchors back to the moved card
// ---------------------------------------------------------------------------
describe('AC4: single-step reorder anchors', () => {
  it('direction=up redirect Location contains #task-<id>', async () => {
    const target = taskIds[5];
    const res = await adminAgent
      .post('/admin/tasks/reorder')
      .type('form')
      .send({ id: target, direction: 'up' });

    expect(res.status).toBe(303);
    expect(res.headers.location).toContain('#task-' + target);
  });

  it('direction=down redirect Location contains #task-<id>', async () => {
    const target = taskIds[5];
    const res = await adminAgent
      .post('/admin/tasks/reorder')
      .type('form')
      .send({ id: target, direction: 'down' });

    expect(res.status).toBe(303);
    expect(res.headers.location).toContain('#task-' + target);
  });
});

// ---------------------------------------------------------------------------
// AC5 — guest task list shares the order
// ---------------------------------------------------------------------------
describe('AC5: guest /tasks reflects move-to-top', () => {
  it('a task moved to top appears first for guests too', async () => {
    const target = taskIds[17];
    await adminAgent
      .post('/admin/tasks/reorder')
      .type('form')
      .send({ id: target, direction: 'top' });

    const guestAgent = signInGuest(app, 'guesttoken');
    const res = await guestAgent.get('/tasks');
    expect(res.status).toBe(200);

    // taskIds[17]'s title. "Task number 18" is no other title's prefix, and
    // the comparison titles below are prefix-unambiguous too.
    const targetPos = res.text.indexOf('Task number 18');
    expect(targetPos).toBeGreaterThan(-1);
    ['Task number 31', 'Dance floor at 10', 'Sunset group photo'].forEach((title) => {
      const otherPos = res.text.indexOf(title);
      expect(otherPos).toBeGreaterThan(-1);
      expect(targetPos).toBeLessThan(otherPos);
    });
  });
});
