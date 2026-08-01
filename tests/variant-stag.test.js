// tests/variant-stag.test.js
// Issue #640 — the bachelor-party "Stag Master" instance (VARIANT=stag).
// Covers:
//   AC2 — <html> carries data-theme="stag" and the black-tie palette (the
//         exact values transcribed from the owner-approved preview) ships
//         in base.css's [data-theme='stag'] block.
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
const { fetchThemeCssOverHttp } = require('./helpers/theme-css');

// Copied from tests/feed-full-bleed.test.js (issue #878 implementation plan
// step 4): extractBalancedBlock/allIndicesOf are file-local there and not
// exported, so the #878 source-order guard below carries its own copy rather
// than reaching into another test file or adding a second way to read the
// stylesheet (this file already fetches it over HTTP; fs.readFileSync is not
// introduced here).
/** Find the balanced {...} block whose '{' is the first at or after fromIndex. */
function extractBalancedBlock(source, fromIndex) {
  const braceStart = source.indexOf('{', fromIndex);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(braceStart, i + 1);
    }
  }
  throw new Error('unbalanced braces from index ' + fromIndex);
}

function allIndicesOf(source, needle) {
  const out = [];
  let i = source.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = source.indexOf(needle, i + 1);
  }
  return out;
}

let app;
let db;
let scoring;
let badgeIcons;
let taskBadges;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
  // Required only now, after loadApp() has set DATA_DIR/DB_PATH/VARIANT and
  // required src/db.js once (module cache), so both bind to this file's temp
  // DB and this file's VARIANT.
  scoring = require('../src/services/scoring');
  badgeIcons = require('../src/services/badge-icons');
  taskBadges = require('../src/services/task-badges');
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

  it("the theme stylesheet ships the [data-theme='stag'] block with the approved hexes", async () => {
    // Issue #969: theme.css split into slices -- fetch every sheet over HTTP
    // in head.ejs's own link order and concatenate (the HTTP mirror of
    // readThemeCss()), since this guard spans the whole former theme.css.
    const { body } = await fetchThemeCssOverHttp(app);
    expect(body).toContain("[data-theme='stag']");
    expect(body).toContain('#0a0a0a'); // near-black ground
    expect(body).toContain('#c8a24c'); // gold accent
    expect(body).toContain('#8a7136'); // dim gold
    expect(body).toContain('#6e2222'); // wine danger fill
  });

  it('#869: --badge-icon-color resolves to stag gold, and stays green-700 in :root (no regression for the default variant)', async () => {
    const { body } = await fetchThemeCssOverHttp(app);

    // The theme stylesheet itself never branches on VARIANT — it ships both
    // the :root block and the [data-theme='stag'] override, and the wedding
    // instance (no data-theme attribute on <html>) only ever matches :root.
    // So the :root slice IS the "wedding stays green" no-regression
    // assertion, not a separate app instance.
    const stagSelectorAt = body.indexOf("[data-theme='stag']");
    const rootBlock = body.slice(0, stagSelectorAt);
    const stagBlock = body.slice(stagSelectorAt);
    expect(rootBlock).toContain('--badge-icon-color: var(--green-700);');
    expect(stagBlock).toContain('--badge-icon-color: var(--gold);');

    // The mask contract that actually recolors the ~349 bundled icons: both
    // glyph classes pull their fill from the single --badge-icon-color owner
    // above and mask the per-render --icon-src, rather than sizing an <img>.
    // Sliced per-selector (not a bare body.toContain) so a regression
    // that keeps the property text somewhere else in the file but detaches it
    // from these two classes would still be caught.
    for (const selector of ['.badge-medallion-icon', '.badge-picker-glyph']) {
      const ruleStart = body.indexOf(selector + ' {');
      expect(ruleStart).toBeGreaterThan(-1);
      const ruleEnd = body.indexOf('}', ruleStart);
      const rule = body.slice(ruleStart, ruleEnd);
      expect(rule).toContain('background-color: var(--badge-icon-color);');
      expect(rule).toContain('mask-image: var(--icon-src, none);');
    }
  });

  it("#878 AC4: --color-ink-strong is declared in both :root and [data-theme='stag']", async () => {
    const { body } = await fetchThemeCssOverHttp(app);

    // Same root/stag slicing technique as the #869 test above.
    const stagSelectorAt = body.indexOf("[data-theme='stag']");
    const rootBlock = body.slice(0, stagSelectorAt);
    const stagBlock = body.slice(stagSelectorAt);

    expect(rootBlock).toContain('--color-ink-strong: var(--green-900);');
    expect(stagBlock).toContain('--color-ink-strong: #fafafa;');
  });

  it('#878 AC2: on the wedding instance (:root), .task-points-raised resolves byte-identical to the pre-change #2a4335', async () => {
    const { body } = await fetchThemeCssOverHttp(app);

    const stagSelectorAt = body.indexOf("[data-theme='stag']");
    const rootBlock = body.slice(0, stagSelectorAt);

    // .task-points-raised itself is unscoped (one shared rule cascades to
    // both instances; only the custom-property values it reads differ per
    // theme), so it lives far below the :root block in source order — search
    // the whole sheet for the rule, then check the WEDDING-side variable
    // chain it reads from (:root, i.e. rootBlock) separately: color ->
    // --color-ink-strong -> --green-900. All three must hold, or the
    // owner-approved wedding pixels have moved.
    const ruleStart = body.indexOf('.task-points-raised {');
    expect(ruleStart).toBeGreaterThan(-1);
    const rule = extractBalancedBlock(body, ruleStart);
    expect(rule).toContain('color: var(--color-ink-strong);');
    expect(rootBlock).toContain('--color-ink-strong: var(--green-900);');
    expect(rootBlock).toContain('--green-900: #2a4335;');
  });

  it('#878 AC1: on stag, .task-points-raised resolves to near-white, distinct from the near-black page ground, and is the last color-setting rule for that class', async () => {
    const { body } = await fetchThemeCssOverHttp(app);

    const stagSelectorAt = body.indexOf("[data-theme='stag']");
    const stagBlock = body.slice(stagSelectorAt);

    // Trace the chain for stag: .task-points-raised's color ->
    // --color-ink-strong -> #fafafa directly (no further var() hop), and
    // confirm that resolved value is distinct from stag's --color-bg — by
    // extracting both declared values out of the served stylesheet text and
    // comparing THOSE, not by comparing two hard-coded string literals to
    // each other (a comparison that could never fail regardless of what
    // the theme stylesheet actually contains).
    expect(stagBlock).toContain('--color-ink-strong: #fafafa;');
    expect(stagBlock).toContain('--color-bg: #0a0a0a;');

    const inkMatch = stagBlock.match(/--color-ink-strong:\s*(#[0-9a-fA-F]+)\s*;/);
    const bgMatch = stagBlock.match(/--color-bg:\s*(#[0-9a-fA-F]+)\s*;/);
    expect(inkMatch).toBeTruthy();
    expect(bgMatch).toBeTruthy();
    expect(inkMatch[1]).not.toBe(bgMatch[1]);

    // Source-order guard: find every `.task-points-raised { ... }` rule in
    // the whole stylesheet and confirm the LAST one in source order is the
    // one that inks via --color-ink-strong — so nothing declared after it
    // takes the color back (today there is exactly one such rule; this
    // assertion still catches a future rule added later in the file that
    // would win the cascade and silently repaint the price tag).
    const selectorIndices = allIndicesOf(body, '.task-points-raised {');
    expect(selectorIndices.length).toBeGreaterThan(0);
    const lastSelectorIdx = selectorIndices[selectorIndices.length - 1];
    const lastRule = extractBalancedBlock(body, lastSelectorIdx);
    expect(lastRule).toContain('color: var(--color-ink-strong);');
  });

  it('#878 AC3: no color: declaration anywhere in the stylesheet inks directly with the raw --green-900 ramp variable', async () => {
    const { body } = await fetchThemeCssOverHttp(app);

    // A standalone `color:` property (never `background-color:`,
    // `border-color:`, `outline-color:`, etc. — those legitimately reference
    // --green-900 elsewhere in this file for non-text uses, and are not what
    // AC3 guards). The negative lookbehind excludes any compound property
    // name ending in "-color" so this only catches the literal `color:` this
    // issue's defect form used. The value is scanned all the way to the
    // declaration's closing `;` (or `}` for a rule's last declaration), not
    // just immediately after `color:`, so a --green-900 reference reached
    // through a nested fallback — e.g.
    // `color: var(--some-token, var(--green-900))` — is caught too, not only
    // a direct `color: var(--green-900)`. Runs over the CONCATENATED text
    // (all five sheets, issue #969) so a rule that moved to a different
    // sheet than :root's own stays covered.
    const offendingColorDecl = /(?<![a-zA-Z-])color\s*:\s*[^;}]*var\(\s*--green-900\s*\)/;
    expect(body).not.toMatch(offendingColorDecl);
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

describe('#869: a custom (picker-chosen) badge renders as a masked glyph, not a green-baked <img>', () => {
  // A picker-chosen custom badge points its art_path at the WEDDING icon
  // catalog (src/services/badge-icons.js's ICONS_URL_PREFIX) even on the
  // stag instance — #869's own scope note: the admin picker itself stays
  // wedding-icon-only, only the RENDER of that icon recolors via CSS. So this
  // is the realistic stag shape: a wedding-prefixed art_path, rendered under
  // data-theme="stag".
  let iconTaskId;

  beforeAll(() => {
    iconTaskId = db
      .prepare(`INSERT INTO tasks (title, special_mode) VALUES (?, 'none')`)
      .run('Stag icon task').lastInsertRowid;
    taskBadges.setTaskBadge(iconTaskId, {
      name: 'Golden Moment',
      artPath: badgeIcons.iconArtPath('favorite'),
    });
  });

  it('the admin task board emits a masked <span> carrying --icon-src and an accessible name, not an <img> with the icon baked into its src', async () => {
    const agent = await makeAdminAgent(app);
    const res = await agent.get('/admin/tasks');
    expect(res.status).toBe(200);

    // The exact masked-glyph markup badge-art.ejs's icon branch emits
    // (src/views/partials/badge-art.ejs) — a bare <span>, no src attribute,
    // the icon supplied only as a mask via --icon-src, with role="img" +
    // aria-label carrying the accessible name the retired <img alt> used to.
    // The style value's quotes render as `&#39;` (EJS's `<%=` escaping the
    // badgeIconMaskStyle output, PR review finding 3/4) — harmless to the
    // browser, which HTML-decodes the attribute before the CSS parser reads it.
    expect(res.text).toContain(
      '<span class="badge-medallion-icon" style="--icon-src: url(&#39;/badges/icons/favorite.svg&#39;)" role="img" aria-label="Golden Moment"></span>'
    );

    // Regression guard: the pre-#869 shape rendered this exact icon as
    // `<img ... src="/badges/icons/favorite.svg" ...>`, which bakes the
    // green-700 fill into the served bytes and cannot be recolored by the
    // stag theme. If the recolor ever regresses back to an <img>, this is
    // what would reappear.
    expect(res.text).not.toContain('src="/badges/icons/favorite.svg"');
  });
});
