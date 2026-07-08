// tests/guest-identity.test.js
// Covers issue #239 acceptance criteria:
//   AC1 — ensureGuestIdentityColumns migrates a pre-#239 guests table (no
//         contact/contact_type/pin) in place, and a second run doesn't throw
//   AC2 — email normalization
//   AC3 — phone normalization (including US country-code stripping)
//   AC4 — garbage contact input is rejected
//   AC5 — PIN validation
//   AC6 — the partial unique index enforces contact uniqueness while letting
//         any number of NULL-contact rows coexist
//
// AC1 needs a guests table that genuinely predates this change (no identity
// columns) so the migration path is exercised for real, not just re-verified
// on an already-migrated table. loadApp() (tests/helpers/testApp.js) always
// builds a FRESH db, whose CREATE TABLE already includes the three columns —
// that would only prove idempotency, not migration. So this file skips
// loadApp() (which also pulls in src/app.js's multer/sharp upload pipeline,
// unneeded here) and instead: creates a temp DB file, opens it standalone to
// lay down the OLD guests shape, points DATA_DIR/DB_PATH at that same file,
// then requires the real src/db.js fresh so its module-load code — including
// the real, exported ensureGuestIdentityColumns — runs against that
// pre-existing old-shape table. This binds directly to the shipped migration
// rather than an inline copy of its logic.
//
// One db connection is opened ONCE for the whole file (not per describe
// block): re-requiring src/db.js a second time inside the same file does not
// reliably yield a second, independent connection, so AC1 and AC6 share the
// single migrated connection below rather than each trying to open their own.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { normalizeContact, isValidPin } = require('../src/services/identity');

let dbModule;

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-identity-test-'));
  const dbPath = path.join(dir, 'test.db');

  // Lay down the OLD guests shape (pre-#239: no contact/contact_type/pin),
  // mirroring every column the real CREATE TABLE carried before this issue.
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
      pinned        INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);
  seedDb.close();

  process.env.DATA_DIR = dir;
  process.env.DB_PATH = dbPath;

  // Requiring src/db.js NOW runs its real module-load migrations —
  // including ensureGuestIdentityColumns — against the old-shape table
  // created above.
  dbModule = require('../src/db');
});

afterAll(() => {
  dbModule.db.close();
  delete process.env.DATA_DIR;
  delete process.env.DB_PATH;
});

describe('AC1: ensureGuestIdentityColumns migrates a pre-#239 guests table', () => {
  it('adds contact, contact_type, and pin columns to a pre-existing guests table', () => {
    const cols = dbModule.db.prepare('PRAGMA table_info(guests)').all();
    const names = cols.map((c) => c.name);
    expect(names).toContain('contact');
    expect(names).toContain('contact_type');
    expect(names).toContain('pin');
  });

  it('a second run of the real guard against the same DB does not throw', () => {
    // A naked ALTER against the now-migrated table proves the guard is
    // load-bearing (this is what db.js would hit on a second boot if it did
    // not check PRAGMA table_info first), same pattern as
    // tests/per-photo-points.test.js AC1.
    expect(() => dbModule.db.exec('ALTER TABLE guests ADD COLUMN contact TEXT')).toThrow(
      /duplicate column/i
    );

    expect(() => dbModule.ensureGuestIdentityColumns()).not.toThrow();

    const cols = dbModule.db.prepare('PRAGMA table_info(guests)').all();
    expect(cols.filter((c) => c.name === 'contact').length).toBe(1);
    expect(cols.filter((c) => c.name === 'contact_type').length).toBe(1);
    expect(cols.filter((c) => c.name === 'pin').length).toBe(1);
  });
});

describe('AC2-AC4: normalizeContact', () => {
  it.each([
    [' Lilly@Example.COM ', { type: 'email', value: 'lilly@example.com' }],
    ['(208) 555-0142', { type: 'phone', value: '2085550142' }],
    ['+1 208 555 0142', { type: 'phone', value: '2085550142' }],
    ['not-a-contact', null],
    ['', null],
    ['123', null],
  ])('normalizeContact(%j) === %j', (input, expected) => {
    expect(normalizeContact(input)).toEqual(expected);
  });
});

describe('AC5: isValidPin', () => {
  it.each([
    ['0412', true],
    ['12345', false],
    ['12a4', false],
    ['', false],
  ])('isValidPin(%j) === %j', (input, expected) => {
    expect(isValidPin(input)).toBe(expected);
  });
});

describe('AC6: partial unique index enforces contact uniqueness', () => {
  it('a second row with the same non-null contact throws a uniqueness violation', () => {
    dbModule.db
      .prepare(`INSERT INTO guests (token, name, contact) VALUES (?, ?, ?)`)
      .run('ac6-token-1', 'AC6 Guest One', 'lilly@example.com');

    expect(() =>
      dbModule.db
        .prepare(`INSERT INTO guests (token, name, contact) VALUES (?, ?, ?)`)
        .run('ac6-token-2', 'AC6 Guest Two', 'lilly@example.com')
    ).toThrow(/unique/i);
  });

  it('two rows with contact = NULL both succeed', () => {
    expect(() =>
      dbModule.db
        .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
        .run('ac6-token-3', 'AC6 Guest Three')
    ).not.toThrow();

    expect(() =>
      dbModule.db
        .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
        .run('ac6-token-4', 'AC6 Guest Four')
    ).not.toThrow();

    const nullContactCount = dbModule.db
      .prepare(`SELECT COUNT(*) AS n FROM guests WHERE contact IS NULL`)
      .get().n;
    expect(nullContactCount).toBeGreaterThanOrEqual(2);
  });
});
