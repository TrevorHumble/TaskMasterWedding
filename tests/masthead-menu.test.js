// tests/masthead-menu.test.js
// Covers issue #252 acceptance criteria — the "Wedding Master" guest masthead
// and the profile bottom menu:
//   AC1 — the header carries the script-faced "Wedding Master" wordmark
//         followed by a Lilly/Axel line, and the old .brand/.brand-text
//         top-level brand markup is fully retired (file-content check)
//   AC2 — active-section-from-path: /tasks lights up Tasks (and only Tasks),
//         /gallery lights up Gallery (and only Gallery)
//   AC3 — a self-hosted woff2 exists, theme.css @font-faces it with
//         font-display: swap, and no view/stylesheet still talks to a
//         Google Fonts CDN
//   AC4 — the profile menu renders the 3 rows, in order (Share a memory,
//         How to play, Report a bug), the old VIEW ALL TASKS button is
//         gone, and Shared gallery / Leaderboard rows are gone (owner
//         revision, 2026-07-09 visual review — those three duplicated the
//         masthead nav directly above the menu)
//   AC5 — the footer reads "Wedding Master · Lilly & Axel", not the old
//         "Wedding Scavenger Hunt" line
//   AC6 — .site-header in theme.css is opaque and non-sticky
//
// REQUIRE ORDER MATTERS: config / db / app are required only via loadApp() —
// see tests/helpers/testApp.js "REQUIRE ORDER MATTERS".
'use strict';

const fs = require('fs');
const path = require('path');
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
  return db
    .prepare('INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)')
    .run(token, 'Guest ' + token).lastInsertRowid;
}

async function signedInAgent(token) {
  const agent = request.agent(app);
  signInGuest(app, token, agent);
  return agent;
}

// Real source files, read directly for the file-content ACs (3 and 6, and
// half of AC1). Paths are relative to this test file, matching the
// convention other file-content-checking tests in this repo would use.
const HEADER_PATH = path.join(__dirname, '../src/views/partials/header.ejs');
const THEME_PATH = path.join(__dirname, '../src/public/css/theme.css');
const HEAD_PATH = path.join(__dirname, '../src/views/partials/head.ejs');
const FOOTER_PATH = path.join(__dirname, '../src/views/partials/footer.ejs');
const FONTS_DIR = path.join(__dirname, '../src/public/fonts');

describe('AC1: script-faced "Wedding Master" wordmark, old brand markup retired', () => {
  test('a guest page renders Wedding Master (script-classed) followed by a Lilly/Axel line', async () => {
    resetTables();
    const token = 'ac1-token';
    insertGuest(token);
    const agent = await signedInAgent(token);

    const res = await agent.get('/');
    expect(res.status).toBe(200);

    const scriptIdx = res.text.indexOf('class="brand-script">Wedding Master');
    expect(scriptIdx).toBeGreaterThan(-1);
    // The names line follows the wordmark in document order, not before it.
    const lillyIdx = res.text.indexOf('Lilly', scriptIdx);
    const axelIdx = res.text.indexOf('Axel', scriptIdx);
    expect(lillyIdx).toBeGreaterThan(scriptIdx);
    expect(axelIdx).toBeGreaterThan(scriptIdx);
  });

  test('the old .brand/.brand-text top-level brand markup no longer exists anywhere', () => {
    const headerSrc = fs.readFileSync(HEADER_PATH, 'utf8');
    const themeSrc = fs.readFileSync(THEME_PATH, 'utf8');
    // The exact old pattern: a top-level element carrying class="brand-text".
    // (Admin kept its own brand LINE, but renamed off this class — see
    // .admin-brand-text — so this substring is gone from both files.)
    expect(headerSrc).not.toMatch(/class="brand-text"/);
    expect(themeSrc).not.toMatch(/\.brand-text\b/);
  });
});

describe('AC2: active-section-from-path lights up exactly one nav link', () => {
  test('/tasks carries aria-current="page" on Tasks only', async () => {
    resetTables();
    const token = 'ac2-tasks-token';
    insertGuest(token);
    const agent = await signedInAgent(token);

    const res = await agent.get('/tasks');
    expect(res.status).toBe(200);

    const currentCount = (res.text.match(/aria-current="page"/g) || []).length;
    expect(currentCount).toBe(1);
    expect(res.text).toMatch(/<a class="nav-link" href="\/tasks" aria-current="page">Tasks<\/a>/);
  });

  test('/gallery carries aria-current="page" on Gallery only', async () => {
    resetTables();
    const token = 'ac2-gallery-token';
    insertGuest(token);
    const agent = await signedInAgent(token);

    const res = await agent.get('/gallery');
    expect(res.status).toBe(200);

    const currentCount = (res.text.match(/aria-current="page"/g) || []).length;
    expect(currentCount).toBe(1);
    expect(res.text).toMatch(
      /<a class="nav-link" href="\/gallery" aria-current="page">Gallery<\/a>/
    );
  });

  test('/memories/new (a "/me..." lookalike path) does NOT light up My Profile', async () => {
    // Edge case: '/memories/new' shares the '/me' prefix with '/me/edit',
    // so a naive indexOf('/me') === 0 check would wrongly mark My Profile
    // active on the Share-a-memory page.
    resetTables();
    const token = 'ac2-memories-token';
    insertGuest(token);
    const agent = await signedInAgent(token);

    const res = await agent.get('/memories/new');
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/href="\/" aria-current="page"/);
  });
});

describe('AC3: self-hosted script font, no Google Fonts CDN request', () => {
  test('the woff2 file exists on disk', () => {
    expect(fs.existsSync(path.join(FONTS_DIR, 'wedding-script.woff2'))).toBe(true);
  });

  test('theme.css @font-faces it with font-display: swap', () => {
    const themeSrc = fs.readFileSync(THEME_PATH, 'utf8');
    const rule = /@font-face\s*{[^}]*url\('\/fonts\/wedding-script\.woff2'\)[^}]*}/.exec(themeSrc);
    expect(rule).not.toBeNull();
    expect(rule[0]).toMatch(/font-display:\s*swap/);
  });

  test('no view or stylesheet talks to a Google Fonts CDN', () => {
    const sources = [
      fs.readFileSync(HEAD_PATH, 'utf8'),
      fs.readFileSync(HEADER_PATH, 'utf8'),
      fs.readFileSync(THEME_PATH, 'utf8'),
    ];
    for (const src of sources) {
      expect(src).not.toMatch(/fonts\.googleapis\.com/);
    }
  });
});

describe('AC4: profile menu — 3 rows in order, old button and redundant rows gone', () => {
  test('the guest profile page renders the 3 menu rows in order', async () => {
    resetTables();
    const token = 'ac4-token';
    insertGuest(token);
    const agent = await signedInAgent(token);

    const res = await agent.get('/');
    expect(res.status).toBe(200);

    // Match the menu-label span specifically, not just the bare word — the
    // masthead nav above ALSO renders a "Leaderboard" link, so a bare
    // indexOf('Leaderboard') would find that nav link instead of the menu row.
    const labels = ['Share a memory', 'How to play', 'Report a bug'];
    let lastIdx = -1;
    for (const label of labels) {
      const idx = res.text.indexOf('class="menu-label' + '">' + label + '<');
      expect(idx).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }

    expect(res.text).not.toContain('VIEW ALL TASKS');
    expect(res.text).not.toMatch(/class="btn[^"]*"[^>]*>\s*View all tasks/);

    // The menu itself must not contain the cut rows. The masthead nav above
    // still renders "Leaderboard" as a nav link, so this asserts against the
    // menu-label form specifically, not the bare word.
    expect(res.text).not.toContain('class="menu-label">Shared gallery<');
    expect(res.text).not.toContain('class="menu-label">Leaderboard<');
    expect(res.text).not.toContain('class="menu-label">View all tasks<');
  });
});

describe('AC5: footer brand line', () => {
  test('the footer reads "Wedding Master · Lilly & Axel", not the old line', async () => {
    resetTables();
    const token = 'ac5-token';
    insertGuest(token);
    const agent = await signedInAgent(token);

    const res = await agent.get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Wedding Master &#183; Lilly &amp; Axel');
    expect(res.text).not.toContain('Wedding Scavenger Hunt');
  });

  test('the footer source file itself carries the new line, not the old one', () => {
    const footerSrc = fs.readFileSync(FOOTER_PATH, 'utf8');
    expect(footerSrc).toContain('Wedding Master &#183; Lilly &amp; Axel');
    expect(footerSrc).not.toContain('Wedding Scavenger Hunt');
  });
});

describe('AC6: .site-header is opaque and non-sticky', () => {
  test('theme.css .site-header has no position: sticky and no rgba/transparent background', () => {
    const themeSrc = fs.readFileSync(THEME_PATH, 'utf8');
    const start = themeSrc.indexOf('.site-header {');
    expect(start).toBeGreaterThan(-1);
    const end = themeSrc.indexOf('}', start);
    const block = themeSrc.slice(start, end + 1);

    expect(block).not.toMatch(/position:\s*sticky/);
    expect(block).not.toMatch(/rgba\(/);
    expect(block).not.toMatch(/background:\s*transparent/);
  });
});
