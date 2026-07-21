// tests/admin-tasks-ui.test.js
// Covers issue #258 acceptance criteria — the tasks admin page as phone-first
// cards with move-to-top and add-to-top — RETARGETED to the issue #682
// redesign's markup (`<li class="admin-task-card">` tap-to-edit cards, a
// separate edit popup instead of inline Active/Delete forms). The page these
// tests originally exercised (`<article class="task-admin-card">` with
// Active/Delete forms baked into the card, a `.task-edit-form` percentage-
// width rule) no longer exists — #682's owner-approved redesign replaced it
// wholesale — so the markup assertions below were rewritten against the
// current DOM.
//
//   AC1 — each task renders as an <li> card (no <table>), with a drag handle
//         and a tap-to-edit opener; Active/Delete now live in the edit popup
//         (tests/admin-tasks-crud.test.js), not inline in the card.
//   AC3 — add_to_top field (route-level; the wizard's own UI no longer
//         exposes a checkbox — see issue #682's owner-approved design) renders
//         first; omitted renders last. Every create POST now carries a valid
//         badge_icon (issue #682 AC-A: badge is required server-side).
//
// The original AC2 (move-to-top), AC4 (single-step reorder anchors), and AC5
// (guest task list reflects the admin's order) all drove POST /admin/tasks/
// reorder — the old neighbor-swap up/down/top route, REMOVED by the #682
// review fix that deleted its now-orphaned UI (the redesign's drag handle
// only ever posts a FULL reordered list). That coverage now lives, repointed
// to POST /admin/tasks/reorder-all, in tests/admin-tasks-crud.test.js's
// "AC-C: POST /admin/tasks/reorder-all" describe block (persists sort_order
// AND asserts the guest task list reflects it) — not duplicated here.
//
// REQUIRE ORDER: loadApp() must run before any require that pulls in config
// or db (see tests/helpers/testApp.js).
'use strict';

const { loadApp, makeAdminAgent } = require('./helpers/testApp');

let app;
let db;
let adminAgent;

beforeAll(async () => {
  const result = loadApp();
  app = result.app;
  db = result.db;
  adminAgent = await makeAdminAgent(app);

  const insert = db.prepare('INSERT INTO tasks (title, sort_order) VALUES (?, ?)');
  for (let i = 0; i < 32; i++) {
    insert.run('Task number ' + (i + 1), i);
  }

  db.prepare('INSERT INTO guests (token, name) VALUES (?, ?)').run('guesttoken', 'Guest One');
});

// Task ids in the order the admin page renders their cards. The class and id
// attributes are on separate (indented) lines in the source template, so the
// gap between them is whitespace/newlines, not a single literal space.
function renderedOrder(html) {
  return [...html.matchAll(/<li class="admin-task-card[^"]*"\s+id="task-(\d+)"/g)].map((m) =>
    parseInt(m[1], 10)
  );
}

// ---------------------------------------------------------------------------
// AC1 — cards render as <li>s, no <table>, tap-to-edit + drag handle present
// ---------------------------------------------------------------------------
describe('AC1: task cards render (issue #682 markup)', () => {
  it('renders a card per task, no <table>, each with a drag handle and a tap-to-edit opener', async () => {
    const res = await adminAgent.get('/admin/tasks');
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/<table/i);
    expect(renderedOrder(res.text).length).toBe(32);

    const firstCard = res.text.match(/<li class="admin-task-card[\s\S]*?<\/li>/)[0];
    expect(firstCard).toMatch(/class="admin-task-drag"/);
    expect(firstCard).toMatch(/data-edit-task="\d+"/);
    expect(firstCard).toMatch(/class="task-points"/);
  });
});

// ---------------------------------------------------------------------------
// AC3 — add_to_top field. Issue #682's 3-step wizard requires a badge on
// every create (AC-A), so every send() below carries a valid catalog
// badge_icon.
// ---------------------------------------------------------------------------
describe('AC3: add_to_top', () => {
  it('set: the new task renders before all existing tasks', async () => {
    await adminAgent
      .post('/admin/tasks')
      .type('form')
      .send({ title: 'Dance floor at 10', add_to_top: '1', badge_icon: 'favorite' });

    const page = await adminAgent.get('/admin/tasks');
    const order = renderedOrder(page.text);
    const created = db.prepare('SELECT id FROM tasks WHERE title = ?').get('Dance floor at 10').id;
    expect(order[0]).toBe(created);
  });

  it('omitted: the new task renders last', async () => {
    await adminAgent
      .post('/admin/tasks')
      .type('form')
      .send({ title: 'Sunset group photo', badge_icon: 'favorite' });

    const page = await adminAgent.get('/admin/tasks');
    const order = renderedOrder(page.text);
    const created = db.prepare('SELECT id FROM tasks WHERE title = ?').get('Sunset group photo').id;
    expect(order[order.length - 1]).toBe(created);
  });
});
