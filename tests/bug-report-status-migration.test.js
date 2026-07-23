// tests/bug-report-status-migration.test.js
// Issue #686 AC7: ensureBugReportStatusColumn() migrates a database that
// already has `bug_reports` in its pre-#686 shape (guest_id/body/page/
// user_agent/resolved/created_at, no `status` column) — the exact deployed
// app.db shape this issue's implementation plan targets.
//
// Follows the same minimal-seed-then-require-db.js-fresh pattern as
// tests/oneday-challenge-migration.test.js: pre-create the OLD-shape table on
// disk with a raw better-sqlite3 connection, seed one guest and two
// bug_reports rows (one resolved=1, one resolved=0), THEN require src/db.js
// so its real, exported ensureBugReportStatusColumn() runs against that
// shape.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

let dbModule;
let db;
let guestId;
let closedReportId;
let openReportId;

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-bugstatus-migration-test-'));
  const dbPath = path.join(dir, 'test.db');

  // Lay down the real PRE-#686 shape: guests (needed for bug_reports' own FK)
  // plus bug_reports without `status`. Every OTHER table (tasks, submissions,
  // badges, ...) does not exist yet in this fresh file, so db.js's own
  // `CREATE TABLE IF NOT EXISTS` block creates them fresh, with no rows, the
  // moment it is required below.
  const seedDb = new Database(dbPath);
  seedDb.exec(`
    CREATE TABLE guests (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      token         TEXT    NOT NULL UNIQUE,
      name          TEXT    NOT NULL DEFAULT '',
      avatar_path   TEXT,
      social_links  TEXT    NOT NULL DEFAULT '{}',
      bonus_points  INTEGER NOT NULL DEFAULT 0,
      onboarded     INTEGER NOT NULL DEFAULT 0,
      contact       TEXT,
      contact_type  TEXT,
      pin           TEXT,
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

  guestId = seedDb
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run('bugstatus-migration-guest', 'Migration Guest').lastInsertRowid;

  closedReportId = seedDb
    .prepare(`INSERT INTO bug_reports (guest_id, body, page, resolved) VALUES (?, ?, ?, 1)`)
    .run(guestId, 'Pre-686 closed report', '/gallery').lastInsertRowid;

  openReportId = seedDb
    .prepare(`INSERT INTO bug_reports (guest_id, body, page, resolved) VALUES (?, ?, ?, 0)`)
    .run(guestId, 'Pre-686 open report', '/tasks/1').lastInsertRowid;

  seedDb.close();

  process.env.DATA_DIR = dir;
  process.env.DB_PATH = dbPath;

  // Requiring src/db.js NOW runs its real module-load migrations — including
  // the real, exported ensureBugReportStatusColumn — against the old-shape
  // table above.
  dbModule = require('../src/db');
  db = dbModule.db;
});

afterAll(() => {
  dbModule.db.close();
  delete process.env.DATA_DIR;
  delete process.env.DB_PATH;
});

describe('AC7: the bug-report status migration widens a real pre-#686 database', () => {
  it('bug_reports.status now exists', () => {
    const cols = db
      .prepare('PRAGMA table_info(bug_reports)')
      .all()
      .map((c) => c.name);
    expect(cols).toContain('status');
    expect(cols).toContain('resolved'); // retired but kept, not dropped
  });

  it('a pre-existing resolved=1 row reads as status=closed', () => {
    const row = db.prepare('SELECT * FROM bug_reports WHERE id = ?').get(closedReportId);
    expect(row.resolved).toBe(1);
    expect(row.status).toBe('closed');
    expect(row.body).toBe('Pre-686 closed report');
  });

  it('a pre-existing resolved=0 row reads as status=open', () => {
    const row = db.prepare('SELECT * FROM bug_reports WHERE id = ?').get(openReportId);
    expect(row.resolved).toBe(0);
    expect(row.status).toBe('open');
    expect(row.body).toBe('Pre-686 open report');
  });

  it('openBugCount() counts only the open row', () => {
    expect(dbModule.openBugCount()).toBe(1);
  });

  it('the old resolved-keyed index is gone; the new status-keyed index exists', () => {
    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'bug_reports'`)
      .all()
      .map((r) => r.name);
    expect(indexes).not.toContain('idx_bug_reports_resolved');
    expect(indexes).toContain('idx_bug_reports_status');
  });

  it('a new insert with no explicit status defaults to open', () => {
    const info = db
      .prepare('INSERT INTO bug_reports (guest_id, body, page) VALUES (?, ?, ?)')
      .run(guestId, 'Freshly reported', '/me');
    const row = db.prepare('SELECT status FROM bug_reports WHERE id = ?').get(info.lastInsertRowid);
    expect(row.status).toBe('open');
  });

  it('the status CHECK rejects an unknown value, on both a new insert and an update', () => {
    expect(() =>
      db
        .prepare('INSERT INTO bug_reports (guest_id, body, status) VALUES (?, ?, ?)')
        .run(guestId, 'Bad status insert', 'bogus')
    ).toThrow(/CHECK/i);

    expect(() =>
      db.prepare('UPDATE bug_reports SET status = ? WHERE id = ?').run('bogus', openReportId)
    ).toThrow(/CHECK/i);
  });

  it('a second run of the real guard against the already-migrated DB does not throw and does not duplicate the column', () => {
    expect(() => db.exec('ALTER TABLE bug_reports ADD COLUMN status TEXT')).toThrow(
      /duplicate column/i
    );

    expect(() => dbModule.ensureBugReportStatusColumn()).not.toThrow();

    const cols = db.prepare('PRAGMA table_info(bug_reports)').all();
    expect(cols.filter((c) => c.name === 'status')).toHaveLength(1);

    // Booting is idempotent end-to-end too: rows are untouched by the repeat run.
    expect(db.prepare('SELECT COUNT(*) AS n FROM bug_reports').get().n).toBe(3);
    expect(
      db.prepare('SELECT status FROM bug_reports WHERE id = ?').get(closedReportId).status
    ).toBe('closed');
  });
});
