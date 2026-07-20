// tests/leaderboard-ties.test.js
// Covers issue #626 (pedestal redesign), superseding this file's earlier
// standard-competition ("T3"/"1224") coverage of issue #78/#249/#361:
//   AC1 — dense ("1223") ranking: rank increments only when points change, so
//         a tie never leaves the rank below it empty (points [24,20x8,18x2]
//         -> dense ranks 1, 2x8, 3x2 — never skipping to 10)
//   AC2 — the standings show the PLAIN dense number, never a "T" prefix
//   AC3 — a 3rd-place tier is present whenever 3+ distinct point values exist
//   AC4 — a tier over 9 tied guests shows exactly 9 avatars + a "+N" chip; a
//         tier of 9 or fewer shows every avatar and no chip
//   AC5 — 1st place is crowned; a lone champion gets the hero-size cluster
//         (no `is-tie`), a tied champion keeps normal cluster size (`is-tie`)
//   AC6 — an all-guest tie suppresses the podium, showing "everyone's tied"
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

// ---------------------------------------------------------------------------
// Seeding helpers. Each visible submission is worth POINTS_PER_PHOTO = 1, so a
// guest's point total is (their visible submission count) + bonus_points. We
// give each guest a single dedicated task and clone it into N submissions to
// hit an exact point value while keeping distinct created_at timestamps.
// ---------------------------------------------------------------------------

// Wipe the tables these tests populate so each test starts from an empty field.
function resetField() {
  db.prepare('DELETE FROM guest_badges').run();
  db.prepare('DELETE FROM submissions').run();
  db.prepare('DELETE FROM guests').run();
  db.prepare('DELETE FROM badges').run();
}

let seq = 0;
let lastToken = null;

// /leaderboard sits behind guest.js's requireGuest, so a viewer must be signed
// in. We sign in as one of the already-seeded guests (via signInGuest, the
// same pattern the other route tests use) rather than adding an extra guest to
// the field, which would perturb the engineered point distributions.
async function signedInBoard(token) {
  const agent = request.agent(app);
  signInGuest(app, token, agent);
  const res = await agent.get('/leaderboard');
  expect(res.status).toBe(200);
  return res;
}

/**
 * Create a guest with exactly `points` points, built from `points` visible
 * submissions. Returns the guest id.
 */
function makeGuest(name, points) {
  const token = `tie-token-${seq++}`;
  const guestId = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run(token, name).lastInsertRowid;
  lastToken = token;

  const insertSub = db.prepare(
    `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, created_at)
     VALUES (?, ?, ?, ?, 0, ?)`
  );
  const base = Date.parse('2026-08-07T18:00:00Z');
  for (let i = 0; i < points; i++) {
    // A fresh task per submission avoids the UNIQUE(guest_id, task_id) collision.
    const taskId = db
      .prepare(`INSERT INTO tasks (title) VALUES (?)`)
      .run(`Tie task ${seq}-${i}`).lastInsertRowid;
    const ts = new Date(base + i * 60000)
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d+Z$/, '');
    insertSub.run(guestId, taskId, `p${seq}-${i}.jpg`, `t${seq}-${i}.jpg`, ts);
  }
  return guestId;
}

/** Insert `n` distinct badges and award all of them to `guestId`. */
function giveBadges(guestId, n) {
  const insBadge = db.prepare(
    `INSERT INTO badges (code, name, type, art_path) VALUES (?, ?, 'special', ?)`
  );
  const award = db.prepare(
    `INSERT INTO guest_badges (guest_id, badge_id, awarded_by) VALUES (?, ?, 'admin')`
  );
  for (let i = 0; i < n; i++) {
    const badgeId = insBadge.run(
      `TIEBADGE_${seq}_${i}`,
      `Badge ${i}`,
      `/badges/b${seq}-${i}.svg`
    ).lastInsertRowid;
    award.run(guestId, badgeId);
  }
  seq++;
}

// The podium highlight block: from its opening div to the "Full standings"
// heading that always follows it. Scopes assertions to podium markup only.
function podiumMarkup(html) {
  const start = html.indexOf('<div class="podium">');
  const end = html.indexOf('lb-standings-title');
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, end);
}

// The markup for one podium-slot rank (rank-1/2/3), isolated by scanning to
// the next "rank-" marker (or the end of the podium block for the last slot
// in DOM order). Display order is 2nd, 1st, 3rd, so rank-1's slice must stop
// at rank-3, not run to the end, when a 3rd-place slot follows it.
function slotMarkup(podium, rank) {
  const marker = `rank-${rank}`;
  const start = podium.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const rest = podium.slice(start + marker.length);
  const nextMatch = rest.match(/rank-\d/);
  return nextMatch ? rest.slice(0, nextMatch.index) : rest;
}

// Extract the text of every <span class="rank ...">…</span> element in order
// (the full-standings list; the podium itself carries no .rank spans).
function rankLabels(html) {
  const out = [];
  const re = /<span class="rank[^"]*">([\s\S]*?)<\/span>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push(m[1].trim());
  }
  return out;
}

// ---------------------------------------------------------------------------

describe('leaderboard dense ranking (#626)', () => {
  test('AC1/AC2: points [24,20x8,18x2] -> dense ranks 1, 2x8 (no skip to 10), 3x2 — plain labels, no "T"', async () => {
    resetField();
    makeGuest('Solo Top', 24);
    for (let i = 0; i < 8; i++) makeGuest(`Mid ${i}`, 20);
    makeGuest('Low A', 18);
    makeGuest('Low B', 18);

    const res = await signedInBoard(lastToken);
    const labels = rankLabels(res.text);

    expect(labels.filter((l) => l === '1').length).toBe(1);
    expect(labels.filter((l) => l === '2').length).toBe(8);
    expect(labels.filter((l) => l === '3').length).toBe(2);
    // Dense ranking never skips to 10 for the rank below an 8-way tie, and
    // no label ever carries the old "T" tie prefix.
    expect(labels).not.toContain('10');
    expect(labels.some((l) => l.includes('T'))).toBe(false);

    // The podium groups mirror the standings exactly: rank 1 = [24] (lone,
    // hero-sized), rank 2 = the eight 20s, rank 3 = the two 18s.
    const podium = podiumMarkup(res.text);
    const rank1 = slotMarkup(podium, 1);
    const rank2 = slotMarkup(podium, 2);
    const rank3 = slotMarkup(podium, 3);
    expect((rank1.match(/class="podium-cluster-avatar"/g) || []).length).toBe(1);
    expect(rank1).not.toContain('is-tie');
    expect((rank2.match(/class="podium-cluster-avatar"/g) || []).length).toBe(8);
    expect(rank2).not.toContain('podium-cluster-more');
    expect((rank3.match(/class="podium-cluster-avatar"/g) || []).length).toBe(2);
  });

  test('AC3: [5,4,3,3,3,3,1] (4 distinct values) -> dense ranks 1,2,3,3,3,3,4 — 3rd never empty, never skips to 7', async () => {
    resetField();
    makeGuest('Alpha', 5);
    makeGuest('Bravo', 4);
    makeGuest('Cara', 3);
    makeGuest('Dara', 3);
    makeGuest('Elle', 3);
    makeGuest('Finn', 3);
    makeGuest('Gwen', 1);

    const res = await signedInBoard(lastToken);
    const labels = rankLabels(res.text);

    expect(labels.filter((l) => l === '3').length).toBe(4);
    // The old standard-competition gap (rank 7) is gone: the next distinct
    // rank after the four-way tie is dense rank 4.
    expect(labels).toContain('4');
    expect(labels).not.toContain('7');
    expect(labels).not.toContain('6');

    // The 3rd-place podium tier itself carries all four tied guests.
    const podium = podiumMarkup(res.text);
    const rank3 = slotMarkup(podium, 3);
    for (const name of ['Cara', 'Dara', 'Elle', 'Finn']) {
      expect(rank3).toContain(name);
    }
  });

  test('AC2: two-way tie for 1st shows two plain "1" labels, no rank "2", no "T" anywhere', async () => {
    resetField();
    makeGuest('Alpha', 3);
    makeGuest('Bravo', 3);
    makeGuest('Cara', 1);

    const res = await signedInBoard(lastToken);
    const labels = rankLabels(res.text);

    expect(labels.filter((l) => l === '1').length).toBe(2);
    // Dense ranking: the next distinct rank is 2 (not 3, as standard-competition
    // ranking would have produced).
    expect(labels.filter((l) => l === '2').length).toBe(1);
    expect(labels.some((l) => l.includes('T'))).toBe(false);
  });

  test('AC6: all-guest tie suppresses the podium and shows "everyone\'s tied"', async () => {
    resetField();
    makeGuest('Alpha', 2);
    makeGuest('Bravo', 2);
    makeGuest('Cara', 2);

    const res = await signedInBoard(lastToken);
    expect(res.status).toBe(200);
    expect(res.text).toContain("everyone's tied");
    expect(res.text).not.toContain('podium-slot');
  });

  test('AC6: badge row caps at 8 icons + one "+4" chip; 3 badges show 3 icons and no chip', async () => {
    resetField();
    const big = makeGuest('BigCollector', 5);
    const small = makeGuest('SmallCollector', 3);
    giveBadges(big, 12);
    giveBadges(small, 3);

    const res = await signedInBoard(lastToken);

    // Isolate each guest's LIST row so badge counts don't cross-contaminate.
    const list = res.text.slice(res.text.indexOf('<ol'));
    const rowOf = (name) => {
      const start = list.indexOf(name);
      const li = list.lastIndexOf('<li', start);
      const end = list.indexOf('</li>', start);
      return list.slice(li, end);
    };

    const bigRow = rowOf('BigCollector');
    const bigIcons = (bigRow.match(/<img class="lb-badge-icon"/g) || []).length;
    expect(bigIcons).toBe(8);
    const bigMore = bigRow.match(/<span class="lb-badge-more">([^<]*)<\/span>/);
    expect(bigMore).not.toBeNull();
    expect(bigMore[1]).toContain('+4');

    const smallRow = rowOf('SmallCollector');
    const smallIcons = (smallRow.match(/<img class="lb-badge-icon"/g) || []).length;
    expect(smallIcons).toBe(3);
    expect(smallRow).not.toContain('lb-badge-more');
  });
});

// ---------------------------------------------------------------------------
// Issue #626 — capped grow-to-fit tiers: a tie beyond 9 members folds into a
// "+N" chip; 9 or fewer shows every avatar with no chip.
// ---------------------------------------------------------------------------
describe('podium capped grow-to-fit tiers (#626)', () => {
  test('AC4: a 12-way tie renders exactly 9 avatars plus a "+3" chip', async () => {
    resetField();
    makeGuest('Solo Top', 30);
    for (let i = 0; i < 12; i++) makeGuest(`Mid ${i}`, 20);
    makeGuest('Solo Bottom', 10);

    const res = await signedInBoard(lastToken);
    const podium = podiumMarkup(res.text);
    const rank2 = slotMarkup(podium, 2);

    expect((rank2.match(/class="podium-cluster-avatar"/g) || []).length).toBe(9);
    expect(rank2).toContain('+3');
  });

  test('AC4: a 9-way tie renders all 9 avatars and no "+N" chip', async () => {
    resetField();
    makeGuest('Solo Top', 30);
    for (let i = 0; i < 9; i++) makeGuest(`Mid ${i}`, 20);
    makeGuest('Solo Bottom', 10);

    const res = await signedInBoard(lastToken);
    const podium = podiumMarkup(res.text);
    const rank2 = slotMarkup(podium, 2);

    expect((rank2.match(/class="podium-cluster-avatar"/g) || []).length).toBe(9);
    expect(rank2).not.toContain('podium-cluster-more');
  });

  test('every podium avatar (tied or lone) is wrapped in a /u/<id> profile anchor', async () => {
    resetField();
    makeGuest('Alpha Winner', 19);
    makeGuest('Liam Park', 12);
    makeGuest('Priya Rao', 12);
    makeGuest('Noah Bell', 12);

    const res = await signedInBoard(lastToken);
    const podium = podiumMarkup(res.text);

    const anchors = podium.match(/<a class="podium-cluster-avatar"[^>]*>/g) || [];
    // 1 lone champion + 3 tied 2nd-place avatars = 4 total.
    expect(anchors.length).toBe(4);
    for (const tag of anchors) {
      expect(tag).toMatch(/href="\/u\/\d+"/);
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #626 — crowned champion: a lone 1st place gets the hero-size cluster
// (`is-tie` absent); a 1st-place tie keeps every co-champion at normal
// cluster size (`is-tie` present).
// ---------------------------------------------------------------------------
describe('podium crowned champion sizing (#626)', () => {
  test('AC5: a lone 1st place is crowned and its cluster carries no "is-tie" class', async () => {
    resetField();
    makeGuest('Solo Champion', 10);
    makeGuest('Runner Up', 5);
    makeGuest('Third Place', 2);

    const res = await signedInBoard(lastToken);
    const podium = podiumMarkup(res.text);
    const rank1 = slotMarkup(podium, 1);

    expect(rank1).toContain('podium-crown');
    expect(rank1).toMatch(/class="podium-cluster"/);
    expect(rank1).not.toContain('is-tie');
  });

  test('AC5: a tied 1st place is crowned once and its cluster carries "is-tie"', async () => {
    resetField();
    makeGuest('Co-Champion A', 10);
    makeGuest('Co-Champion B', 10);
    makeGuest('Runner Up', 5);

    const res = await signedInBoard(lastToken);
    const podium = podiumMarkup(res.text);
    const rank1 = slotMarkup(podium, 1);

    // Exactly one crown for the whole tied tier, not one per co-champion.
    expect((rank1.match(/podium-crown/g) || []).length).toBe(1);
    expect(rank1).toContain('class="podium-cluster is-tie"');
    expect((rank1.match(/class="podium-cluster-avatar"/g) || []).length).toBe(2);
  });
});
