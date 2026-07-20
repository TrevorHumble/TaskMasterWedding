// tests/task-worth-mode-migration.test.js
// Issue #727 AC3: ensureTaskWorthAndMode() migrates a pre-#727 tasks table
// (is_active, no worth/special_mode) in place — an is_active = 0 row becomes
// special_mode = 'hidden', worth = 1, and is_active is gone.
//
// AC3 needs a tasks table that genuinely predates this change so the rebuild
// path is exercised for real, not just re-verified on an already-migrated
// table. loadApp() (tests/helpers/testApp.js) always builds a FRESH db, whose
// CREATE TABLE already has the new shape — that would only prove idempotency,
// not migration. So, following the same minimal-seed pattern as
// tests/guest-identity.test.js (only the ONE table under test needs to be
// pre-created in its OLD shape — every other table db.js's own
// `CREATE TABLE IF NOT EXISTS` block creates fresh, in its current/correct
// shape, since this is otherwise an empty DB file): this file creates a temp
// DB file, opens it standalone to lay down ONLY the OLD tasks shape, points
// DATA_DIR/DB_PATH at that file, then requires the real src/db.js fresh so
// its module-load code — including the real, exported ensureTaskWorthAndMode
// — runs against the pre-existing old-shape table.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

let dbModule;
let db;
let hiddenTaskId;

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-task-worth-migration-test-'));
  const dbPath = path.join(dir, 'test.db');

  // Lay down ONLY the OLD (pre-#727) tasks shape: is_active instead of
  // worth/special_mode. Every other table (guests, submissions, badges,
  // guest_badges, ...) does not exist yet in this fresh file, so db.js's own
  // `CREATE TABLE IF NOT EXISTS` block creates them all with their current,
  // correct shape the moment it is required below — only `tasks` needs to be
  // deliberately stale here.
  const seedDb = new Database(dbPath);
  seedDb.exec(`
    CREATE TABLE tasks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      title        TEXT    NOT NULL,
      description  TEXT    NOT NULL DEFAULT '',
      sort_order   INTEGER NOT NULL DEFAULT 0,
      is_active    INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  seedDb
    .prepare(
      `INSERT INTO tasks (id, title, description, sort_order, is_active) VALUES (?, ?, ?, ?, ?)`
    )
    .run(1, 'Old Live Task', 'still active pre-migration', 0, 1);
  hiddenTaskId = seedDb
    .prepare(
      `INSERT INTO tasks (id, title, description, sort_order, is_active) VALUES (?, ?, ?, ?, ?)`
    )
    .run(2, 'Old Hidden Task', 'was is_active = 0', 1, 0).lastInsertRowid;

  seedDb.close();

  process.env.DATA_DIR = dir;
  process.env.DB_PATH = dbPath;

  // Requiring src/db.js NOW runs its real module-load migrations — including
  // the real, exported ensureTaskWorthAndMode — against the old-shape table
  // created above.
  dbModule = require('../src/db');
  db = dbModule.db;
});

afterAll(() => {
  dbModule.db.close();
  delete process.env.DATA_DIR;
  delete process.env.DB_PATH;
});

describe('AC3: ensureTaskWorthAndMode migrates a pre-#727 tasks table', () => {
  it('is_active is gone and worth/special_mode now exist', () => {
    const cols = db.prepare('PRAGMA table_info(tasks)').all();
    const names = cols.map((c) => c.name);
    expect(names).not.toContain('is_active');
    expect(names).toContain('worth');
    expect(names).toContain('special_mode');
  });

  it("the is_active = 0 row is now special_mode = 'hidden', worth = 1, with id/title/description/sort_order preserved", () => {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(hiddenTaskId);
    expect(row).toBeTruthy();
    expect(row.title).toBe('Old Hidden Task');
    expect(row.description).toBe('was is_active = 0');
    expect(row.sort_order).toBe(1);
    expect(row.special_mode).toBe('hidden');
    expect(row.worth).toBe(1);
  });

  it("the is_active = 1 row is now special_mode = 'none', worth = 1", () => {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(1);
    expect(row.special_mode).toBe('none');
    expect(row.worth).toBe(1);
  });

  it('the migrated hidden task behaves as hidden through the one owner (no guest-visible change)', () => {
    const tasksSvc = require('../src/services/tasks');
    const row = db.prepare('SELECT special_mode FROM tasks WHERE id = ?').get(hiddenTaskId);
    expect(tasksSvc.isTaskLive(row)).toBe(false);

    const liveIds = db
      .prepare(`SELECT id FROM tasks WHERE ${tasksSvc.liveTaskWhere('')}`)
      .all()
      .map((r) => r.id);
    expect(liveIds).not.toContain(hiddenTaskId);
    expect(liveIds).toContain(1);
  });

  it('a second run of the real guard against the already-migrated DB does not throw and does not duplicate columns', () => {
    // A naked ALTER against the now-migrated table proves the guard is
    // load-bearing (same pattern as tests/per-photo-points.test.js AC1 and
    // tests/guest-identity.test.js AC1's second-run checks).
    expect(() => db.exec('ALTER TABLE tasks ADD COLUMN worth INTEGER')).toThrow(
      /duplicate column/i
    );

    expect(() => dbModule.ensureTaskWorthAndMode()).not.toThrow();

    const cols = db.prepare('PRAGMA table_info(tasks)').all();
    expect(cols.filter((c) => c.name === 'worth')).toHaveLength(1);
    expect(cols.filter((c) => c.name === 'special_mode')).toHaveLength(1);
    expect(cols.filter((c) => c.name === 'is_active')).toHaveLength(0);
  });

  it('the worth CHECK (1-3) and special_mode CHECK (none/hidden) are enforced on the migrated table', () => {
    expect(() =>
      db.prepare('INSERT INTO tasks (title, worth) VALUES (?, ?)').run('Bad worth', 4)
    ).toThrow(/CHECK/i);
    expect(() =>
      db.prepare('INSERT INTO tasks (title, special_mode) VALUES (?, ?)').run('Bad mode', 'lucky')
    ).toThrow(/CHECK/i);
  });
});
