// tests/leaderboard-reconcile.test.js
//
// Issue #149: reconciliation guard for leaderboard() after #89 (per-photo
// points SELECT) and #78 (tiebreaker ORDER BY) both merged into the same
// query. Neither issue's own tests cover a tie CREATED by the per-photo bonus
// and then RESOLVED by the tiebreaker — the exact seam a bad merge of the two
// edits would break. This test pins that combined behavior.
//
// REQUIRE ORDER: config / db / app are required only AFTER loadApp() sets
// DATA_DIR / DB_PATH. Do not hoist requires above the loadApp() call.
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

// Wipe the tables these tests populate so each test starts from an empty field.
function resetField() {
  db.prepare('DELETE FROM guest_badges').run();
  db.prepare('DELETE FROM submissions').run();
  db.prepare('DELETE FROM guests').run();
  db.prepare('DELETE FROM badges').run();
}

let seq = 0;

function makeGuest(name, bonusPoints = 0) {
  const token = `reconcile-token-${seq++}`;
  return db
    .prepare(`INSERT INTO guests (token, name, bonus_points) VALUES (?, ?, ?)`)
    .run(token, name, bonusPoints).lastInsertRowid;
}

/**
 * Insert one visible submission for guestId with the given photo_bonus and
 * created_at (a comparable TEXT datetime, same 'YYYY-MM-DD HH:MM:SS' shape
 * tests/leaderboard-ties.test.js uses for MAX(s.created_at) comparisons).
 * A fresh task per call avoids the UNIQUE(guest_id, task_id) collision.
 */
function seedSubmission(guestId, { photoBonus = 0, minute = 0 } = {}) {
  const taskId = db
    .prepare(`INSERT INTO tasks (title) VALUES (?)`)
    .run(`Reconcile task ${seq++}`).lastInsertRowid;
  const base = Date.parse('2026-08-07T18:00:00Z');
  const ts = new Date(base + minute * 60000)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, '');
  db.prepare(
    `INSERT INTO submissions
       (guest_id, task_id, photo_path, thumb_path, taken_down, photo_bonus, created_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`
  ).run(guestId, taskId, `p${seq}.jpg`, `t${seq}.jpg`, photoBonus, ts);
}

// Extract the text of every <span class="rank ...">…</span> element within
// the given HTML slice, in document order (same pattern as leaderboard-ties.test.js).
function rankLabels(html) {
  const out = [];
  const re = /<span class="rank[^"]*">([\s\S]*?)<\/span>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push(m[1].trim());
  }
  return out;
}

async function signedInBoard(token) {
  const agent = request.agent(app);
  signInGuest(app, token, agent);
  const res = await agent.get('/leaderboard');
  expect(res.status).toBe(200);
  return res;
}

describe('leaderboard reconciliation (#149): per-photo points (#89) + tiebreaker (#78)', () => {
  // -------------------------------------------------------------------------
  // AC1 + AC3: A and B both total 5 (a tie created by the per-photo bonus
  // term, not by raw completed count), A's latest submission earlier than
  // B's -> both labelled plain rank 1 (dense ranking, issue #626), A's row before B's.
  // -------------------------------------------------------------------------
  test('AC1: A (2 subs, photo_bonus 1+2) and B (5 subs, bonus 0) both total 5', async () => {
    resetField();

    const guestA = makeGuest('Reconcile Alpha', 0);
    const guestB = makeGuest('Reconcile Bravo', 0);

    // A: two visible submissions, photo_bonus 1 and 2 -> 2 base + 3 bonus = 5.
    seedSubmission(guestA, { photoBonus: 1, minute: 0 });
    seedSubmission(guestA, { photoBonus: 2, minute: 1 });

    // B: five visible submissions, photo_bonus 0 each -> 5 base + 0 = 5.
    for (let i = 0; i < 5; i++) {
      seedSubmission(guestB, { photoBonus: 0, minute: 2 + i });
    }

    const scoring = require('../src/services/scoring');
    const rows = scoring.leaderboard();
    const rowA = rows.find((r) => r.id === guestA);
    const rowB = rows.find((r) => r.id === guestB);

    // If the per-photo SUM(photo_bonus) term were dropped, A's total would be
    // 2 (base only), not 5 — this assertion catches that regression directly.
    expect(rowA.points).toBe(5);
    expect(rowB.points).toBe(5);
  });

  test('AC2: guest C (1 sub, photo_bonus 4, guests.bonus_points 3) totals 8', async () => {
    resetField();
    const guestC = makeGuest('Reconcile Charlie', 3);
    seedSubmission(guestC, { photoBonus: 4, minute: 0 });

    const scoring = require('../src/services/scoring');
    const rows = scoring.leaderboard();
    const rowC = rows.find((r) => r.id === guestC);

    // 1 base + 4 photo-bonus + 3 guest-bonus = 8. Dropping either bonus term,
    // or double-counting one, would land on a different number (e.g. 5 if
    // guests.bonus_points were dropped, or 12 if photo_bonus were doubled).
    expect(rowC.points).toBe(8);
  });

  test('AC3 (rendered): tied A/B (both 5) render identical plain rank-1 labels and A-before-B row order', async () => {
    resetField();

    // Names deliberately chosen so "Zed" > "Yara" alphabetically — i.e. the
    // guest that must sort FIRST (earlier last_submission_at) has the name
    // that sorts LATER. This makes the name/id fallback keys in the ORDER BY
    // insufficient to produce A-before-B on their own: only a correctly
    // functioning created_at tiebreaker can put Zed ahead of Yara. If the
    // tiebreaker were dropped (falling through to name ASC) or inverted, this
    // test would fail rather than passing by alphabetical coincidence.
    const tokenA = 'reconcile-render-a';
    const tokenB = 'reconcile-render-b';
    const guestA = db
      .prepare(`INSERT INTO guests (token, name, bonus_points) VALUES (?, ?, 0)`)
      .run(tokenA, 'Reconcile Zed').lastInsertRowid;
    const guestB = db
      .prepare(`INSERT INTO guests (token, name, bonus_points) VALUES (?, ?, 0)`)
      .run(tokenB, 'Reconcile Yara').lastInsertRowid;

    // A: two visible submissions, photo_bonus 1 and 2 -> 2 base + 3 bonus = 5.
    // Latest submission at minute 1, earlier than B's latest (minute 6).
    seedSubmission(guestA, { photoBonus: 1, minute: 0 });
    seedSubmission(guestA, { photoBonus: 2, minute: 1 });

    // B: five visible submissions, photo_bonus 0 -> 5 base = 5.
    // Latest submission at minute 6, later than A's.
    for (let i = 0; i < 5; i++) {
      seedSubmission(guestB, { photoBonus: 0, minute: 2 + i });
    }

    const scoring = require('../src/services/scoring');
    const rows = scoring.leaderboard();
    expect(rows.find((r) => r.id === guestA).points).toBe(5);
    expect(rows.find((r) => r.id === guestB).points).toBe(5);

    const res = await signedInBoard(tokenA);

    // Restrict the rank-label and order checks to the full-standings <ol> —
    // same convention as tests/leaderboard-ties.test.js — since the podium
    // above may render a collapsed tie tile with its own rank spans.
    const list = res.text.slice(res.text.indexOf('<ol'));

    const idxA = list.indexOf('Reconcile Zed');
    const idxB = list.indexOf('Reconcile Yara');
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);
    // A (Zed)'s earlier last_submission_at must sort it before B (Yara)
    // within the tie, DESPITE "Zed" sorting after "Yara" alphabetically. If
    // the tiebreaker were inverted, or dropped so ORDER BY fell through to
    // name ASC, this would flip to Yara-before-Zed and fail here.
    expect(idxA).toBeLessThan(idxB);

    const listLabels = rankLabels(list);
    // Dense ranking (issue #626) drops the old "T" tie prefix — a tie is a
    // plain repeated number.
    const rank1Count = listLabels.filter((l) => l === '1').length;
    expect(rank1Count).toBe(2);
    expect(listLabels).not.toContain('2');
  });
});
