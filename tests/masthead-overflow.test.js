// tests/masthead-overflow.test.js
// Covers issue #388: the guest masthead nav overflowed the page horizontally
// at iPhone-SE-class widths (375px and below) because .site-nav-row laid its
// two links out with no wrap (.nav-link { white-space: nowrap }) and no
// flex-wrap, so an unwrappable row wider than the ~327px content area at
// 375px forced the whole page to scroll sideways and clip the form below it.
//
// jsdom (this repo's only DOM test dependency) does not implement CSS layout
// — scrollWidth/clientWidth are always 0 there, so a real "no horizontal
// overflow at 375px" assertion cannot run in this suite. Instead this test
// asserts on the parsed CSS source directly, the same pattern the AC6 block
// in tests/masthead-menu.test.js already uses for .site-header. The real
// behavioral proof (AC1/AC2/AC4 — actual rendered screenshots at 375px and
// 320px) happens in the visual-approval loop, not here.
'use strict';

const fs = require('fs');
const path = require('path');

const THEME_PATH = path.join(__dirname, '../src/public/css/theme.css');

// Pull a top-level CSS rule block out of the stylesheet source by selector
// text, the same helper approach AC6 in masthead-menu.test.js uses inline.
function ruleBlock(source, selector) {
  const start = source.indexOf(selector + ' {');
  if (start === -1) return null;
  const end = source.indexOf('}', start);
  return source.slice(start, end + 1);
}

describe('AC388(1,2): .site-nav-row wraps instead of forcing horizontal overflow', () => {
  test('.site-nav-row sets flex-wrap: wrap', () => {
    const themeSrc = fs.readFileSync(THEME_PATH, 'utf8');
    const block = ruleBlock(themeSrc, '.site-nav-row');
    expect(block).not.toBeNull();
    expect(block).toMatch(/flex-wrap:\s*wrap/);
  });

  test('the guest nav overrides .nav-link white-space: nowrap so a single label can wrap too', () => {
    const themeSrc = fs.readFileSync(THEME_PATH, 'utf8');

    // The shared base rule keeps its original nowrap (admin masthead relies
    // on this — see AC388(3) below), so this must be a MORE specific
    // guest-scoped selector, not an edit to the shared .nav-link rule.
    const guestBlock = ruleBlock(themeSrc, '.site-nav-guest .nav-link');
    expect(guestBlock).not.toBeNull();
    expect(guestBlock).toMatch(/white-space:\s*normal/);
  });
});

describe('AC388(3): no regression to the #252-approved 430px layout', () => {
  test('.page max-width is unchanged at 430px (var(--app-max-width))', () => {
    const themeSrc = fs.readFileSync(THEME_PATH, 'utf8');
    const block = ruleBlock(themeSrc, '.page');
    expect(block).not.toBeNull();
    expect(block).toMatch(/max-width:\s*var\(--app-max-width\)/);

    const rootBlock = ruleBlock(themeSrc, ':root');
    expect(rootBlock).toMatch(/--app-max-width:\s*430px/);
  });

  test('.site-header-inner max-width is unchanged at 430px (var(--app-max-width))', () => {
    const themeSrc = fs.readFileSync(THEME_PATH, 'utf8');
    const block = ruleBlock(themeSrc, '.site-header-inner');
    expect(block).not.toBeNull();
    expect(block).toMatch(/max-width:\s*var\(--app-max-width\)/);
  });

  test('.site-nav-row itself is not narrowed (no width/max-width clamp added alongside the wrap rule)', () => {
    // AC3 requires the wrap rule not force an earlier wrap than the row's
    // natural width at 430px. flex-wrap only engages when content already
    // overflows the container, so it cannot itself narrow the row — but a
    // stray width/max-width on the same rule would. Guard against that.
    const themeSrc = fs.readFileSync(THEME_PATH, 'utf8');
    const block = ruleBlock(themeSrc, '.site-nav-row');
    expect(block).not.toMatch(/\bwidth:/);
    expect(block).not.toMatch(/max-width:/);
  });

  test('the shared .nav-link rule (admin masthead) still sets white-space: nowrap unmodified', () => {
    // The admin nav (.site-nav, no -guest class) must keep its original
    // single-line treatment — only the guest-scoped selector above changes.
    const themeSrc = fs.readFileSync(THEME_PATH, 'utf8');
    const block = ruleBlock(themeSrc, '.nav-link');
    expect(block).not.toBeNull();
    expect(block).toMatch(/white-space:\s*nowrap/);
  });
});
