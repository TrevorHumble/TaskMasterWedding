// tests/variant-flag.test.js
// Issue #640 — the bachelor-party "Stag Master" instance, the VARIANT flag
// itself. Covers:
//   AC1 — VARIANT unset (or any value other than the literal 'stag') renders
//         byte-identical to today: no data-theme attribute, wedding
//         branding, the wedding badge catalog (GARDEN included).
//   AC6 — two instances, each started with its own DATA_DIR/DB_PATH/PORT,
//         never share a database row or an uploaded file.
//
// CACHE EVICTION: unlike most files in this suite (which boot exactly one
// app instance and rely on vitest's per-file module isolation — see
// tests/helpers/testApp.js's own "REQUIRE ORDER MATTERS" comment), this file
// boots MULTIPLE app instances with different VARIANT values in one run, so
// config.js/src/app.js/src/db.js must be evicted from require.cache and
// re-required each time to force a real re-execution against the freshly
// set env vars — same technique as tests/hosting-lifecycle.test.js's
// reloadAppWithFreshConfig and tests/config-branches.test.js's reloadConfig,
// which document why vi.resetModules() alone does not do this for a plain
// CommonJS require().
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

const CONFIG_PATH = require.resolve('../config');
const APP_PATH = require.resolve('../src/app');
const DB_MODULE_PATH = require.resolve('../src/db');

/**
 * Boot a fresh app instance against a brand-new temp DATA_DIR, with VARIANT
 * set to `variant` (falsy -> deleted, matching config.js's own "unset ->
 * default ''" contract).
 *
 * @param {string} [variant]
 * @returns {{ app: import('express').Application, db: import('better-sqlite3').Database, config: object }}
 */
function bootApp(variant) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-test-'));
  process.env.DATA_DIR = dir;
  process.env.DB_PATH = path.join(dir, 'test.db');
  if (variant) {
    process.env.VARIANT = variant;
  } else {
    delete process.env.VARIANT;
  }
  delete require.cache[CONFIG_PATH];
  delete require.cache[APP_PATH];
  delete require.cache[DB_MODULE_PATH];
  const app = require('../src/app');
  const { db } = require('../src/db');
  const config = require('../config');
  return { app, db, config };
}

afterAll(() => {
  // Leave the env and require.cache clean for the next test file that
  // happens to share this worker (same discipline as
  // tests/config-branches.test.js's own afterEach).
  delete process.env.VARIANT;
  delete require.cache[CONFIG_PATH];
  delete require.cache[APP_PATH];
  delete require.cache[DB_MODULE_PATH];
});

describe('#640 AC1: VARIANT unset or non-"stag" renders byte-identical wedding output', () => {
  it('unset resolves config.VARIANT to the empty-string default', () => {
    const { config } = bootApp(undefined);
    expect(config.VARIANT).toBe('');
  });

  it('a non-stag string is read verbatim but never equals the literal "stag" — every call site tests exact equality, never truthiness, so this still behaves as wedding', () => {
    const { config } = bootApp('wedding-two');
    expect(config.VARIANT).toBe('wedding-two');
    expect(config.VARIANT).not.toBe('stag');
  });

  it.each([
    ['unset', undefined],
    ['a non-stag string ("wedding-two")', 'wedding-two'],
  ])(
    '%s: GET /admin/login carries no data-theme attribute and the wedding wordmark',
    async (_label, variant) => {
      const { app } = bootApp(variant);
      const res = await request(app).get('/admin/login');
      expect(res.status).toBe(200);
      expect(res.text).toContain('<html lang="en">');
      expect(res.text).not.toContain('data-theme');
      expect(res.text).toContain('Wedding Master Login');
      expect(res.text).not.toContain('Stag Master');
    }
  );

  it('unset: the boot-time badge catalog is the wedding one, GARDEN included, no stag art anywhere', () => {
    const { db } = bootApp(undefined);
    const rows = db.prepare('SELECT code, name, art_path FROM badges ORDER BY code').all();
    const garden = rows.find((r) => r.code === 'GARDEN');
    expect(garden).toBeTruthy();
    expect(garden.name).toBe('Full Garden');
    expect(garden.art_path).toBe('/badges/garden.svg');
    for (const row of rows) {
      expect(row.art_path).not.toContain('/badges/stag/');
    }
  });

  // NOTE: a guest-authenticated page (the 404 page included, since a
  // signed-out visitor never reaches it — src/routes/guest.js's
  // router.use(requireGuest) redirects first) is deliberately NOT exercised
  // in this file: bootApp() above evicts only config.js/src/app.js/src/db.js
  // between calls, and every route/middleware module those pull in
  // (src/middleware/session.js, src/routes/*) stays cached from this FILE's
  // FIRST boot, holding a STALE db/config reference from that first temp
  // DATA_DIR — so a second-or-later bootApp() call's guest lookups silently
  // miss (verified empirically: attachGuest queries the FIRST call's db, not
  // the current one, and req.guest ends up null). tests/variant-wedding-default.test.js
  // covers the same AC1 guarantee for guest-authenticated pages (including
  // 404) with a single, un-evicted boot instead — the pattern every other
  // file in this suite already relies on.
});

describe('#640 AC6: two instances, each its own DATA_DIR, never share a row or a file', () => {
  it('a guest and an uploaded photo written to a stag instance leave zero trace in a separately-booted wedding instance', () => {
    const wedding = bootApp(undefined);
    const stag = bootApp('stag');

    // The two instances resolved to genuinely different data directories —
    // this is what makes the isolation below meaningful rather than
    // incidental.
    expect(wedding.config.DATA_DIR).not.toBe(stag.config.DATA_DIR);
    expect(wedding.config.UPLOADS_DIR).not.toBe(stag.config.UPLOADS_DIR);

    // Write a guest + a submission into the STAG instance only.
    const stagGuestId = stag.db
      .prepare('INSERT INTO guests (token, name) VALUES (?, ?)')
      .run('stag-isolation-guest', 'Stag Isolation Guest').lastInsertRowid;
    const stagTaskId = stag.db
      .prepare(`INSERT INTO tasks (title) VALUES (?)`)
      .run('Stag isolation task').lastInsertRowid;
    stag.db
      .prepare(
        `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
         VALUES (?, ?, ?, ?, 0)`
      )
      .run(stagGuestId, stagTaskId, 'stag-isolation.jpg', 'stag-isolation-thumb.jpg');
    // Write the actual "uploaded" file into the stag instance's own
    // UPLOADS_DIR — AC6 names files, not just rows.
    fs.mkdirSync(stag.config.UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(path.join(stag.config.UPLOADS_DIR, 'stag-isolation.jpg'), 'fake-photo-bytes');

    // The WEDDING instance's database has none of it.
    const weddingGuestRow = wedding.db
      .prepare('SELECT * FROM guests WHERE token = ?')
      .get('stag-isolation-guest');
    expect(weddingGuestRow).toBeUndefined();
    const weddingSubmissionCount = wedding.db
      .prepare('SELECT COUNT(*) AS n FROM submissions')
      .get().n;
    expect(weddingSubmissionCount).toBe(0);

    // The WEDDING instance's uploads directory does not contain the file.
    fs.mkdirSync(wedding.config.UPLOADS_DIR, { recursive: true });
    expect(fs.existsSync(path.join(wedding.config.UPLOADS_DIR, 'stag-isolation.jpg'))).toBe(false);
  });
});
