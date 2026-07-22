// tests/lucky-task-migration.test.js
// Issue #650 acceptance criterion 8: ensureTaskLuckyColumns() migrates
// tasks.lucky_date/lucky_bonus onto a database seeded at the post-#761,
// pre-lucky `tasks` shape, losing nothing, and 'lucky' still stays refused
// by the special_mode CHECK (no table was rebuilt, no CHECK was widened).
//
// Mirrors tests/flash-migration.test.js's documented seed-then-require-
// db.js-fresh pattern (its own file header) — see that file's header comment
// for the full rationale (real second boot, not a cached module reuse,
// verified there and reused here unchanged) and for why an inline copy of
// the guard is not an acceptable substitute for calling the real exported
// ensureTaskLuckyColumns().
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const GUESTS_SQL = `
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
`;

const BADGES_SQL = `
  CREATE TABLE badges (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    code         TEXT    NOT NULL UNIQUE,
    name         TEXT    NOT NULL,
    type         TEXT    NOT NULL CHECK (type IN ('auto','special','metric','transferable','custom')),
    threshold    INTEGER,
    art_path     TEXT    NOT NULL,
    description  TEXT    NOT NULL DEFAULT '',
    task_id      INTEGER REFERENCES tasks(id) ON DELETE CASCADE
  );
  CREATE UNIQUE INDEX idx_badges_task_id ON badges(task_id) WHERE task_id IS NOT NULL;
`;

/**
 * Seed a fresh temp-file database at the post-#761, pre-#650 `tasks` shape
 * (special_date/special_bonus AND the flash trio present, no lucky columns,
 * narrow special_mode CHECK excluding 'lucky'), boot src/db.js's real
 * module-load migrations against it, and return everything a test needs.
 */
function bootFreshDb(seedFn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-lucky-migration-test-'));
  const dbPath = path.join(dir, 'test.db');

  const seedDb = new Database(dbPath);
  seedDb.exec(GUESTS_SQL);
  const ids = seedFn(seedDb);
  seedDb.close();

  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../src/db')];
  process.env.DATA_DIR = dir;
  process.env.DB_PATH = dbPath;

  const dbModule = require('../src/db');
  return { dbModule, db: dbModule.db, dir, ...ids };
}

describe('AC8: lucky migration on the post-#761 shape (flash columns present, no lucky columns yet)', () => {
  let dbModule;
  let db;
  let guestId;
  let liveTaskId;
  let hiddenTaskId;
  let submissionId;
  let taskBadgeId;

  beforeAll(() => {
    const booted = bootFreshDb((seedDb) => {
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
          flash_start_at TEXT,
          flash_minutes  INTEGER,
          flash_bonus    INTEGER,
          created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
          CONSTRAINT chk_special_pairing CHECK ((special_date IS NULL) = (special_bonus IS NULL))
        );

        CREATE TABLE submissions (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          guest_id     INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
          task_id      INTEGER REFERENCES tasks(id)  ON DELETE CASCADE,
          photo_path   TEXT    NOT NULL,
          thumb_path   TEXT    NOT NULL,
          caption      TEXT    NOT NULL DEFAULT '',
          taken_down   INTEGER NOT NULL DEFAULT 0,
          photo_bonus  INTEGER NOT NULL DEFAULT 0,
          created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
          resubmitted  INTEGER NOT NULL DEFAULT 0,
          bonus_amount INTEGER NOT NULL DEFAULT 0,
          bonus_reason TEXT,
          CONSTRAINT uq_sub UNIQUE (guest_id, task_id)
        );
      `);

      const guestId = seedDb
        .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
        .run('lucky-migration-guest', 'Lucky Migration Guest').lastInsertRowid;

      const liveTaskId = seedDb
        .prepare(
          `INSERT INTO tasks (title, description, sort_order, worth, special_mode, special_date, special_bonus)
           VALUES (?, ?, ?, ?, 'oneday', ?, ?)`
        )
        .run(
          'Pre-Lucky Challenge Task',
          'a real one-day-only challenge',
          4,
          2,
          '2026-08-08',
          3
        ).lastInsertRowid;

      const hiddenTaskId = seedDb
        .prepare(
          `INSERT INTO tasks (title, description, sort_order, worth, special_mode) VALUES (?, ?, ?, ?, 'hidden')`
        )
        .run('Pre-Lucky Hidden Task', 'was already hidden', 8, 1).lastInsertRowid;

      const submissionId = seedDb
        .prepare(
          `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, bonus_amount, bonus_reason)
           VALUES (?, ?, ?, ?, 0, ?, ?)`
        )
        .run(guestId, liveTaskId, 'prelucky.jpg', 'prelucky.jpg.jpg', 3, 'oneday').lastInsertRowid;

      seedDb.exec(BADGES_SQL);
      const taskBadgeId = seedDb
        .prepare(
          `INSERT INTO badges (code, name, type, threshold, art_path, description, task_id)
           VALUES (?, ?, 'custom', NULL, ?, '', ?)`
        )
        .run(
          `TASK-${liveTaskId}`,
          'Task Badge',
          '/badges/default-ribbon.svg',
          liveTaskId
        ).lastInsertRowid;

      return { guestId, liveTaskId, hiddenTaskId, submissionId, taskBadgeId };
    });

    ({ dbModule, db, guestId, liveTaskId, hiddenTaskId, submissionId, taskBadgeId } = booted);
  });

  afterAll(() => {
    dbModule.db.close();
    delete process.env.DATA_DIR;
    delete process.env.DB_PATH;
  });

  it('both lucky columns exist after boot', () => {
    const cols = db
      .prepare('PRAGMA table_info(tasks)')
      .all()
      .map((c) => c.name);
    expect(cols).toContain('lucky_date');
    expect(cols).toContain('lucky_bonus');
  });

  it('special_mode still REFUSES lucky -- no table was rebuilt, no CHECK was widened', () => {
    expect(() =>
      db
        .prepare(`INSERT INTO tasks (title, worth, special_mode) VALUES (?, ?, 'lucky')`)
        .run('Should Be Refused', 1)
    ).toThrow(/CHECK constraint failed|constraint/i);
  });

  it('the pre-existing challenge task keeps every column it had, including the flash trio and the on-day bonus banked before this migration ran', () => {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(liveTaskId);
    expect(row.title).toBe('Pre-Lucky Challenge Task');
    expect(row.sort_order).toBe(4);
    expect(row.worth).toBe(2);
    expect(row.special_mode).toBe('oneday');
    expect(row.special_date).toBe('2026-08-08');
    expect(row.special_bonus).toBe(3);
    expect(row.flash_start_at).toBeNull();
    expect(row.flash_minutes).toBeNull();
    expect(row.flash_bonus).toBeNull();
    // Never armed by this migration -- NULL, not a default a lucky task
    // could ever be mistaken for.
    expect(row.lucky_date).toBeNull();
    expect(row.lucky_bonus).toBeNull();
  });

  it('the pre-existing hidden task also survives untouched', () => {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(hiddenTaskId);
    expect(row.title).toBe('Pre-Lucky Hidden Task');
    expect(row.special_mode).toBe('hidden');
    expect(row.lucky_date).toBeNull();
  });

  it('the pre-existing submission survives with its banked on-day bonus intact', () => {
    const row = db.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId);
    expect(row).toBeTruthy();
    expect(row.task_id).toBe(liveTaskId);
    expect(row.guest_id).toBe(guestId);
    expect(row.photo_path).toBe('prelucky.jpg');
    expect(row.bonus_amount).toBe(3);
    expect(row.bonus_reason).toBe('oneday');
  });

  it('the pre-existing task badge survives with its task_id intact', () => {
    const row = db.prepare('SELECT * FROM badges WHERE id = ?').get(taskBadgeId);
    expect(row).toBeTruthy();
    expect(row.task_id).toBe(liveTaskId);
    expect(row.code).toBe(`TASK-${liveTaskId}`);
  });

  it('a lucky task can be armed on the migrated database and round-trips its values', () => {
    const info = db
      .prepare(`INSERT INTO tasks (title, worth, lucky_date, lucky_bonus) VALUES (?, ?, ?, ?)`)
      .run('New Lucky Task', 1, '2026-08-08', 2);
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid);
    expect(row.lucky_date).toBe('2026-08-08');
    expect(row.lucky_bonus).toBe(2);
  });

  it('no CHECK constraint gates the two lucky columns (issue #650 plan step 1 design trade) -- an out-of-range value is accepted at the schema layer', () => {
    expect(() =>
      db
        .prepare(`INSERT INTO tasks (title, worth, lucky_bonus) VALUES (?, ?, ?)`)
        .run('Half-set, out-of-range lucky', 1, 99)
    ).not.toThrow();
  });

  it('a second run of the real exported guard against the already-migrated DB does not throw and does not duplicate columns -- "booted a second time, nothing changes further" (AC8)', () => {
    expect(() => db.exec('ALTER TABLE tasks ADD COLUMN lucky_date TEXT')).toThrow(
      /duplicate column/i
    );

    expect(() => dbModule.ensureTaskLuckyColumns()).not.toThrow();

    const cols = db.prepare('PRAGMA table_info(tasks)').all();
    expect(cols.filter((c) => c.name === 'lucky_date')).toHaveLength(1);
    expect(cols.filter((c) => c.name === 'lucky_bonus')).toHaveLength(1);

    // Idempotent end-to-end too: every row untouched by the repeat run.
    expect(db.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId).task_id).toBe(
      liveTaskId
    );
    expect(db.prepare('SELECT * FROM tasks WHERE id = ?').get(liveTaskId).special_date).toBe(
      '2026-08-08'
    );
  });
});
