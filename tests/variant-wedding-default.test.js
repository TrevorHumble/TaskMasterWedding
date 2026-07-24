// tests/variant-wedding-default.test.js
// Issue #640 — the bachelor-party "Stag Master" instance. This file covers
// AC1 for every GUEST-AUTHENTICATED surface: with VARIANT unset (the ambient
// default in this whole suite — no other file sets process.env.VARIANT
// before this one, and vitest gives each test file its own isolated module
// registry, same guarantee tests/helpers/testApp.js's loadApp() already
// relies on for DATA_DIR), a signed-in guest's pages carry no data-theme
// attribute, no "Stag"/martini branding, and the wedding heart/wordmark/
// badge catalog stay exactly as they were before this issue.
//
// tests/variant-flag.test.js covers the same AC1 guarantee for pages that
// do NOT need a signed-in guest (admin/login, the badge catalog) plus the
// "any non-'stag' value" case and AC6 (two-instance isolation) — split out
// because those need MULTIPLE app boots with require.cache eviction in one
// file, which leaves every route/middleware module's db/config reference
// stale after the first boot (see that file's own comment). This file boots
// exactly once via the ordinary loadApp(), so a real signed-in guest session
// works the same way it does in every other test file in this suite.
'use strict';

const { loadApp, seed, signInGuest } = require('./helpers/testApp');

let app;
let db;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
  seed(db); // one task/guest('seedtoken')/non-taken-down submission
});

const HEART_PATH =
  'M12 21s-8.5-5.3-8.5-11.2A4.8 4.8 0 0 1 12 6.6a4.8 4.8 0 0 1 8.5 3.2C20.5 15.7 12 21 12 21z';
const MARTINI_PATH = 'M21 5V3H3v2l8 9v5H6v2h12v-2h-5v-5l8-9zM7.43 7 5.66 5h12.69l-1.78 2H7.43z';

describe('#640 AC1: VARIANT unset — signed-in guest pages render byte-identical to today', () => {
  it.each([['/'], ['/tasks'], ['/gallery'], ['/how-to-play'], ['/how-points-work']])(
    'GET %s carries no data-theme attribute, the wedding heart ornament, and "Wedding Master"',
    async (route) => {
      const agent = signInGuest(app, 'seedtoken');
      const res = await agent.get(route);
      expect(res.status).toBe(200);
      expect(res.text).toContain('<html lang="en">');
      expect(res.text).not.toContain('data-theme');
      expect(res.text).toContain('Wedding Master');
      expect(res.text).not.toContain('Stag Master');
      expect(res.text).not.toContain(MARTINI_PATH);
    }
  );

  it('the 404 page (reached only once a guest is signed in — router.use(requireGuest) redirects otherwise) carries "Lilly", the heart brand ornament, never "Stag"/martini/data-theme', async () => {
    const agent = signInGuest(app, 'seedtoken');
    const res = await agent.get('/this-route-does-not-exist');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('data-theme');
    expect(res.text).not.toContain('Stag');
    expect(res.text).toContain('Lilly');
    // 404.ejs renders through partials/message-card.ejs, which always
    // includes partials/heart.ejs (unlike the guest masthead below, which
    // writes the wedding heart as a literal &#9829; entity, not this SVG).
    expect(res.text).toContain(HEART_PATH);
    expect(res.text).not.toContain(MARTINI_PATH);
  });

  it('the guest masthead still reads the literal "&#9829; Lilly &amp; Axel &#9829;" ornament, unchanged', async () => {
    const agent = signInGuest(app, 'seedtoken');
    const res = await agent.get('/tasks');
    expect(res.status).toBe(200);
    expect(res.text).toContain('&#9829; Lilly &amp; Axel &#9829;');
  });

  it('the boot-time badge catalog is the wedding one — GARDEN included, no /badges/stag/ art anywhere', () => {
    const rows = db.prepare('SELECT code, name, art_path FROM badges ORDER BY code').all();
    const garden = rows.find((r) => r.code === 'GARDEN');
    expect(garden).toBeTruthy();
    expect(garden.name).toBe('Full Garden');
    expect(garden.art_path).toBe('/badges/garden.svg');
    for (const row of rows) {
      expect(row.art_path).not.toContain('/badges/stag/');
    }
  });

  // PR review follow-up: these two are server-rendered from route/module-
  // level literals (src/routes/community.js's GET /slideshow,
  // src/routes/guest.js's BUG_REPORT_THANKS), not a view-local — confirming
  // they stay byte-identical is the other half of the same regression check
  // tests/variant-stag.test.js runs for the stag instance.
  it('GET /slideshow keeps "Slideshow — Lilly & Axel" in <title>, unchanged', async () => {
    const agent = signInGuest(app, 'seedtoken');
    const res = await agent.get('/slideshow');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<title>Slideshow — Lilly &amp; Axel</title>');
  });

  it('a bug-report submission still thanks "the Wedding Masters", unchanged', async () => {
    db.prepare('INSERT INTO guests (token, name) VALUES (?, ?)').run(
      'wed-bug-token',
      'Wedding Bug Reporter'
    );
    const agent = signInGuest(app, 'wed-bug-token');

    const post = await agent.post('/bug-report').send({ body: 'The heart icon flickers' });
    expect(post.status).toBe(302);

    const follow = await agent.get('/');
    expect(follow.text).toContain('Thanks — the Wedding Masters have been told.');
  });
});
