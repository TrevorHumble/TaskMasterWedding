// tests/gallery-person-filter.test.js
// Covers issue #251 AC5 — the live person search filters sections client-side
// by case-insensitive any-word-prefix match, and clearing the field restores
// everything. Tests the pure applyPersonFilter exported from
// src/public/js/gallery.js with the real match rule from
// src/public/js/filter.js (the same pair the browser wires together), using
// plain section stand-ins: applyPersonFilter only touches getAttribute and
// the `hidden` property, exactly what it uses on real DOM elements.
'use strict';

const { applyPersonFilter, wireUpPersonSearch } = require('../src/public/js/gallery');
const { nameMatchesQuery } = require('../src/public/js/filter');

function section(name) {
  return {
    hidden: false,
    getAttribute: (attr) => (attr === 'data-person-section' ? name : null),
  };
}

function visibleNames(sections) {
  return sections.filter((s) => !s.hidden).map((s) => s.getAttribute('data-person-section'));
}

const NAMES = ['Priya Patel', 'Marcus Bell', 'Ava Fenwick', 'Pat Marlowe'];

it('typing "pri" leaves only sections whose name has a word starting with "pri"', () => {
  const sections = NAMES.map(section);
  const shown = applyPersonFilter(sections, 'pri', nameMatchesQuery);
  expect(visibleNames(sections)).toEqual(['Priya Patel']);
  expect(shown).toBe(1);
});

it('"pat" prefix-matches ANY word of the name: Priya Patel and Pat Marlowe', () => {
  const sections = NAMES.map(section);
  applyPersonFilter(sections, 'pat', nameMatchesQuery);
  expect(visibleNames(sections)).toEqual(['Priya Patel', 'Pat Marlowe']);
});

it('matching is case-insensitive', () => {
  const sections = NAMES.map(section);
  applyPersonFilter(sections, 'MARCUS', nameMatchesQuery);
  expect(visibleNames(sections)).toEqual(['Marcus Bell']);
});

it('clearing the field restores every section', () => {
  const sections = NAMES.map(section);
  applyPersonFilter(sections, 'pri', nameMatchesQuery);
  expect(visibleNames(sections)).toEqual(['Priya Patel']);

  const shown = applyPersonFilter(sections, '', nameMatchesQuery);
  expect(visibleNames(sections)).toEqual(NAMES);
  expect(shown).toBe(NAMES.length);
});

it('a query matching nothing hides every section (clean empty state)', () => {
  const sections = NAMES.map(section);
  const shown = applyPersonFilter(sections, 'zzz', nameMatchesQuery);
  expect(shown).toBe(0);
  expect(visibleNames(sections)).toEqual([]);
});

// ---------------------------------------------------------------------------
// DOM wiring via jsdom — the glue itself (#person-search id, the
// [data-person-section] selector, the input listener), so a typo'd id or
// selector cannot leave the suite green. Same pattern as
// tests/admin-guests-ui.test.js.
// ---------------------------------------------------------------------------
const { JSDOM } = require('jsdom');

// Point the window/document/navigator globals at a jsdom instance so the
// browser-side script can be required. Descriptor-based because newer Node
// versions define global.navigator as getter-only. Returns a restore function.
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

describe('DOM wiring via jsdom: typing in #person-search filters sections (#251 AC5)', () => {
  let dom;
  let restoreGlobals;

  beforeAll(() => {
    dom = new JSDOM(
      `<input type="search" id="person-search" />
       <section class="gallery-group" data-person-section="Priya Patel"></section>
       <section class="gallery-group" data-person-section="Marcus Bell"></section>
       <section class="gallery-group" data-person-section="Ava Fenwick"></section>`,
      { url: 'http://localhost/' }
    );
    restoreGlobals = installDomGlobals(dom);
    // In the browser /js/filter.js loads first and attaches HuntFilter;
    // replicate that, then run the real wiring against this document. (The
    // top-of-file require ran before any window existed, so the module's
    // self-wiring was a no-op — CJS caching means a re-require would not
    // re-execute it, hence the explicit exported entry point.)
    dom.window.HuntFilter = { nameMatchesQuery };
    wireUpPersonSearch();
  });

  afterAll(() => {
    restoreGlobals();
  });

  it('input events drive the filter; clearing restores every section', () => {
    const input = dom.window.document.getElementById('person-search');
    const sections = () => [...dom.window.document.querySelectorAll('[data-person-section]')];
    const visible = () =>
      sections()
        .filter((s) => !s.hidden)
        .map((s) => s.getAttribute('data-person-section'));

    input.value = 'pri';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(visible()).toEqual(['Priya Patel']);

    input.value = '';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(visible()).toEqual(['Priya Patel', 'Marcus Bell', 'Ava Fenwick']);
  });
});
