// tests/gallery-task-filter.test.js
// Covers issue #527 AC1 — the live task search filters By-task gallery
// sections client-side by the same case-insensitive any-word-prefix rule the
// By-person view already uses, and clearing the field restores everything.
// Tests the generalized applySectionFilter / wireUpSectionSearch exported
// from src/public/js/gallery.js (issue #527 AC2 — one filter function, one
// wiring function, parameterized by section attribute and input id — not a
// second copy of the By-person implementation), with the real match rule
// from src/public/js/filter.js, using plain section stand-ins:
// applySectionFilter only touches getAttribute and the `hidden` property,
// exactly what it uses on real DOM elements. Same harness shape as
// tests/gallery-person-filter.test.js.
'use strict';

const { applySectionFilter, wireUpGallerySearch } = require('../src/public/js/gallery');
const { nameMatchesQuery } = require('../src/public/js/filter');

const ATTR = 'data-task-section';

function section(name) {
  return {
    hidden: false,
    getAttribute: (attr) => (attr === ATTR ? name : null),
  };
}

function visibleNames(sections) {
  return sections.filter((s) => !s.hidden).map((s) => s.getAttribute(ATTR));
}

const TASKS = ['Photograph the dessert table', 'Toast the couple', 'Memories'];

it('typing "dessert" leaves only the dessert-table section', () => {
  const sections = TASKS.map(section);
  const shown = applySectionFilter(sections, 'dessert', nameMatchesQuery, ATTR);
  expect(visibleNames(sections)).toEqual(['Photograph the dessert table']);
  expect(shown).toBe(1);
});

it('matching is case-insensitive and matches any word, not just the first', () => {
  const sections = TASKS.map(section);
  applySectionFilter(sections, 'TOAST', nameMatchesQuery, ATTR);
  expect(visibleNames(sections)).toEqual(['Toast the couple']);
});

it('the Memories group filters on the word "Memories" like any other section', () => {
  const sections = TASKS.map(section);
  applySectionFilter(sections, 'mem', nameMatchesQuery, ATTR);
  expect(visibleNames(sections)).toEqual(['Memories']);
});

it('clearing the field restores every section', () => {
  const sections = TASKS.map(section);
  applySectionFilter(sections, 'dessert', nameMatchesQuery, ATTR);
  expect(visibleNames(sections)).toEqual(['Photograph the dessert table']);

  const shown = applySectionFilter(sections, '', nameMatchesQuery, ATTR);
  expect(visibleNames(sections)).toEqual(TASKS);
  expect(shown).toBe(TASKS.length);
});

it('a query matching nothing hides every section (clean empty state)', () => {
  const sections = TASKS.map(section);
  const shown = applySectionFilter(sections, 'zzz', nameMatchesQuery, ATTR);
  expect(shown).toBe(0);
  expect(visibleNames(sections)).toEqual([]);
});

// ---------------------------------------------------------------------------
// DOM wiring via jsdom — the glue itself (#task-search id, the
// [data-task-section] selector, the input listener), so a typo'd id or
// selector cannot leave the suite green. Also proves the negative case from
// AC1/the implementation plan: a #person-search input on the same page does
// not cross-filter with #task-search — each wiring call only touches its own
// input id and its own section attribute.
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

describe('DOM wiring via jsdom: typing in #task-search filters sections (#527 AC1)', () => {
  let dom;
  let restoreGlobals;

  beforeAll(() => {
    dom = new JSDOM(
      `<input type="search" id="person-search" />
       <section class="gallery-group" data-person-section="Priya Patel"></section>
       <input type="search" id="task-search" />
       <section class="gallery-group" data-task-section="Photograph the dessert table"></section>
       <section class="gallery-group" data-task-section="Toast the couple"></section>
       <section class="gallery-group" data-task-section="Memories"></section>`,
      { url: 'http://localhost/' }
    );
    restoreGlobals = installDomGlobals(dom);
    // In the browser /js/filter.js loads first and attaches HuntFilter;
    // replicate that, then run the real wiring against this document.
    //
    // Deliberately wireUpGallerySearch() — the browser's own entry point —
    // and NOT wireUpSectionSearch() with hand-written arguments. The literal
    // ids and attributes only exist in SEARCHABLE_VIEWS; passing them in by
    // hand here would test a path no browser takes, and a typo in that table
    // ('data-task-sction') would kill the live filter on both views with this
    // suite still green. Calling the bootstrap makes the table load-bearing.
    // It also wires both views at once, same as a real page, which is what
    // the no-cross-filter case below relies on.
    dom.window.HuntFilter = { nameMatchesQuery };
    wireUpGallerySearch();
  });

  afterAll(() => {
    restoreGlobals();
  });

  it('input events drive the task filter; clearing restores every section', () => {
    const input = dom.window.document.getElementById('task-search');
    const sections = () => [...dom.window.document.querySelectorAll('[data-task-section]')];
    const visible = () =>
      sections()
        .filter((s) => !s.hidden)
        .map((s) => s.getAttribute('data-task-section'));

    input.value = 'dessert';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(visible()).toEqual(['Photograph the dessert table']);

    input.value = '';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(visible()).toEqual(['Photograph the dessert table', 'Toast the couple', 'Memories']);
  });

  it('typing in #task-search does not hide the #person-search section (no cross-filter)', () => {
    const taskInput = dom.window.document.getElementById('task-search');
    const personSection = dom.window.document.querySelector('[data-person-section]');

    taskInput.value = 'zzz-matches-nothing';
    taskInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    expect(personSection.hidden).toBe(false);
  });
});
