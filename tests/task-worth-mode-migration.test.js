// tests/task-worth-mode-migration.test.js
// Issue #727 AC3: ensureTaskWorthAndMode() migrates a pre-#727 tasks table
// (is_active, no worth/special_mode) in place — an is_active = 0 row becomes
// special_mode = 'hidden', worth = 1 at that migration step, and is_active is
// gone. Issue #1103 added a LATER migration in the same boot chain,
// ensureTaskWorthRange(), which rescales every worth value once more (1 -> 3,
// 2 -> 4, 3 -> 5) — so a pre-#727 table that boots the real src/db.js today
// lands on worth = 3, not worth = 1, by the time boot finishes. The first
// describe block below exercises that full chain end to end; the second adds
// dedicated remap coverage for ensureTaskWorthRange() itself, seeding a
// table already in the FULL post-#727/pre-#1103 shape (worth already exists,
// CHECK still BETWEEN 1 AND 3) with rows at all three old values.
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
const { evictDbModules } = require('./helpers/db-boot');

describe('AC3: ensureTaskWorthAndMode migrates a pre-#727 tasks table (then #1103 rescales worth on the same boot)', () => {
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
    // the real, exported ensureTaskWorthAndMode and, later in the same chain,
    // ensureTaskWorthRange — against the old-shape table created above.
    dbModule = require('../src/db');
    db = dbModule.db;
  });

  afterAll(() => {
    dbModule.db.close();
    delete process.env.DATA_DIR;
    delete process.env.DB_PATH;
  });

  it('is_active is gone and worth/special_mode now exist', () => {
    const cols = db.prepare('PRAGMA table_info(tasks)').all();
    const names = cols.map((c) => c.name);
    expect(names).not.toContain('is_active');
    expect(names).toContain('worth');
    expect(names).toContain('special_mode');
  });

  it("the is_active = 0 row is now special_mode = 'hidden', worth = 3 (ensureTaskWorthAndMode's historical worth=1 backfill, then rescaled 1 -> 3 by ensureTaskWorthRange), with id/title/description/sort_order preserved", () => {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(hiddenTaskId);
    expect(row).toBeTruthy();
    expect(row.title).toBe('Old Hidden Task');
    expect(row.description).toBe('was is_active = 0');
    expect(row.sort_order).toBe(1);
    expect(row.special_mode).toBe('hidden');
    expect(row.worth).toBe(3);
  });

  it("the is_active = 1 row is now special_mode = 'none', worth = 3", () => {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(1);
    expect(row.special_mode).toBe('none');
    expect(row.worth).toBe(3);
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
    expect(() => dbModule.ensureTaskWorthRange()).not.toThrow();

    const cols = db.prepare('PRAGMA table_info(tasks)').all();
    expect(cols.filter((c) => c.name === 'worth')).toHaveLength(1);
    expect(cols.filter((c) => c.name === 'special_mode')).toHaveLength(1);
    expect(cols.filter((c) => c.name === 'is_active')).toHaveLength(0);

    // Idempotent end to end too: a repeat run of ensureTaskWorthRange must not
    // shift an already-rescaled worth a second time (3 -> 5, which would be
    // silently wrong but still pass the bare CHECK).
    expect(db.prepare('SELECT worth FROM tasks WHERE id = ?').get(hiddenTaskId).worth).toBe(3);
  });

  it('the worth CHECK (3-5) and special_mode CHECK (none/hidden/oneday) are enforced on the migrated table', () => {
    expect(() =>
      db.prepare('INSERT INTO tasks (title, worth) VALUES (?, ?)').run('Bad worth too low', 2)
    ).toThrow(/CHECK/i);
    expect(() =>
      db.prepare('INSERT INTO tasks (title, worth) VALUES (?, ?)').run('Bad worth too high', 6)
    ).toThrow(/CHECK/i);
    expect(() =>
      db.prepare('INSERT INTO tasks (title, worth) VALUES (?, ?)').run('Good worth', 4)
    ).not.toThrow();
    expect(() =>
      db.prepare('INSERT INTO tasks (title, special_mode) VALUES (?, ?)').run('Bad mode', 'lucky')
    ).toThrow(/CHECK/i);
  });
});

describe('AC2 (#1103): ensureTaskWorthRange remaps 1/2/3 -> 3/4/5 on a full post-#727 pre-#1103 tasks table', () => {
  // Seeds a tasks table already in the FULL shape every earlier migration in
  // this file produces (worth/special_mode/special_date/special_bonus/flash
  // trio/lucky pair/live_since all present) but still carrying the OLD
  // `worth BETWEEN 1 AND 3` CHECK — the exact shape a real deployed app.db
  // reached the moment before this issue shipped. Requires a real second boot
  // of src/db.js (evictDbModules, mirroring tests/flash-migration.test.js's
  // documented bootFreshDb pattern) rather than reusing the outer describe
  // block's already-migrated module/handle.
  let dbModule;
  let db;
  let worth1Id;
  let worth2Id;
  let worth3Id;

  beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-task-worth-range-test-'));
    const dbPath = path.join(dir, 'test.db');

    const seedDb = new Database(dbPath);
    // Pre-flash shape (issue #761's starting point): flash/lucky/live_since
    // don't exist yet and created_at is the last declared column. The six
    // columns are then added with ALTER TABLE ADD COLUMN below, exactly as
    // ensureTaskFlashColumns/ensureTaskLuckyColumns/ensureTaskLiveSinceColumn
    // add them on a real deployed app.db — each ALTER appends after every
    // existing column, so on a real migrated database they sit AFTER
    // created_at, not in the declared order a fresh CREATE TABLE would give
    // them. Reproducing that divergence here means a future `SELECT *`
    // simplification of ensureTaskWorthRange's rebuild would copy the right
    // values into the wrong named columns and fail this suite, instead of
    // passing silently because the fixture happened to already match
    // tasks_new's declared order.
    seedDb.exec(`
      CREATE TABLE tasks (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        title          TEXT    NOT NULL,
        description    TEXT    NOT NULL DEFAULT '',
        sort_order     INTEGER NOT NULL DEFAULT 0,
        worth          INTEGER NOT NULL DEFAULT 1 CHECK (worth BETWEEN 1 AND 3),
        special_mode   TEXT    NOT NULL DEFAULT 'none' CHECK (special_mode IN ('none','hidden','oneday')),
        special_date   TEXT,
        special_bonus  INTEGER CHECK (special_bonus IS NULL OR special_bonus BETWEEN 1 AND 3),
        created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
        CONSTRAINT chk_special_pairing CHECK ((special_date IS NULL) = (special_bonus IS NULL))
      );
      ALTER TABLE tasks ADD COLUMN flash_start_at TEXT;
      ALTER TABLE tasks ADD COLUMN flash_minutes INTEGER;
      ALTER TABLE tasks ADD COLUMN flash_bonus INTEGER;
      ALTER TABLE tasks ADD COLUMN lucky_date TEXT;
      ALTER TABLE tasks ADD COLUMN lucky_bonus INTEGER;
      ALTER TABLE tasks ADD COLUMN live_since TEXT;
    `);

    worth1Id = seedDb
      .prepare(
        `INSERT INTO tasks (title, description, sort_order, worth, special_mode, live_since)
         VALUES (?, ?, ?, 1, 'none', ?)`
      )
      .run('Worth One Task', 'was worth 1', 0, '2026-08-01T00:00:00.000Z').lastInsertRowid;
    worth2Id = seedDb
      .prepare(
        `INSERT INTO tasks (title, description, sort_order, worth, special_mode, flash_minutes, flash_bonus)
         VALUES (?, ?, ?, 2, 'none', ?, ?)`
      )
      .run('Worth Two Task', 'was worth 2', 1, 15, 2).lastInsertRowid;
    worth3Id = seedDb
      .prepare(
        `INSERT INTO tasks (title, description, sort_order, worth, special_mode, special_date, special_bonus)
         VALUES (?, ?, ?, 3, 'oneday', ?, ?)`
      )
      .run('Worth Three Task', 'was worth 3', 2, '2026-08-08', 2).lastInsertRowid;

    seedDb.close();

    delete require.cache[require.resolve('../config')];
    evictDbModules();
    process.env.DATA_DIR = dir;
    process.env.DB_PATH = dbPath;

    dbModule = require('../src/db');
    db = dbModule.db;
  });

  afterAll(() => {
    dbModule.db.close();
    delete process.env.DATA_DIR;
    delete process.env.DB_PATH;
  });

  it('remaps 1 -> 3, 2 -> 4, and 3 -> 5 exactly', () => {
    expect(db.prepare('SELECT worth FROM tasks WHERE id = ?').get(worth1Id).worth).toBe(3);
    expect(db.prepare('SELECT worth FROM tasks WHERE id = ?').get(worth2Id).worth).toBe(4);
    expect(db.prepare('SELECT worth FROM tasks WHERE id = ?').get(worth3Id).worth).toBe(5);
  });

  it('every other column survives the rebuild untouched, flash/lucky/live_since included', () => {
    const row2 = db.prepare('SELECT * FROM tasks WHERE id = ?').get(worth2Id);
    expect(row2.title).toBe('Worth Two Task');
    expect(row2.description).toBe('was worth 2');
    expect(row2.sort_order).toBe(1);
    expect(row2.flash_minutes).toBe(15);
    expect(row2.flash_bonus).toBe(2);
    expect(row2.lucky_date).toBeNull();

    const row1 = db.prepare('SELECT * FROM tasks WHERE id = ?').get(worth1Id);
    expect(row1.live_since).toBe('2026-08-01T00:00:00.000Z');

    const row3 = db.prepare('SELECT * FROM tasks WHERE id = ?').get(worth3Id);
    expect(row3.special_mode).toBe('oneday');
    expect(row3.special_date).toBe('2026-08-08');
    expect(row3.special_bonus).toBe(2);
  });

  it('the widened CHECK (3-5) is what the migrated table now enforces', () => {
    expect(() =>
      db.prepare('INSERT INTO tasks (title, worth) VALUES (?, ?)').run('Too low', 2)
    ).toThrow(/CHECK/i);
    expect(() =>
      db.prepare('INSERT INTO tasks (title, worth) VALUES (?, ?)').run('Too high', 6)
    ).toThrow(/CHECK/i);
  });

  it('a second boot-time run is a no-op — idempotent, no further shift', () => {
    expect(() => dbModule.ensureTaskWorthRange()).not.toThrow();
    expect(db.prepare('SELECT worth FROM tasks WHERE id = ?').get(worth1Id).worth).toBe(3);
    expect(db.prepare('SELECT worth FROM tasks WHERE id = ?').get(worth2Id).worth).toBe(4);
    expect(db.prepare('SELECT worth FROM tasks WHERE id = ?').get(worth3Id).worth).toBe(5);
  });
});
