// tests/bug-reports-signed-out.test.js
// Issue #1102: a bug report filed by someone who is not signed in must be
// storable (AC1-AC4, the guest_id-nullable migration) and visible to the
// host in GET /admin/bugs like any other report (AC5-AC8).
//
// AC5-AC8 run first, via the ordinary supertest loadApp() pattern
// tests/bug-reports.test.js already uses. AC2-AC4 each need a SECOND,
// independent database via a fresh `require('../src/db')` against an
// old-shape on-disk table — exactly like tests/flash-migration.test.js's
// bootFreshDb helper and tests/guest-delete-attribution.test.js's AC7 block
// (their own header comments explain why): a plain second `require` would
// return the module already cached by loadApp() above, pointed at THAT temp
// database, instead of re-running the module-load migrations against a new
// one. So each migration block evicts config.js and src/db.js/connection.js
// from require.cache (tests/helpers/db-boot.js's evictDbModules(), the
// single owner of that eviction pairing) before its own require, and both
// migration blocks are declared AFTER the loadApp()-based block so their
// cache eviction and process.env mutation can never run ahead of it.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { evictDbModules } = require('./helpers/db-boot');

describe('AC5-AC8: GET /admin/bugs surfaces a signed-out report', () => {
  const { loadApp, makeAdminAgent } = require('./helpers/testApp');

  let app;
  let db;
  let adminAgent;

  beforeAll(async () => {
    const loaded = loadApp();
    app = loaded.app;
    db = loaded.db;
    adminAgent = await makeAdminAgent(app);
  });

  function resetTables() {
    db.prepare('DELETE FROM bug_reports').run();
    db.prepare('DELETE FROM guests').run();
  }

  function insertGuest(token, name) {
    return db
      .prepare('INSERT INTO guests (token, name) VALUES (?, ?)')
      .run(token, name || 'Guest ' + token).lastInsertRowid;
  }

  function insertBugReport(guestId, { body, page, status }) {
    return db
      .prepare(`INSERT INTO bug_reports (guest_id, body, page, status) VALUES (?, ?, ?, ?)`)
      .run(guestId, body, page, status || 'open').lastInsertRowid;
  }

  test('AC5: a null-guest_id report appears in the open queue as "Not signed in", never "Guest #null"', async () => {
    resetTables();
    const nullReportId = insertBugReport(null, { body: 'Broke before joining', page: '/join' });

    const res = await adminAgent.get('/admin/bugs');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Broke before joining');
    expect(res.text).toContain('Not signed in');
    expect(res.text).not.toContain('Guest #null');

    // Also true once handled, in both the tracked and closed rows.
    await adminAgent
      .post('/admin/bugs/' + nullReportId + '/track')
      .type('form')
      .send({});
    const trackedRes = await adminAgent.get('/admin/bugs');
    expect(trackedRes.text).toContain('Not signed in');
    expect(trackedRes.text).not.toContain('Guest #null');

    await adminAgent
      .post('/admin/bugs/' + nullReportId + '/close')
      .type('form')
      .send({});
    const closedRes = await adminAgent.get('/admin/bugs');
    expect(closedRes.text).toContain('Not signed in');
    expect(closedRes.text).not.toContain('Guest #null');
  });

  test('AC6: in the open section, a null-guest row has no /admin/guests link but a guest-attributed row still does', async () => {
    resetTables();
    const guestId = insertGuest('ac6-token', 'Named Reporter');
    insertBugReport(guestId, { body: 'Named reporter bug', page: '/tasks/1' });
    insertBugReport(null, { body: 'Anonymous bug', page: '/join' });

    const res = await adminAgent.get('/admin/bugs');
    expect(res.status).toBe(200);

    // Named reporter's row is still wrapped in the guests link.
    expect(res.text).toContain('<a href="/admin/guests">Named Reporter</a>');

    // The signed-out row's reporter text appears with no such link around it.
    expect(res.text).not.toContain('<a href="/admin/guests">Not signed in</a>');
    expect(res.text).toContain('Not signed in');
  });

  test('AC7: the "Open issue" link names the reporter "Not signed in" for a null-guest report', async () => {
    resetTables();
    const id = insertBugReport(null, {
      body: 'Signed-out prefill check',
      page: '/login',
    });

    const res = await adminAgent.get('/admin/bugs');
    expect(res.status).toBe(200);

    const expectedBodyLine = 'Reported by **Not signed in** on /login';
    expect(res.text).toContain(encodeURIComponent(expectedBodyLine));
    // The link itself is otherwise unchanged — still targets the GitHub new-issue form.
    expect(res.text).toContain('/issues/new?title=');
    // The onclick tracking wiring still fires for this report id.
    expect(res.text).toContain('sendBeacon(&#39;/admin/bugs/' + id + '/track&#39;,');
  });

  test('AC8: a guest_id set but pointing at a missing guests row reads "Guest #<id>", not "Not signed in"', async () => {
    resetTables();
    // Insert then delete the guest WITHOUT going through the app (foreign_keys
    // enforcement briefly turned off for one statement) so the bug_reports
    // row is left pointing at an id no longer in `guests` — simulating data
    // drift rather than a real, FK-enforced guest deletion (which would
    // cascade the report away, per the AC2 cascade coverage below).
    const guestId = insertGuest('orphan-token', 'Soon Gone');
    insertBugReport(guestId, { body: 'Orphaned reporter bug', page: '/gallery' });

    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM guests WHERE id = ?').run(guestId);
    db.pragma('foreign_keys = ON');

    const res = await adminAgent.get('/admin/bugs');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Orphaned reporter bug');
    expect(res.text).toContain('Guest #' + guestId);
    // This row must not be mistaken for a genuinely signed-out one.
    const rowStart = res.text.indexOf('Orphaned reporter bug');
    const rowSection = res.text.slice(Math.max(0, rowStart - 400), rowStart);
    expect(rowSection).not.toContain('Not signed in');
  });
});

describe('AC1: a fresh schema reports guest_id nullable, FK cascade intact', () => {
  test('PRAGMA table_info/foreign_key_list on a schema-only database', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-bugs-signedout-fresh-test-'));
    const freshDb = new Database(path.join(dir, 'fresh.db'));
    const schema = require('../src/db/schema');
    schema.applySchema(freshDb);

    const cols = freshDb.prepare('PRAGMA table_info(bug_reports)').all();
    const guestIdCol = cols.find((c) => c.name === 'guest_id');
    expect(guestIdCol.notnull).toBe(0);

    const fks = freshDb.prepare('PRAGMA foreign_key_list(bug_reports)').all();
    const guestFk = fks.find((fk) => fk.table === 'guests');
    expect(guestFk).toBeTruthy();
    expect(guestFk.on_delete).toBe('CASCADE');

    freshDb.close();
  });
});

// ---------------------------------------------------------------------------
// AC2/AC3: an existing (post-#686, pre-#1102) database migrates guest_id to
// nullable correctly on boot, and a second boot is a no-op.
//
// Declared AFTER the loadApp()-based block above so its cache eviction and
// process.env mutation can never run ahead of (and poison) it — same
// ordering rule tests/guest-delete-attribution.test.js's AC7 block states.
// ---------------------------------------------------------------------------
describe('AC2/AC3: bug_reports.guest_id nullable migration on an existing (post-#686) database', () => {
  let dbModule;
  let db;
  let guestId;
  let existingReportId;

  beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-bugs-signedout-migration-test-'));
    const dbPath = path.join(dir, 'test.db');

    // Lay down the real PRE-#1102 shape: guest_id NOT NULL, status already
    // present (post-#686) so this block exercises the guest_id migration
    // only, in isolation from the status backfill AC4 separately covers.
    const seedDb = new Database(dbPath);
    seedDb.exec(`
      CREATE TABLE guests (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        token         TEXT    NOT NULL UNIQUE,
        name          TEXT    NOT NULL DEFAULT '',
        created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE bug_reports (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        guest_id    INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
        body        TEXT    NOT NULL,
        page        TEXT,
        user_agent  TEXT,
        resolved    INTEGER NOT NULL DEFAULT 0,
        status      TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','tracked','closed')),
        created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_bug_reports_status ON bug_reports(status, created_at DESC);
    `);

    guestId = seedDb
      .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
      .run('signedout-migration-guest', 'Migration Guest').lastInsertRowid;

    existingReportId = seedDb
      .prepare(`INSERT INTO bug_reports (guest_id, body, page, status) VALUES (?, ?, ?, 'open')`)
      .run(guestId, 'Pre-#1102 report', '/gallery').lastInsertRowid;

    seedDb.close();

    delete require.cache[require.resolve('../config')];
    // evictDbModules() is the single owner of the db.js/connection.js
    // eviction pairing (tests/helpers/db-boot.js) — evicting db.js alone
    // would leave connection.js cached, silently reusing the loadApp()
    // block's already-open handle instead of a real second boot.
    evictDbModules();
    process.env.DATA_DIR = dir;
    process.env.DB_PATH = dbPath;

    // Requiring src/db.js NOW runs its real module-load migrations —
    // including the real, exported ensureBugReportGuestIdNullable — against
    // the old NOT-NULL shape above.
    dbModule = require('../src/db');
    db = dbModule.db;
  });

  afterAll(() => {
    dbModule.db.close();
    delete process.env.DATA_DIR;
    delete process.env.DB_PATH;
  });

  test('AC2: guest_id becomes nullable; every column of the existing row survives; index and CHECK still hold; cascade still deletes', () => {
    const cols = db.prepare('PRAGMA table_info(bug_reports)').all();
    const guestIdCol = cols.find((c) => c.name === 'guest_id');
    expect(guestIdCol.notnull).toBe(0);

    const row = db.prepare('SELECT * FROM bug_reports WHERE id = ?').get(existingReportId);
    expect(row.id).toBe(existingReportId);
    expect(row.guest_id).toBe(guestId);
    expect(row.body).toBe('Pre-#1102 report');
    expect(row.page).toBe('/gallery');
    expect(row.user_agent).toBeNull();
    expect(row.resolved).toBe(0);
    expect(row.status).toBe('open');
    expect(row.created_at).toBeTruthy();

    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'bug_reports'`)
      .all()
      .map((r) => r.name);
    expect(indexes).toContain('idx_bug_reports_status');

    expect(() =>
      db.prepare('UPDATE bug_reports SET status = ? WHERE id = ?').run('bogus', existingReportId)
    ).toThrow(/CHECK/i);

    // Cascade: deleting the guest still removes their report.
    const cascadeGuestId = db
      .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
      .run('cascade-check-guest', 'Cascade Guest').lastInsertRowid;
    const cascadeReportId = db
      .prepare(`INSERT INTO bug_reports (guest_id, body) VALUES (?, ?)`)
      .run(cascadeGuestId, 'Will cascade away').lastInsertRowid;
    db.prepare('DELETE FROM guests WHERE id = ?').run(cascadeGuestId);
    expect(
      db.prepare('SELECT * FROM bug_reports WHERE id = ?').get(cascadeReportId)
    ).toBeUndefined();

    // A NULL guest_id can now be inserted directly on the migrated table.
    const info = db
      .prepare('INSERT INTO bug_reports (guest_id, body, page) VALUES (NULL, ?, ?)')
      .run('Filed before joining', '/join');
    const nullRow = db.prepare('SELECT * FROM bug_reports WHERE id = ?').get(info.lastInsertRowid);
    expect(nullRow.guest_id).toBeNull();
  });

  test('AC3: a second boot against the already-migrated DB is a no-op — throws nothing, changes no row', () => {
    const beforeRow = db.prepare('SELECT * FROM bug_reports WHERE id = ?').get(existingReportId);

    // The bare ALTER is itself idempotent, so asserting only "nothing changed"
    // would pass with the PRAGMA guard deleted. Spy on db.exec to assert the
    // guard's real contract: on an already-migrated database the migration
    // issues no DDL at all, rather than re-running a statement that happens
    // to be harmless.
    const execSpy = vi.spyOn(db, 'exec');
    expect(() => dbModule.ensureBugReportGuestIdNullable()).not.toThrow();
    expect(execSpy).not.toHaveBeenCalled();
    execSpy.mockRestore();

    const afterRow = db.prepare('SELECT * FROM bug_reports WHERE id = ?').get(existingReportId);
    expect(afterRow).toEqual(beforeRow);

    const cols = db.prepare('PRAGMA table_info(bug_reports)').all();
    expect(cols.filter((c) => c.name === 'guest_id')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AC4: the guest_id migration must not regress the pre-#686 (no `status`
// column yet) boot path, and ensureBugReportStatusColumn's own backfill must
// still assign the right status regardless of source order relative to the
// new migration.
// ---------------------------------------------------------------------------
describe('AC4: guest_id nullability migrates cleanly on a pre-#686 database (no status column yet)', () => {
  let dbModule;
  let db;
  let closedReportId;
  let openReportId;

  beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-bugs-signedout-pre686-test-'));
    const dbPath = path.join(dir, 'test.db');

    const seedDb = new Database(dbPath);
    seedDb.exec(`
      CREATE TABLE guests (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        token         TEXT    NOT NULL UNIQUE,
        name          TEXT    NOT NULL DEFAULT '',
        created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE bug_reports (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        guest_id    INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
        body        TEXT    NOT NULL,
        page        TEXT,
        user_agent  TEXT,
        resolved    INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_bug_reports_resolved ON bug_reports(resolved, created_at DESC);
    `);

    const guestId = seedDb
      .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
      .run('pre686-signedout-guest', 'Pre-686 Guest').lastInsertRowid;

    closedReportId = seedDb
      .prepare(`INSERT INTO bug_reports (guest_id, body, page, resolved) VALUES (?, ?, ?, 1)`)
      .run(guestId, 'Pre-686 closed report', '/gallery').lastInsertRowid;

    openReportId = seedDb
      .prepare(`INSERT INTO bug_reports (guest_id, body, page, resolved) VALUES (?, ?, ?, 0)`)
      .run(guestId, 'Pre-686 open report', '/tasks/1').lastInsertRowid;

    seedDb.close();

    delete require.cache[require.resolve('../config')];
    evictDbModules();
    process.env.DATA_DIR = dir;
    process.env.DB_PATH = dbPath;

    // No `status` column exists yet on this database — booting must not
    // throw "no such column: status" from ensureBugReportGuestIdNullable,
    // and ensureBugReportStatusColumn's own backfill must still run
    // correctly regardless of source order relative to the new migration.
    dbModule = require('../src/db');
    db = dbModule.db;
  });

  afterAll(() => {
    dbModule.db.close();
    delete process.env.DATA_DIR;
    delete process.env.DB_PATH;
  });

  test('boot succeeds with no "no such column" error; guest_id is nullable', () => {
    const cols = db.prepare('PRAGMA table_info(bug_reports)').all();
    expect(cols.some((c) => c.name === 'status')).toBe(true);
    const guestIdCol = cols.find((c) => c.name === 'guest_id');
    expect(guestIdCol.notnull).toBe(0);
  });

  test('each migrated row keeps the status ensureBugReportStatusColumn assigns it', () => {
    const closedRow = db.prepare('SELECT status FROM bug_reports WHERE id = ?').get(closedReportId);
    expect(closedRow.status).toBe('closed');

    const openRow = db.prepare('SELECT status FROM bug_reports WHERE id = ?').get(openReportId);
    expect(openRow.status).toBe('open');
  });
});
