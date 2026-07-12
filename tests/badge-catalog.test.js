// tests/badge-catalog.test.js
// Issue #193: art exists for every seeded badge (AC1), every badge SVG uses
// only the design-system palette (AC2), and both seed scripts share one
// catalog module (AC4). AC1 iterates the seeded DB rows and AC2 iterates the
// badge directory, so a future badge with missing art or off-palette color
// fails CI without this file changing.
'use strict';

const fs = require('fs');
const path = require('path');

const { loadApp } = require('./helpers/testApp');

const BADGE_SRC_DIR = path.join(__dirname, '..', 'src', 'public', 'badges');
const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');

// The six design-system hexes (docs/design-system/DESIGN_SYSTEM.md § 2).
// Only #ffffff has a 3-digit equivalent; the other five do not collapse.
const ALLOWED_PAINTS = new Set([
  '#467058',
  '#2a4335',
  '#6e8478',
  '#aebbb2',
  '#f0f4f2',
  '#ffffff',
  '#fff',
  'none',
  'currentcolor',
]);

describe('#193 AC1: art exists for every seeded badge', () => {
  let db;

  beforeAll(() => {
    ({ db } = loadApp());
    // Seed the real catalog via the actual seed script (it binds to the temp
    // DATA_DIR loadApp just created).
    require('../scripts/seed.js');
  });

  it('every badges.art_path seeded by scripts/seed.js resolves to a real file under src/public', () => {
    const rows = db.prepare('SELECT code, art_path FROM badges ORDER BY code').all();
    expect(rows.length).toBeGreaterThanOrEqual(9);
    for (const row of rows) {
      const resolved = path.join(__dirname, '..', 'src', 'public', row.art_path);
      expect(fs.existsSync(resolved), `${row.code}: art file missing for ${row.art_path}`).toBe(
        true
      );
    }
  });
});

describe('#193 AC2: every badge SVG uses only the design-system palette', () => {
  const svgFiles = fs.readdirSync(BADGE_SRC_DIR).filter((f) => f.endsWith('.svg'));

  it('the badge directory holds at least the nine catalog SVGs', () => {
    expect(svgFiles.length).toBeGreaterThanOrEqual(9);
  });

  for (const file of svgFiles) {
    it(`${file} carries no off-palette paint and no disallowed paint syntax`, () => {
      const svg = fs.readFileSync(path.join(BADGE_SRC_DIR, file), 'utf8');

      // Disallowed outright: style attributes / <style> elements (colors
      // hidden from the attribute scan), gradients and patterns (even with
      // on-palette stops), url() paint-server references, rgb()/hsl().
      expect(svg).not.toMatch(/<style\b/i);
      expect(svg).not.toMatch(/\bstyle\s*=/i);
      expect(svg).not.toMatch(/<(linearGradient|radialGradient|pattern)\b/i);
      expect(svg).not.toMatch(/url\s*\(/i);
      expect(svg).not.toMatch(/\b(rgb|hsl)a?\s*\(/i);
      // SMIL could animate a paint to an off-palette value without any of
      // the syntaxes above (<animate attributeName="fill" to="red"/>).
      expect(svg).not.toMatch(/<(animate|set)\b/i);

      // Every explicit paint value must be an allowed hex, none, or
      // currentColor. Named colors (e.g. fill="pink") fail here because they
      // are not in the allowed set. Match both quote styles — single-quoted
      // attributes are valid XML and nothing else normalizes them.
      const paintAttr = /(?:fill|stroke|stop-color|color)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
      const paints = [];
      let match;
      while ((match = paintAttr.exec(svg)) !== null) {
        paints.push((match[1] ?? match[2]).trim().toLowerCase());
      }
      expect(paints.length).toBeGreaterThan(0);
      for (const paint of paints) {
        expect(ALLOWED_PAINTS.has(paint), `${file}: off-palette paint "${paint}"`).toBe(true);
      }
    });
  }
});

describe('#193 AC4: one catalog, not two', () => {
  const readScript = (name) => fs.readFileSync(path.join(SCRIPTS_DIR, name), 'utf8');

  it('both seed scripts require the shared badge-catalog module', () => {
    expect(readScript('seed.js')).toMatch(/require\(['"]\.\/badge-catalog['"]\)/);
    expect(readScript('seed-event.js')).toMatch(/require\(['"]\.\/badge-catalog['"]\)/);
  });

  it('neither seed script carries its own hand-copied BADGES literal', () => {
    expect(readScript('seed.js')).not.toMatch(/const BADGES\s*=\s*\[/);
    expect(readScript('seed-event.js')).not.toMatch(/const BADGES\s*=\s*\[/);
  });

  it('the shared catalog holds all ten badge codes', () => {
    const { BADGES } = require('../scripts/badge-catalog');
    expect(BADGES.map((b) => b.code)).toEqual([
      'BLOOM',
      'BOUQUET',
      'GARDEN',
      'EARLYBIRD',
      'SHUTTERBUG',
      'CROWDFAV',
      'CHOICE',
      'COMPLETIONIST',
      'MOSTPHOTOS',
      'MOSTLIKED',
    ]);
  });
});
