// tests/how-points-work.test.js
// Covers issue #818 acceptance criteria — the "How to earn points" page:
//   AC1 — GET /how-points-work as a signed-in guest is 200, contains the
//         page title and all five row titles ("Masters'" renders with a
//         &rsquo; entity, so this asserts the substring up to the apostrophe,
//         not a literal straight quote).
//   AC2 — each row's reward tags render: a points tag with its range, and a
//         "Badge" tag only on the three badge rows (Masters' favor, Win the
//         crowd, Collect milestone badges) — not on Snap the tasks or Share
//         a memory.
//   AC3 — a signed-out visitor is redirected (302) to /join, same gate as
//         /how-to-play.
//   AC4 — /how-to-play links to the real route (not the retired
//         /how-points-work.html mock path), positioned above the
//         "See your list of tasks" CTA.
//
// REQUIRE ORDER: config / db / app are required only via loadApp() — see
// tests/helpers/testApp.js "REQUIRE ORDER MATTERS".
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

function resetTables() {
  db.prepare('DELETE FROM submissions').run();
  db.prepare('DELETE FROM tasks').run();
  db.prepare('DELETE FROM guests').run();
}

function insertGuest(token) {
  return db.prepare('INSERT INTO guests (token, name) VALUES (?, ?)').run(token, 'Guest ' + token)
    .lastInsertRowid;
}

function signedInAgent(token) {
  return signInGuest(app, token);
}

// Extracts the <div class="points-tags">...</div> block that immediately
// follows a given row title, so AC2 can assert each row's own tags instead of
// searching the whole page (which would pass even if a tag landed under the
// wrong title).
function tagsBlockFor(text, title) {
  const re = new RegExp(
    '<span class="points-title">' +
      title +
      '</span>\\s*' +
      '<div class="points-tags">([\\s\\S]*?)</div>'
  );
  const match = text.match(re);
  return match ? match[1] : null;
}

describe('AC1: the page renders with the title and all six row titles', () => {
  test('GET /how-points-work is 200 and contains the title and every row title', async () => {
    resetTables();
    insertGuest('ac1-token');

    const agent = await signedInAgent('ac1-token');
    const res = await agent.get('/how-points-work');

    expect(res.status).toBe(200);
    expect(res.text).toContain('How to earn points');
    // "Masters'" renders with &rsquo;, not a straight apostrophe.
    expect(res.text).toContain('Earn the Masters');
    expect(res.text).toContain('Earn the Masters&rsquo; favor');
    expect(res.text).toContain('Snap the tasks');
    expect(res.text).toContain('Win the crowd');
    expect(res.text).toContain('Share a memory');
    expect(res.text).toContain('Collect milestone badges');
    // Issue #1105: the clean sweep now has its own separate row.
    expect(res.text).toContain('Sweep every task');
  });
});

describe('AC2: each row shows the correct reward tags', () => {
  test('the six reward-tag combinations render on their own rows', async () => {
    resetTables();
    insertGuest('ac2-token');

    const agent = await signedInAgent('ac2-token');
    const res = await agent.get('/how-points-work');
    expect(res.status).toBe(200);

    const mastersFavor = tagsBlockFor(res.text, 'Earn the Masters&rsquo; favor');
    expect(mastersFavor).toContain('1&ndash;5 points');
    expect(mastersFavor).toContain('Badge');

    const snapTasks = tagsBlockFor(res.text, 'Snap the tasks');
    expect(snapTasks).toContain('3&ndash;5 points');
    expect(snapTasks).not.toContain('Badge');

    const winCrowd = tagsBlockFor(res.text, 'Win the crowd');
    expect(winCrowd).toContain('1&ndash;5 points');
    expect(winCrowd).toContain('Badge');

    const shareMemory = tagsBlockFor(res.text, 'Share a memory');
    expect(shareMemory).toContain('1 point each');
    expect(shareMemory).not.toContain('Badge');
    // Desc lock (issue #1104): the row's own description states the
    // two-per-day rule in words, not just the "1 point each" tag above.
    expect(res.text).toContain('Your first two memories each day earn a point apiece.');

    const milestoneBadges = tagsBlockFor(res.text, 'Collect milestone badges');
    expect(milestoneBadges).toContain('1 point');
    expect(milestoneBadges).toContain('Badge');

    // Issue #1105: the clean-sweep row's own tags, 3 points and Badge.
    const sweepEveryTask = tagsBlockFor(res.text, 'Sweep every task');
    expect(sweepEveryTask).toContain('3 points');
    expect(sweepEveryTask).toContain('Badge');
  });
});

describe('AC3: signed-out visitor is gated', () => {
  test('GET /how-points-work with no guest cookie redirects to /join', async () => {
    resetTables();

    const res = await request(app).get('/how-points-work');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/join');
  });
});

describe('issue #1094 AC7: the milestone sentence is built from the DB thresholds', () => {
  test('at the seeded default thresholds, the milestone row renders the trimmed threshold sentence', async () => {
    resetTables();
    insertGuest('1094-default-token');

    const agent = await signedInAgent('1094-default-token');
    const res = await agent.get('/how-points-work');

    expect(res.status).toBe(200);
    // Issue #1105: the milestone sentence no longer names the clean sweep.
    // That badge now has its own separate "Sweep every task" row.
    expect(res.text).toContain(
      'Rack up tasks and badges land on their own: First Bloom at 5, Bouquet Builder at 10, Full Garden at 15.'
    );
  });

  test('a custom threshold set (4/8/12) renders those exact numbers in the milestone sentence', async () => {
    resetTables();
    insertGuest('1094-custom-token');

    const scoring = require('../src/services/scoring');
    scoring.setAutoBadgeThresholds([
      { code: 'BLOOM', n: 4 },
      { code: 'BOUQUET', n: 8 },
      { code: 'GARDEN', n: 12 },
    ]);
    try {
      const agent = await signedInAgent('1094-custom-token');
      const res = await agent.get('/how-points-work');

      expect(res.status).toBe(200);
      expect(res.text).toContain(
        'Rack up tasks and badges land on their own: First Bloom at 4, Bouquet Builder at 8, Full Garden at 12.'
      );
    } finally {
      scoring.setAutoBadgeThresholds([
        { code: 'BLOOM', n: 5 },
        { code: 'BOUQUET', n: 10 },
        { code: 'GARDEN', n: 15 },
      ]);
    }
  });
});

describe('issue #1105: the "Sweep every task" row names Completionist and its 3 points', () => {
  test('the row renders "Completionist" (not a hard-typed literal) and 3 points while held', async () => {
    resetTables();
    insertGuest('1105-sweep-token');

    const agent = await signedInAgent('1105-sweep-token');
    const res = await agent.get('/how-points-work');

    expect(res.status).toBe(200);
    expect(res.text).toContain(
      'Finish the whole task list and the Completionist badge is yours, with 3 points while you hold it.'
    );
  });
});

describe('AC4: the instruction card links to the real route', () => {
  test('GET /how-to-play links to /how-points-work (not the .html mock), above "See your list of tasks"', async () => {
    resetTables();
    insertGuest('ac4-token');

    const agent = await signedInAgent('ac4-token');
    const res = await agent.get('/how-to-play');

    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/how-points-work"');
    expect(res.text).not.toContain('/how-points-work.html');

    const pointsIdx = res.text.indexOf('How to earn points');
    const tasksIdx = res.text.indexOf('See your list of tasks');
    expect(pointsIdx).toBeGreaterThan(-1);
    expect(tasksIdx).toBeGreaterThan(-1);
    expect(pointsIdx).toBeLessThan(tasksIdx);
  });
});
