// tests/variant-stag.test.js
// Issue #640 — the bachelor-party "Stag Master" instance (VARIANT=stag).
// Covers:
//   AC2 — <html> carries data-theme="stag" and the black-tie palette (the
//         exact values transcribed from the owner-approved preview) ships
//         in theme.css's [data-theme='stag'] block.
//   AC3 — the brand ornament is the martini glass, the wordmark is
//         "Stag Master", "Lilly" appears nowhere guest- or admin-facing, and
//         the FUNCTIONAL photo like-heart stays a heart (never swaps to the
//         martini — that swap is the brand ORNAMENT only, src/views/partials/
//         heart.ejs, never the like button in feed.ejs).
//   AC5 — the stag milestone catalog (First Round/Second Round/Last Call)
//         grants at 5/10/every-active-task, renders as a bare icon inside
//         the gold medallion (not the composed flower art), no GARDEN
//         (15-task) badge exists at all, and a boot-time re-sync
//         (scripts/badge-catalog.js's ensureBadgeCatalog) re-asserts the
//         stag values rather than reverting to the wedding ones — the same
//         guarantee a real process restart relies on (src/db.js calls this
//         on every boot).
//
// REQUIRE ORDER: process.env.VARIANT is set at module scope, BEFORE
// requiring anything that pulls in config.js — config reads it once at
// first require (same rule as DATA_DIR/DB_PATH; see tests/helpers/testApp.js's
// own header comment). This file creates its app instance via loadApp()
// exactly once, so no require.cache eviction is needed: vitest gives every
// test FILE its own isolated module registry (every other test file in this
// suite relies on the same guarantee for DATA_DIR, with no eviction).
'use strict';

process.env.VARIANT = 'stag';

const request = require('supertest');
const { loadApp, seed, signInGuest, makeAdminAgent } = require('./helpers/testApp');
const { ensureBadgeCatalog } = require('../scripts/badge-catalog');

let app;
let db;
let scoring;
let badgeIcons;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
  // Required only now, after loadApp() has set DATA_DIR/DB_PATH/VARIANT and
  // required src/db.js once (module cache), so both bind to this file's temp
  // DB and this file's VARIANT.
  scoring = require('../src/services/scoring');
  badgeIcons = require('../src/services/badge-icons');
});

// Defensive: restore the ambient env for any later test file that happens to
// share this worker (mirrors tests/config-branches.test.js's own cleanup
// discipline for an env var a file sets at module scope).
afterAll(() => {
  delete process.env.VARIANT;
});

describe('AC2: VARIANT=stag emits data-theme="stag" and the black-tie palette', () => {
  it('GET /admin/login carries data-theme="stag" on <html>, exactly', async () => {
    const res = await request(app).get('/admin/login');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<html lang="en" data-theme="stag">');
  });

  it("GET /css/theme.css ships the [data-theme='stag'] block with the approved hexes", async () => {
    const res = await request(app).get('/css/theme.css');
    expect(res.status).toBe(200);
    expect(res.text).toContain("[data-theme='stag']");
    expect(res.text).toContain('#0a0a0a'); // near-black ground
    expect(res.text).toContain('#c8a24c'); // gold accent
    expect(res.text).toContain('#8a7136'); // dim gold
    expect(res.text).toContain('#6e2222'); // wine danger fill
  });
});

describe('AC3: brand ornament, wordmark, Lilly scrubbed, functional hearts stay hearts', () => {
  const MARTINI_PATH = 'M21 5V3H3v2l8 9v5H6v2h12v-2h-5v-5l8-9zM7.43 7 5.66 5h12.69l-1.78 2H7.43z';
  const LIKE_HEART_PATH =
    'M12 21s-8.5-5.3-8.5-11.2A4.8 4.8 0 0 1 12 6.6a4.8 4.8 0 0 1 8.5 3.2C20.5 15.7 12 21 12 21z';

  it('GET /admin/login (guest-style masthead, pre-auth) carries the martini glyph and "Stag Master", never "Lilly"', async () => {
    const res = await request(app).get('/admin/login');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Stag Master Login');
    expect(res.text).toContain(MARTINI_PATH);
    expect(res.text.toLowerCase()).not.toContain('lilly');
  });

  it('an authenticated admin dashboard carries the martini ornament and "Stag Master", never "Lilly"', async () => {
    const agent = await makeAdminAgent(app);
    const res = await agent.get('/admin');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Stag Master');
    expect(res.text).toContain(MARTINI_PATH);
    expect(res.text.toLowerCase()).not.toContain('lilly');
  });

  it('the functional like-heart on /feed stays a heart, never the martini path', async () => {
    seed(db); // one task/guest/non-taken-down submission (tests/helpers/testApp.js)
    const agent = signInGuest(app, 'seedtoken');
    const res = await agent.get('/feed');
    expect(res.status).toBe(200);
    expect(res.text).toContain('class="like-heart"');
    expect(res.text).toContain(LIKE_HEART_PATH);
    // The martini path never leaks into the like button itself.
    const likeBlockStart = res.text.indexOf('class="like-heart"');
    const likeBlockEnd = res.text.indexOf('</svg>', likeBlockStart);
    const likeBlock = res.text.slice(likeBlockStart, likeBlockEnd);
    expect(likeBlock).not.toContain(MARTINI_PATH);
  });
});

describe('AC3 (PR review follow-up): /slideshow title and the bug-report thank-you are scrubbed too', () => {
  // These two are server-rendered from route/module-level literals
  // (src/routes/community.js's GET /slideshow, src/routes/guest.js's
  // BUG_REPORT_THANKS), not from a view-local — both read config.VARIANT
  // directly rather than res.locals.isStag (routes/services read
  // config.VARIANT directly; res.locals mirrors exist only for views).
  it('GET /slideshow carries "Slideshow — Axel" in <title>, never "Lilly"', async () => {
    // Reuses the 'seedtoken' guest the earlier AC3 describe block's own
    // seed(db) call already inserted — seed() is not idempotent (guests.token
    // is UNIQUE), so this block signs into that same guest rather than
    // reseeding.
    const agent = signInGuest(app, 'seedtoken');
    const res = await agent.get('/slideshow');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<title>Slideshow — Axel</title>');
    expect(res.text.toLowerCase()).not.toContain('lilly');
  });

  it('a bug-report submission thanks "the Stag Masters", never "Wedding"', async () => {
    db.prepare('INSERT INTO guests (token, name) VALUES (?, ?)').run(
      'stag-bug-token',
      'Stag Bug Reporter'
    );
    const agent = signInGuest(app, 'stag-bug-token');

    const post = await agent.post('/bug-report').send({ body: 'The martini glass is crooked' });
    expect(post.status).toBe(302);

    const follow = await agent.get('/');
    expect(follow.text).toContain('Thanks — the Stag Masters have been told.');
    expect(follow.text).not.toContain('Wedding Masters');
  });
});

describe('AC5: stag milestone badges, no GARDEN tier, re-sync survives a reboot', () => {
  let guestId;
  let taskIds;

  beforeAll(() => {
    // COMPLETIONIST's rule is "covers every ACTIVE task" globally, so hide
    // whatever the earlier describe blocks' seed()/sample rows inserted and
    // build a closed set of 10 tasks this block fully controls — matching
    // the real event's own "10 challenges, no 15-task tier" shape (issue
    // #640 context), not an arbitrary number.
    db.prepare("UPDATE tasks SET special_mode = 'hidden'").run();
    taskIds = [];
    for (let i = 0; i < 10; i += 1) {
      taskIds.push(
        db
          .prepare(`INSERT INTO tasks (title, special_mode) VALUES (?, 'none')`)
          .run(`Stag task ${i}`).lastInsertRowid
      );
    }
    guestId = db
      .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
      .run('stag-milestone-guest', 'Stag Guest').lastInsertRowid;
  });

  function submit(taskId) {
    db.prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, 0)`
    ).run(guestId, taskId, `p-${taskId}.jpg`, `t-${taskId}.jpg`);
  }

  function heldBadges() {
    return db
      .prepare(
        `SELECT b.code, b.name, b.art_path FROM guest_badges gb JOIN badges b ON b.id = gb.badge_id
          WHERE gb.guest_id = ? ORDER BY b.code ASC`
      )
      .all(guestId);
  }

  it('no GARDEN (15-task) row exists in the stag catalog at all', () => {
    const row = db.prepare('SELECT * FROM badges WHERE code = ?').get('GARDEN');
    expect(row).toBeUndefined();
  });

  it('5 completed tasks earns "First Round" as a bare gold icon in the medallion', () => {
    for (let i = 0; i < 5; i += 1) submit(taskIds[i]);
    scoring.recomputeBadges(guestId);

    const first = heldBadges().find((b) => b.code === 'BLOOM');
    expect(first).toBeTruthy();
    expect(first.name).toBe('First Round');
    expect(first.art_path).toBe('/badges/stag/icons/sports-bar.svg');
    // The medallion-vs-composed decision (src/views/partials/badge-art.ejs)
    // reads exactly this predicate — a false here would silently fall back
    // to the plain-<img> composed-badge rendering instead of the approved
    // icon-in-gold-medallion look.
    expect(badgeIcons.isIconArtPath(first.art_path)).toBe(true);
  });

  it('10 completed tasks earns "Second Round"', () => {
    for (let i = 5; i < 10; i += 1) submit(taskIds[i]);
    scoring.recomputeBadges(guestId);

    const second = heldBadges().find((b) => b.code === 'BOUQUET');
    expect(second).toBeTruthy();
    expect(second.name).toBe('Second Round');
    expect(second.art_path).toBe('/badges/stag/icons/liquor.svg');
    expect(badgeIcons.isIconArtPath(second.art_path)).toBe(true);
  });

  it('completing every active task earns "Last Call" (COMPLETIONIST)', () => {
    scoring.recomputeBadges(guestId);

    const lastCall = heldBadges().find((b) => b.code === 'COMPLETIONIST');
    expect(lastCall).toBeTruthy();
    expect(lastCall.name).toBe('Last Call');
    expect(lastCall.art_path).toBe('/badges/stag/icons/nightlife.svg');
    expect(badgeIcons.isIconArtPath(lastCall.art_path)).toBe(true);
  });

  it('a boot-time re-sync (ensureBadgeCatalog) re-asserts the stag values, never the wedding ones, after a stale edit', () => {
    // Simulate what a WEDDING-catalog write would have left behind, so this
    // assertion can actually fail if the re-sync ever resolved the wrong
    // catalog array for this DATA_DIR's variant.
    db.prepare(
      `UPDATE badges SET name = 'First Bloom', art_path = '/badges/bloom.svg' WHERE code = 'BLOOM'`
    ).run();

    const result = ensureBadgeCatalog(db, 'stag');

    expect(result.updated).toBeGreaterThanOrEqual(1);
    const row = db.prepare('SELECT name, art_path FROM badges WHERE code = ?').get('BLOOM');
    expect(row.name).toBe('First Round');
    expect(row.art_path).toBe('/badges/stag/icons/sports-bar.svg');
  });
});
