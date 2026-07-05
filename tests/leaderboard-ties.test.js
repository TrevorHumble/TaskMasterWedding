// tests/leaderboard-ties.test.js
// Covers issue #78 acceptance criteria:
//   AC1 — rank computed once; ties share a `T{rank}` label; standard-competition
//         gap after a four-way tie ([5,4,3,3,3,3,1] -> labels 1,2,T3,T3,T3,T3,7)
//   AC2 — (superseded by #249) a 3+-way tie renders every tied guest as an
//         avatar stack + names line; the collapsed "T3 · 4 tied" tile is gone
//   AC3 — a two-way tie for 1st shows both entries labelled T1, no rank `2`
//   AC4 — an all-guest tie suppresses the podium and shows "everyone's tied"
//   AC5 — the last-submission tiebreaker orders tied rows without changing rank
//   AC6 — per-row badge icons cap at 8 with a single "+K" overflow chip
//
// REQUIRE ORDER: config / db / app are required only AFTER loadApp() sets
// DATA_DIR / DB_PATH. Do not hoist requires above the loadApp() call.
'use strict';

const request = require('supertest');
const { loadApp } = require('./helpers/testApp');

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
// in. We sign in as one of the already-seeded guests (via GET /j/<token>, the
// same pattern the other route tests use) rather than adding an extra guest to
// the field, which would perturb the engineered point distributions.
async function signedInBoard(token) {
  const agent = request.agent(app);
  await agent.get('/j/' + token);
  const res = await agent.get('/leaderboard');
  expect(res.status).toBe(200);
  return res;
}

/**
 * Create a guest with exactly `points` points, built from `points` visible
 * submissions. Submission timestamps start at `baseMinute` minutes past a
 * fixed epoch and increment, so callers can control which tied guest has the
 * earlier latest submission (AC5). Returns the guest id.
 */
function makeGuest(name, points, baseMinute = 0) {
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
    const ts = new Date(base + (baseMinute + i) * 60000)
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

// Strip tags and collapse runs of whitespace so text split across EJS output
// lines ("Cara</a>, <a>Dara</a> and 2 more") compares as one string.
function collapse(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Extract the text of every <span class="rank ...">…</span> element in order.
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

describe('leaderboard ties (#78)', () => {
  test('AC1: [5,4,3,3,3,3,1] yields labels 1,2,T3,T3,T3,T3,7 — never a plain 3', async () => {
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

    // The four 3-point guests are labelled T3 (list row spans). This assertion
    // FAILS if rank were derived from array index (index 2..5 would give
    // 3,4,5,6 instead of a shared T3).
    const t3Count = labels.filter((l) => l === 'T3').length;
    expect(t3Count).toBeGreaterThanOrEqual(4);

    // The 1-point guest sits at the standard-competition gap: rank 7, not 6.
    expect(labels).toContain('7');
    expect(labels).not.toContain('6');

    // No rank label is a bare `3` — tied guests carry `T3`, and the incidental
    // point value 3 renders in .lb-points, not in a .rank span.
    expect(labels).not.toContain('3');

    // The unique top two are plain 1 and 2.
    expect(labels).toContain('1');
    expect(labels).toContain('2');
  });

  test('AC2 (as redesigned by #249): four-way tie renders an avatar stack, never a collapsed "tied" tile', async () => {
    resetField();
    makeGuest('Alpha', 5);
    makeGuest('Bravo', 4);
    // Distinct baseMinutes pin the tiebreak order (earliest latest-submission
    // first), so the two NAMED tied guests are deterministic: Cara, Dara.
    makeGuest('Cara', 3, 0);
    makeGuest('Dara', 3, 10);
    makeGuest('Elle', 3, 20);
    makeGuest('Finn', 3, 30);
    makeGuest('Gwen', 1);

    const res = await signedInBoard(lastToken);

    // The collapsed tile and its star placeholder are gone entirely (#249).
    expect(res.text).not.toContain('podium-tie');
    expect(res.text).not.toContain('&#9733;');

    const podium = podiumMarkup(res.text);
    // 4 tied at rank 3 -> 3 stacked avatars plus a "+1" overflow chip.
    expect((podium.match(/class="podium-stack-avatar"/g) || []).length).toBe(3);
    expect(podium).toContain('+1');
    // Names line: first two named, the rest counted.
    expect(collapse(podium)).toContain('Cara, Dara and 2 more');
    expect(podium).toContain('3rd place · 3 pts each');
  });

  test('AC3: two-way tie for 1st shows two T1 entries and no rank 2', async () => {
    resetField();
    makeGuest('Alpha', 3);
    makeGuest('Bravo', 3);
    makeGuest('Cara', 1);

    const res = await signedInBoard(lastToken);
    const labels = rankLabels(res.text);

    // Two guests tied at rank 1: their labels are T1. Since #249 the podium
    // renders no .rank spans, so both T1 labels come from the standings list.
    const t1Count = labels.filter((l) => l === 'T1').length;
    expect(t1Count).toBeGreaterThanOrEqual(2);

    // Standard-competition gap: the next distinct rank is 3, so no rank label is 2.
    expect(labels).not.toContain('2');
  });

  test('AC4: all-guest tie suppresses the podium and shows "everyone\'s tied"', async () => {
    resetField();
    makeGuest('Alpha', 2);
    makeGuest('Bravo', 2);
    makeGuest('Cara', 2);

    const res = await signedInBoard(lastToken);
    expect(res.status).toBe(200);
    expect(res.text).toContain("everyone's tied");
    expect(res.text).not.toContain('podium-slot');
    expect(res.text).not.toContain('podium-tie');
  });

  test('AC5: last-submission tiebreaker orders tied rows but keeps identical T3 labels', async () => {
    resetField();
    // A unique 1st and 2nd, then two guests tied for 3rd (rank 3 -> label T3).
    makeGuest('Top', 6);
    makeGuest('Second', 5);
    // The two tied-at-3rd guests. Guest A's latest submission (minute 0..3) is
    // earlier than guest B's (minute 10..13), so A must sort before B while
    // both keep the identical rank label.
    makeGuest('Aaron', 4, 0); // latest submission at minute 3
    makeGuest('Bella', 4, 10); // latest submission at minute 13

    const res = await signedInBoard(lastToken);

    // Restrict ordering checks to the list <ol> — the podium renders names in a
    // different (2nd,1st,3rd) order, which is not what AC5 constrains.
    const list = res.text.slice(res.text.indexOf('<ol'));

    // Guest A's list row appears before guest B's.
    const idxA = list.indexOf('Aaron');
    const idxB = list.indexOf('Bella');
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);
    expect(idxA).toBeLessThan(idxB);

    // Both tied guests carry the identical label T3 (rank unchanged by the
    // tiebreaker): the two list rows for Aaron and Bella.
    const listLabels = rankLabels(list);
    expect(listLabels.filter((l) => l === 'T3').length).toBeGreaterThanOrEqual(2);
  });

  test('AC6: badge row caps at 8 icons + one "+4" chip; 3 badges show 3 icons and no chip', async () => {
    resetField();
    const big = makeGuest('BigCollector', 5);
    const small = makeGuest('SmallCollector', 3);
    giveBadges(big, 12);
    giveBadges(small, 3);

    const res = await signedInBoard(lastToken);

    // Isolate each guest's LIST row so badge counts don't cross-contaminate.
    // Search only within the <ol> — a podium slot renders the name too but has
    // no <li>, so searching the whole document could grab the wrong row.
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
// Issue #249 — podium ties show every tied guest: avatar stack, names line,
// labeled bars. The anonymous star tile and "N tied" string are removed.
// ---------------------------------------------------------------------------
describe('podium tie redesign (#249)', () => {
  test('AC1+AC3: 3-way tie at 2nd names all three guests; untied 1st bar reads "1st · 19 pts"', async () => {
    resetField();
    makeGuest('Alpha Winner', 19);
    makeGuest('Liam Park', 12, 0);
    makeGuest('Priya Rao', 12, 30);
    makeGuest('Noah Bell', 12, 60);

    const res = await signedInBoard(lastToken);
    const podium = podiumMarkup(res.text);

    // Rank-2 slot: display order is 2nd, 1st, 3rd, so the rank-2 group is the
    // slice from its own marker to the rank-1 marker.
    const rank2 = podium.slice(podium.indexOf('rank-2'), podium.indexOf('rank-1'));
    expect(rank2).toContain('Liam');
    expect(rank2).toContain('Priya');
    expect(rank2).toContain('Noah');

    // AC1: the shared-rank sub-line, and no "tied" anywhere in podium markup.
    expect(podium).toContain('2nd place · 12 pts each');
    expect(podium).not.toContain('tied');

    // AC3: the untied #1 bar label is the exact string.
    const rank1 = podium.slice(podium.indexOf('rank-1'));
    const barLabel = rank1.match(/<span class="podium-bar-label">([^<]*)<\/span>/);
    expect(barLabel).not.toBeNull();
    expect(barLabel[1]).toBe('1st · 19 pts');

    // The tied slot's bar carries a label too (no blank rectangles).
    const rank2Label = rank2.match(/<span class="podium-bar-label">([^<]*)<\/span>/);
    expect(rank2Label).not.toBeNull();
    expect(rank2Label[1]).toBe('2nd · 12 pts');
  });

  test('AC2: 5-way tie shows exactly 3 avatars, a "+2" chip, and a names line ending "and 3 more"', async () => {
    resetField();
    makeGuest('Alpha Winner', 9);
    makeGuest('Liam Park', 5, 0);
    makeGuest('Priya Rao', 5, 10);
    makeGuest('Noah Bell', 5, 20);
    makeGuest('Mara Finch', 5, 30);
    makeGuest('Quin Hale', 5, 40);

    const res = await signedInBoard(lastToken);
    const podium = podiumMarkup(res.text);

    expect((podium.match(/class="podium-stack-avatar"/g) || []).length).toBe(3);
    const moreChip = podium.match(/<span class="podium-stack-more">([^<]*)<\/span>/);
    expect(moreChip).not.toBeNull();
    expect(moreChip[1]).toBe('+2');

    // Names line ends with "and 3 more" (tags stripped, whitespace collapsed).
    const namesDiv = podium.match(/<div class="podium-name podium-names">([\s\S]*?)<\/div>/);
    expect(namesDiv).not.toBeNull();
    expect(collapse(namesDiv[1]).endsWith('and 3 more')).toBe(true);
    expect(collapse(namesDiv[1])).toBe('Liam, Priya and 3 more');
  });

  test('AC4: every podium avatar is wrapped in a /u/<id> profile anchor', async () => {
    resetField();
    makeGuest('Alpha Winner', 19);
    makeGuest('Liam Park', 12, 0);
    makeGuest('Priya Rao', 12, 30);
    makeGuest('Noah Bell', 12, 60);

    const res = await signedInBoard(lastToken);
    const podium = podiumMarkup(res.text);

    // Stacked (tied) avatars are anchors with a /u/<id> href…
    const stacked = podium.match(/<a class="podium-stack-avatar"[^>]*>/g) || [];
    expect(stacked.length).toBe(3);
    for (const tag of stacked) {
      expect(tag).toMatch(/href="\/u\/\d+"/);
    }
    // …and so is the untied slot's single avatar.
    const solo = podium.match(/<a class="podium-avatar"[^>]*>/g) || [];
    expect(solo.length).toBe(1);
    expect(solo[0]).toMatch(/href="\/u\/\d+"/);
  });
});
