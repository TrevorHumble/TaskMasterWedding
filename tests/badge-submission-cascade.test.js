// tests/badge-submission-cascade.test.js
// Covers issue #713 acceptance criteria:
//   AC1 — deleting a submissions row deletes the guest_badges award row that
//         pointed at it (its points leave the total)
//   AC2 — a guest_badges row with submission_id NULL (system/auto/special
//         grant) is untouched by the migration: submission_id stays NULL and
//         points/note are unchanged
//   AC3 — migration proof: seeded copy of the real pre-#713 shape (submission_id
//         ON DELETE SET NULL) migrates so every row's id/guest_id/badge_id/
//         awarded_by/created_at/points/note survives byte-for-byte and only the
//         FK action changes to CASCADE
//   AC4 — covered by the repo-wide npm test/lint/format:check run, not here
//
// AC2/AC3 need a guest_badges table that genuinely predates this change
// (submission_id ON DELETE SET NULL) so the migration path is exercised for
// real, not just re-verified on an already-migrated table. Same approach as
// tests/guest-identity.test.js: create a temp DB file, open it standalone to
// lay down the OLD guest_badges shape (mirroring every column the real
// CREATE TABLE + ensureGuestBadgeAwardColumns carried before this issue),
// point DATA_DIR/DB_PATH at that same file, then require the real src/db.js
// fresh so its module-load code — including the real, exported
// ensureGuestBadgeSubmissionCascade — runs against the pre-existing
// old-shape table. This binds directly to the shipped migration rather than
// an inline copy of its logic.
//
// AC1 uses the SAME migrated connection (guest_badges is already CASCADE by
// the time AC1's block runs) rather than opening a second one, matching
// guest-identity.test.js's "one connection for the whole file" note.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

let dbModule;
let db;

// Seeded rows for AC2/AC3, keyed by their intended distinguishing trait.
const SEED_ROWS = [
  // id, guest_id, badge_id, awarded_by, created_at, points, note, submission_id
  [1, 1, 1, 'system', '2026-01-01 00:00:00', 5, null, 1],
  [2, 1, 2, 'admin', '2026-01-02 12:30:00', 10, 'nice catch', 2],
  // A system/special grant: no earning photo, non-default note (and points
  // deliberately left at the column default 0 — see badge id 3's comment
  // above for why this row's badge is 'special' rather than 'auto') to prove
  // the FK-cascade migration doesn't clobber them or the NULL.
  [3, 2, 3, 'system', '2026-01-03 08:15:00', 0, 'starter badge', null],
];

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-badge-cascade-test-'));
  const dbPath = path.join(dir, 'test.db');

  // Lay down guests/tasks/badges/submissions with their CURRENT (already
  // up-to-date) shape — none of those tables are under test here, and
  // db.js's module-load code prepares statements against every column they
  // carry today, so a trimmed-down stand-in for any of them throws "no such
  // column" before the guest_badges migration under test even runs. Only
  // guest_badges below is deliberately the OLD pre-#713 shape.
  const seedDb = new Database(dbPath);
  seedDb.pragma('foreign_keys = OFF');
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
      pinned        INTEGER NOT NULL DEFAULT 0,
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

    CREATE TABLE submissions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      guest_id    INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
      task_id     INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
      photo_path  TEXT    NOT NULL,
      thumb_path  TEXT    NOT NULL,
      caption     TEXT    NOT NULL DEFAULT '',
      taken_down  INTEGER NOT NULL DEFAULT 0,
      photo_bonus INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      CONSTRAINT uq_sub UNIQUE (guest_id, task_id)
    );

    CREATE TABLE guest_badges (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      guest_id    INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
      badge_id    INTEGER NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
      awarded_by  TEXT    NOT NULL CHECK (awarded_by IN ('system','admin')),
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      points      INTEGER NOT NULL DEFAULT 0,
      note        TEXT,
      submission_id INTEGER REFERENCES submissions(id) ON DELETE SET NULL,
      CONSTRAINT uq_gb UNIQUE (guest_id, badge_id)
    );
  `);

  seedDb
    .prepare(`INSERT INTO guests (id, token, name) VALUES (?, ?, ?)`)
    .run(1, 'seed-guest-1', 'Guest One');
  seedDb
    .prepare(`INSERT INTO guests (id, token, name) VALUES (?, ?, ?)`)
    .run(2, 'seed-guest-2', 'Guest Two');

  for (let i = 1; i <= 3; i += 1) {
    // Badge id 3 (row 3's badge, held at points=0) is deliberately type
    // 'special', not 'auto' — issue #709's own guarded backfill
    // (ensureAutoMetricBadgePointsBackfilled, also exercised by this same
    // require('../src/db') below) rewrites a held auto/metric row still at
    // points=0 to 1, which would otherwise falsify this file's "every row
    // survives byte-for-byte" claim for a fact this file isn't testing.
    const type = i === 3 ? 'special' : 'auto';
    seedDb
      .prepare(
        `INSERT INTO badges (id, code, name, type, art_path) VALUES (?, ?, ?, ?, 'badges/x.svg')`
      )
      .run(i, 'CODE' + i, 'Badge ' + i, type);
  }

  seedDb
    .prepare(
      `INSERT INTO submissions (id, guest_id, task_id, photo_path, thumb_path) VALUES (?, 1, NULL, ?, ?)`
    )
    .run(1, 'p1.jpg', 't1.jpg');
  seedDb
    .prepare(
      `INSERT INTO submissions (id, guest_id, task_id, photo_path, thumb_path) VALUES (?, 1, NULL, ?, ?)`
    )
    .run(2, 'p2.jpg', 't2.jpg');

  const insertGb = seedDb.prepare(`
    INSERT INTO guest_badges
      (id, guest_id, badge_id, awarded_by, created_at, points, note, submission_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of SEED_ROWS) {
    insertGb.run(...row);
  }
  seedDb.pragma('foreign_keys = ON');
  seedDb.close();

  process.env.DATA_DIR = dir;
  process.env.DB_PATH = dbPath;

  // Requiring src/db.js NOW runs its real module-load migrations —
  // including the real, exported ensureGuestBadgeSubmissionCascade —
  // against the old-shape table created above.
  dbModule = require('../src/db');
  db = dbModule.db;
});

afterAll(() => {
  dbModule.db.close();
  delete process.env.DATA_DIR;
  delete process.env.DB_PATH;
});

describe('AC3: migration preserves every row and flips the FK action to CASCADE', () => {
  it('every seeded row survives byte-for-byte (id/guest_id/badge_id/awarded_by/created_at/points/note/submission_id)', () => {
    for (const [
      id,
      guestId,
      badgeId,
      awardedBy,
      createdAt,
      points,
      note,
      submissionId,
    ] of SEED_ROWS) {
      const row = db.prepare(`SELECT * FROM guest_badges WHERE id = ?`).get(id);
      expect(row).toBeTruthy();
      expect(row.guest_id).toBe(guestId);
      expect(row.badge_id).toBe(badgeId);
      expect(row.awarded_by).toBe(awardedBy);
      expect(row.created_at).toBe(createdAt);
      expect(row.points).toBe(points);
      expect(row.note).toBe(note);
      expect(row.submission_id).toBe(submissionId);
    }
  });

  it('the submission_id FK on_delete action is now CASCADE', () => {
    const fks = db.prepare(`PRAGMA foreign_key_list(guest_badges)`).all();
    const submissionFk = fks.find((fk) => fk.table === 'submissions');
    expect(submissionFk).toBeTruthy();
    expect(submissionFk.on_delete).toBe('CASCADE');
  });

  it('the uq_gb UNIQUE(guest_id, badge_id) constraint still holds', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO guest_badges (guest_id, badge_id, awarded_by) VALUES (1, 1, 'system')`
        )
        .run()
    ).toThrow(/unique/i);
  });
});

describe('AC2: a NULL submission_id row (system/auto/special grant) is untouched', () => {
  it('stays NULL with its own points/note unchanged', () => {
    const row = db.prepare(`SELECT * FROM guest_badges WHERE id = 3`).get();
    expect(row.submission_id).toBeNull();
    expect(row.points).toBe(0);
    expect(row.note).toBe('starter badge');
  });
});

describe('AC1: deleting a submission cascades to its award row', () => {
  it('deleting the submissions row deletes the guest_badges row that pointed at it', () => {
    // Row id=1 points at submission id=1 (guest 1, 5 points).
    const before = db.prepare(`SELECT COUNT(*) AS c FROM guest_badges WHERE id = 1`).get();
    expect(before.c).toBe(1);

    db.prepare(`DELETE FROM submissions WHERE id = ?`).run(1);

    const after = db.prepare(`SELECT COUNT(*) AS c FROM guest_badges WHERE id = 1`).get();
    expect(after.c).toBe(0);

    // The unrelated award row (id=2, pointing at submission 2) is untouched —
    // proves the cascade is scoped to the deleted submission, not a wipe.
    const other = db.prepare(`SELECT * FROM guest_badges WHERE id = 2`).get();
    expect(other).toBeTruthy();
    expect(other.points).toBe(10);
  });
});

describe('Idempotency: the exported guard is a safe no-op on an already-migrated DB', () => {
  it('a second call does not throw and does not duplicate/alter the table', () => {
    expect(() => dbModule.ensureGuestBadgeSubmissionCascade()).not.toThrow();

    // guest_badges must still contain exactly the two surviving rows (id=1
    // was deleted by AC1's cascade above; id=2 and id=3 remain) — a re-run
    // that mistakenly re-ran the rebuild would not duplicate rows, but this
    // also confirms the table itself wasn't dropped/recreated empty.
    const rows = db.prepare(`SELECT id FROM guest_badges ORDER BY id`).all();
    expect(rows.map((r) => r.id)).toEqual([2, 3]);

    const fks = db.prepare(`PRAGMA foreign_key_list(guest_badges)`).all();
    const submissionFk = fks.find((fk) => fk.table === 'submissions');
    expect(submissionFk.on_delete).toBe('CASCADE');
  });
});
