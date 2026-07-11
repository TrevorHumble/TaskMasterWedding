// tests/admin-comments-ui.test.js
// Covers issue #360 acceptance criteria 1-3 — the admin Comments page gets
// the same card CSS as the other admin pages (Guests, Tasks, Photos), which
// previously shipped with bare browser-default block styling.
//
//   AC1 — GET /admin/comments renders a seeded comment as a
//         .comment-admin-row
//   AC2 — theme.css declares .comment-admin-row exactly once, with a
//         background and border-radius; .comment-meta has a font-size;
//         .comment-admin-list has a gap or margin
//   AC3 — the served GET /css/theme.css stylesheet contains the
//         .comment-admin-row rule block with a background declaration
//
// REQUIRE ORDER: loadApp() must run before any require that pulls in config
// or db (see tests/helpers/testApp.js).
'use strict';

const fs = require('fs');
const path = require('path');
const { loadApp, seed, makeAdminAgent } = require('./helpers/testApp');

const THEME_CSS = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'public', 'css', 'theme.css'),
  'utf8'
);

// Extract the body of the first CSS rule whose selector line contains `selector`.
function cssRuleBody(selector) {
  const idx = THEME_CSS.indexOf(selector);
  if (idx === -1) return null;
  const open = THEME_CSS.indexOf('{', idx);
  const close = THEME_CSS.indexOf('}', open);
  return THEME_CSS.slice(open + 1, close);
}

let app;
let db;
let adminAgent;

beforeAll(async () => {
  const result = loadApp();
  app = result.app;
  db = result.db;
  adminAgent = await makeAdminAgent(app);

  const { guestId, submissionId } = seed(db);
  db.prepare(
    `INSERT INTO comments (submission_id, guest_id, body, taken_down) VALUES (?, ?, ?, 0)`
  ).run(submissionId, guestId, 'Great shot of the cake!');
});

// ---------------------------------------------------------------------------
// AC1 — rendered page: seeded comment shows up as a .comment-admin-row
// ---------------------------------------------------------------------------
describe('AC1: comment admin rows render', () => {
  it('GET /admin/comments is 200 and contains a comment-admin-row for the seeded comment', async () => {
    const res = await adminAgent.get('/admin/comments');
    expect(res.status).toBe(200);
    expect(res.text).toContain('class="comment-admin-row');
    expect(res.text).toContain('Great shot of the cake!');
  });
});

// ---------------------------------------------------------------------------
// AC2 — theme.css source declarations
// ---------------------------------------------------------------------------
describe('AC2: theme.css declares the comment admin card rules', () => {
  it('.comment-admin-row { appears exactly once', () => {
    const matches = THEME_CSS.match(/\.comment-admin-row \{/g) || [];
    expect(matches.length).toBe(1);
  });

  it('.comment-admin-row has a background and a border-radius declaration', () => {
    const body = cssRuleBody('.comment-admin-row {');
    expect(body).not.toBeNull();
    expect(body).toMatch(/background:\s*var\(--white\)/);
    expect(body).toMatch(/border-radius:\s*var\(--radius-card\)/);
  });

  it('.comment-meta has a font-size declaration', () => {
    const body = cssRuleBody('.comment-meta {');
    expect(body).not.toBeNull();
    expect(body).toMatch(/font-size:\s*var\(--fs-small\)/);
  });

  it('.comment-admin-list has a gap or margin declaration', () => {
    const body = cssRuleBody('.comment-admin-list {');
    expect(body).not.toBeNull();
    expect(body).toMatch(/(gap|margin):/);
  });
});

// ---------------------------------------------------------------------------
// AC3 — the served stylesheet (not just the source file) carries the rule
// ---------------------------------------------------------------------------
describe('AC3: GET /css/theme.css serves the comment-admin-row rule', () => {
  it('response is 200 and the body has a .comment-admin-row block with background', async () => {
    const res = await adminAgent.get('/css/theme.css');
    expect(res.status).toBe(200);

    const idx = res.text.indexOf('.comment-admin-row {');
    expect(idx).toBeGreaterThan(-1);
    const open = res.text.indexOf('{', idx);
    const close = res.text.indexOf('}', open);
    const body = res.text.slice(open + 1, close);
    expect(body).toMatch(/background:/);
  });
});
