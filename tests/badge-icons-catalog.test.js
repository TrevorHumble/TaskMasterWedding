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
});
