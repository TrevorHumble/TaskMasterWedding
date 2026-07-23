// tests/admin-badges.test.js
// Issue #181: badge-admin routes need tests that assert the resulting
// guest_badges/badges rows, not just that a handler ran. Covers award/remove/
// toggle of a special badge, the issue #80 AC5 refusal of metric/transferable
// codes, custom-badge creation, the duplicate-code guard, and validation.
//
// REQUIRE ORDER: loadApp() must run before any require that pulls in config
// or db (see tests/helpers/testApp.js).
'use strict';

const { loadApp, makeAdminAgent } = require('./helpers/testApp');

let app;
let db;
let adminAgent;
let guestId;

beforeAll(async () => {
  const result = loadApp();
  app = result.app;
  db = result.db;
  adminAgent = await makeAdminAgent(app);

  guestId = db
    .prepare('INSERT INTO guests (token, name) VALUES (?, ?)')
    .run('badgetoken000000000000000000000', 'Badge Guest').lastInsertRowid;

  // EARLYBIRD (special) and COMPLETIONIST (metric) both already exist here
  // (#314): src/db.js's boot-heal runs ensureBadgeCatalog() at module load,
  // so loadApp() above already seeded the full canonical catalog. (CHOICE
  // was also a 'special' catalog code here once, but issue #661 retired it —
  // along with SHUTTERBUG/CROWDFAV, which collided in NAME ONLY with the
  // now-deleted give-a-badge photo-winner picker's own codes — so this file
  // exercises EARLYBIRD instead; the award/remove/toggle route under test is
  // unaffected either way.)
});

function heldCount(badgeCode) {
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM guest_badges gb
         JOIN badges b ON b.id = gb.badge_id
        WHERE gb.guest_id = ? AND b.code = ?`
    )
    .get(guestId, badgeCode).n;
}

describe('POST /admin/guests/:id/badge — special badge award/remove', () => {
  it('awards EARLYBIRD, then removes it', async () => {
    expect(heldCount('EARLYBIRD')).toBe(0);

    let res = await adminAgent
      .post(`/admin/guests/${guestId}/badge`)
      .type('form')
      .send({ code: 'EARLYBIRD', action: 'award' });
    expect(heldCount('EARLYBIRD')).toBe(1);
    expect(res.headers.location).toContain(encodeURIComponent('Awarded badge'));

    res = await adminAgent
      .post(`/admin/guests/${guestId}/badge`)
      .type('form')
      .send({ code: 'EARLYBIRD', action: 'remove' });
    expect(heldCount('EARLYBIRD')).toBe(0);
    expect(res.headers.location).toContain(encodeURIComponent('Removed badge'));
  });

  it('action=toggle resolves against current held state, twice', async () => {
    expect(heldCount('EARLYBIRD')).toBe(0);

    await adminAgent
      .post(`/admin/guests/${guestId}/badge`)
      .type('form')
      .send({ code: 'EARLYBIRD', action: 'toggle' });
    expect(heldCount('EARLYBIRD')).toBe(1);

    await adminAgent
      .post(`/admin/guests/${guestId}/badge`)
      .type('form')
      .send({ code: 'EARLYBIRD', action: 'toggle' });
    expect(heldCount('EARLYBIRD')).toBe(0);
  });

  it('an unknown code is refused with "Unknown special or custom badge." and creates no row', async () => {
    const res = await adminAgent
      .post(`/admin/guests/${guestId}/badge`)
      .type('form')
      .send({ code: 'NOPE', action: 'award' });
    expect(res.headers.location).toContain(encodeURIComponent('Unknown special or custom badge.'));
  });

  it('#80 AC5: a metric-type code is refused — no guest_badges row created or deleted', async () => {
    // Pre-seed a system-awarded row so a wrongful "remove" would be observable too.
    const badge = db.prepare("SELECT id FROM badges WHERE code = 'COMPLETIONIST'").get();
    db.prepare(
      "INSERT INTO guest_badges (guest_id, badge_id, awarded_by) VALUES (?, ?, 'system')"
    ).run(guestId, badge.id);
    expect(heldCount('COMPLETIONIST')).toBe(1);

    const resAward = await adminAgent
      .post(`/admin/guests/${guestId}/badge`)
      .type('form')
      .send({ code: 'COMPLETIONIST', action: 'award' });
    expect(heldCount('COMPLETIONIST')).toBe(1); // unchanged — still exactly the system row
    expect(resAward.headers.location).toContain(
      encodeURIComponent('Unknown special or custom badge.')
    );

    const resRemove = await adminAgent
      .post(`/admin/guests/${guestId}/badge`)
      .type('form')
      .send({ code: 'COMPLETIONIST', action: 'remove' });
    expect(heldCount('COMPLETIONIST')).toBe(1); // still not removed by the admin route
    expect(resRemove.headers.location).toContain(
      encodeURIComponent('Unknown special or custom badge.')
    );
  });
});

describe('POST /admin/badges — create custom badge', () => {
  it('creates a custom badge with a derived code', async () => {
    const res = await adminAgent
      .post('/admin/badges')
      .type('form')
      .send({ name: 'Best Dancer', art_path: '🕺' });

    expect(res.headers.location).toContain(encodeURIComponent('Created custom badge'));
    const row = db.prepare("SELECT * FROM badges WHERE code = 'BESTDANCER'").get();
    expect(row).toBeTruthy();
    expect(row.type).toBe('custom');
  });

  it('a duplicate code is refused, exactly one row remains', async () => {
    const before = db.prepare("SELECT COUNT(*) AS n FROM badges WHERE code = 'BESTDANCER'").get().n;
    const res = await adminAgent
      .post('/admin/badges')
      .type('form')
      .send({ name: 'Best Dancer', art_path: '🕺' });

    expect(res.headers.location).toContain(encodeURIComponent('already exists'));
    expect(db.prepare("SELECT COUNT(*) AS n FROM badges WHERE code = 'BESTDANCER'").get().n).toBe(
      before
    );
  });

  it('validation: missing name, missing art, and unusable-characters name all refuse with zero rows', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM badges').get().n;

    let res = await adminAgent.post('/admin/badges').type('form').send({ art_path: '🎉' });
    expect(res.headers.location).toContain(encodeURIComponent('needs a name'));

    res = await adminAgent.post('/admin/badges').type('form').send({ name: 'No Art' });
    expect(res.headers.location).toContain(encodeURIComponent('needs art'));

    res = await adminAgent.post('/admin/badges').type('form').send({ name: '###', art_path: '🎉' });
    expect(res.headers.location).toContain(encodeURIComponent('no usable characters'));

    expect(db.prepare('SELECT COUNT(*) AS n FROM badges').get().n).toBe(before);
  });
});
