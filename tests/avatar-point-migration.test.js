// tests/avatar-point-migration.test.js
// Issue #716 AC4: a pre-existing database that still carries the retired
// `avatar_point_awarded` flag column must migrate to the derived rule with
// no double-count and no silently-kept ghost point.
//
// AC4: Given a pre-existing guest with avatar_point_awarded = 1 and an
//      avatar, When the migration runs, Then their total is unchanged
//      (banked point removed, derived point present); a pre-existing guest
//      with the flag set but NO avatar loses the ghost point.
//
// This needs a guests table that genuinely predates #716 (carries
// avatar_point_awarded, the CREATE TABLE above no longer does) so the real
// migration path (src/db.js's ensureAvatarPointAwardedRetired) runs for
// real, not just re-verified on an already-migrated table. Same approach as
// tests/guest-identity.test.js / tests/badge-submission-cascade.test.js:
// create a temp DB file, open it standalone to lay down the OLD guests
// shape, point DATA_DIR/DB_PATH at that same file, then require the real
// src/db.js fresh so its module-load code — including the real, exported
// ensureAvatarPointAwardedRetired — runs against the pre-existing old-shape
// table. This binds directly to the shipped migration rather than an inline
// copy of its logic.
//
// This stands ALONE from tests/profile-photo-task.test.js's AC1-3 (which use
// loadApp(), always a fresh already-migrated database) because re-requiring
// src/db.js a second time inside the same file does not reliably yield a
// second, independent connection (see guest-identity.test.js's file header).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

let dbModule;
let scoring;

// Four pre-existing guests covering every AC4-relevant combination:
//   A — flag set, HAS an avatar: total must be UNCHANGED after migration
//       (banked point removed from bonus_points, derived point picks it
//       right back up).
//   B — flag set, NO avatar: loses the ghost point (banked point removed,
//       nothing derived to replace it — this guest banked the point, then
//       removed their photo before the migration ran).
//   C — flag set, HAS an avatar, bonus_points already at the 0 floor: the
//       recorded, accepted design edge (issue #716's Design) — the -1 floors
//       at 0 (MAX(0, 0-1) = 0), then the derived +1 still applies, so this
//       guest nets +1 versus their pre-migration total. Not special-cased;
//       asserted here so the edge is documented, not silently exercised.
//   D — flag NEVER set, no avatar: completely unaffected by the migration.
let guestAId, guestBId, guestCId, guestDId;

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-avatar-point-migration-'));
  const dbPath = path.join(dir, 'test.db');

  // Lay down the guests table in its pre-#716 shape: every column the real
  // CREATE TABLE carries today, PLUS the retired avatar_point_awarded flag.
  const seedDb = new Database(dbPath);
  seedDb.exec(`
    CREATE TABLE guests (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      token         TEXT    NOT NULL UNIQUE,
      name          TEXT    NOT NULL DEFAULT '',
      avatar_path   TEXT,
      avatar_point_awarded INTEGER NOT NULL DEFAULT 0,
      social_links  TEXT    NOT NULL DEFAULT '{}',
      bonus_points  INTEGER NOT NULL DEFAULT 0,
      onboarded     INTEGER NOT NULL DEFAULT 0,
      contact       TEXT,
      contact_type  TEXT,
      pin           TEXT,
      pinned        INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const insert = seedDb.prepare(
    `INSERT INTO guests (token, name, avatar_path, avatar_point_awarded, bonus_points)
     VALUES (?, ?, ?, ?, ?)`
  );
  guestAId = insert.run('migration-a', 'Guest A', 'a-avatar.jpg', 1, 5).lastInsertRowid;
  guestBId = insert.run('migration-b', 'Guest B', null, 1, 3).lastInsertRowid;
  guestCId = insert.run('migration-c', 'Guest C', 'c-avatar.jpg', 1, 0).lastInsertRowid;
  guestDId = insert.run('migration-d', 'Guest D', null, 0, 2).lastInsertRowid;

  seedDb.close();

  process.env.DATA_DIR = dir;
  process.env.DB_PATH = dbPath;

  // Requiring src/db.js NOW runs its real module-load migrations —
  // including ensureAvatarPointAwardedRetired — against the old-shape table
  // created above.
  dbModule = require('../src/db');
  scoring = require('../src/services/scoring');
});

afterAll(() => {
  dbModule.db.close();
  delete process.env.DATA_DIR;
  delete process.env.DB_PATH;
});

function guestRow(id) {
  return dbModule.db.prepare('SELECT * FROM guests WHERE id = ?').get(id);
}

describe('AC4: migrating a pre-#716 database with banked avatar_point_awarded rows', () => {
  it('drops the retired avatar_point_awarded column', () => {
    const cols = dbModule.db.prepare('PRAGMA table_info(guests)').all();
    expect(cols.some((c) => c.name === 'avatar_point_awarded')).toBe(false);
  });

  it('guest A (flag set, has an avatar): total is unchanged — banked point removed, derived point present', () => {
    const row = guestAId && guestRow(guestAId);
    expect(row.avatar_path).toBe('a-avatar.jpg');
    // 5 banked -> 4 after the -1 subtraction; +1 derived brings it back to 5.
    expect(row.bonus_points).toBe(4);
    expect(scoring.getPoints(guestAId)).toBe(5);
  });

  it('guest B (flag set, NO avatar): loses the ghost point', () => {
    const row = guestRow(guestBId);
    expect(row.avatar_path).toBeNull();
    // 3 banked -> 2 after the -1 subtraction; nothing derived to replace it
    // (no avatar), so the total actually drops from 3 to 2.
    expect(row.bonus_points).toBe(2);
    expect(scoring.getPoints(guestBId)).toBe(2);
  });

  it('guest C (flag set, has an avatar, bonus_points already at 0): the floor-0 edge nets +1 — accepted, not special-cased', () => {
    const row = guestRow(guestCId);
    expect(row.avatar_path).toBe('c-avatar.jpg');
    // MAX(0, 0 - 1) = 0 — the floor holds. Pre-migration this guest's real
    // total (banked point already stripped out by admin deductions below the
    // stored floor) was 0; post-migration the derived +1 applies regardless,
    // netting +1. This is issue #716's Design-recorded, accepted edge.
    expect(row.bonus_points).toBe(0);
    expect(scoring.getPoints(guestCId)).toBe(1);
  });

  it('guest D (flag never set, no avatar): completely unaffected', () => {
    const row = guestRow(guestDId);
    expect(row.avatar_path).toBeNull();
    expect(row.bonus_points).toBe(2);
    expect(scoring.getPoints(guestDId)).toBe(2);
  });

  it('a second run of the real guard against the already-migrated DB does not throw', () => {
    // Same idempotency check every other guarded migration in this file
    // gets (see guest-identity.test.js AC1's sibling assertion): the column
    // is already gone, so PRAGMA table_info's guard makes this a no-op
    // rather than an "ALTER TABLE ... DROP COLUMN" on a column that no
    // longer exists.
    expect(() => dbModule.ensureAvatarPointAwardedRetired()).not.toThrow();
  });
});
