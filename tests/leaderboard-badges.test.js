// tests/leaderboard-badges.test.js
// Issue #489: the leaderboard's badge strip now renders from REAL award
// data (task_id / rank / submission_id / submission visibility) instead of
// the phase-1 DEMO_RANK map: a 1st-place Task Master badge renders whole-icon
// gold and links straight to the winning photo; every other badge (system,
// or a task badge ranked below 1st, or with no/taken-down photo) keeps the
// plain look and links to its own detail page. Guards the already-shipped
// overflow chip (#891) and cap/rank order (#625/#626) alongside the new
// wiring so a future regression on either surfaces here too.
//
// REQUIRE ORDER: config / db / app are required only AFTER loadApp() sets
// DATA_DIR / DB_PATH, same pattern as tests/leaderboard-overflow.test.js.
'use strict';

const request = require('supertest');
const { loadApp, signInGuest } = require('./helpers/testApp');

let app;
let db;
let config;
let taskBadges;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
  config = require('../config');
  taskBadges = require('../src/services/task-badges');
});

// Wipe every table these tests populate so each test starts from an empty
// field (same idiom as tests/leaderboard-overflow.test.js's resetField,
// widened to also clear tasks/badges since this file mints its own task
// badges via the real releaseRanking path).
function resetField() {
  db.prepare('DELETE FROM guest_badges').run();
  db.prepare('DELETE FROM submissions').run();
  db.prepare('DELETE FROM tasks').run();
  db.prepare('DELETE FROM guests').run();
  db.prepare('DELETE FROM badges').run();
}

let guestSeq = 0;
function makeGuest(name) {
  guestSeq += 1;
  const token = `lb-badge-token-${guestSeq}`;
  const id = db
    .prepare('INSERT INTO guests (token, name) VALUES (?, ?)')
    .run(token, name).lastInsertRowid;
  return { id, token };
}

let taskSeq = 0;
function makeTask(title) {
  taskSeq += 1;
  return db.prepare('INSERT INTO tasks (title) VALUES (?)').run(title || `LB badge task ${taskSeq}`)
    .lastInsertRowid;
}

let subSeq = 0;
function makeSubmission(guestId, taskId) {
  subSeq += 1;
  return db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, 0)`
    )
    .run(guestId, taskId, `lbb${subSeq}.jpg`, `lbb${subSeq}t.jpg`).lastInsertRowid;
}

function takeDown(submissionId) {
  db.prepare('UPDATE submissions SET taken_down = 1 WHERE id = ?').run(submissionId);
}

// A plain system badge (task_id NULL, same shape scoring.js's stmtGrantBadge
// grants). A fresh code per call so multiple grants to the same guest never
// collide on badges' UNIQUE(code).
let sysBadgeSeq = 0;
function grantSystemBadge(guestId) {
  sysBadgeSeq += 1;
  const code = `LBSYS_${sysBadgeSeq}`;
  const badgeId = db
    .prepare(`INSERT INTO badges (code, name, type, art_path) VALUES (?, ?, 'special', ?)`)
    .run(code, `System Badge ${sysBadgeSeq}`, `/badges/sys${sysBadgeSeq}.svg`).lastInsertRowid;
  db.prepare(
    `INSERT INTO guest_badges (guest_id, badge_id, awarded_by) VALUES (?, ?, 'system')`
  ).run(guestId, badgeId);
  return code;
}

async function boardHtml(token) {
  const agent = request.agent(app);
  signInGuest(app, token, agent);
  const res = await agent.get('/leaderboard');
  expect(res.status).toBe(200);
  return res.text;
}

// Isolate one guest's <li> row within the full-standings list (same helper
// as tests/leaderboard-overflow.test.js's rowOf).
function rowOf(html, name) {
  const list = html.slice(html.indexOf('<ol'));
  const start = list.indexOf(name);
  expect(start).toBeGreaterThan(-1);
  const li = list.lastIndexOf('<li', start);
  const end = list.indexOf('</li>', start);
  return list.slice(li, end);
}

// The single <a>...</a> anchor within a row whose href contains hrefFragment,
// lets a test pin the class list and href of exactly the badge it cares
// about, rather than asserting on the row's raw text.
function anchorFor(rowHtml, hrefFragment) {
  const idx = rowHtml.indexOf(hrefFragment);
  expect(idx).toBeGreaterThan(-1);
  const start = rowHtml.lastIndexOf('<a', idx);
  const end = rowHtml.indexOf('</a>', idx) + 4;
  return rowHtml.slice(start, end);
}

describe('leaderboard badge rendering wires real data (issue #489)', () => {
  test('system badge plain-links to its detail page (AC1)', async () => {
    resetField();
    const guest = makeGuest('Solo System Badge');
    const sysCode = grantSystemBadge(guest.id);

    const html = await boardHtml(guest.token);
    const row = rowOf(html, 'Solo System Badge');

    const anchor = anchorFor(row, `/badge/${sysCode}`);
    expect(anchor).toContain(`href="/badge/${sysCode}"`);
    expect(anchor).not.toContain('lb-badge-gold');
  });

  test('1st-place Task Master badge renders gold and links to the visible winning photo (AC2, AC4)', async () => {
    resetField();
    const guest = makeGuest('Champion');
    const task = makeTask('Solo win task');
    const sub = makeSubmission(guest.id, task);

    const released = taskBadges.releaseRanking(task, [sub]);
    expect(released).toBeTruthy();
    expect(released.winners).toBe(1);

    const html = await boardHtml(guest.token);
    const row = rowOf(html, 'Champion');

    const anchor = anchorFor(row, `/feed?from=${sub}#photo-${sub}`);
    expect(anchor).toContain('lb-badge-gold');
    expect(anchor).toContain(`href="/feed?from=${sub}#photo-${sub}"`);
  });

  test('2nd-place Task Master badge is NOT gold, even with a visible photo (AC3)', async () => {
    resetField();
    const winner = makeGuest('First Place');
    const runnerUp = makeGuest('Second Place');
    const task = makeTask('Two-winner task');
    const subWinner = makeSubmission(winner.id, task);
    const subRunnerUp = makeSubmission(runnerUp.id, task);

    const released = taskBadges.releaseRanking(task, [subWinner, subRunnerUp]);
    expect(released.winners).toBe(2);

    const html = await boardHtml(runnerUp.token);
    const row = rowOf(html, 'Second Place');

    // The runner-up's photo is still visible, so it still gets the photo
    // link, but no gold class, because their award ranked 2nd, not 1st.
    const anchor = anchorFor(row, `/feed?from=${subRunnerUp}#photo-${subRunnerUp}`);
    expect(anchor).not.toContain('lb-badge-gold');
  });

  test('Task Master badge with a taken-down winning photo falls back to /badge/<code> (AC5)', async () => {
    resetField();
    const winner = makeGuest('Visible Winner');
    const hidden = makeGuest('Hidden Runner-up');
    const task = makeTask('Takedown fallback task');
    const subWinner = makeSubmission(winner.id, task);
    const subHidden = makeSubmission(hidden.id, task);

    const released = taskBadges.releaseRanking(task, [subWinner, subHidden]);
    expect(released.winners).toBe(2);
    takeDown(subHidden);

    const badge = taskBadges.resolveTaskBadge(task);
    const html = await boardHtml(hidden.token);
    const row = rowOf(html, 'Hidden Runner-up');

    const anchor = anchorFor(row, `/badge/${badge.code}`);
    expect(anchor).not.toContain('lb-badge-gold');
    expect(anchor).not.toContain('/feed?from=');
    expect(anchor).toContain(`href="/badge/${badge.code}"`);
  });

  test('a Task Master badge with no submission at all (possession-only) falls back to /badge/<code> (AC5)', async () => {
    resetField();
    const guest = makeGuest('No Photo Holder');
    const task = makeTask('Possession-only task');
    const badge = taskBadges.resolveTaskBadge(task);
    // A possession-only task-badge grant: task_id set, rank/submission_id
    // both NULL. The shape a ranked release never itself produces, but the
    // projection must still degrade to the plain fallback rather than
    // crashing on a NULL submission_id.
    db.prepare(
      `INSERT INTO guest_badges (guest_id, badge_id, awarded_by) VALUES (?, ?, 'admin')`
    ).run(guest.id, badge.id);

    const html = await boardHtml(guest.token);
    const row = rowOf(html, 'No Photo Holder');

    const anchor = anchorFor(row, `/badge/${badge.code}`);
    expect(anchor).not.toContain('lb-badge-gold');
    expect(anchor).toContain(`href="/badge/${badge.code}"`);
  });
});

describe('leaderboard badge overflow: Task Master badges stay visible, cap/rank order hold (issue #489)', () => {
  test('2 Task Master badges stay in the visible slice among LEADERBOARD_BADGE_CAP+3 held badges; +N still links to the profile; the higher-points guest still ranks above the lower one', async () => {
    resetField();

    const highGuest = makeGuest('High Scorer');
    const lowGuest = makeGuest('Low Scorer');

    // Give each guest completed-task points via visible submissions (same
    // idiom as tests/leaderboard-overflow.test.js's makeGuest). highGuest
    // gets strictly more than lowGuest so AC8's rank order is exercised.
    function givePoints(guestId, n, label) {
      for (let i = 0; i < n; i++) {
        const t = makeTask(`${label} points task ${i}`);
        makeSubmission(guestId, t);
      }
    }
    givePoints(highGuest.id, 8, 'high');
    givePoints(lowGuest.id, 5, 'low');

    // 2 Task Master badges for highGuest (rank irrelevant to this test.
    // AC6 only cares that they survive the cap slice).
    const t1 = makeTask('Overflow TM task 1');
    const s1 = makeSubmission(highGuest.id, t1);
    taskBadges.releaseRanking(t1, [s1]);

    const t2 = makeTask('Overflow TM task 2');
    const s2 = makeSubmission(highGuest.id, t2);
    taskBadges.releaseRanking(t2, [s2]);

    // Fill up to LEADERBOARD_BADGE_CAP + 3 total held badges (2 already
    // Task Master, the rest plain system badges).
    const cap = config.LEADERBOARD_BADGE_CAP;
    const systemCount = cap + 3 - 2;
    for (let i = 0; i < systemCount; i++) {
      grantSystemBadge(highGuest.id);
    }
    const heldCount = cap + 3;

    const html = await boardHtml(highGuest.token);
    const highRow = rowOf(html, 'High Scorer');

    // AC6: both Task Master badges (rendered as their photo links, since
    // both are sole/visible rank-1 winners) are in the visible slice, not
    // folded into the overflow chip.
    expect(highRow).toContain(`/feed?from=${s1}#photo-${s1}`);
    expect(highRow).toContain(`/feed?from=${s2}#photo-${s2}`);

    // Structural cap check: exactly `cap` badge-icon anchors render (the
    // more-chip is a separate class, "lb-badge-more", so this regex, which
    // requires the class attribute to close right after "lb-badge" or
    // "lb-badge lb-badge-gold", never counts it).
    const iconAnchors = highRow.match(/class="lb-badge(?: lb-badge-gold)?"/g) || [];
    expect(iconAnchors.length).toBe(cap);

    // AC7 (already shipped, guarded here): the "+N" overflow chip still
    // links to this guest's own profile, with the correct overflow count.
    expect(highRow).toMatch(/<a class="lb-badge-more" href="\/u\/\d+"/);
    const hrefMatch = highRow.match(/<a class="lb-badge-more" href="\/u\/(\d+)"/);
    expect(hrefMatch).not.toBeNull();
    expect(Number(hrefMatch[1])).toBe(highGuest.id);
    expect(highRow).toContain(`>+${heldCount - cap}</a>`);

    // AC8: cap and rank order are unaffected by the badge display rewiring.
    // the strictly-higher-points guest still ranks above the lower one.
    const lowRow = rowOf(html, 'Low Scorer');
    const highPoints = Number(highRow.match(/<strong>(\d+)<\/strong>/)[1]);
    const lowPoints = Number(lowRow.match(/<strong>(\d+)<\/strong>/)[1]);
    expect(highPoints).toBeGreaterThan(lowPoints);

    const list = html.slice(html.indexOf('<ol'));
    expect(list.indexOf('High Scorer')).toBeLessThan(list.indexOf('Low Scorer'));
  });
});
