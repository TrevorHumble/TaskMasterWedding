// tests/admin-guests-ui.test.js
// Originally covered issue #257's phone-first card list with live name
// search. Issue #1093 rebuilt the page onto the admin Tasks card/dialog
// shape (one row per guest opening a single shared popup) and cut the
// per-row name form, bonus-points form, badge-award form, the "Create a
// custom badge" setup section and the Dashboard/Poster page-actions row
// entirely (all now either gone or moved into the popup). The describe
// blocks that asserted those removed controls' markup (#257's AC1, AC4,
// AC5, AC6) went with the controls they covered. See
// tests/admin-guest-management.test.js and tests/admin-guests-script.test.js
// for #1093's own coverage.
//
// What survives here: AC2's name-search filter (still the same control,
// unaffected by the rebuild: pure-function tests plus a DOM count via
// jsdom) and the badge action=toggle test, which posts directly to
// POST /admin/guests/:id/badge rather than through any page control. That
// endpoint stays live per #1093 criterion 7 even though its own award/remove
// form is gone from this page.
//
// The jsdom parts build DOMs explicitly via the jsdom package (node test
// environment throughout) so supertest keeps its node HTTP transport.
//
// REQUIRE ORDER: loadApp() must run before any require that pulls in config
// or db (see tests/helpers/testApp.js).
'use strict';

const { loadApp, makeAdminAgent } = require('./helpers/testApp');
const { JSDOM } = require('jsdom');
const { nameMatchesQuery } = require('../src/public/js/filter');
const { readThemeCss } = require('./helpers/theme-css');

// Issue #969: theme.css split into slices -- read via the shared helper.
const THEME_CSS = readThemeCss();

// Extract the body of the first CSS rule whose selector line contains `selector`.
function cssRuleBody(selector) {
  const idx = THEME_CSS.indexOf(selector);
  if (idx === -1) return null;
  const open = THEME_CSS.indexOf('{', idx);
  const close = THEME_CSS.indexOf('}', open);
  return THEME_CSS.slice(open + 1, close);
}

// Point the window/document/navigator globals at a jsdom instance so the
// browser-side scripts can be required. Descriptor-based because newer Node
// versions define global.navigator as getter-only (plain assignment throws
// in strict mode). Returns a restore function.
function installDomGlobals(dom) {
  const keys = ['window', 'document', 'navigator'];
  const saved = {};
  keys.forEach((key) => {
    saved[key] = Object.getOwnPropertyDescriptor(global, key);
    const value = key === 'window' ? dom.window : dom.window[key];
    Object.defineProperty(global, key, { value, configurable: true, writable: true });
  });
  return function restore() {
    keys.forEach((key) => {
      if (saved[key]) {
        Object.defineProperty(global, key, saved[key]);
      } else {
        delete global[key];
      }
    });
  };
}

let app;
let db;
let adminAgent;

const guestToken = 'avatoken0000000000000000000000aa';

beforeAll(async () => {
  const result = loadApp();
  app = result.app;
  db = result.db;
  adminAgent = await makeAdminAgent(app);

  db.prepare('INSERT INTO tasks (title, sort_order) VALUES (?, 0)').run('Selfie with the cake');
  db.prepare('INSERT INTO guests (token, name) VALUES (?, ?)').run(guestToken, 'Ava Fenwick');
  db.prepare('INSERT INTO guests (token, name) VALUES (?, ?)').run(
    'marcustoken00000000000000000000b',
    'Marcus Bell'
  );
  db.prepare('INSERT INTO guests (token, name) VALUES (?, ?)').run(
    'noratoken0000000000000000000000c',
    'Nora Avery'
  );
});

// ---------------------------------------------------------------------------
// AC2 — any-word prefix filter: pure function + DOM count
// ---------------------------------------------------------------------------
describe('AC2: nameMatchesQuery is a case-insensitive any-word prefix match', () => {
  it('matches a prefix of any word in the name', () => {
    expect(nameMatchesQuery('Ava Fenwick', 'ava')).toBe(true);
    expect(nameMatchesQuery('Ava Fenwick', 'fen')).toBe(true);
    expect(nameMatchesQuery('Nora Avery', 'ave')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(nameMatchesQuery('Ava Fenwick', 'AVA')).toBe(true);
    expect(nameMatchesQuery('ava fenwick', 'Fen')).toBe(true);
  });

  it('rejects mid-word substrings and non-matches', () => {
    expect(nameMatchesQuery('Marcus Bell', 'arcus')).toBe(false);
    expect(nameMatchesQuery('Marcus Bell', 'ava')).toBe(false);
  });

  it('requires every query word to prefix-match some name word', () => {
    expect(nameMatchesQuery('Ava Fenwick', 'av fe')).toBe(true);
    expect(nameMatchesQuery('Ava Fenwick', 'av zz')).toBe(false);
  });

  it('blank or missing query matches everything', () => {
    expect(nameMatchesQuery('Anyone', '')).toBe(true);
    expect(nameMatchesQuery('Anyone', '   ')).toBe(true);
    expect(nameMatchesQuery('Anyone', undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC2 (DOM count) — one jsdom instance, one require of the client scripts.
// (AC3's copy-link DOM coverage lived here too before issue #244 removed the
// feature — see the file header comment.)
// ---------------------------------------------------------------------------
describe('DOM wiring via jsdom: search filtering (AC2)', () => {
  let dom;
  let restoreGlobals;

  beforeAll(async () => {
    dom = new JSDOM(
      `<input type="search" id="guest-search" />
       <div class="guest-list">
         <article class="guest-card" data-guest-name="Ava Fenwick"></article>
         <article class="guest-card" data-guest-name="Marcus Bell"></article>
         <article class="guest-card" data-guest-name="Nora Avery"></article>
       </div>`,
      { url: 'http://localhost/' }
    );
    restoreGlobals = installDomGlobals(dom);
    // filter.js was already required at the top of this file (before any
    // window existed), so its window-wiring line never ran and a re-require
    // returns the cached module. Attach HuntFilter the way the script tag
    // does in the browser, then load admin.js — its one require in this
    // file, so it attaches its listeners to this document.
    dom.window.HuntFilter = { nameMatchesQuery };
    require('../src/public/js/admin.js');
  });

  afterAll(() => {
    restoreGlobals();
  });

  it('AC2: filters cards as the user types, and clearing restores all', () => {
    const input = dom.window.document.getElementById('guest-search');
    const cards = () => [...dom.window.document.querySelectorAll('.guest-card')];
    const visible = () => cards().filter((c) => !c.hidden);

    // "ava" prefix-matches "Ava" but not "Avery" (a-v-e) or "Marcus Bell".
    input.value = 'ava';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(visible().map((c) => c.getAttribute('data-guest-name'))).toEqual(['Ava Fenwick']);

    // "av" prefix-matches both Ava and Avery.
    input.value = 'av';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(visible().map((c) => c.getAttribute('data-guest-name'))).toEqual([
      'Ava Fenwick',
      'Nora Avery',
    ]);

    input.value = '';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(visible().length).toBe(3);
  });

  it('AC2 guard: theme.css forces display:none on [hidden] cards', () => {
    // .guest-card is display:flex, which beats the UA's plain
    // [hidden] { display: none } on WebKit — the filter only visibly works
    // because of this rule. jsdom doesn't apply external stylesheets, so
    // assert the rule itself.
    const body = cssRuleBody('.guest-card[hidden]');
    expect(body).not.toBeNull();
    expect(body).toMatch(/display:\s*none\s*!important/);
  });
});

// ---------------------------------------------------------------------------
// Badge action=toggle resolves against held state server-side. Posted
// directly here (issue #1093 removed this page's own award/remove form, but
// the endpoint stays live, criterion 7).
// ---------------------------------------------------------------------------
describe('badge action=toggle resolves server-side', () => {
  it('toggle awards when not held, then removes when held', async () => {
    const badgeId = db
      .prepare(
        `INSERT INTO badges (code, name, type, art_path) VALUES ('TOGGLETEST', 'Toggle Test', 'custom', '🎖️')`
      )
      .run().lastInsertRowid;
    const guestId = db.prepare('SELECT id FROM guests WHERE token = ?').get(guestToken).id;
    const heldCount = () =>
      db
        .prepare('SELECT COUNT(*) AS n FROM guest_badges WHERE guest_id = ? AND badge_id = ?')
        .get(guestId, badgeId).n;

    expect(heldCount()).toBe(0);

    await adminAgent
      .post(`/admin/guests/${guestId}/badge`)
      .type('form')
      .send({ code: 'TOGGLETEST', action: 'toggle' });
    expect(heldCount()).toBe(1);

    await adminAgent
      .post(`/admin/guests/${guestId}/badge`)
      .type('form')
      .send({ code: 'TOGGLETEST', action: 'toggle' });
    expect(heldCount()).toBe(0);
  });
});
