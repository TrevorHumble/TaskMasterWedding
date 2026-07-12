// tests/badge-frontend.test.js
// Issue #88: the home screen's contradictory "next badge" threshold line is
// removed; the single progress bar is re-based on task completion
// (completedTasks / totalTasks), and badge rendering on home, the
// leaderboard, and the public profile keeps working unchanged.
'use strict';

const { loadApp, signInGuest } = require('./helpers/testApp');

let app;
let db;
let scoring;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
  scoring = require('../src/services/scoring');
  // scripts/seed.js inserts the canonical badge catalog (BLOOM/EARLYBIRD/etc.)
  // and 6 sample tasks — the same "6 seeded tasks" the issue's AC1 refers to.
  require('../scripts/seed.js');
});

let guestSeq = 0;
function makeGuest(name) {
  guestSeq += 1;
  const token = `badge-fe-${guestSeq}`;
  const id = db
    .prepare('INSERT INTO guests (token, name) VALUES (?, ?)')
    .run(token, name).lastInsertRowid;
  return { id, token };
}

let subSeq = 0;
function submit(guestId, taskId) {
  subSeq += 1;
  db.prepare(
    `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
     VALUES (?, ?, ?, ?, 0)`
  ).run(guestId, taskId, `p${subSeq}.jpg`, `t${subSeq}.jpg`);
}

function signIn(token) {
  return signInGuest(app, token);
}

describe('AC1/AC5: home progress bar is re-based on task completion, not badge thresholds', () => {
  it('a guest with 2 of 6 active tasks complete sees "2 of 6", no "to your next badge", and aria-valuenow="33"', async () => {
    // seed.js's 6 sample tasks are the only active tasks at this point (fresh
    // temp DB, nothing else has touched `tasks` yet in this file).
    const activeTaskIds = db
      .prepare('SELECT id FROM tasks WHERE is_active = 1 ORDER BY id LIMIT 2')
      .all()
      .map((r) => r.id);
    expect(activeTaskIds.length).toBe(2);

    const guest = makeGuest('AC1 Guest');
    for (const taskId of activeTaskIds) submit(guest.id, taskId);

    const agent = await signIn(guest.token);
    const res = await agent.get('/');

    expect(res.status).toBe(200);
    expect(res.text).toContain('2 of 6');
    expect(res.text).not.toContain('to your next badge');
    // AC5: round(2/6*100) = 33.
    expect(res.text).toMatch(/role="progressbar"[^>]*aria-valuenow="33"/);
  });

  it('clamps aria-valuenow to 100 when completedTasks exceeds totalTasks (task deactivated after completion)', async () => {
    // This case needs an EXACT active-task denominator (2, then 1), so first
    // snapshot and clear every currently-active task, then restore them at the
    // end — later tests must still see seed.js's original 6 active tasks.
    const previouslyActive = db
      .prepare('SELECT id FROM tasks WHERE is_active = 1')
      .all()
      .map((r) => r.id);
    db.prepare('UPDATE tasks SET is_active = 0').run();

    const t1 = db
      .prepare("INSERT INTO tasks (title, is_active) VALUES ('Clamp task A', 1)")
      .run().lastInsertRowid;
    const t2 = db
      .prepare("INSERT INTO tasks (title, is_active) VALUES ('Clamp task B', 1)")
      .run().lastInsertRowid;

    const guest = makeGuest('Clamp Guest');
    submit(guest.id, t1);
    submit(guest.id, t2); // completedTasks = 2 (canonical count ignores is_active)

    // Admin later deactivates one of the completed tasks: totalTasks drops to
    // 1 while completedTasks stays 2, so the raw ratio is 200% — the clamp
    // must hold it at 100.
    db.prepare('UPDATE tasks SET is_active = 0 WHERE id = ?').run(t2);

    const agent = await signIn(guest.token);
    const res = await agent.get('/');
    expect(res.status).toBe(200);
    // Without the [0,100] clamp this element would carry aria-valuenow="200".
    expect(res.text).toMatch(/role="progressbar"[^>]*aria-valuenow="100"/);

    // Restore the seeded active-task field so later tests see the original 6.
    db.prepare('UPDATE tasks SET is_active = 0 WHERE id IN (?, ?)').run(t1, t2);
    if (previouslyActive.length > 0) {
      db.prepare(
        `UPDATE tasks SET is_active = 1 WHERE id IN (${previouslyActive.map(() => '?').join(',')})`
      ).run(...previouslyActive);
    }
  });
});

describe('AC2/AC3/AC4: badge rendering on home, leaderboard, and profile is unbroken', () => {
  it('a guest holding BLOOM sees "First Bloom" on home, on their leaderboard row, and on their profile', async () => {
    const guest = makeGuest('AC2 Bloom Guest');

    // BLOOM is an 'auto' badge granted by recomputeBadges once completedTasks
    // reaches its threshold (5, per scripts/seed.js's catalog row) — submit 5
    // of the 6 seeded active tasks.
    const taskIds = db
      .prepare('SELECT id FROM tasks WHERE is_active = 1 ORDER BY id LIMIT 5')
      .all()
      .map((r) => r.id);
    expect(taskIds.length).toBe(5);
    for (const taskId of taskIds) submit(guest.id, taskId);
    scoring.recomputeBadges(guest.id);

    const codes = db
      .prepare(
        `SELECT b.code FROM guest_badges gb JOIN badges b ON b.id = gb.badge_id WHERE gb.guest_id = ?`
      )
      .all(guest.id)
      .map((r) => r.code);
    expect(codes).toContain('BLOOM');

    const agent = await signIn(guest.token);

    // AC2: home.
    const home = await agent.get('/');
    expect(home.text).toContain('First Bloom');

    // AC3: leaderboard row.
    const board = await agent.get('/leaderboard');
    expect(board.status).toBe(200);
    expect(board.text).toContain('First Bloom');

    // AC4: public profile.
    const profile = await agent.get('/u/' + guest.id);
    expect(profile.status).toBe(200);
    expect(profile.text).toContain('First Bloom');
  });

  it('AC4: a badge-less guest sees "No badges yet" on their profile', async () => {
    const guest = makeGuest('AC4 Empty Guest');
    const agent = await signIn(guest.token);
    const profile = await agent.get('/u/' + guest.id);
    expect(profile.status).toBe(200);
    expect(profile.text).toContain('No badges yet');
  });
});

describe('AC6: home renders a full 12-badge collection without truncation', () => {
  it('a guest holding 12 distinct badges sees all 12 names on GET /', async () => {
    const guest = makeGuest('AC6 Guest');

    // 4 seeded 'special' codes (admin-awardable) plus 8 freshly created
    // 'custom' codes (also admin-awardable) = 12 distinct held badges.
    const specialCodes = ['EARLYBIRD', 'SHUTTERBUG', 'CROWDFAV', 'CHOICE'];
    for (const code of specialCodes) {
      expect(scoring.awardSpecialBadge(guest.id, code)).toBe(true);
    }

    // Suffix with a monotonic counter so a retried test (vitest retries a
    // failed test before reporting it) never collides with the code its own
    // earlier attempt already inserted.
    guestSeq += 1;
    const runId = guestSeq;
    const customNames = [];
    for (let i = 0; i < 8; i++) {
      const code = `AC6CUSTOM${runId}${i}`;
      const name = `AC6 Custom Badge ${i}`;
      const badge = scoring.createCustomBadge({
        code,
        name,
        type: 'custom',
        artPath: '🏅',
        description: 'AC6 fixture badge.',
      });
      expect(badge).toBeTruthy();
      expect(scoring.awardSpecialBadge(guest.id, code)).toBe(true);
      customNames.push(name);
    }

    const heldCount = db
      .prepare('SELECT COUNT(*) AS n FROM guest_badges WHERE guest_id = ?')
      .get(guest.id).n;
    expect(heldCount).toBe(12); // 4 special + 8 custom = 12 distinct badges

    const agent = await signIn(guest.token);
    const res = await agent.get('/');
    expect(res.status).toBe(200);

    // Fetch the actual seeded names for the special codes rather than
    // assuming wording, so this assertion can't drift from scripts/seed.js.
    // EJS escapes HTML entities (e.g. "'" -> "&#39;") by default, so compare
    // against the same escaping the view produces rather than the raw DB value.
    const escapeHtml = (s) =>
      s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/'/g, '&#39;')
        .replace(/"/g, '&#34;');

    const actualSpecialNames = db
      .prepare(`SELECT name FROM badges WHERE code IN (${specialCodes.map(() => '?').join(',')})`)
      .all(...specialCodes)
      .map((r) => r.name);
    expect(actualSpecialNames.length).toBe(4);

    for (const name of actualSpecialNames) {
      expect(res.text).toContain(escapeHtml(name));
    }
    for (const name of customNames) {
      expect(res.text).toContain(name);
    }
  });
});
