// tests/badge-icons-catalog.test.js
//
// Issue #410: src/services/badge-icons.js is the SINGLE owner of the bundled
// badge-icon catalog (≥200 curated Material Symbols SVGs under
// src/public/badges/icons/). This file covers:
//
//   AC1 — the catalog has at least 200 entries, every id resolves to a real
//         bundled file, and no entry points outside src/public/badges/icons/
//         (no path-traversal-shaped id, no external URL).
//   AC5 — one catalog owner: isValidIconId/resolveIconPath reject anything
//         not in the list, so a view or route can never invent its own
//         second list of "real" icons.
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
  it('AC1: lists at least 200 icons', () => {
    const icons = badgeIcons.listIcons();
    expect(Array.isArray(icons)).toBe(true);
    expect(icons.length).toBeGreaterThanOrEqual(200);
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
