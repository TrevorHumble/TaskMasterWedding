// tests/leaderboard-overflow.test.js
// Covers issue #891: a leaderboard row overflowed the phone viewport when a
// guest combined a long name with a near-cap badge count, because .lb-guest
// had no min-width: 0 (so its flex child couldn't shrink) and .lb-badges had
// no flex-wrap (so the badge cluster pushed the row wider than the screen).
// The fix is CSS-only plus one markup change: the "+N" overflow chip becomes
// a link to the guest's public profile instead of an inert span.
//
// jsdom (this repo's only DOM test dependency) does not implement CSS layout
// — scrollWidth/clientWidth are always 0 there, so a real "no horizontal
// overflow at 375px" assertion cannot run in this suite (same limitation
// documented in tests/masthead-overflow.test.js). This file asserts the two
// behaviors that CAN be pinned in Node: (1) the rendered markup — the "+N"
// chip is an anchor to /u/:guestId, not a span — and (2) the CSS source
// carries the shrink/wrap rules the layout fix depends on. The real
// behavioral proof (actual rendered screenshots at 375px) happened in the
// owner's visual-approval loop, not here.
//
// REQUIRE ORDER: config / db / app are required only AFTER loadApp() sets
// DATA_DIR / DB_PATH. Do not hoist requires above the loadApp() call.
'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { loadApp, signInGuest } = require('./helpers/testApp');

let app;
let db;
let config;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
  config = require('../config');
});

// Wipe the tables these tests populate so each test starts from an empty field.
function resetField() {
  db.prepare('DELETE FROM guest_badges').run();
  db.prepare('DELETE FROM submissions').run();
  db.prepare('DELETE FROM guests').run();
  db.prepare('DELETE FROM badges').run();
}

let seq = 0;
let lastToken = null;

/**
 * Create a guest with exactly `points` points, built from `points` visible
 * submissions (same idiom as tests/leaderboard-ties.test.js's makeGuest).
 */
function makeGuest(name, points) {
  const token = `overflow-token-${seq++}`;
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
      .run(`Overflow task ${seq}-${i}`).lastInsertRowid;
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
      `OVERFLOWBADGE_${seq}_${i}`,
      `Badge ${i}`,
      `/badges/b${seq}-${i}.svg`
    ).lastInsertRowid;
    award.run(guestId, badgeId);
  }
  seq++;
}

async function signedInBoard(token) {
  const agent = request.agent(app);
  signInGuest(app, token, agent);
  const res = await agent.get('/leaderboard');
  expect(res.status).toBe(200);
  return res;
}

// Isolate one guest's <li> row within the full-standings list (same pattern
// as tests/leaderboard-ties.test.js's rowOf), so badge counts and markup
// checks don't cross-contaminate between guests on the same rendered page.
function rowOf(html, name) {
  const list = html.slice(html.indexOf('<ol'));
  const start = list.indexOf(name);
  expect(start).toBeGreaterThan(-1);
  const li = list.lastIndexOf('<li', start);
  const end = list.indexOf('</li>', start);
  return list.slice(li, end);
}

describe('leaderboard overflow chip is a profile link (#891)', () => {
  test('a guest above the badge cap renders "+N" as an <a class="lb-badge-more"> to their own /u/:id', async () => {
    resetField();
    const over = makeGuest('Badge Hoarder', 5);
    giveBadges(over, config.LEADERBOARD_BADGE_CAP + 3);

    const res = await signedInBoard(lastToken);
    const row = rowOf(res.text, 'Badge Hoarder');

    expect(row).toContain('class="lb-badge-more"');
    // A real anchor tag, not the old inert span — the acceptance criteria's
    // point is that the chip now leads somewhere.
    expect(row).toMatch(/<a class="lb-badge-more" href="\/u\/\d+"/);
    // The href must point at THIS guest's id specifically, not any guest's.
    const hrefMatch = row.match(/<a class="lb-badge-more" href="\/u\/(\d+)"/);
    expect(hrefMatch).not.toBeNull();
    expect(Number(hrefMatch[1])).toBe(over);
    // The count text is unchanged: cap+3 badges over cap -> "+3".
    expect(row).toContain('>+3</a>');
    // The title names the guest, per the approved screen.
    expect(row).toMatch(/title="See all of Badge Hoarder's badges"/);
  });

  test('a guest exactly at the badge cap renders no overflow chip at all', async () => {
    resetField();
    const atCap = makeGuest('Cap Exactly', 4);
    giveBadges(atCap, config.LEADERBOARD_BADGE_CAP);

    const res = await signedInBoard(lastToken);
    const row = rowOf(res.text, 'Cap Exactly');

    expect(row).not.toContain('lb-badge-more');
  });
});

// ---------------------------------------------------------------------------
// CSS guardrail: the layout fix's two load-bearing rules must be present in
// the stylesheet source. jsdom can't verify the rendered layout (see the file
// header comment), so this pins the CSS text itself the same way
// tests/masthead-overflow.test.js guards .site-nav-row's flex-wrap.
// ---------------------------------------------------------------------------
describe('CSS guardrail: the shrink/wrap rules the #891 fix depends on', () => {
  const THEME_PATH = path.join(__dirname, '../src/public/css/theme.css');

  // Pull a top-level CSS rule block out of the stylesheet source by selector
  // text (same helper as tests/masthead-overflow.test.js's ruleBlock).
  function ruleBlock(source, selector) {
    const start = source.indexOf(selector + ' {');
    if (start === -1) return null;
    const end = source.indexOf('}', start);
    return source.slice(start, end + 1);
  }

  test('.lb-guest sets min-width: 0 so the name column can shrink below its content', () => {
    const themeSrc = fs.readFileSync(THEME_PATH, 'utf8');
    const block = ruleBlock(themeSrc, '.lb-guest');
    expect(block).not.toBeNull();
    expect(block).toMatch(/min-width:\s*0/);
  });

  test('.lb-badges wraps and is capped to 38% width instead of forcing row overflow', () => {
    const themeSrc = fs.readFileSync(THEME_PATH, 'utf8');
    const block = ruleBlock(themeSrc, '.lb-badges');
    expect(block).not.toBeNull();
    expect(block).toMatch(/flex-wrap:\s*wrap/);
    expect(block).toMatch(/max-width:\s*38%/);
  });

  test('.lb-guest .lb-name truncates with an ellipsis on one line', () => {
    const themeSrc = fs.readFileSync(THEME_PATH, 'utf8');
    const block = ruleBlock(themeSrc, '.lb-guest .lb-name');
    expect(block).not.toBeNull();
    expect(block).toMatch(/overflow:\s*hidden/);
    expect(block).toMatch(/text-overflow:\s*ellipsis/);
    expect(block).toMatch(/white-space:\s*nowrap/);
  });

  test('the avatar (filled or empty) never shrinks when the row squeezes', () => {
    // This rule's selector spans two lines (a grouped selector), so it can't
    // use the single-line `selector + ' {'` lookup ruleBlock relies on —
    // locate the block by its distinctive first selector line instead.
    const themeSrc = fs.readFileSync(THEME_PATH, 'utf8');
    const start = themeSrc.indexOf('.lb-guest .lb-avatar,');
    expect(start).toBeGreaterThan(-1);
    const end = themeSrc.indexOf('}', start);
    const block = themeSrc.slice(start, end + 1);
    expect(block).toContain('.lb-guest .lb-avatar-empty');
    expect(block).toMatch(/flex-shrink:\s*0/);
  });

  test('.lb-badge-more is a pill (--radius-pill) and keeps no underline on hover', () => {
    const themeSrc = fs.readFileSync(THEME_PATH, 'utf8');
    const block = ruleBlock(themeSrc, '.lb-badge-more');
    expect(block).not.toBeNull();
    expect(block).toMatch(/border-radius:\s*var\(--radius-pill\)/);

    const hoverBlock = ruleBlock(themeSrc, '.lb-badge-more:hover');
    expect(hoverBlock).not.toBeNull();
    expect(hoverBlock).toMatch(/text-decoration:\s*none/);
  });
});
