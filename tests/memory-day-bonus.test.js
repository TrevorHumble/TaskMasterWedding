// tests/memory-day-bonus.test.js
// Issue #656 — +1 for a guest's first memory each event-local day, derived
// (not banked) from the guest's visible memories' created_at, on BOTH scoring
// surfaces (getPoints/leaderboard), plus the /tasks row's price tag tracking
// today's claimed state and the approved copy rendering everywhere it was
// approved. Covers AC1-AC7 from the issue.
//
// REQUIRE ORDER MATTERS: config / db / services are required only AFTER
// loadApp() sets DATA_DIR / DB_PATH env vars (see tests/helpers/testApp.js).
'use strict';

const crypto = require('crypto');
const request = require('supertest');
const sharp = require('sharp');
const { loadApp, signInGuest } = require('./helpers/testApp');

let app;
let db;
let scoring;
let dbModule;
let validJpeg;

beforeAll(async () => {
  // A tiny real JPEG so photos.makeThumb (sharp) succeeds on the /submit call
  // in AC7 below — same fixture/recipe as tests/rewards.test.js. A corrupt
  // 4-byte buffer (the original version of this test) makes sharp reject the
  // upload as thumb_failed, which redirects with NO taskComplete flash — the
  // "fresh success card" assertion would then never run.
  validJpeg = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .jpeg()
    .toBuffer();

  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;

  scoring = require('../src/services/scoring');
  dbModule = require('../src/db');
});

let seq = 0;
function insertGuest(name) {
  seq += 1;
  const token = `mdb-${seq}-${crypto.randomUUID()}`;
  const guestId = db
    .prepare('INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)')
    .run(token, name).lastInsertRowid;
  return { guestId, token };
}

function insertTask(title, worth = 1) {
  return db.prepare('INSERT INTO tasks (title, worth) VALUES (?, ?)').run(title, worth)
    .lastInsertRowid;
}

/** Insert a submission row directly, optionally pinning created_at
 * ("YYYY-MM-DD HH:MM:SS", UTC — the raw SQLite shape, matching
 * relative-time.js's parseSqliteDatetime contract) so tests can control
 * exactly which instant a memory/task photo lands on. */
function insertSubmission({ guestId, taskId = null, takenDown = 0, createdAt = null }) {
  seq += 1;
  const photoPath = `mdb-${seq}.jpg`;
  const thumbPath = `mdb-${seq}-t.jpg`;
  if (createdAt) {
    db.prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(guestId, taskId, photoPath, thumbPath, takenDown, createdAt);
  } else {
    db.prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, ?)`
    ).run(guestId, taskId, photoPath, thumbPath, takenDown);
  }
  return db
    .prepare('SELECT id FROM submissions WHERE guest_id = ? ORDER BY id DESC LIMIT 1')
    .get(guestId).id;
}

function resetEventConfigToDefault() {
  dbModule.setEventConfig({
    timezone: 'America/Boise',
    startDate: '2026-08-07',
    endDate: '2026-08-09',
  });
}

async function signedInAgent(token) {
  const agent = request.agent(app);
  signInGuest(app, token, agent);
  return agent;
}

beforeEach(() => {
  resetEventConfigToDefault();
});

// ---------------------------------------------------------------------------
// AC1 — first memory of the day pays, once; a same-day second memory does
// not pay again; a day whose only visible submission is task-linked earns no
// memory-day point at all.
// ---------------------------------------------------------------------------
describe('AC1: first memory of the day pays, once', () => {
  it('first memory: P -> P+1; second memory same day: stays P+1', () => {
    const { guestId } = insertGuest('AC1 Guest');
    const pointsBefore = scoring.getPoints(guestId);

    insertSubmission({ guestId }); // memory 1, real "now"
    expect(scoring.getPoints(guestId)).toBe(pointsBefore + 1);

    insertSubmission({ guestId }); // memory 2, same event-local day
    expect(scoring.getPoints(guestId)).toBe(pointsBefore + 1);
  });

  it('a guest whose only visible submission that day is task-linked earns no memory-day point', () => {
    const { guestId } = insertGuest('AC1 Task-Only Guest');
    const taskId = insertTask('AC1 Task', 2);
    const pointsBefore = scoring.getPoints(guestId);

    insertSubmission({ guestId, taskId });

    // +2 from the task's own worth, +0 from the memory-day term (no memory
    // exists at all, task-linked or otherwise).
    expect(scoring.getPoints(guestId)).toBe(pointsBefore + 2);
  });
});

// ---------------------------------------------------------------------------
// AC2 — the next event-local day pays again, asserted on BOTH getPoints AND
// leaderboard in the same test.
// ---------------------------------------------------------------------------
describe('AC2: next day pays again, on both surfaces', () => {
  it('two memories a day apart total +2 in getPoints AND leaderboard', () => {
    const { guestId } = insertGuest('AC2 Guest');

    // Two pinned instants, 24h apart, both well inside their own event-local
    // day in America/Boise (MDT, UTC-6 in August) so neither pin is anywhere
    // near a day-boundary edge case.
    insertSubmission({ guestId, createdAt: '2026-08-07 18:00:00' }); // Aug 7 12:00 MDT
    insertSubmission({ guestId, createdAt: '2026-08-08 18:00:00' }); // Aug 8 12:00 MDT

    expect(scoring.getPoints(guestId)).toBe(2);

    const rows = scoring.leaderboard();
    const row = rows.find((r) => r.id === guestId);
    expect(row.points).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AC3 — takedown reverts a day's only point; restore re-adds it.
// ---------------------------------------------------------------------------
describe('AC3: takedown reverts, restore re-adds', () => {
  it("taking down a day's only memory drops the point; restoring brings it back", () => {
    const { guestId } = insertGuest('AC3 Guest');
    const pointsBefore = scoring.getPoints(guestId);

    const submissionId = insertSubmission({ guestId });
    expect(scoring.getPoints(guestId)).toBe(pointsBefore + 1);

    db.prepare('UPDATE submissions SET taken_down = 1 WHERE id = ?').run(submissionId);
    expect(scoring.getPoints(guestId)).toBe(pointsBefore);

    db.prepare('UPDATE submissions SET taken_down = 0 WHERE id = ?').run(submissionId);
    expect(scoring.getPoints(guestId)).toBe(pointsBefore + 1);
  });
});

// ---------------------------------------------------------------------------
// AC4 — the day boundary is event-local, not UTC. Pinned instants + a
// configured timezone that is NOT UTC (America/Boise), so a server running
// in UTC cannot pass this test vacuously.
// ---------------------------------------------------------------------------
describe('AC4: the day boundary is event-local, not UTC', () => {
  it('two memories on the same UTC date but different event-local dates count as 2 distinct days', () => {
    dbModule.setEventConfig({
      timezone: 'America/Boise',
      startDate: '2026-08-07',
      endDate: '2026-08-09',
    });
    const { guestId } = insertGuest('AC4 Same-UTC-Date Guest');

    // Both instants fall on UTC calendar date 2026-08-08, but convert to
    // different America/Boise (MDT, UTC-6) event-local dates:
    //   2026-08-08T04:00:00Z - 6h = 2026-08-07 22:00 local -> event-local Aug 7
    //   2026-08-08T20:00:00Z - 6h = 2026-08-08 14:00 local -> event-local Aug 8
    insertSubmission({ guestId, createdAt: '2026-08-08 04:00:00' });
    insertSubmission({ guestId, createdAt: '2026-08-08 20:00:00' });

    // If the day boundary were (wrongly) computed from the UTC calendar
    // date, both rows share 2026-08-08 and this would read 1, not 2.
    expect(scoring.memoryDayCount(guestId, 'America/Boise')).toBe(2);
    expect(scoring.getPoints(guestId)).toBe(2);
  });

  it('two memories on different UTC dates but the SAME event-local date count as 1 distinct day', () => {
    dbModule.setEventConfig({
      timezone: 'America/Boise',
      startDate: '2026-08-07',
      endDate: '2026-08-09',
    });
    const { guestId } = insertGuest('AC4 Same-Local-Date Guest');

    // Different UTC calendar dates, same America/Boise event-local date:
    //   2026-08-08T05:59:00Z - 6h = 2026-08-07 23:59 local -> event-local Aug 7
    //   2026-08-07T06:01:00Z - 6h = 2026-08-07 00:01 local -> event-local Aug 7
    insertSubmission({ guestId, createdAt: '2026-08-08 05:59:00' });
    insertSubmission({ guestId, createdAt: '2026-08-07 06:01:00' });

    // If the day boundary were (wrongly) computed from the UTC calendar
    // date, these two rows (Aug 8 vs Aug 7 UTC) would read 2, not 1.
    expect(scoring.memoryDayCount(guestId, 'America/Boise')).toBe(1);
    expect(scoring.getPoints(guestId)).toBe(1);
  });

  // Both cases above pin August instants, where America/Boise sits at a
  // fixed MDT (UTC-6) offset throughout — DST is the stated reason this day
  // math lives in JS rather than a fixed SQL `datetime()` shift, but nothing
  // else in this file actually straddles a real transition. America/Boise
  // springs forward from MST (UTC-7) to MDT (UTC-6) at 2:00 AM local on
  // 2026-03-08 (the US's second Sunday in March). The instants below are
  // chosen so the REAL zone rules and a naive fixed UTC-6 shift disagree
  // about which calendar day the first submission falls on — that
  // disagreement is what makes this test able to fail against a
  // hard-coded-offset implementation instead of passing for either reason.
  it('two memories that straddle a real DST transition land on different event-local days, distinguishing real zone rules from a fixed UTC-6 shift', () => {
    dbModule.setEventConfig({
      timezone: 'America/Boise',
      startDate: '2026-08-07',
      endDate: '2026-08-09',
    });
    const { guestId } = insertGuest('AC4 DST Guest');

    // Before the spring-forward: still MST (UTC-7). 2026-03-08 06:30:00 UTC
    // is 2026-03-07 23:30 local under the real rule (March 7) — but under a
    // naive fixed UTC-6 shift it would read 2026-03-08 00:30 (March 8). This
    // is the discriminating instant: real rules and a fixed offset disagree
    // about which day it lands on.
    insertSubmission({ guestId, createdAt: '2026-03-08 06:30:00' });
    // After the spring-forward: MDT (UTC-6), where the real rule and a fixed
    // UTC-6 shift agree. 2026-03-08 16:00:00 UTC = 2026-03-08 10:00 local
    // (March 8) under both.
    insertSubmission({ guestId, createdAt: '2026-03-08 16:00:00' });

    // Under real zone rules these are event-local March 7 and March 8: 2
    // distinct days. A fixed UTC-6 implementation would fold the first
    // submission onto March 8 too, reading 1 — so this assertion catches
    // that regression.
    expect(scoring.memoryDayCount(guestId, 'America/Boise')).toBe(2);

    // A third memory the next local day (after the transition, still MDT,
    // where real rules and fixed UTC-6 agree) must count as a distinct
    // third day either way.
    insertSubmission({ guestId, createdAt: '2026-03-09 16:00:00' });
    expect(scoring.memoryDayCount(guestId, 'America/Boise')).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// AC5 — standings stay ordered by the total they display: the memory-day
// term can flip a ranking, and leaderboard()'s row order must follow.
// ---------------------------------------------------------------------------
describe('AC5: standings stay ordered by the total they display', () => {
  it('guest A trails guest B before the memory-day term and leads after it; A appears above B', () => {
    const { guestId: guestAId } = insertGuest('AC5 Guest A');
    const { guestId: guestBId } = insertGuest('AC5 Guest B');
    const taskA = insertTask('AC5 Task A', 2);
    const taskB = insertTask('AC5 Task B', 3);

    // Before the memory-day term: A has 2 points (task worth), B has 3 —
    // B leads.
    insertSubmission({ guestId: guestAId, taskId: taskA });
    insertSubmission({ guestId: guestBId, taskId: taskB });

    let rows = scoring.leaderboard();
    let rowA = rows.find((r) => r.id === guestAId);
    let rowB = rows.find((r) => r.id === guestBId);
    expect(rowA.points).toBe(2);
    expect(rowB.points).toBe(3);
    expect(rows.indexOf(rowB)).toBeLessThan(rows.indexOf(rowA));

    // A shares two memories on two distinct event-local days (+2), pushing A
    // to 4 — now A leads B's 3.
    insertSubmission({ guestId: guestAId, createdAt: '2026-08-07 18:00:00' });
    insertSubmission({ guestId: guestAId, createdAt: '2026-08-08 18:00:00' });

    rows = scoring.leaderboard();
    rowA = rows.find((r) => r.id === guestAId);
    rowB = rows.find((r) => r.id === guestBId);
    expect(rowA.points).toBe(4);
    expect(rowB.points).toBe(3);
    // The returned row ORDER must match the returned points values: A above B.
    expect(rows.indexOf(rowA)).toBeLessThan(rows.indexOf(rowB));
  });
});

// ---------------------------------------------------------------------------
// leaderboard() comparator — the NULL-handling and tiebreak keys the
// comparator alone now owns (scoring.js's SQL query carries no ORDER BY;
// see DESIGN.md's #656 ADR). Only points DESC is exercised elsewhere in this
// file, so these pin the riskier branches directly.
// ---------------------------------------------------------------------------
describe('leaderboard() comparator: NULL handling and tiebreak keys', () => {
  it('a guest with no visible submissions sorts LAST among guests tied on points', () => {
    const { guestId: noSubId } = insertGuest('Cmp No-Submissions Guest');
    const { guestId: earlyId } = insertGuest('Cmp Early Guest');
    const { guestId: lateId } = insertGuest('Cmp Late Guest');

    // Tie all three at 3 points: the no-submissions guest via bonus_points
    // alone (last_submission_at stays NULL — no visible submission ever
    // joins), the other two via one memory each (contributing the +1
    // memory-day term) plus 2 bonus points, pinned to different instants so
    // last_submission_at differs between them.
    scoring.addBonusPoints(noSubId, 3);
    insertSubmission({ guestId: earlyId, createdAt: '2026-08-07 18:00:00' });
    scoring.addBonusPoints(earlyId, 2);
    insertSubmission({ guestId: lateId, createdAt: '2026-08-08 18:00:00' });
    scoring.addBonusPoints(lateId, 2);

    const rows = scoring.leaderboard();
    const noSubRow = rows.find((r) => r.id === noSubId);
    const earlyRow = rows.find((r) => r.id === earlyId);
    const lateRow = rows.find((r) => r.id === lateId);

    expect(noSubRow.points).toBe(3);
    expect(earlyRow.points).toBe(3);
    expect(lateRow.points).toBe(3);
    expect(noSubRow.last_submission_at).toBeNull();

    // Earliest last_submission_at first, then the no-submissions (NULL) guest
    // LAST — never ahead of a guest who actually scored.
    expect(rows.indexOf(earlyRow)).toBeLessThan(rows.indexOf(lateRow));
    expect(rows.indexOf(lateRow)).toBeLessThan(rows.indexOf(noSubRow));
  });

  it('equal points and equal last_submission_at tie-break by name, then id', () => {
    const pinned = '2026-08-07 18:00:00';
    const { guestId: bId } = insertGuest('Cmp Tie B');
    insertSubmission({ guestId: bId, createdAt: pinned });
    const { guestId: aId } = insertGuest('Cmp Tie A');
    insertSubmission({ guestId: aId, createdAt: pinned });

    const rows = scoring.leaderboard();
    const rowA = rows.find((r) => r.id === aId);
    const rowB = rows.find((r) => r.id === bId);

    expect(rowA.points).toBe(rowB.points);
    expect(rowA.last_submission_at).toBe(rowB.last_submission_at);
    // 'Cmp Tie A' < 'Cmp Tie B' alphabetically, regardless of insertion/id
    // order (B was inserted first, so an id-only tiebreak would get this
    // backwards).
    expect(rows.indexOf(rowA)).toBeLessThan(rows.indexOf(rowB));
  });

  it('equal points, equal last_submission_at, AND equal name tie-break by id, lower id first', () => {
    const pinned = '2026-08-07 18:00:00';
    const { guestId: firstId } = insertGuest('Cmp Tie Same Name');
    insertSubmission({ guestId: firstId, createdAt: pinned });
    const { guestId: secondId } = insertGuest('Cmp Tie Same Name');
    insertSubmission({ guestId: secondId, createdAt: pinned });

    const rows = scoring.leaderboard();
    const rowFirst = rows.find((r) => r.id === firstId);
    const rowSecond = rows.find((r) => r.id === secondId);

    expect(rowFirst.points).toBe(rowSecond.points);
    expect(rowFirst.last_submission_at).toBe(rowSecond.last_submission_at);
    expect(firstId).toBeLessThan(secondId);
    // Name is identical for both, so the comparator falls through to its
    // final `a.id - b.id` key: the lower id (inserted first) sorts first.
    expect(rows.indexOf(rowFirst)).toBeLessThan(rows.indexOf(rowSecond));
  });
});

// ---------------------------------------------------------------------------
// AC6 — the row's price tag tracks the day: available -> "+1 pt"; already
// claimed today -> the .task-points element is OMITTED entirely.
// ---------------------------------------------------------------------------
describe("AC6: the Share a memory row's price tag tracks the day", () => {
  it('no memory today: the last to-do row renders "+1 pt"', async () => {
    const { token } = insertGuest('AC6 Available Guest');
    insertTask('AC6 Available Task'); // at least one task still to do

    const agent = await signedInAgent(token);
    const res = await agent.get('/tasks');
    expect(res.status).toBe(200);

    const listStart = res.text.indexOf('<ul class="task-list">');
    const listEnd = res.text.indexOf('</ul>', listStart);
    const list = res.text.slice(listStart, listEnd);
    const rows = list.split('<li class="task-row task-todo">').slice(1);
    expect(rows.length).toBeGreaterThan(0);
    const memoryRow = rows[rows.length - 1];
    expect(memoryRow).toContain('Share a memory');
    expect(memoryRow).toContain('<span class="task-points">+1 pt</span>');
  });

  it('already has a memory today: the last to-do row omits .task-points entirely', async () => {
    const { guestId, token } = insertGuest('AC6 Claimed Guest');
    insertTask('AC6 Claimed Task'); // at least one task still to do
    insertSubmission({ guestId }); // today's memory, real "now"

    const agent = await signedInAgent(token);
    const res = await agent.get('/tasks');
    expect(res.status).toBe(200);

    const listStart = res.text.indexOf('<ul class="task-list">');
    const listEnd = res.text.indexOf('</ul>', listStart);
    const list = res.text.slice(listStart, listEnd);
    const rows = list.split('<li class="task-row task-todo">').slice(1);
    expect(rows.length).toBeGreaterThan(0);
    const memoryRow = rows[rows.length - 1];
    expect(memoryRow).toContain('Share a memory');
    expect(memoryRow).not.toContain('task-points');
  });
});

// ---------------------------------------------------------------------------
// AC7 — the approved copy renders, everywhere it was approved; /tasks
// renders no .task-share-memory button.
// ---------------------------------------------------------------------------
describe('AC7: the approved copy renders everywhere it was approved', () => {
  const ROW_DESC = 'Any photo you love, task or not. First memory of the day earns +1';
  const PAYOFF_LINE = '+1 point for your first memory each day, and any photo can win a badge.';
  const MEMORY_NEW_PROMISE =
    "Your first memory each day is +1 point, but share as many as you'd like.";
  const HOW_TO_PLAY_PROMISE =
    'Your first memory each day is +1 point, and you can share as many as you like.';

  /** The approved copy wraps across source lines in the .ejs templates, so
   * the rendered HTML carries real newlines/indentation where the approved
   * string has plain spaces. Collapse all whitespace runs to a single space
   * before comparing, on both sides, so this asserts the actual WORDS match
   * without being sensitive to the template's own line-wrap formatting. */
  function normalizeWhitespace(s) {
    return s.replace(/\s+/g, ' ').trim();
  }
  function containsNormalized(haystack, needle) {
    expect(normalizeWhitespace(haystack)).toContain(normalizeWhitespace(needle));
  }

  it('/tasks row description renders identically in BOTH the available and claimed states', async () => {
    const available = insertGuest('AC7 Available Guest');
    insertTask('AC7 Available Task');
    const claimed = insertGuest('AC7 Claimed Guest');
    insertTask('AC7 Claimed Task');
    insertSubmission({ guestId: claimed.guestId });

    const availableRes = await (await signedInAgent(available.token)).get('/tasks');
    containsNormalized(availableRes.text, ROW_DESC);

    const claimedRes = await (await signedInAgent(claimed.token)).get('/tasks');
    containsNormalized(claimedRes.text, ROW_DESC);

    // And /tasks renders no standalone .task-share-memory button anywhere.
    expect(availableRes.text).not.toContain('task-share-memory');
    expect(claimedRes.text).not.toContain('task-share-memory');
  });

  it('/tasks finished-all card carries the payoff line', async () => {
    // Delete every other task so this guest's own single task is the ONLY
    // one on the board — allDone (src/views/tasks.ejs) only fires when
    // todoCount === 0, which requires every LIVE task to be this guest's own
    // completed one, not just the fixture's freshly inserted task.
    db.prepare('DELETE FROM submissions').run();
    db.prepare('DELETE FROM tasks').run();

    const { guestId, token } = insertGuest('AC7 Finished Guest');
    const taskId = insertTask('AC7 Finished Task');
    db.prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, 0)`
    ).run(guestId, taskId, 'f.jpg', 'ft.jpg');
    // avatar_path unset would leave the starter row outstanding — set it so
    // this guest is genuinely "all done".
    db.prepare('UPDATE guests SET avatar_path = ? WHERE id = ?').run('avatar.jpg', guestId);

    const res = await (await signedInAgent(token)).get('/tasks');
    expect(res.status).toBe(200);
    containsNormalized(res.text, PAYOFF_LINE);
  });

  it('/task/:id fresh success card AND return-visit/replace prompt both carry the payoff line', async () => {
    const { guestId, token } = insertGuest('AC7 Task Detail Guest');
    const taskId = insertTask('AC7 Task Detail Task');
    const agent = await signedInAgent(token);

    // Fresh completion: taskComplete flash sets the one-shot success card.
    // validJpeg is a real, tiny JPEG (module-level beforeAll) so sharp's
    // thumbnail step succeeds and the route actually sets the taskComplete
    // flash — a corrupt buffer here would make the assertion below dead code.
    const submitRes = await agent
      .post(`/tasks/${taskId}/submit`)
      .attach('photo', validJpeg, { filename: 'ac7.jpg', contentType: 'image/jpeg' });
    expect([301, 302, 303]).toContain(submitRes.status);

    const freshPage = await agent.get(submitRes.headers.location);
    expect(freshPage.text).toContain('Task complete!');
    containsNormalized(freshPage.text, PAYOFF_LINE);

    // Return-visit/replace prompt: insert the submission directly (bypassing
    // upload) so the page renders the "existing submission" branch, not the
    // one-shot success card.
    db.prepare('DELETE FROM submissions WHERE guest_id = ? AND task_id = ?').run(guestId, taskId);
    db.prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, 0)`
    ).run(guestId, taskId, 'ac7b.jpg', 'ac7bt.jpg');

    const returnRes = await agent.get(`/tasks/${taskId}`);
    expect(returnRes.status).toBe(200);
    expect(returnRes.text).toContain('Got more from tonight?');
    containsNormalized(returnRes.text, PAYOFF_LINE);
  });

  it('/memories/new carries the folded-in promise', async () => {
    const { token } = insertGuest('AC7 Memories New Guest');
    const res = await (await signedInAgent(token)).get('/memories/new');
    expect(res.status).toBe(200);
    containsNormalized(res.text, MEMORY_NEW_PROMISE);
  });

  it('/how-to-play carries the rewritten rule row', async () => {
    const { token } = insertGuest('AC7 How To Play Guest');
    const res = await (await signedInAgent(token)).get('/how-to-play');
    expect(res.status).toBe(200);
    containsNormalized(res.text, HOW_TO_PLAY_PROMISE);
  });
});
