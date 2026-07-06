// tests/admin-guests-ui.test.js
// Covers issue #257 acceptance criteria — the guests admin page as a
// phone-first card list with live name search and copy-link.
//
//   AC1 — each guest renders as a card (name form, "N pts · D/T tasks" meta,
//         Copy control, bonus-points form, delete form); no <table> anywhere
//   AC2 — any-word-prefix filter: pure-function tests + DOM count via jsdom
//   AC3 — Copy button calls clipboard.writeText with the /j/<token> link and
//         the literal "Copied!" appears (jsdom + clipboard mock)
//   AC4 — name input width rule in theme.css resolves to ≥ 60% of the card
//   AC5 — Dashboard + Print QR share a flex container with a gap rule
//   AC6 — guest list starts within the first 40% of the response body
//
// The jsdom parts build DOMs explicitly via the jsdom package (node test
// environment throughout) so supertest keeps its node HTTP transport.
//
// REQUIRE ORDER: loadApp() must run before any require that pulls in config
// or db (see tests/helpers/testApp.js).
'use strict';

const fs = require('fs');
const path = require('path');
const { loadApp, makeAdminAgent } = require('./helpers/testApp');
const { JSDOM } = require('jsdom');
const { nameMatchesQuery } = require('../src/public/js/filter');

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
// AC1 — card per guest, required contents, no table
// ---------------------------------------------------------------------------
describe('AC1: guest cards replace the table', () => {
  it('renders a .guest-card per guest with meta line, Copy, bonus form, delete form', async () => {
    const res = await adminAgent.get('/admin/guests');
    expect(res.status).toBe(200);

    const cardCount = (res.text.match(/class="guest-card"/g) || []).length;
    expect(cardCount).toBe(3);

    // "N pts · D/T tasks" meta line, one per guest.
    const metaCount = (res.text.match(/\d+ pts · \d+\/\d+ tasks/g) || []).length;
    expect(metaCount).toBe(3);

    expect(res.text).toMatch(/class="[^"]*copy-link[^"]*"/);
    expect(res.text).toMatch(/action="\/admin\/guests\/\d+\/points"/);
    expect(res.text).toMatch(/action="\/admin\/guests\/\d+\/delete"/);

    // Minimum structural check from the AC: no <table> in the layout at all.
    expect(res.text).not.toMatch(/<table/i);
  });
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
// AC2 (DOM count) + AC3 — one jsdom instance, one require of the client
// scripts. The browser scripts attach their listeners to whichever document
// is global when they load, so both DOM tests share a single fixture and a
// single load rather than re-requiring against fresh documents.
// ---------------------------------------------------------------------------
describe('DOM wiring via jsdom: search filtering (AC2) and copy-link (AC3)', () => {
  const link = 'http://localhost:3000/j/' + guestToken;
  let dom;
  let writeText;
  let restoreGlobals;

  beforeAll(async () => {
    dom = new JSDOM(
      `<input type="search" id="guest-search" />
       <div class="guest-list">
         <article class="guest-card" data-guest-name="Ava Fenwick">
           <div class="guest-link-row">
             <input type="text" readonly value="${link}" />
             <button type="button" class="copy-link" data-link="${link}">Copy</button>
             <span class="copy-confirm" hidden>Copied!</span>
           </div>
         </article>
         <article class="guest-card" data-guest-name="Marcus Bell"></article>
         <article class="guest-card" data-guest-name="Nora Avery"></article>
       </div>`,
      { url: 'http://localhost/' }
    );
    writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(dom.window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
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

  it('AC3: clipboard.writeText gets the guest link and Copied! appears', async () => {
    const btn = dom.window.document.querySelector('.copy-link');
    const confirmEl = dom.window.document.querySelector('.copy-confirm');
    expect(confirmEl.hidden).toBe(true);

    btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    // Flush the clipboard promise's .then().
    await Promise.resolve();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith(link);
    expect(confirmEl.hidden).toBe(false);
    expect(confirmEl.textContent).toBe('Copied!');
  });
});

// ---------------------------------------------------------------------------
// Badge select posts action=toggle; the server resolves it from held state
// (no-JS correctness for the card's badge-award form).
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

// ---------------------------------------------------------------------------
// AC4 — name input width rule resolves to ≥ 60% of the card
// ---------------------------------------------------------------------------
describe('AC4: name input width rule', () => {
  it('theme.css gives .guest-name-form input a width of at least 60%', () => {
    const body = cssRuleBody('.guest-name-form input');
    expect(body).not.toBeNull();
    const width = body.match(/width:\s*(\d+)%/);
    expect(width).not.toBeNull();
    expect(parseInt(width[1], 10)).toBeGreaterThanOrEqual(60);
    // flex-grow lets it take the rest of the row beyond that basis.
    expect(body).toMatch(/flex:\s*1 1 auto/);
  });
});

// ---------------------------------------------------------------------------
// AC5 — header actions share a flex container with a gap
// ---------------------------------------------------------------------------
describe('AC5: page-actions flex row', () => {
  it('Dashboard and Print QR live in one .page-actions element', async () => {
    const res = await adminAgent.get('/admin/guests');
    const rowMatch = res.text.match(/<p class="page-actions">[\s\S]*?<\/p>/);
    expect(rowMatch).not.toBeNull();
    expect(rowMatch[0]).toContain('Dashboard');
    expect(rowMatch[0]).toContain('Print QR place-cards');
  });

  it('theme.css .page-actions is display:flex with a gap rule', () => {
    const body = cssRuleBody('.page-actions');
    expect(body).not.toBeNull();
    expect(body).toMatch(/display:\s*flex/);
    expect(body).toMatch(/gap:/);
    expect(body).toMatch(/flex-wrap:\s*wrap/);
  });
});

// ---------------------------------------------------------------------------
// AC6 — setup forms are <details>; guest list starts early in the document
// ---------------------------------------------------------------------------
describe('AC6: setup sections collapse, guest list starts within one screen', () => {
  it('the three setup sections are <details> blocks', async () => {
    const res = await adminAgent.get('/admin/guests');
    const detailsCount = (res.text.match(/<details class="setup-details">/g) || []).length;
    expect(detailsCount).toBe(3);
    ['Add one guest', 'Bulk create', 'Create a custom badge'].forEach((label) => {
      expect(res.text).toMatch(new RegExp('<summary>' + label + '</summary>'));
    });
  });

  it('the first guest card appears within the first 40% of the body', async () => {
    const res = await adminAgent.get('/admin/guests');
    const firstCard = res.text.indexOf('class="guest-card"');
    expect(firstCard).toBeGreaterThan(-1);
    expect(firstCard).toBeLessThan(res.text.length * 0.4);
  });
});
