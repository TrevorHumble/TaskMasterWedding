// tests/badge-icons-catalog.test.js
//
// Issue #410 (extended by #870): src/services/badge-icons.js is the SINGLE
// owner of the bundled badge-icon catalog (349 curated Material Symbols SVGs
// under src/public/badges/icons/ — 200 wedding entries plus 149 bachelor-
// party entries added by #870). This file covers:
//
//   AC1 — the catalog is at or above #410's original 200-entry floor (349
//         today), every id resolves to a real
//         bundled file, and no entry points outside src/public/badges/icons/
//         (no path-traversal-shaped id, no external URL).
//   AC5 — one catalog owner: isValidIconId/resolveIconPath reject anything
//         not in the list, so a view or route can never invent its own
//         second list of "real" icons.
//   #870 AC2 — the catalog is exactly 349 entries long, a spot-set of the 149
//         new ids round-trip to their approved names and paths, and no id or
//         case-insensitive name repeats across all 349.
//   #870 AC3 — every one of the 149 new bundled SVGs matches the existing
//         200's form: viewBox="0 -960 960 960", no width/height, fill="#467058".
//
// No app/DB bootstrap needed — this module has no dependency on Express or
// better-sqlite3, so it is required directly (no loadApp()).
'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const badgeIcons = require('../src/services/badge-icons');
const config = require('../config');

describe('badge-icons catalog — issue #410', () => {
  it("AC1: lists at least #410's floor of 200 icons (349 today)", () => {
    const icons = badgeIcons.listIcons();
    expect(Array.isArray(icons)).toBe(true);
    expect(icons.length).toBeGreaterThanOrEqual(200);
  });

  it('#870 AC2: the catalog is exactly 349 entries — 200 wedding + 149 bachelor-party', () => {
    const icons = badgeIcons.listIcons();
    expect(icons.length).toBe(349);
  });

  it('#870 AC2: a spot-set of the 149 new ids round-trip to their approved name and path', () => {
    const spotSet = [
      { id: 'crown', name: 'Crown' },
      { id: 'sick', name: 'Rough Morning' },
      { id: 'grid-4x4', name: 'Hopscotch' },
      { id: 'burst-mode', name: 'Burst' },
      { id: 'help', name: 'Questionable' },
      { id: 'shopping-bag', name: 'Loot' },
      { id: 'group-add', name: 'New Friend' },
      { id: 'bookmark', name: 'Bookmark' },
    ];
    for (const { id, name } of spotSet) {
      expect(badgeIcons.iconName(id)).toBe(name);
      expect(badgeIcons.resolveIconPath(id)).toBe(`/badges/icons/${id}.svg`);
      expect(badgeIcons.isValidIconId(id)).toBe(true);
    }
  });

  it('#870 AC2: no duplicate id and no case-insensitive duplicate name across all 349', () => {
    const icons = badgeIcons.listIcons();
    const ids = icons.map((i) => i.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);

    const lowerNames = icons.map((i) => i.name.toLowerCase());
    const uniqueNames = new Set(lowerNames);
    expect(uniqueNames.size).toBe(lowerNames.length);
  });

  it('#870 AC2: the pre-existing 200 keep their original order ahead of the 149 new entries', () => {
    const icons = badgeIcons.listIcons();
    // The first pre-#870 entry (src/services/badge-icons.js) and the first
    // #870 entry, pinned so a reorder of either block would fail this test.
    expect(icons[0]).toEqual({ id: 'favorite', name: 'Heart' });
    expect(icons[199]).toEqual({ id: 'library-music', name: 'Music Library' });
    expect(icons[200]).toEqual({ id: 'burst-mode', name: 'Burst' });
    expect(icons[348]).toEqual({ id: 'bookmark', name: 'Bookmark' });
  });

  it('#870 AC3: every one of the 149 new SVG files matches the existing 200s form', () => {
    const icons = badgeIcons.listIcons();
    const newIcons = icons.slice(200);
    expect(newIcons.length).toBe(149);
    for (const icon of newIcons) {
      const absPath = path.join(config.PUBLIC_DIR, 'badges', 'icons', `${icon.id}.svg`);
      const svg = fs.readFileSync(absPath, 'utf8');
      expect(svg).toContain('viewBox="0 -960 960 960"');
      expect(svg).toContain('fill="#467058"');
      expect(svg).not.toMatch(/\swidth="/);
      expect(svg).not.toMatch(/\sheight="/);
    }
  });

  it('AC1: every catalog id resolves to a real file under src/public/badges/icons/', () => {
    const icons = badgeIcons.listIcons();
    for (const icon of icons) {
      expect(typeof icon.id).toBe('string');
      expect(icon.id.length).toBeGreaterThan(0);
      expect(typeof icon.name).toBe('string');
      expect(icon.name.length).toBeGreaterThan(0);

      const resolved = badgeIcons.resolveIconPath(icon.id);
      expect(resolved).toBe(`/badges/icons/${icon.id}.svg`);
      // Never points outside the bundled icons dir.
      expect(resolved.startsWith('/badges/icons/')).toBe(true);

      const absPath = path.join(config.PUBLIC_DIR, resolved);
      expect(fs.existsSync(absPath)).toBe(true);
    }
  });

  it('AC1: catalog ids have no path-traversal-shaped or absolute-URL entries', () => {
    const icons = badgeIcons.listIcons();
    for (const icon of icons) {
      expect(icon.id).not.toMatch(/\.\.|\/|\\|:/);
      expect(icon.id.toLowerCase()).not.toMatch(/^https?/);
    }
  });

  it('listIcons returns a fresh array each call (pushing to it cannot corrupt the catalog)', () => {
    const first = badgeIcons.listIcons();
    first.push({ id: 'bogus', name: 'Bogus' });
    const second = badgeIcons.listIcons();
    expect(second.find((i) => i.id === 'bogus')).toBeUndefined();
    expect(second.length).toBe(first.length - 1);
  });

  describe('isValidIconId / resolveIconPath / iconName — AC5 (single validation gate)', () => {
    it('accepts a real catalog id and rejects anything else', () => {
      const [real] = badgeIcons.listIcons();
      expect(badgeIcons.isValidIconId(real.id)).toBe(true);
      expect(badgeIcons.isValidIconId('definitely-not-a-real-icon-id')).toBe(false);
      expect(badgeIcons.isValidIconId('')).toBe(false);
      expect(badgeIcons.isValidIconId(null)).toBe(false);
      expect(badgeIcons.isValidIconId(undefined)).toBe(false);
      expect(badgeIcons.isValidIconId(42)).toBe(false);
      expect(badgeIcons.isValidIconId('../../etc/passwd')).toBe(false);
    });

    it('resolveIconPath returns null for an invalid id instead of building a path', () => {
      expect(badgeIcons.resolveIconPath('not-real')).toBeNull();
      expect(badgeIcons.resolveIconPath('../../etc/passwd')).toBeNull();
    });

    it('iconName returns the catalog display name for a real id, null otherwise', () => {
      const [real] = badgeIcons.listIcons();
      expect(badgeIcons.iconName(real.id)).toBe(real.name);
      expect(badgeIcons.iconName('not-real')).toBeNull();
    });
  });

  // #869 PR review, finding 3/4: iconMaskStyle is the single owner of the
  // --icon-src CSS value badge-art.ejs / badge-picker.ejs emit, and the one
  // place that must defend the value against a hostile art_path — POST
  // /admin/badges accepts an arbitrary art_path with only a non-empty check
  // (no catalog validation), so a crafted path starting with the icon
  // prefix and carrying a CSS-string-terminating quote must not be able to
  // break out of the url('...') the mask rule reads.
  //
  // decodeCssSingleQuotedUrl below re-implements, in miniature, exactly what
  // a CSS parser does when it reads `url('...')`: a backslash escapes the
  // next character literally, and an UN-escaped quote ends the string. Using
  // this (rather than a regex guess at "looks escaped") is what makes the
  // assertions below a real proof: if the whole original path round-trips
  // back out, nothing broke the string early; if escaping ever regressed,
  // the decoded value would silently truncate at the injected quote instead.
  function decodeCssSingleQuotedUrl(cssDeclaration) {
    const prefix = "--icon-src: url('";
    const suffix = "')";
    expect(cssDeclaration.startsWith(prefix)).toBe(true);
    expect(cssDeclaration.endsWith(suffix)).toBe(true);
    const body = cssDeclaration.slice(prefix.length, -suffix.length);
    let decoded = '';
    for (let i = 0; i < body.length; i++) {
      if (body[i] === '\\' && i + 1 < body.length) {
        decoded += body[i + 1];
        i += 1;
      } else if (body[i] === "'") {
        throw new Error('un-escaped quote found before the declared end of the CSS string');
      } else {
        decoded += body[i];
      }
    }
    return decoded;
  }

  // Undoes EJS's default escapeXML (node_modules/ejs/lib/cjs/utils.js) —
  // the exact 5 entities it emits, nothing more. Standing in for what a
  // browser does when it parses an HTML attribute value back into a string,
  // BEFORE the CSS parser ever sees it (the crux of finding 4: HTML-escaping
  // a quote to `&#39;` does not, by itself, stop it decoding back to a
  // literal `'` at the CSS layer).
  function htmlDecodeAttr(value) {
    return value
      .replace(/&#39;/g, "'")
      .replace(/&#34;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  describe('iconMaskStyle — the single --icon-src CSS-value owner (#869)', () => {
    it("wraps an ordinary path in url('...') verbatim", () => {
      expect(badgeIcons.iconMaskStyle('/badges/icons/favorite.svg')).toBe(
        "--icon-src: url('/badges/icons/favorite.svg')"
      );
    });

    it('a quote-bearing path round-trips exactly through the CSS decoder (proves the quote cannot terminate the string early)', () => {
      const hostile = "/badges/icons/favorite.svg' ) ; } .evil { color:red; --x: ( 'x";
      const style = badgeIcons.iconMaskStyle(hostile);
      expect(decodeCssSingleQuotedUrl(style)).toBe(hostile);
    });

    it('a path ending in a literal backslash still round-trips (backslash itself must be escaped, or it would consume the real closing quote)', () => {
      const hostile = "/badges/icons/favorite.svg\\'"; // literal backslash, then quote
      const style = badgeIcons.iconMaskStyle(hostile);
      expect(decodeCssSingleQuotedUrl(style)).toBe(hostile);
    });

    it('a quote-bearing art_path renders through the REAL badge-art.ejs partial with no CSS breakout', () => {
      // Exercises the actual template (not just the encoder in isolation) --
      // the same integration badge-art.ejs's icon branch performs, matching
      // src/services/notifications.js's own direct ejs.compile pattern.
      const templatePath = path.join(config.VIEWS_DIR, 'partials', 'badge-art.ejs');
      const render = ejs.compile(fs.readFileSync(templatePath, 'utf8'), { filename: templatePath });

      const hostileArtPath = "/badges/icons/favorite.svg'; } .evil{color:red} .x{--y:'";
      const html = render({
        badge: { name: 'Golden Moment', art_path: hostileArtPath },
        alt: 'Golden Moment badge',
        badgeIsIcon: badgeIcons.isIconArtPath,
        badgeIconMaskStyle: badgeIcons.iconMaskStyle,
      });

      const styleValueMatch = html.match(/style="([^"]*)"/);
      expect(styleValueMatch).toBeTruthy();
      // EJS's `<%= %>` HTML-escapes the whole style value (a real `'`
      // becomes `&#39;`), same as it would for any other interpolated
      // attribute -- htmlDecodeAttr undoes exactly that, standing in for
      // what a browser does when it parses the attribute back into a
      // string, before the CSS parser ever runs on it.
      const cssDeclaration = htmlDecodeAttr(styleValueMatch[1]);
      expect(decodeCssSingleQuotedUrl(cssDeclaration)).toBe(hostileArtPath);
    });
  });
});
