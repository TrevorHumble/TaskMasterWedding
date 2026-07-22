// tests/flash-migration.test.js
// Issue #761 criterion 1: ensureTaskFlashColumns() migrates tasks.flash_start_at
// / flash_minutes / flash_bonus onto BOTH database shapes this app can boot
// from, losing nothing on either.
//
// Mirrors tests/oneday-challenge-migration.test.js's documented seed-then-
// require-db.js-fresh pattern (its own file header and bootFreshDb helper):
// seed the old-shape tables into a temp file, point DATA_DIR/DB_PATH at it,
// then require('../src/db') so the real exported guard runs at module load.
// Do NOT open a raw better-sqlite3 handle and hand-run the ALTER TABLE
// statements -- an inline copy of the guard tests nothing, which is exactly
// what the sibling guards' own doc comments warn against (issue #761 review
// fix: cited by NAME, not line, since a line citation here rots the
// moment either file gains a line above it -- see every other guarded
// migration in src/db.js, e.g. ensureTaskSpecialDayColumns()'s and
// ensureSubmissionsBonusColumns()'s own "Exported so tests bind to this real
// guard rather than an inline copy" rule).
//
// TWO SHAPES, ONE FILE, TWO REAL BOOTS. src/db.js runs its guards at module
// load and is deliberately left cached across a plain second `require` --
// tests/hosting-lifecycle.test.js's reloadAppWithFreshConfig (:57-70) proves
// the fix for the identical problem with config.js/app.js: manually evict
// the module from require.cache before the second require, rather than
// relying on vi.resetModules() (verified elsewhere in this repo not to
// defeat this caching on its own). bootFreshDb() below generalizes that
// exact technique to src/db.js itself -- evicting BOTH config.js (db.js
// reads config.DATA_DIR/DB_PATH at module-load time) and src/db.js from
// require.cache before each boot, so the second `require('../src/db')` in
// this same file really re-executes every module-load migration against a
// SECOND, independent temp database rather than returning the first boot's
// already-migrated module object. This was verified directly against this
// repo's actual src/db.js before relying on it here: two boots in one
// process, second db path seeded with a distinct marker row, second boot's
// module object and db handle both !== the first's, and the second boot's
// query returns only the second seed's row -- a real second connection, not
// a silently-reused first one.
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
 * Seed a fresh temp-file database in one of the two pre-#761 shapes, boot
 * src/db.js's real module-load migrations against it (evicting config.js
 * and src/db.js from require.cache first, per this file's header comment),
 * and return everything a test needs to assert against.
 *
 * @param {(seedDb: import('better-sqlite3').Database) => {guestId: number, liveTaskId: number, hiddenTaskId: number, submissionId: number, taskBadgeId: number}} seedFn
 */
function bootFreshDb(seedFn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-flash-migration-test-'));
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

describe('AC1: flash migration on the post-#753 shape (special_date/special_bonus already present, no flash columns)', () => {
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
        .run('flash-migration-post753-guest', 'Post753 Guest').lastInsertRowid;

      const liveTaskId = seedDb
        .prepare(
          `INSERT INTO tasks (title, description, sort_order, worth, special_mode, special_date, special_bonus)
           VALUES (?, ?, ?, ?, 'oneday', ?, ?)`
        )
        .run(
          'Post-753 Challenge Task',
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
        .run('Post-753 Hidden Task', 'was already hidden', 8, 1).lastInsertRowid;

      const submissionId = seedDb
        .prepare(
          `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
           VALUES (?, ?, ?, ?, 0)`
        )
        .run(guestId, liveTaskId, 'post753.jpg', 'post753.jpg.jpg').lastInsertRowid;

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
  });

  it('all three flash columns exist after boot', () => {
    const cols = db
      .prepare('PRAGMA table_info(tasks)')
      .all()
      .map((c) => c.name);
    expect(cols).toContain('flash_start_at');
    expect(cols).toContain('flash_minutes');
    expect(cols).toContain('flash_bonus');
  });

  it('the pre-existing challenge task keeps every column it had, including special_date/special_bonus', () => {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(liveTaskId);
    expect(row.title).toBe('Post-753 Challenge Task');
    expect(row.sort_order).toBe(4);
    expect(row.worth).toBe(2);
    expect(row.special_mode).toBe('oneday');
    expect(row.special_date).toBe('2026-08-08');
    expect(row.special_bonus).toBe(3);
    // Never armed by this migration -- NULL, not a default that could be
    // mistaken for a real flash.
    expect(row.flash_start_at).toBeNull();
    expect(row.flash_minutes).toBeNull();
    expect(row.flash_bonus).toBeNull();
  });

  it('the pre-existing hidden task also survives untouched', () => {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(hiddenTaskId);
    expect(row.title).toBe('Post-753 Hidden Task');
    expect(row.special_mode).toBe('hidden');
    expect(row.special_date).toBeNull();
    expect(row.flash_start_at).toBeNull();
  });

  it('the pre-existing submission survives with its task_id intact', () => {
    const row = db.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId);
    expect(row).toBeTruthy();
    expect(row.task_id).toBe(liveTaskId);
    expect(row.guest_id).toBe(guestId);
    expect(row.photo_path).toBe('post753.jpg');
  });

  it('the pre-existing task badge survives with its task_id intact', () => {
    const row = db.prepare('SELECT * FROM badges WHERE id = ?').get(taskBadgeId);
    expect(row).toBeTruthy();
    expect(row.task_id).toBe(liveTaskId);
    expect(row.code).toBe(`TASK-${liveTaskId}`);
  });

  it('a flash task can be armed on the migrated database and round-trips its values', () => {
    const info = db
      .prepare(
        `INSERT INTO tasks (title, worth, flash_start_at, flash_minutes, flash_bonus)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run('New Flash Task', 1, '2026-08-08T18:00:00.000Z', 15, 2);
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid);
    expect(row.flash_start_at).toBe('2026-08-08T18:00:00.000Z');
    expect(row.flash_minutes).toBe(15);
    expect(row.flash_bonus).toBe(2);
  });

  it('no CHECK constraint gates the three flash columns (issue #761 plan step 1 design trade) -- an out-of-range value is accepted at the schema layer', () => {
    // Deliberately no schema guard here (see src/db.js's ensureTaskFlashColumns
    // comment): the all-three-or-none pairing and the 1-3 bonus range are
    // enforced by #763's write path and by tasks.flashState()'s read-side
    // defensive check, not by SQLite. A bonus of 99 and a half-populated row
    // are both legal database states this migration must not refuse.
    expect(() =>
      db
        .prepare(`INSERT INTO tasks (title, worth, flash_bonus) VALUES (?, ?, ?)`)
        .run('Half-set, out-of-range flash', 1, 99)
    ).not.toThrow();
  });

  it('a second run of the real exported guards against the already-migrated DB does not throw and does not duplicate columns', () => {
    expect(() => db.exec('ALTER TABLE tasks ADD COLUMN flash_start_at TEXT')).toThrow(
      /duplicate column/i
    );

    expect(() => dbModule.ensureTaskSpecialDayColumns()).not.toThrow();
    expect(() => dbModule.ensureTaskFlashColumns()).not.toThrow();

    const cols = db.prepare('PRAGMA table_info(tasks)').all();
    expect(cols.filter((c) => c.name === 'flash_start_at')).toHaveLength(1);
    expect(cols.filter((c) => c.name === 'flash_minutes')).toHaveLength(1);
    expect(cols.filter((c) => c.name === 'flash_bonus')).toHaveLength(1);

    // Idempotent end-to-end too: rows are untouched by the repeat run.
    expect(db.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId).task_id).toBe(
      liveTaskId
    );
  });
});

describe('AC1: flash migration on the pre-#753 shape (narrow special_mode CHECK, no special_date column, no flash columns) -- the shape that can actually fail', () => {
  // This is the ONLY shape where ensureTaskSpecialDayColumns() rebuilds
  // `tasks` (its own CREATE TABLE tasks_new block in src/db.js -- cited by
  // NAME, not line, issue #761 review fix) in the same boot as
  // ensureTaskFlashColumns() -- a flash guard called too early (before that
  // rebuild finishes) would have its ALTERed columns silently dropped when
  // the rebuild's explicit tasks_new column list runs. Same seed shape as
  // tests/oneday-challenge-migration.test.js.
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
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          title        TEXT    NOT NULL,
          description  TEXT    NOT NULL DEFAULT '',
          sort_order   INTEGER NOT NULL DEFAULT 0,
          worth        INTEGER NOT NULL DEFAULT 1 CHECK (worth BETWEEN 1 AND 3),
          special_mode TEXT    NOT NULL DEFAULT 'none' CHECK (special_mode IN ('none','hidden')),
          created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE submissions (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          guest_id    INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
          task_id     INTEGER REFERENCES tasks(id)  ON DELETE CASCADE,
          photo_path  TEXT    NOT NULL,
          thumb_path  TEXT    NOT NULL,
          caption     TEXT    NOT NULL DEFAULT '',
          taken_down  INTEGER NOT NULL DEFAULT 0,
          photo_bonus INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
          resubmitted INTEGER NOT NULL DEFAULT 0,
          CONSTRAINT uq_sub UNIQUE (guest_id, task_id)
        );
      `);

      const guestId = seedDb
        .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
        .run('flash-migration-pre753-guest', 'Pre753 Guest').lastInsertRowid;

      const liveTaskId = seedDb
        .prepare(
          `INSERT INTO tasks (title, description, sort_order, worth, special_mode) VALUES (?, ?, ?, ?, ?)`
        )
        .run('Pre-753 Live Task', 'has a real description', 7, 2, 'none').lastInsertRowid;

      const hiddenTaskId = seedDb
        .prepare(
          `INSERT INTO tasks (title, description, sort_order, worth, special_mode) VALUES (?, ?, ?, ?, ?)`
        )
        .run('Pre-753 Hidden Task', 'was already hidden', 9, 3, 'hidden').lastInsertRowid;

      const submissionId = seedDb
        .prepare(
          `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
           VALUES (?, ?, ?, ?, 0)`
        )
        .run(guestId, liveTaskId, 'pre753.jpg', 'pre753.jpg.jpg').lastInsertRowid;

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

  it('all three flash columns exist after boot, even though the tasks table was rebuilt mid-boot by an earlier migration', () => {
    const cols = db
      .prepare('PRAGMA table_info(tasks)')
      .all()
      .map((c) => c.name);
    expect(cols).toContain('special_date');
    expect(cols).toContain('special_bonus');
    expect(cols).toContain('flash_start_at');
    expect(cols).toContain('flash_minutes');
    expect(cols).toContain('flash_bonus');
  });

  it('the pre-existing live task keeps every column it had across BOTH migrations', () => {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(liveTaskId);
    expect(row.title).toBe('Pre-753 Live Task');
    expect(row.description).toBe('has a real description');
    expect(row.sort_order).toBe(7);
    expect(row.worth).toBe(2);
    expect(row.special_mode).toBe('none');
    expect(row.special_date).toBeNull();
    expect(row.special_bonus).toBeNull();
    expect(row.flash_start_at).toBeNull();
    expect(row.flash_minutes).toBeNull();
    expect(row.flash_bonus).toBeNull();
  });

  it('the pre-existing hidden task also survives', () => {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(hiddenTaskId);
    expect(row.title).toBe('Pre-753 Hidden Task');
    expect(row.special_mode).toBe('hidden');
    expect(row.flash_start_at).toBeNull();
  });

  it('the pre-existing submission still exists with its task_id intact', () => {
    const row = db.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId);
    expect(row).toBeTruthy();
    expect(row.task_id).toBe(liveTaskId);
    expect(row.guest_id).toBe(guestId);
  });

  it('the pre-existing task badge still exists with its task_id intact', () => {
    const row = db.prepare('SELECT * FROM badges WHERE id = ?').get(taskBadgeId);
    expect(row).toBeTruthy();
    expect(row.task_id).toBe(liveTaskId);
  });

  it('a flash task can be armed on the migrated database', () => {
    const info = db
      .prepare(
        `INSERT INTO tasks (title, worth, flash_start_at, flash_minutes, flash_bonus)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run('New Flash Task On Rebuilt DB', 1, '2026-08-09T12:00:00.000Z', 30, 1);
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid);
    expect(row.flash_start_at).toBe('2026-08-09T12:00:00.000Z');
    expect(row.flash_minutes).toBe(30);
    expect(row.flash_bonus).toBe(1);
  });

  it('a second run of the real exported guards is a no-op', () => {
    expect(() => dbModule.ensureTaskFlashColumns()).not.toThrow();
    const cols = db.prepare('PRAGMA table_info(tasks)').all();
    expect(cols.filter((c) => c.name === 'flash_start_at')).toHaveLength(1);
    expect(cols.filter((c) => c.name === 'flash_minutes')).toHaveLength(1);
    expect(cols.filter((c) => c.name === 'flash_bonus')).toHaveLength(1);
  });
});
