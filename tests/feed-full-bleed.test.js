// tests/feed-full-bleed.test.js
// Covers issue #612 (full-bleed feed photos) acceptance criteria against the
// already-authored, owner-approved CSS in src/public/css/theme.css. This is a
// tests-only phase-2 issue — theme.css is frozen; do not edit it here. Pattern
// (parse theme.css text, extract balanced rule blocks) mirrors
// tests/feed-card.test.js's AC4/AC6/AC9 blocks.
//
//   AC1 — the desktop `.feed-item { max-width: 560px; margin-inline: auto }`
//         cap under `@media (min-width: 700px)` is GONE (it suppressed
//         flex stretch on narrow photos).
//   AC2/AC6 — `.feed` carries `margin-inline: calc(-1 * var(--gutter))`
//         (full-bleed via the container, not the photo, so paint containment
//         on `.feed-item` never clips it); the text rows
//         (.feed-by/.feed-caption/.feed-actionbar/.feed-comments/
//         .feed-task-line/.admin-feed-downline) are re-indented with
//         `padding-inline: var(--gutter)`.
//   AC3 — `.feed-photo` carries no border-radius and no border.
//   AC4 — `.feed-photo` keeps `width: 100%` and `height: auto`, and has no
//         `object-fit: cover` (whole image shown, never cropped).
//   AC5 — guest/admin parity: admin-photos.ejs renders its inline feed cards
//         with `class="feed-item admin-feed-item ..."` and an `<img
//         class="feed-photo" ...>`, so the shared .feed-item/.feed-photo CSS
//         rules apply to both surfaces.
'use strict';

const fs = require('fs');
const path = require('path');

const THEME_CSS_PATH = path.join(__dirname, '..', 'src', 'public', 'css', 'theme.css');
const ADMIN_PHOTOS_EJS_PATH = path.join(__dirname, '..', 'src', 'views', 'admin-photos.ejs');
const THEME_CSS_SOURCE = fs.readFileSync(THEME_CSS_PATH, 'utf8');
const ADMIN_PHOTOS_EJS_SOURCE = fs.readFileSync(ADMIN_PHOTOS_EJS_PATH, 'utf8');

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

// ---------------------------------------------------------------------------
// AC1 — the desktop cap rule that suppressed flex stretch is gone.
// ---------------------------------------------------------------------------
describe('AC1: the desktop .feed-item width-cap/margin-inline:auto rule is removed', () => {
  it('no @media (min-width: 700px) block sets .feed-item max-width/margin-inline: auto', () => {
    // The specific inert-but-harmful combination this issue removed: a
    // desktop media query whose .feed-item rule pairs max-width with
    // margin-inline: auto (auto cross-axis margins suppress align-items:
    // stretch on the .feed flex column, floating narrow photos with white
    // space). Assert no such block exists anywhere in the stylesheet,
    // regardless of exact breakpoint or property order.
    const mediaBlocks = allIndicesOf(THEME_CSS_SOURCE, '@media (min-width:').map((idx) => {
      const braceStart = THEME_CSS_SOURCE.indexOf('{', idx);
      return extractBalancedBlock(THEME_CSS_SOURCE, braceStart);
    });
    const offender = mediaBlocks.find((block) => {
      if (!/\.feed-item\s*\{/.test(block)) return false;
      const innerIdx = block.search(/\.feed-item\s*\{/);
      const innerRule = extractBalancedBlock(block, innerIdx);
      return innerRule.includes('max-width') && innerRule.includes('margin-inline: auto');
    });
    expect(offender).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC3 — no border, no rounded corners on .feed-photo.
// ---------------------------------------------------------------------------
describe('AC3: .feed-photo carries no border and no border-radius', () => {
  it('the .feed-photo rule block contains neither border-radius nor border', () => {
    const idx = THEME_CSS_SOURCE.indexOf('.feed-photo {');
    expect(idx).toBeGreaterThan(-1);
    const rule = extractBalancedBlock(THEME_CSS_SOURCE, idx);
    expect(rule).not.toMatch(/border-radius/);
    expect(rule).not.toMatch(/\bborder\s*:/);
  });
});

// ---------------------------------------------------------------------------
// AC2/AC6 — full-bleed achieved at the container level (.feed breaks out of
// the .page gutter; text rows are re-indented), not by the photo overflowing
// its own (paint-contained) .feed-item card.
// ---------------------------------------------------------------------------
describe('AC2/AC6: full-bleed via the .feed container, text rows re-indented', () => {
  it('.feed carries margin-inline: calc(-1 * var(--gutter))', () => {
    const idx = THEME_CSS_SOURCE.indexOf('.feed {');
    expect(idx).toBeGreaterThan(-1);
    const rule = extractBalancedBlock(THEME_CSS_SOURCE, idx);
    expect(rule).toContain('margin-inline: calc(-1 * var(--gutter))');
  });

  it('the text-row selector group is re-indented with padding-inline: var(--gutter)', () => {
    // Match the selector group as a whole (order-independent within the
    // group), then confirm the declaration.
    const selectors = [
      '.feed-by',
      '.feed-caption',
      '.feed-actionbar',
      '.feed-comments',
      '.feed-task-line',
      '.admin-feed-downline',
    ];
    const idx = THEME_CSS_SOURCE.indexOf(selectors[0] + ',');
    expect(idx).toBeGreaterThan(-1);
    // Grab from the first selector to the opening brace to check every
    // selector in the group is present, then the rule body for the padding.
    const braceStart = THEME_CSS_SOURCE.indexOf('{', idx);
    const selectorGroup = THEME_CSS_SOURCE.slice(idx, braceStart);
    selectors.forEach((sel) => {
      expect(selectorGroup).toContain(sel);
    });
    const rule = extractBalancedBlock(THEME_CSS_SOURCE, braceStart - 1);
    expect(rule).toContain('padding-inline: var(--gutter)');
  });

  it('.feed-photo itself carries no negative margin or overflow trick (bleed is container-level only)', () => {
    const idx = THEME_CSS_SOURCE.indexOf('.feed-photo {');
    const rule = extractBalancedBlock(THEME_CSS_SOURCE, idx);
    expect(rule).not.toMatch(/margin.*calc\(-1/);
    expect(rule).not.toContain('overflow');
  });
});

// ---------------------------------------------------------------------------
// AC4 — big photos are never cropped: width:100%/height:auto preserved, no
// object-fit: cover.
// ---------------------------------------------------------------------------
describe('AC4: .feed-photo preserves aspect ratio; never crops', () => {
  it('the .feed-photo rule keeps width: 100% and height: auto, with no object-fit: cover', () => {
    const idx = THEME_CSS_SOURCE.indexOf('.feed-photo {');
    const rule = extractBalancedBlock(THEME_CSS_SOURCE, idx);
    expect(rule).toContain('width: 100%');
    expect(rule).toContain('height: auto');
    expect(rule).not.toMatch(/object-fit:\s*cover/);
  });
});

// ---------------------------------------------------------------------------
// AC5 — guest <-> admin parity: the admin inline feed reuses the same
// .feed-item / .feed-photo classes the shared CSS rules above target.
// ---------------------------------------------------------------------------
describe('AC5: admin feed reuses .feed-item / .feed-photo for parity with the guest feed', () => {
  it('admin-photos.ejs renders each card as an <article class="feed-item admin-feed-item ...">', () => {
    // Not a single regex across the tag: the id attribute's EJS interpolation
    // (`<%= p.id %>`) contains a literal `>` inside `%>`, which would
    // terminate a `[^>]*` match before reaching `class=`. Instead, find the
    // class attribute, then confirm the nearest preceding `<article` is on
    // the same line (i.e. it is that tag's own class attribute).
    const classIdx = ADMIN_PHOTOS_EJS_SOURCE.indexOf('class="feed-item admin-feed-item');
    expect(classIdx).toBeGreaterThan(-1);
    const articleIdx = ADMIN_PHOTOS_EJS_SOURCE.lastIndexOf('<article', classIdx);
    expect(articleIdx).toBeGreaterThan(-1);
    expect(ADMIN_PHOTOS_EJS_SOURCE.slice(articleIdx, classIdx)).not.toContain('\n');
  });

  it('admin-photos.ejs renders the photo as an <img class="feed-photo" ...>', () => {
    expect(ADMIN_PHOTOS_EJS_SOURCE).toMatch(/<img\s+class="feed-photo"/);
  });
});
