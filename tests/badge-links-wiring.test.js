// tests/badge-links-wiring.test.js
// Issue #488 (folded-in scope) — a badge is only a "story you can explore" if
// every place a badge or a task appears actually LINKS to /badge/:code. This
// file asserts that wiring on each surface that renders badge art or a task:
//   - badge art on the guest home, the public profile, and the leaderboard
//     links to that badge's own detail page;
//   - every task row on GET /tasks, and the task detail page GET /tasks/:id,
//     links to that task's own badge (code TASK-<id>).
//
// REQUIRE ORDER: config/db/app only after loadApp() sets DATA_DIR/DB_PATH.
// Sign-in is required for every request (src/routes/guest.js applies
// requireGuest to '/'), exactly as documented in badge-detail-page.test.js.
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

let guestSeq = 0;
function makeGuest(name) {
  guestSeq += 1;
  const token = `badge-links-${guestSeq}`;
  const id = db
    .prepare('INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)')
    .run(token, name).lastInsertRowid;
  return { id, token };
}

let taskSeq = 0;
function makeTask() {
  taskSeq += 1;
  return db
    .prepare(`INSERT INTO tasks (title, is_active) VALUES (?, 1)`)
    .run(`Wiring fixture task ${taskSeq}`).lastInsertRowid;
}

function grantSystemBadge(guestId, code) {
  const badge = db.prepare('SELECT id FROM badges WHERE code = ?').get(code);
  db.prepare(
    `INSERT INTO guest_badges (guest_id, badge_id, awarded_by) VALUES (?, ?, 'system')`
  ).run(guestId, badge.id);
}

function signIn(token) {
  return signInGuest(app, token);
}

describe('Badge art links to its detail page (guest home, profile, leaderboard)', () => {
  it('wraps the badge on all three surfaces in an href to /badge/<code>', async () => {
    const guest = makeGuest('Priya');
    // BLOOM is a real catalog badge seeded by db.js's boot path.
    grantSystemBadge(guest.id, 'BLOOM');

    const agent = await signIn(guest.token);

    // Guest home (GET /): the guest's own badge grid.
    const home = await agent.get('/');
    expect(home.status).toBe(200);
    expect(home.text).toContain('href="/badge/BLOOM"');

    // Public profile (GET /u/:id): anyone's badge grid.
    const profile = await agent.get(`/u/${guest.id}`);
    expect(profile.status).toBe(200);
    expect(profile.text).toContain('href="/badge/BLOOM"');

    // Leaderboard (GET /leaderboard): the small badge icons beside each name.
    const board = await agent.get('/leaderboard');
    expect(board.status).toBe(200);
    expect(board.text).toContain('href="/badge/BLOOM"');
  });
});

describe("The task detail page links to the task's own badge", () => {
  it('renders an href to /badge/TASK-<id> on GET /tasks/:id', async () => {
    // The tasks LIST itself deliberately does not carry a direct badge link:
    // issue #486 owns that surface (each row shows "Earn [name] plus extra
    // points" and the whole row links to the task detail). A task's badge is
    // reached from there via the task detail's "Earns:" line, asserted here.
    const guest = makeGuest('Marcus');
    const taskId = makeTask();
    // The task's own badge row (code TASK-<id>); resolve it through the real
    // production path so the code the page renders is the code the route
    // actually derived, never an assumed shape.
    const badge = taskBadges.resolveTaskBadge(taskId);
    const expectedHref = `href="/badge/${badge.code}"`;

    const agent = await signIn(guest.token);

    // Task detail (GET /tasks/:id): the "Earns:" line links the badge.
    const detail = await agent.get(`/tasks/${taskId}`);
    expect(detail.status).toBe(200);
    expect(detail.text).toContain(expectedHref);
  });
});
