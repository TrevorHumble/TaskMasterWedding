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

describe('#655: ensureBadgeCatalog upserts a stale catalog row without touching non-catalog rows', () => {
  let db;
  const { ensureBadgeCatalog, BADGES } = require('../scripts/badge-catalog');

  beforeAll(() => {
    ({ db } = loadApp());
  });

  beforeEach(() => {
    // Reset to the canonical catalog before each case: the ten catalog rows
    // exactly as the module seeds them, with no stale edit or extra row
    // carried over from a prior case. So every test below is understandable
    // and passes on its own, in any order.
    db.prepare('DELETE FROM badges').run();
    ensureBadgeCatalog(db);
  });

  it('AC3: a fresh (empty) badges table is inserted exactly as today', () => {
    db.prepare('DELETE FROM badges').run();

    const result = ensureBadgeCatalog(db);

    expect(result).toEqual({ inserted: BADGES.length, updated: 0, unchanged: 0 });
    const rows = db.prepare('SELECT code FROM badges ORDER BY code').all();
    expect(rows.map((r) => r.code).sort()).toEqual([...BADGES.map((b) => b.code)].sort());
    const choice = db.prepare('SELECT name FROM badges WHERE code = ?').get('CHOICE');
    expect(choice.name).toBe("Wedding Master's Choice");
  });

  it('AC1: a stale pre-#354 CHOICE row (old name/description/art) is corrected to the current catalog values on ensure', () => {
    db.prepare(`UPDATE badges SET name = ?, description = ?, art_path = ? WHERE code = ?`).run(
      "Task Master's Choice",
      'This badge is awarded by the Task Master.',
      '/badges/old-choice.svg',
      'CHOICE'
    );

    const result = ensureBadgeCatalog(db);

    // Only CHOICE was mutated, so the tally is exact: nothing new, one row
    // corrected, every other catalog code already matched.
    expect(result).toEqual({ inserted: 0, updated: 1, unchanged: BADGES.length - 1 });
    const row = db
      .prepare('SELECT name, description, art_path FROM badges WHERE code = ?')
      .get('CHOICE');
    const catalogChoice = BADGES.find((b) => b.code === 'CHOICE');
    expect(row).toEqual({
      name: catalogChoice.name,
      description: catalogChoice.description,
      art_path: catalogChoice.art_path,
    });
  });

  it('AC2: a non-catalog custom badge row is byte-identical after ensure, and never counted in the tally', () => {
    // Mirrors a real task badge's shape (src/services/task-badges.js): code
    // 'TASK-<id>', type 'custom' — a code absent from BADGES above.
    db.prepare(
      `INSERT INTO badges (code, name, type, threshold, art_path, description)
       VALUES ('TASK-9001', 'Admin Custom Name', 'custom', NULL, '/badges/custom.svg', 'Admin custom description')`
    ).run();
    const before = db.prepare('SELECT * FROM badges WHERE code = ?').get('TASK-9001');

    const result = ensureBadgeCatalog(db);

    const after = db.prepare('SELECT * FROM badges WHERE code = ?').get('TASK-9001');
    expect(after).toEqual(before);
    // The catalog rows are already canonical (beforeEach), so this run
    // touches nothing new and updates nothing — the tally covers exactly
    // the catalog codes, never the extra TASK-9001 row.
    expect(result).toEqual({ inserted: 0, updated: 0, unchanged: BADGES.length });
  });
});
