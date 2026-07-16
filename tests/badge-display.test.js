// tests/badge-display.test.js
// Issue #487: badges render as a clean, uniform row — icon, title (with a
// conditional "+N pts" suffix), description — on the guest home page and
// the public profile, instead of the old green-tile grid.
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
});

let guestSeq = 0;
function makeGuest(name) {
  guestSeq += 1;
  const token = `badge-display-${guestSeq}`;
  const id = db
    .prepare('INSERT INTO guests (token, name) VALUES (?, ?)')
    .run(token, name).lastInsertRowid;
  return { id, token };
}

// Creates a 'custom' catalog badge and grants it directly to `guestId` with
// a chosen award `points` value (guest_badges.points, issue #483) — the
// scoring service's own award paths (awardSpecialBadge, task-badges'
// awardTaskBadge) don't expose an arbitrary points value in one call, so the
// grant is written directly the same way other tests seed fixture rows.
let codeSeq = 0;
function grantBadge(guestId, { name, description, points }) {
  codeSeq += 1;
  const badge = scoring.createCustomBadge({
    code: `BDT${codeSeq}`,
    name,
    type: 'custom',
    artPath: '/badges/default-ribbon.svg',
    description,
  });
  db.prepare(
    `INSERT INTO guest_badges (guest_id, badge_id, awarded_by, points) VALUES (?, ?, 'admin', ?)`
  ).run(guestId, badge.id, points);
}

// EJS's default escaping (used by <%= %>) turns a raw apostrophe into
// &#39; — match that here so the assertion compares against what the view
// actually emits, not the raw fixture string.
function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&#39;');
}

// Both views now share the same badge-item markup (issue #487), so a badge's
// own row can be isolated the same way on either page: locate the badge
// title, then find the nearest enclosing <li class="badge-item">...</li>.
// This is required (not cosmetic) for AC2: public-profile's OWN point total
// ("<strong>0</strong> pts") elsewhere on the page also contains the
// substring "pts", so an unscoped page-text check would give a false pass.
function extractBadgeRow(html, title) {
  const titleIdx = html.indexOf(title);
  expect(titleIdx).toBeGreaterThan(-1);
  const rowStart = html.lastIndexOf('<li class="badge-item">', titleIdx);
  const rowEnd = html.indexOf('</li>', titleIdx);
  expect(rowStart).toBeGreaterThan(-1);
  expect(rowEnd).toBeGreaterThan(-1);
  return html.slice(rowStart, rowEnd);
}

describe('AC1/AC3: a badge with nonzero points shows its title, "+N pts", and description', () => {
  it('renders on the guest home page and the public profile', async () => {
    const guest = makeGuest('Points Guest');
    grantBadge(guest.id, { name: 'Golden Move', description: "The host's pick", points: 5 });

    const agent = signInGuest(app, guest.token);
    const expectedDesc = escapeHtml("The host's pick");

    const home = await agent.get('/');
    expect(home.status).toBe(200);
    const homeRow = extractBadgeRow(home.text, 'Golden Move');
    expect(homeRow).toContain('Golden Move');
    expect(homeRow).toContain('+5 pts');
    expect(homeRow).toContain(expectedDesc);

    const profile = await agent.get('/u/' + guest.id);
    expect(profile.status).toBe(200);
    const profileRow = extractBadgeRow(profile.text, 'Golden Move');
    expect(profileRow).toContain('Golden Move');
    expect(profileRow).toContain('+5 pts');
    expect(profileRow).toContain(expectedDesc);
  });
});

describe('AC5 (#518): each badge row stays wrapped in its /badge/:code link', () => {
  it('renders the href on both the guest home page and the public profile', async () => {
    const guest = makeGuest('Link Guest');
    const badge = scoring.createCustomBadge({
      code: `BDTLINK${++codeSeq}`,
      name: 'Linked Badge',
      type: 'custom',
      artPath: '/badges/default-ribbon.svg',
      description: 'Has a link.',
    });
    db.prepare(
      `INSERT INTO guest_badges (guest_id, badge_id, awarded_by, points) VALUES (?, ?, 'admin', ?)`
    ).run(guest.id, badge.id, 3);

    const agent = signInGuest(app, guest.token);

    const home = await agent.get('/');
    const homeRow = extractBadgeRow(home.text, 'Linked Badge');
    expect(homeRow).toContain(`href="/badge/${badge.code}"`);

    const profile = await agent.get('/u/' + guest.id);
    const profileRow = extractBadgeRow(profile.text, 'Linked Badge');
    expect(profileRow).toContain(`href="/badge/${badge.code}"`);
  });
});

describe('AC2: a zero-point badge shows its title but never the "pts" suffix', () => {
  it('renders on the guest home page and the public profile', async () => {
    const guest = makeGuest('Zero Points Guest');
    grantBadge(guest.id, { name: 'Just Because', description: 'A freebie award.', points: 0 });

    const agent = signInGuest(app, guest.token);

    const home = await agent.get('/');
    expect(home.status).toBe(200);
    const homeRow = extractBadgeRow(home.text, 'Just Because');
    expect(homeRow).toContain('Just Because');
    expect(homeRow).not.toContain('pts');

    const profile = await agent.get('/u/' + guest.id);
    expect(profile.status).toBe(200);
    // The public-profile header renders the guest's own point TOTAL as
    // "<strong>0</strong>\n  pt" + "s" (public-profile.ejs), which contains
    // the substring "pts" outside the badge row — extractBadgeRow's slice
    // must exclude it, or this assertion would be a false pass/fail
    // depending on the guest's unrelated total.
    const profileRow = extractBadgeRow(profile.text, 'Just Because');
    expect(profileRow).toContain('Just Because');
    expect(profileRow).not.toContain('pts');
  });
});
