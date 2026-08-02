// tests/badge-dialog-overflow.test.js
// Covers issue #927: `.badge-dialog` set `overflow: hidden` with NO
// max-height, which overrode the UA's own `dialog { overflow: auto }` — so
// on a short/landscape phone the celebration card ran off the bottom of the
// screen and took `.badge-continue` (this dialog's ONLY exit control) with
// it. The fix caps the shell, makes `.badge-card` the scrolling body, and
// pins Continue in a `.badge-foot` sibling that never scrolls, plus a
// backdrop-close branch matching every sibling dialog's second exit.
//
// jsdom (this repo's only DOM test dependency) does not implement CSS layout
// — scrollWidth/clientWidth/actual box heights are always 0 there, so a real
// "the card scrolls and the foot stays in the viewport" assertion cannot run
// in this suite (same limitation documented in tests/leaderboard-overflow.test.js
// and tests/masthead-overflow.test.js). AC5's real behavioral proof (the
// 398x318 measurement) happened in the owner's phase-1 visual-approval loop,
// not here. This file asserts what CAN be pinned in Node: (1) the CSS source
// carries the capped-shell/scrolling-card/pinned-foot rules AC1-AC3 require,
// (2) the rendered markup puts `.badge-continue` in a `.badge-foot` sibling
// of `.badge-card` (AC4), and (3) a jsdom-simulated backdrop click closes the
// dialog while a click on its content does not (AC6).
//
// REQUIRE ORDER: config / db / app are required only AFTER loadApp() sets
// DATA_DIR / DB_PATH. Do not hoist requires above the loadApp() call.
'use strict';

const { JSDOM } = require('jsdom');
const request = require('supertest');
const { loadApp, signInGuest } = require('./helpers/testApp');
const { readThemeCss } = require('./helpers/theme-css');

const RECAP_JS_PATH = require.resolve('../src/public/js/recap.js');

let app;
let db;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
});

// Pull a top-level CSS rule block out of the stylesheet source by selector
// text (same helper as tests/leaderboard-overflow.test.js's and
// tests/masthead-overflow.test.js's ruleBlock).
function ruleBlock(source, selector) {
  const start = source.indexOf(selector + ' {');
  if (start === -1) return null;
  const end = source.indexOf('}', start);
  return source.slice(start, end + 1);
}

// ---------------------------------------------------------------------------
// AC1: the shell caps at 90vh then 90dvh (sibling band 72-92dvh, vh fallback
// declared first) and carries no overflow: hidden.
// ---------------------------------------------------------------------------
describe('AC1: .badge-dialog shell is capped, not clipped', () => {
  test('.badge-dialog sets max-height: 90vh before max-height: 90dvh', () => {
    const themeSrc = readThemeCss();
    const block = ruleBlock(themeSrc, '.badge-dialog');
    expect(block).not.toBeNull();

    const vhIndex = block.search(/max-height:\s*90vh/);
    const dvhIndex = block.search(/max-height:\s*90dvh/);
    expect(vhIndex).toBeGreaterThan(-1);
    expect(dvhIndex).toBeGreaterThan(-1);
    // The vh fallback must be declared FIRST so an engine understanding both
    // properties lands on the later (dvh) declaration via normal cascade
    // order, not source-order luck.
    expect(vhIndex).toBeLessThan(dvhIndex);
  });

  test('.badge-dialog max-height stays within the sibling band (72-92dvh)', () => {
    const themeSrc = readThemeCss();
    const block = ruleBlock(themeSrc, '.badge-dialog');
    const match = block.match(/max-height:\s*(\d+)dvh/);
    expect(match).not.toBeNull();
    const value = Number(match[1]);
    expect(value).toBeGreaterThanOrEqual(72);
    expect(value).toBeLessThanOrEqual(92);
  });

  test('.badge-dialog no longer leaves the shell at overflow: hidden', () => {
    const themeSrc = readThemeCss();
    const block = ruleBlock(themeSrc, '.badge-dialog');
    expect(block).not.toMatch(/overflow:\s*hidden/);
  });
});

// ---------------------------------------------------------------------------
// AC2: .badge-dialog[open] is a column flex container (scoped to [open] so
// the UA's dialog:not([open]) { display: none } still wins while closed);
// .badge-card is the shrinkable, scrolling flex child.
// ---------------------------------------------------------------------------
describe('AC2: [open] column flex, .badge-card the scrolling flex child', () => {
  test('.badge-dialog[open] sets display: flex and flex-direction: column', () => {
    const themeSrc = readThemeCss();
    const block = ruleBlock(themeSrc, '.badge-dialog[open]');
    expect(block).not.toBeNull();
    expect(block).toMatch(/display:\s*flex/);
    expect(block).toMatch(/flex-direction:\s*column/);
  });

  test('.badge-dialog .badge-card sets flex: 1 1 auto, min-height: 0, and both overflow axes', () => {
    const themeSrc = readThemeCss();
    const block = ruleBlock(themeSrc, '.badge-dialog .badge-card');
    expect(block).not.toBeNull();
    expect(block).toMatch(/flex:\s*1\s+1\s+auto/);
    // min-height: 0 is load-bearing (issue body): without it the flex item
    // keeps its full content height and pushes the foot back off screen.
    expect(block).toMatch(/min-height:\s*0/);
    expect(block).toMatch(/overflow-y:\s*auto/);
    expect(block).toMatch(/overflow-x:\s*hidden/);
  });
});

// ---------------------------------------------------------------------------
// AC3: the clip lives on .badge-card, never on .badge-stage — clipping the
// stage would crop the glow ring / badge pop, which overshoot the stage box
// by design.
// ---------------------------------------------------------------------------
describe('AC3: the overflow clip lives on .badge-card, not .badge-stage', () => {
  test('.badge-dialog .badge-card carries the overflow-x: hidden clip', () => {
    const themeSrc = readThemeCss();
    const block = ruleBlock(themeSrc, '.badge-dialog .badge-card');
    expect(block).not.toBeNull();
    expect(block).toMatch(/overflow-x:\s*hidden/);
  });

  test('.badge-dialog .badge-stage carries NO overflow declaration at all', () => {
    const themeSrc = readThemeCss();
    const block = ruleBlock(themeSrc, '.badge-dialog .badge-stage');
    expect(block).not.toBeNull();
    expect(block).not.toMatch(/overflow/);
  });
});

// ---------------------------------------------------------------------------
// AC4: .badge-continue sits in a .badge-foot sibling of .badge-card (not a
// descendant), in the real rendered markup — plus the .badge-foot CSS
// contract (pinned, divider, full-width button).
// ---------------------------------------------------------------------------
describe('AC4: .badge-continue lives in a .badge-foot sibling of .badge-card', () => {
  test('a signed-in guest render puts .badge-continue inside .badge-foot, outside .badge-card', async () => {
    const token = 'badge-dialog-overflow-token';
    db.prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`).run(token, 'Foot Guest');

    const agent = request.agent(app);
    signInGuest(app, token, agent);
    const res = await agent.get('/leaderboard');
    expect(res.status).toBe(200);

    // Parse the response rather than compare character offsets. String-index
    // ordering ("the foot's tag appears after the card's") cannot tell a
    // SIBLING foot from a foot NESTED INSIDE the card — and a nested foot is
    // the exact arrangement AC4 exists to forbid, because it would put
    // Continue back inside the scrolling body and re-create the bug. Only a
    // real tree answers that, so assert on the tree.
    const doc = new JSDOM(res.text).window.document;
    const dialog = doc.getElementById('badge-dialog');
    expect(dialog).not.toBeNull();

    const card = dialog.querySelector('.badge-card');
    const foot = dialog.querySelector('.badge-foot');
    const button = dialog.querySelector('.badge-continue');
    expect(card).not.toBeNull();
    expect(foot).not.toBeNull();
    expect(button).not.toBeNull();

    // The load-bearing pair: the button is inside the foot, and the foot is
    // NOT inside the scrolling card. Either one alone would still pass with
    // the foot nested.
    expect(foot.contains(button)).toBe(true);
    expect(card.contains(button)).toBe(false);
    expect(card.contains(foot)).toBe(false);
    // Siblings under the dialog itself, so the foot is a flex child of the
    // column and can be pinned (AC4's `flex: 0 0 auto`).
    expect(foot.parentElement).toBe(dialog);
    expect(card.parentElement).toBe(dialog);
  });

  test('.badge-dialog .badge-foot is pinned (flex: 0 0 auto) with a hairline divider', () => {
    const themeSrc = readThemeCss();
    const block = ruleBlock(themeSrc, '.badge-dialog .badge-foot');
    expect(block).not.toBeNull();
    expect(block).toMatch(/flex:\s*0\s+0\s+auto/);
    expect(block).toMatch(/border-top:\s*var\(--border-hairline\)/);
  });

  test('.badge-dialog .badge-foot .btn is full width', () => {
    const themeSrc = readThemeCss();
    const block = ruleBlock(themeSrc, '.badge-dialog .badge-foot .btn');
    expect(block).not.toBeNull();
    expect(block).toMatch(/width:\s*100%/);
  });
});

// ---------------------------------------------------------------------------
// AC6: a tap on the ::backdrop (event.target === the dialog element itself)
// closes the celebration dialog — recap.js, loaded on every page that
// renders #badge-dialog.
// ---------------------------------------------------------------------------
describe('AC6: a backdrop tap closes the celebration dialog (recap.js)', () => {
  function loadRecapWithDialog() {
    const dom = new JSDOM(
      '<!doctype html><html><body>' +
        '<dialog class="badge-dialog" id="badge-dialog" tabindex="-1">' +
        '<div class="badge-card">' +
        '<button type="button" class="btn badge-continue">Continue</button>' +
        '</div>' +
        '</dialog>' +
        '<ul id="recap-list"></ul>' +
        '</body></html>',
      { url: 'http://localhost/' }
    );

    const dialogEl = dom.window.document.getElementById('badge-dialog');
    dialogEl.open = true; // the dialog is open when a backdrop click can land at all
    dialogEl.close = function () {
      this.open = false;
      this.dispatchEvent(new dom.window.Event('close'));
    };

    const keys = ['window', 'document', 'navigator'];
    const saved = {};
    keys.forEach((key) => {
      saved[key] = Object.getOwnPropertyDescriptor(global, key);
      const value = key === 'window' ? dom.window : dom.window[key];
      Object.defineProperty(global, key, { value: value, configurable: true, writable: true });
    });

    delete require.cache[RECAP_JS_PATH];
    require(RECAP_JS_PATH);

    function restore() {
      keys.forEach((key) => {
        if (saved[key]) {
          Object.defineProperty(global, key, saved[key]);
        } else {
          delete global[key];
        }
      });
    }

    return { doc: dom.window.document, dialogEl: dialogEl, restore: restore };
  }

  test('a click whose target IS the dialog element (the backdrop) closes it', () => {
    const { doc, dialogEl, restore } = loadRecapWithDialog();
    try {
      expect(dialogEl.open).toBe(true);
      // A real backdrop click's event.target is the <dialog> element itself
      // (the click landed outside every child) — dispatch straight on it so
      // event.target === dialogEl, exactly as a browser would deliver it.
      dialogEl.dispatchEvent(
        new doc.defaultView.Event('click', { bubbles: true, cancelable: true })
      );
      expect(dialogEl.open).toBe(false);
    } finally {
      restore();
    }
  });

  test('a click on a dialog DESCENDANT leaves the dialog open — the identity test must not fire', () => {
    const { doc, dialogEl, restore } = loadRecapWithDialog();
    try {
      const card = doc.querySelector('.badge-card');
      expect(dialogEl.open).toBe(true);
      // event.target here is .badge-card, a DESCENDANT of the dialog, not
      // the dialog element itself — the backdrop branch's identity check
      // must NOT fire.
      card.dispatchEvent(new doc.defaultView.Event('click', { bubbles: true, cancelable: true }));
      expect(dialogEl.open).toBe(true);
    } finally {
      restore();
    }
  });

  test('a backdrop click on an already-closed dialog is a no-op (no throw, stays closed)', () => {
    const { doc, dialogEl, restore } = loadRecapWithDialog();
    try {
      dialogEl.open = false;
      expect(() => {
        dialogEl.dispatchEvent(
          new doc.defaultView.Event('click', { bubbles: true, cancelable: true })
        );
      }).not.toThrow();
      expect(dialogEl.open).toBe(false);
    } finally {
      restore();
    }
  });
});
