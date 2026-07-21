// tests/oneday-challenge-migration.test.js
// Issue #753 AC1: ensureTaskSpecialDayColumns() + ensureSubmissionsBonusColumns()
// migrate a database that has ALREADY run #727 (worth/special_mode exist,
// narrow CHECK IN ('none','hidden')) but not yet #753 — the exact deployed
// app.db shape this issue's implementation plan warns about: a naive
// column-presence guard (like ensureTaskWorthAndMode's own) would never fire
// on this shape, since special_mode already exists.
//
// Follows the same minimal-seed-then-require-db.js-fresh pattern as
// tests/task-worth-mode-migration.test.js, but pre-creates FOUR tables (not
// just the one under direct migration) in their real POST-#727/PRE-#753
// shape — guests, tasks, submissions, badges — so this test can seed a real
// submission and a real task badge BEFORE the migration runs, and then prove
// AC1's stronger claim: not just "the columns appear" but "every existing
// task/submission/badge row, and every column on it, survives the rebuild
// with task_id intact."
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

let dbModule;
let db;
let guestId;
let liveTaskId;
let hiddenTaskId;
let submissionId;
let taskBadgeId;

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-oneday-migration-test-'));
  const dbPath = path.join(dir, 'test.db');

  // Lay down the real POST-#727/PRE-#753 shape for every table this
  // migration (or its fixture) touches. Every OTHER table (likes, comments,
  // guest_badges, settings, ...) does not exist yet in this fresh file, so
  // db.js's own `CREATE TABLE IF NOT EXISTS` block creates them fresh, with
  // no rows, the moment it is required below.
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
  `);

  guestId = seedDb
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run('oneday-migration-guest', 'Migration Guest').lastInsertRowid;

  liveTaskId = seedDb
    .prepare(
      `INSERT INTO tasks (title, description, sort_order, worth, special_mode) VALUES (?, ?, ?, ?, ?)`
    )
    .run('Pre-753 Live Task', 'has a real description', 7, 2, 'none').lastInsertRowid;

  hiddenTaskId = seedDb
    .prepare(
      `INSERT INTO tasks (title, description, sort_order, worth, special_mode) VALUES (?, ?, ?, ?, ?)`
    )
    .run('Pre-753 Hidden Task', 'was already hidden', 9, 3, 'hidden').lastInsertRowid;

  submissionId = seedDb
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, 0)`
    )
    .run(guestId, liveTaskId, 'pre753.jpg', 'pre753.jpg.jpg').lastInsertRowid;

  taskBadgeId = seedDb
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

  seedDb.close();

  process.env.DATA_DIR = dir;
  process.env.DB_PATH = dbPath;

  // Requiring src/db.js NOW runs its real module-load migrations — including
  // the real, exported ensureTaskSpecialDayColumns and
  // ensureSubmissionsBonusColumns — against the old-shape tables above.
  dbModule = require('../src/db');
  db = dbModule.db;
});

afterAll(() => {
  dbModule.db.close();
  delete process.env.DATA_DIR;
  delete process.env.DB_PATH;
});

describe('AC1: the one-day-only migration widens a real post-#727 database', () => {
  it('tasks.special_date/special_bonus and submissions.bonus_amount/bonus_reason now exist', () => {
    const taskCols = db
      .prepare('PRAGMA table_info(tasks)')
      .all()
      .map((c) => c.name);
    expect(taskCols).toContain('special_date');
    expect(taskCols).toContain('special_bonus');

    const subCols = db
      .prepare('PRAGMA table_info(submissions)')
      .all()
      .map((c) => c.name);
    expect(subCols).toContain('bonus_amount');
    expect(subCols).toContain('bonus_reason');
  });

  it('the pre-existing live task keeps every column it had (id, title, description, sort_order, worth, special_mode, created_at)', () => {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(liveTaskId);
    expect(row).toBeTruthy();
    expect(row.title).toBe('Pre-753 Live Task');
    expect(row.description).toBe('has a real description');
    expect(row.sort_order).toBe(7);
    expect(row.worth).toBe(2);
    expect(row.special_mode).toBe('none');
    expect(row.created_at).toBeTruthy();
    // Neither existed before this migration — both are NULL for a
    // pre-existing ordinary task, never a default that could be mistaken
    // for a real challenge date/bonus.
    expect(row.special_date).toBeNull();
    expect(row.special_bonus).toBeNull();
  });

  it('the pre-existing hidden task also keeps every column it had', () => {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(hiddenTaskId);
    expect(row.title).toBe('Pre-753 Hidden Task');
    expect(row.sort_order).toBe(9);
    expect(row.worth).toBe(3);
    expect(row.special_mode).toBe('hidden');
    expect(row.special_date).toBeNull();
  });

  it('a oneday task inserts successfully on the migrated database', () => {
    const info = db
      .prepare(
        `INSERT INTO tasks (title, worth, special_mode, special_date, special_bonus)
         VALUES (?, ?, 'oneday', ?, ?)`
      )
      .run('New One-Day Task', 1, '2026-08-08', 2);
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid);
    expect(row.special_mode).toBe('oneday');
    expect(row.special_date).toBe('2026-08-08');
    expect(row.special_bonus).toBe(2);
  });

  it('the pre-existing submission still exists with its task_id intact', () => {
    const row = db.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId);
    expect(row).toBeTruthy();
    expect(row.task_id).toBe(liveTaskId);
    expect(row.guest_id).toBe(guestId);
    expect(row.photo_path).toBe('pre753.jpg');
    expect(row.bonus_amount).toBe(0);
    expect(row.bonus_reason).toBeNull();
  });

  it('the pre-existing task badge still exists with its task_id intact', () => {
    const row = db.prepare('SELECT * FROM badges WHERE id = ?').get(taskBadgeId);
    expect(row).toBeTruthy();
    expect(row.task_id).toBe(liveTaskId);
    expect(row.code).toBe(`TASK-${liveTaskId}`);
  });

  it('a second run of both real guards against the already-migrated DB does not throw and does not duplicate columns', () => {
    expect(() => db.exec('ALTER TABLE tasks ADD COLUMN special_date TEXT')).toThrow(
      /duplicate column/i
    );
    expect(() => db.exec('ALTER TABLE submissions ADD COLUMN bonus_amount INTEGER')).toThrow(
      /duplicate column/i
    );

    expect(() => dbModule.ensureTaskSpecialDayColumns()).not.toThrow();
    expect(() => dbModule.ensureSubmissionsBonusColumns()).not.toThrow();

    const taskCols = db.prepare('PRAGMA table_info(tasks)').all();
    expect(taskCols.filter((c) => c.name === 'special_date')).toHaveLength(1);
    expect(taskCols.filter((c) => c.name === 'special_bonus')).toHaveLength(1);

    const subCols = db.prepare('PRAGMA table_info(submissions)').all();
    expect(subCols.filter((c) => c.name === 'bonus_amount')).toHaveLength(1);
    expect(subCols.filter((c) => c.name === 'bonus_reason')).toHaveLength(1);

    // Booting is idempotent end-to-end too: rows are untouched by the repeat run.
    expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n).toBe(3);
    expect(db.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId).task_id).toBe(
      liveTaskId
    );
  });

  it('the widened special_mode CHECK still rejects an unknown mode, and special_bonus is capped 1-3', () => {
    expect(() =>
      db.prepare('INSERT INTO tasks (title, special_mode) VALUES (?, ?)').run('Bad mode', 'lucky')
    ).toThrow(/CHECK/i);
    expect(() =>
      db
        .prepare(
          'INSERT INTO tasks (title, special_mode, special_date, special_bonus) VALUES (?, ?, ?, ?)'
        )
        .run('Bad bonus', 'oneday', '2026-08-09', 5)
    ).toThrow(/CHECK/i);
  });

  it('the rebuilt table also carries the special_date/special_bonus pairing CHECK (review fix) -- a half-populated row is rejected here too, not just on a fresh CREATE TABLE', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO tasks (title, special_mode, special_date, special_bonus)
           VALUES (?, 'oneday', ?, NULL)`
        )
        .run('Half-set on rebuilt table', '2026-08-09')
    ).toThrow(/CHECK/i);
  });
});
