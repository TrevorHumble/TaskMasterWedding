// tests/backup.test.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const { backupDatabase, backupPhotos, pruneBackups } = require('../scripts/backup');

// This test builds its own isolated temp DB/dirs directly with better-sqlite3
// rather than going through tests/helpers/testApp.js: backup.js operates on
// raw file paths (dbPath/uploadsDir/thumbsDir/backupDir), not the Express app,
// so there is no need to boot the app or its session middleware here.

const GUEST_COUNT = 8;
const SUBMISSION_COUNT = 25;
const GUEST_BADGE_COUNT = 4;
const UPLOAD_FILE_COUNT = 6;
const THUMB_FILE_COUNT = 6;

/**
 * Create a fresh temp "data/" layout (db file path + uploads/thumbs dirs,
 * none pre-created) so each test run is fully isolated from the real event
 * data and from other test files.
 * @returns {{ root: string, dbPath: string, uploadsDir: string, thumbsDir: string }}
 */
function makeTempLayout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-backup-test-'));
  return {
    root,
    dbPath: path.join(root, 'data', 'app.db'),
    uploadsDir: path.join(root, 'data', 'uploads'),
    thumbsDir: path.join(root, 'data', 'thumbs'),
    adminHashPath: path.join(root, 'data', 'admin.hash'),
  };
}

/**
 * Open (creating if needed) a DB at dbPath with the same schema shape as
 * src/db.js and the same pragmas (WAL + foreign_keys ON), so the backup
 * routine is exercised against a DB that behaves like the real one.
 * @param {string} dbPath
 * @returns {import('better-sqlite3').Database}
 */
function openSchemaDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE guests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL
    );
    CREATE TABLE submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guest_id INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      photo_path TEXT NOT NULL,
      thumb_path TEXT NOT NULL,
      CONSTRAINT uq_sub UNIQUE (guest_id, task_id)
    );
    CREATE TABLE badges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE
    );
    CREATE TABLE guest_badges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guest_id INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
      badge_id INTEGER NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
      CONSTRAINT uq_gb UNIQUE (guest_id, badge_id)
    );
  `);
  return db;
}

/**
 * Seed exactly GUEST_COUNT guests, SUBMISSION_COUNT submissions (spread across
 * enough tasks that 25 distinct (guest,task) pairs satisfy the UNIQUE
 * constraint), 2 badges, and GUEST_BADGE_COUNT guest_badges rows.
 * @param {import('better-sqlite3').Database} db
 */
function seedFixture(db) {
  const insertGuest = db.prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`);
  const guestIds = [];
  for (let i = 0; i < GUEST_COUNT; i++) {
    guestIds.push(insertGuest.run(`tok-${i}`, `Guest ${i}`).lastInsertRowid);
  }

  // 4 tasks x 8 guests = 32 possible (guest,task) pairs -- comfortably more
  // than the 25 distinct pairs UNIQUE(guest_id,task_id) requires.
  const insertTask = db.prepare(`INSERT INTO tasks (title) VALUES (?)`);
  const taskIds = [];
  for (let i = 0; i < 4; i++) {
    taskIds.push(insertTask.run(`Task ${i}`).lastInsertRowid);
  }

  const insertSubmission = db.prepare(
    `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path) VALUES (?, ?, ?, ?)`
  );
  let inserted = 0;
  outer: for (const taskId of taskIds) {
    for (const guestId of guestIds) {
      if (inserted >= SUBMISSION_COUNT) break outer;
      insertSubmission.run(guestId, taskId, `p${inserted}.jpg`, `t${inserted}.jpg`);
      inserted += 1;
    }
  }
  if (inserted !== SUBMISSION_COUNT) {
    throw new Error(`fixture bug: seeded ${inserted} submissions, expected ${SUBMISSION_COUNT}`);
  }

  const insertBadge = db.prepare(`INSERT INTO badges (code) VALUES (?)`);
  const badgeIds = [
    insertBadge.run('BLOOM').lastInsertRowid,
    insertBadge.run('BOUQUET').lastInsertRowid,
  ];

  const insertGuestBadge = db.prepare(
    `INSERT INTO guest_badges (guest_id, badge_id) VALUES (?, ?)`
  );
  for (let i = 0; i < GUEST_BADGE_COUNT; i++) {
    // Alternate badge id so both rows in `badges` are actually referenced.
    insertGuestBadge.run(guestIds[i], badgeIds[i % badgeIds.length]);
  }
}

/**
 * Write UPLOAD_FILE_COUNT small files under uploadsDir (created if needed).
 * @param {string} uploadsDir
 */
function seedUploadFiles(uploadsDir) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  for (let i = 0; i < UPLOAD_FILE_COUNT; i++) {
    fs.writeFileSync(path.join(uploadsDir, `photo-${i}.jpg`), `fake-bytes-${i}`);
  }
}

/**
 * Write THUMB_FILE_COUNT small files under thumbsDir (created if needed).
 * @param {string} thumbsDir
 */
function seedThumbFiles(thumbsDir) {
  fs.mkdirSync(thumbsDir, { recursive: true });
  for (let i = 0; i < THUMB_FILE_COUNT; i++) {
    fs.writeFileSync(path.join(thumbsDir, `thumb-${i}.jpg`), `fake-thumb-${i}`);
  }
}

/**
 * Write a fake admin.hash fixture at adminHashPath (parent dir created if
 * needed). Content is a fixed string standing in for a real bcrypt hash --
 * the test only cares that the bytes survive the round trip unchanged.
 * @param {string} adminHashPath
 */
function seedAdminHashFile(adminHashPath) {
  fs.mkdirSync(path.dirname(adminHashPath), { recursive: true });
  fs.writeFileSync(adminHashPath, 'fake-bcrypt-hash-$2b$10$abcdefghijklmnopqrstuv');
}

/**
 * Mirror the restore steps documented in docs/deploy.md's shipped shape
 * (issue #558): app.db (+ admin.hash, if present) comes from the chosen
 * timestamped DB snapshot; uploads/ and thumbs/ come from the shared,
 * append-only photo store at BACKUP_DIR/photos/ -- NOT from inside the
 * snapshot folder, which no longer carries a per-snapshot photo copy.
 * @param {string} snapshotDir - the chosen timestamped DB snapshot folder
 * @param {string} photoStoreDir - BACKUP_DIR/photos/
 * @param {string} restoredDataDir
 */
function restoreFromBackup(snapshotDir, photoStoreDir, restoredDataDir) {
  fs.mkdirSync(restoredDataDir, { recursive: true });
  fs.copyFileSync(path.join(snapshotDir, 'app.db'), path.join(restoredDataDir, 'app.db'));
  fs.cpSync(path.join(photoStoreDir, 'uploads'), path.join(restoredDataDir, 'uploads'), {
    recursive: true,
  });
  fs.cpSync(path.join(photoStoreDir, 'thumbs'), path.join(restoredDataDir, 'thumbs'), {
    recursive: true,
  });
  const snapshotAdminHash = path.join(snapshotDir, 'admin.hash');
  if (fs.existsSync(snapshotAdminHash)) {
    fs.copyFileSync(snapshotAdminHash, path.join(restoredDataDir, 'admin.hash'));
  }
}

describe('scripts/backup.js', () => {
  it('AC1/AC2: produces a consistent snapshot -- app.db alone reports the true submissions count', async () => {
    const { root, dbPath } = makeTempLayout();
    const db = openSchemaDb(dbPath);
    seedFixture(db);

    const backupDir = path.join(root, 'backups');
    const destDir = await backupDatabase({
      dbPath,
      backupDir,
      timestamp: '20260807-000000',
    });
    db.close();

    expect(destDir).toBe(path.join(backupDir, '20260807-000000'));
    const snapshotDbPath = path.join(destDir, 'app.db');
    expect(fs.existsSync(snapshotDbPath)).toBe(true);

    // AC2: open the snapshot read-only and confirm the exact count. If
    // backupDatabase had done a naive fs.copyFile of a WAL-mode app.db
    // instead of the online .backup(), this could read a torn/partial file
    // (0 rows, or a file SQLite refuses to open) instead of the true 25 --
    // so this assertion actually distinguishes "consistent snapshot" from
    // "torn copy".
    const snapshotDb = new Database(snapshotDbPath, { readonly: true });
    const count = snapshotDb.prepare('SELECT COUNT(*) AS n FROM submissions').get().n;
    snapshotDb.close();
    expect(count).toBe(SUBMISSION_COUNT);
  });

  it('AC3/AC4: restore into an emptied data/ recovers exact guests/submissions/guest_badges/file counts', async () => {
    const { root, dbPath, uploadsDir, thumbsDir, adminHashPath } = makeTempLayout();
    const db = openSchemaDb(dbPath);
    seedFixture(db);
    seedUploadFiles(uploadsDir);
    seedThumbFiles(thumbsDir);
    seedAdminHashFile(adminHashPath);
    const originalHashBytes = fs.readFileSync(adminHashPath);

    const backupDir = path.join(root, 'backups');
    const destDir = await backupDatabase({
      dbPath,
      adminHashPath,
      backupDir,
      timestamp: '20260807-010000',
    });
    backupPhotos({ uploadsDir, thumbsDir, backupDir });
    db.close();

    // Simulate the disaster: the live data/ directory is gone.
    fs.rmSync(path.join(root, 'data'), { recursive: true, force: true });
    expect(fs.existsSync(path.join(root, 'data'))).toBe(false);

    // Documented restore (issue #558's shipped shape): app.db + admin.hash
    // from the chosen DB snapshot, uploads/ + thumbs/ from the shared photo
    // store, back into a fresh data/.
    const restoredDataDir = path.join(root, 'data');
    const photoStoreDir = path.join(backupDir, 'photos');
    restoreFromBackup(destDir, photoStoreDir, restoredDataDir);

    const restoredDb = new Database(path.join(restoredDataDir, 'app.db'), { readonly: true });
    const guestCount = restoredDb.prepare('SELECT COUNT(*) AS n FROM guests').get().n;
    const submissionCount = restoredDb.prepare('SELECT COUNT(*) AS n FROM submissions').get().n;
    const guestBadgeCount = restoredDb.prepare('SELECT COUNT(*) AS n FROM guest_badges').get().n;
    restoredDb.close();

    expect(guestCount).toBe(GUEST_COUNT);
    expect(submissionCount).toBe(SUBMISSION_COUNT);
    expect(guestBadgeCount).toBe(GUEST_BADGE_COUNT);

    const restoredFiles = fs.readdirSync(path.join(restoredDataDir, 'uploads'));
    expect(restoredFiles.length).toBe(UPLOAD_FILE_COUNT);

    const restoredThumbs = fs.readdirSync(path.join(restoredDataDir, 'thumbs'));
    expect(restoredThumbs.length).toBe(THUMB_FILE_COUNT);

    // AC2 (#315), covered at the file layer: the exact credential the
    // /admin/login path reads via config.ADMIN_HASH_PATH must be present,
    // byte-identical, after restore -- otherwise the host is locked out of
    // /admin post-restore even though guests/photos are fine.
    const restoredHashBytes = fs.readFileSync(path.join(restoredDataDir, 'admin.hash'));
    expect(restoredHashBytes.equals(originalHashBytes)).toBe(true);
  });

  it('backupPhotos guards missing source directories instead of throwing (issue #558)', () => {
    const { root, uploadsDir, thumbsDir } = makeTempLayout();
    // uploadsDir and thumbsDir both left uncreated.
    const backupDir = path.join(root, 'backups');

    const copied = backupPhotos({ uploadsDir, thumbsDir, backupDir });

    expect(copied).toBe(0);
    expect(fs.existsSync(path.join(backupDir, 'photos', 'uploads'))).toBe(false);
    expect(fs.existsSync(path.join(backupDir, 'photos', 'thumbs'))).toBe(false);
  });

  it('AC1 (#315): copies admin.hash into the snapshot, byte-identical to the source', async () => {
    const { root, dbPath, adminHashPath } = makeTempLayout();
    const db = openSchemaDb(dbPath);
    seedFixture(db);
    db.close();
    seedAdminHashFile(adminHashPath);
    const sourceBytes = fs.readFileSync(adminHashPath);

    const backupDir = path.join(root, 'backups');
    const destDir = await backupDatabase({
      dbPath,
      adminHashPath,
      backupDir,
      timestamp: '20260807-030000',
    });

    const snapshotHashPath = path.join(destDir, 'admin.hash');
    expect(fs.existsSync(snapshotHashPath)).toBe(true);
    // Byte comparison, not just existence: if the copy silently truncated or
    // re-encoded the hash, the restored admin password would no longer match
    // what bcrypt originally produced, and this assertion would fail while a
    // plain existsSync check would not.
    const snapshotBytes = fs.readFileSync(snapshotHashPath);
    expect(snapshotBytes.equals(sourceBytes)).toBe(true);
  });

  it('guards a missing admin.hash instead of throwing (backup still succeeds with no admin.hash in the snapshot)', async () => {
    const { root, dbPath, adminHashPath } = makeTempLayout();
    const db = openSchemaDb(dbPath);
    seedFixture(db);
    db.close();
    // adminHashPath is deliberately never written -- exercises the
    // missing-source guard for an event that has never had an admin
    // password set.
    expect(fs.existsSync(adminHashPath)).toBe(false);

    const backupDir = path.join(root, 'backups');
    const destDir = await backupDatabase({
      dbPath,
      adminHashPath,
      backupDir,
      timestamp: '20260807-040000',
    });

    expect(fs.existsSync(path.join(destDir, 'app.db'))).toBe(true);
    expect(fs.existsSync(path.join(destDir, 'admin.hash'))).toBe(false);
  });
});

describe('pruneBackups (issue #287)', () => {
  let backupDir;

  beforeEach(() => {
    backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-prune-test-'));
  });

  afterEach(() => {
    fs.rmSync(backupDir, { recursive: true, force: true });
  });

  it('AC1: deletes the oldest snapshot, keeps the newest two intact', () => {
    const names = ['20260101-000000', '20260102-000000', '20260103-000000'];
    for (const name of names) {
      const dir = path.join(backupDir, name);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'app.db'), `contents-of-${name}`);
    }

    const deleted = pruneBackups({ backupDir, keep: 2 });

    // Assert the real value, not just "something happened": exactly the
    // oldest name comes back, in an array, not a count or a boolean.
    expect(deleted).toEqual(['20260101-000000']);
    expect(fs.existsSync(path.join(backupDir, '20260101-000000'))).toBe(false);
    // The two retained folders are not just present -- their contents
    // survived untouched, so this would fail if pruning were inverted and
    // deleted the newest two instead of the oldest one.
    expect(fs.existsSync(path.join(backupDir, '20260102-000000'))).toBe(true);
    expect(fs.readFileSync(path.join(backupDir, '20260102-000000', 'app.db'), 'utf8')).toBe(
      'contents-of-20260102-000000'
    );
    expect(fs.existsSync(path.join(backupDir, '20260103-000000'))).toBe(true);
    expect(fs.readFileSync(path.join(backupDir, '20260103-000000', 'app.db'), 'utf8')).toBe(
      'contents-of-20260103-000000'
    );
  });

  it('AC2: ignores a non-snapshot directory and a stray file regardless of keep value', () => {
    const names = ['20260101-000000', '20260102-000000', '20260103-000000'];
    for (const name of names) {
      fs.mkdirSync(path.join(backupDir, name));
    }
    fs.mkdirSync(path.join(backupDir, 'keep-me'));
    fs.writeFileSync(path.join(backupDir, 'notes.txt'), 'do not touch');

    const deleted = pruneBackups({ backupDir, keep: 1 });

    // Only snapshot-named directories are ever candidates -- keep-me and
    // notes.txt must never appear in the deleted list even with keep=1,
    // which would otherwise delete everything but one snapshot.
    expect(deleted).not.toContain('keep-me');
    expect(deleted).not.toContain('notes.txt');
    expect(fs.existsSync(path.join(backupDir, 'keep-me'))).toBe(true);
    expect(fs.existsSync(path.join(backupDir, 'notes.txt'))).toBe(true);
  });

  it('AC3: keep=0 (the config default) deletes nothing', () => {
    const names = ['20260101-000000', '20260102-000000', '20260103-000000'];
    for (const name of names) {
      fs.mkdirSync(path.join(backupDir, name));
    }

    const deleted = pruneBackups({ backupDir, keep: 0 });

    expect(deleted).toEqual([]);
    for (const name of names) {
      expect(fs.existsSync(path.join(backupDir, name))).toBe(true);
    }
  });

  it('no-ops instead of throwing when backupDir does not exist yet (fresh host, first run)', () => {
    const missingDir = path.join(backupDir, 'does-not-exist');
    expect(() => pruneBackups({ backupDir: missingDir, keep: 5 })).not.toThrow();
    expect(pruneBackups({ backupDir: missingDir, keep: 5 })).toEqual([]);
  });

  it('no-ops on a negative or non-finite keep instead of deleting everything', () => {
    fs.mkdirSync(path.join(backupDir, '20260101-000000'));
    expect(pruneBackups({ backupDir, keep: -1 })).toEqual([]);
    expect(pruneBackups({ backupDir, keep: NaN })).toEqual([]);
    expect(fs.existsSync(path.join(backupDir, '20260101-000000'))).toBe(true);
  });
});

describe('backup.js CLI (issue #287 AC4)', () => {
  let tempBackupDir;

  beforeEach(() => {
    tempBackupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-cli-backup-test-'));
  });

  afterEach(() => {
    // backupDatabase creates the destination snapshot folder before opening
    // the DB, so a run that fails to open a missing dbPath still leaves an
    // empty timestamped folder behind under tempBackupDir -- clean the whole
    // temp dir rather than asserting it is empty.
    fs.rmSync(tempBackupDir, { recursive: true, force: true });
  });

  it('exits nonzero and writes to stderr when dbPath does not exist', () => {
    const missingDbPath = path.join(tempBackupDir, 'nonexistent-app.db');
    const scriptPath = path.join(__dirname, '..', 'scripts', 'backup.js');

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        DB_PATH: missingDbPath,
        BACKUP_DIR: tempBackupDir,
      },
      encoding: 'utf8',
    });

    // Assert the real values -- a nonzero status code AND non-empty stderr,
    // not just "the process ran." This is a regression test over the CLI's
    // existing catch handler (process.exitCode = 1 + console.error), not new
    // behavior -- it would fail if a future change swallowed the error or
    // reset the exit code before exiting.
    expect(result.status).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});
