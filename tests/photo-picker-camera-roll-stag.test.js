// tests/photo-picker-camera-roll-stag.test.js
// Issue #880 AC5 — the bachelor (stag) instance is fixed by the same
// task.ejs/upload-field.ejs change, because both deployments render the one
// src/views/task.ejs from the single VIEWS_DIR (config.js). This is split
// into its own file rather than living in tests/photo-picker-camera-roll.test.js
// because that file boots the wedding app; a second boot in the same file
// would leave every route/middleware module (src/middleware/session.js
// destructures `db` at module load) holding the FIRST boot's db, so a
// signed-in page renders with req.guest null — the same reason
// tests/variant-wedding-default.test.js was split out of
// tests/variant-flag.test.js (see that file's own header comment).
//
// REQUIRE ORDER: process.env.VARIANT is set at module scope, BEFORE
// requiring anything that pulls in config.js — config reads it once at first
// require (tests/helpers/testApp.js's own "REQUIRE ORDER MATTERS" note).
// loadApp() is called exactly ONCE (the single-boot pattern proven at
// tests/variant-stag.test.js:21-34): vitest gives every test file its own
// isolated module registry, so no require.cache eviction is needed and none
// is written here.
//
// Three shapes are deliberately NOT used here because each goes green while
// proving nothing (see the issue's plan step 3b):
//   - passing variant/isStag locals into the partial or task.ejs — neither
//     reads them, so that would only prove the accept value round-trips;
//   - vi.resetModules() + a plain loadApp() — does not evict require.cache
//     for a plain CommonJS require(), so it silently re-serves the wedding
//     app (measured: tests/variant-flag.test.js, tests/config-branches.test.js,
//     tests/hosting-lifecycle.test.js);
//   - a second bootApp('stag')-style boot inside the wedding test file.
'use strict';

process.env.VARIANT = 'stag';

const crypto = require('crypto');
const { loadApp, signInGuest } = require('./helpers/testApp');

let app;
let db;
let config;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
  // Required only now, after loadApp() has set DATA_DIR/DB_PATH/VARIANT and
  // required config.js once (module cache), so it binds to this file's
  // VARIANT — same ordering tests/variant-stag.test.js uses.
  config = require('../config');
});

afterAll(() => {
  // Defensive: restore the ambient env for any later test file sharing this
  // worker (mirrors tests/variant-stag.test.js's own cleanup discipline).
  delete process.env.VARIANT;
});

function insertGuestAndTask(taskTitle) {
  const token = `camera-roll-stag-${crypto.randomUUID()}`;
  db.prepare('INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)').run(
    token,
    'Stag Camera Roll Guest'
  );
  const taskId = db.prepare('INSERT INTO tasks (title) VALUES (?)').run(taskTitle).lastInsertRowid;
  return { taskId, token };
}

function extractInput(html, id) {
  const re = new RegExp(`<input[^>]*id="${id}"[^>]*/>`, 's');
  const match = html.match(re);
  return match ? match[0] : null;
}

describe('AC5: the bachelor (stag) instance is fixed by the same change', () => {
  it('this file really booted the bachelor instance, not a second wedding one', () => {
    expect(config.VARIANT).toBe('stag');
  });

  it('GET /tasks/:id for a signed-in stag guest renders #photo with no capture attribute', async () => {
    const { taskId, token } = insertGuestAndTask('Stag AC5 camera-roll task');
    const agent = signInGuest(app, token);

    const res = await agent.get(`/tasks/${taskId}`);
    expect(res.status).toBe(200);

    // The 200 above is what proves the guest session is live (an unsigned-in
    // guest would 302 to /join). This asserts the separate fact that the
    // page being examined was rendered by the STAG instance — so the file
    // cannot quietly degrade into a second wedding test if the boot ordering
    // above is ever broken.
    expect(res.text).toContain('data-theme="stag"');

    const inputTag = extractInput(res.text, 'photo');
    expect(inputTag).not.toBeNull();
    expect(inputTag).not.toMatch(/\bcapture\s*=/);
    expect(inputTag).toContain('accept="image/*"');
  });
});
