// tests/backup-split.test.js
// Issue #558: split scripts/backup.js into an inexpensive, frequent DB
// snapshot and an incremental, shared photo store, plus the pre-flight
// disk-budget guard both share. This file covers AC1-AC5; the pre-existing
// WAL-safety and prune-after-success behavior stays covered by
// tests/backup.test.js (issue #558's AC7).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const {
  backupPhotos,
  pruneBackups,
  planBackup,
  parseArgs,
  runBackup,
  UNBOUNDED,
} = require('../scripts/backup');
const { setFreeSpaceReader } = require('../src/utils/free-space');

/**
 * Fresh temp "data/" + "backups/" layout, none pre-created.
 * @returns {{ root: string, dbPath: string, uploadsDir: string, thumbsDir: string, adminHashPath: string, backupDir: string }}
 */
function makeLayout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-backup-split-test-'));
  return {
    root,
    dbPath: path.join(root, 'data', 'app.db'),
    uploadsDir: path.join(root, 'data', 'uploads'),
    thumbsDir: path.join(root, 'data', 'thumbs'),
    adminHashPath: path.join(root, 'data', 'admin.hash'),
    backupDir: path.join(root, 'backups'),
  };
}

/**
 * Create a real (tiny, schema-only) sqlite file at dbPath, so
 * backupDatabase's better-sqlite3 online-backup call has a real database to
 * read rather than a plain text stand-in.
 * @param {string} dbPath
 * @returns {number} the created file's size in bytes
 */
function makeRealDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('seed-row');
  db.close();
  return fs.statSync(dbPath).size;
}

/**
 * Write `content` as a file named `name` directly under `dir` (creating dir
 * if needed) and return its byte size.
 * @param {string} dir
 * @param {string} name
 * @param {string} content
 * @returns {number}
 */
function writeFile(dir, name, content) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return fs.statSync(p).size;
}

afterEach(() => {
  // Restore the real fs.statfs reader so a stub injected by one test can
  // never leak into the next (mirrors tests/memories.test.js's own pattern).
  setFreeSpaceReader(null);
});

describe('AC1: --db-only copies no photos', () => {
  it('writes app.db (+ admin.hash) and touches no uploads/thumbs anywhere', async () => {
    const { dbPath, uploadsDir, thumbsDir, adminHashPath, backupDir } = makeLayout();
    makeRealDb(dbPath);
    writeFile(uploadsDir, 'photo-1.jpg', 'upload-bytes-1');
    writeFile(uploadsDir, 'photo-2.jpg', 'upload-bytes-2');
    writeFile(thumbsDir, 'thumb-1.jpg', 'thumb-bytes-1');
    fs.mkdirSync(path.dirname(adminHashPath), { recursive: true });
    fs.writeFileSync(adminHashPath, 'fake-hash');
    setFreeSpaceReader(() => 10 * 1024 * 1024 * 1024); // ample, deterministic

    const result = await runBackup({
      mode: 'db-only',
      dbPath,
      uploadsDir,
      thumbsDir,
      adminHashPath,
      backupDir,
      retentionCount: 0,
      retentionCountEnv: undefined,
      timestamp: '20260807-000000',
    });

    expect(result.destDir).toBe(path.join(backupDir, '20260807-000000'));
    expect(fs.existsSync(path.join(result.destDir, 'app.db'))).toBe(true);
    expect(fs.existsSync(path.join(result.destDir, 'admin.hash'))).toBe(true);
    expect(fs.existsSync(path.join(result.destDir, 'uploads'))).toBe(false);
    expect(fs.existsSync(path.join(result.destDir, 'thumbs'))).toBe(false);
    // The shared photo store must never even be created by a db-only run.
    expect(fs.existsSync(path.join(backupDir, 'photos'))).toBe(false);
    expect(result.photosCopied).toBe(0);
  });

  it('rejects --db-only and --photos-only passed together, exits with a clear message, runs no copy', () => {
    const parsed = parseArgs(['--db-only', '--photos-only']);
    expect(parsed.mode).toBeUndefined();
    expect(typeof parsed.error).toBe('string');
    expect(parsed.error.length).toBeGreaterThan(0);
  });
});

describe('AC2: incremental photo store -- a re-run copies only new files', () => {
  it('copies exactly the files present on the first run, then exactly one more after one new file is added', async () => {
    const { dbPath, uploadsDir, thumbsDir, adminHashPath, backupDir } = makeLayout();
    makeRealDb(dbPath);
    writeFile(uploadsDir, 'a.jpg', 'aaaa');
    writeFile(uploadsDir, 'b.jpg', 'bbbb');
    writeFile(uploadsDir, 'c.jpg', 'cccc');
    writeFile(thumbsDir, 'ta.jpg', 't-aaaa');
    setFreeSpaceReader(() => 10 * 1024 * 1024 * 1024);

    const first = await runBackup({
      mode: 'default',
      dbPath,
      uploadsDir,
      thumbsDir,
      adminHashPath,
      backupDir,
      retentionCount: 0,
      retentionCountEnv: undefined,
      timestamp: '20260807-000000',
    });
    // 3 uploads + 1 thumb, none previously in the store.
    expect(first.photosCopied).toBe(4);
    const storedUploadsAfterFirst = fs.readdirSync(path.join(backupDir, 'photos', 'uploads'));
    expect(storedUploadsAfterFirst.length).toBe(3);

    // Exactly one new file added to uploads/.
    writeFile(uploadsDir, 'd.jpg', 'dddd');

    const second = await runBackup({
      mode: 'default',
      dbPath,
      uploadsDir,
      thumbsDir,
      adminHashPath,
      backupDir,
      retentionCount: 0,
      retentionCountEnv: undefined,
      timestamp: '20260807-010000',
    });

    // Asserted via the copy-counting return value, not wall-clock timing.
    expect(second.photosCopied).toBe(1);
    const storedUploadsAfterSecond = fs.readdirSync(path.join(backupDir, 'photos', 'uploads'));
    expect(storedUploadsAfterSecond.length).toBe(4);
    expect(storedUploadsAfterSecond.sort()).toEqual(['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']);
    // The three previously-backed-up files are untouched, not re-copied.
    expect(fs.readFileSync(path.join(backupDir, 'photos', 'uploads', 'a.jpg'), 'utf8')).toBe(
      'aaaa'
    );
  });

  it('--photos-only backs up new photos and touches no DB snapshot', async () => {
    const { dbPath, uploadsDir, thumbsDir, backupDir } = makeLayout();
    makeRealDb(dbPath);
    writeFile(uploadsDir, 'only.jpg', 'only-bytes');
    setFreeSpaceReader(() => 10 * 1024 * 1024 * 1024);

    const result = await runBackup({
      mode: 'photos-only',
      dbPath,
      uploadsDir,
      thumbsDir,
      backupDir,
      retentionCount: 0,
      retentionCountEnv: undefined,
    });

    expect(result.destDir).toBeNull();
    expect(result.photosCopied).toBe(1);
    // No timestamped snapshot directory of any kind was created.
    const entries = fs.readdirSync(backupDir);
    expect(entries).toEqual(['photos']);
  });
});

describe('AC3: DB retention never touches the photo store', () => {
  it('5 --db-only runs at keep=3 leave exactly 3 snapshots, photo store byte-for-byte unchanged', async () => {
    const { dbPath, uploadsDir, thumbsDir, backupDir } = makeLayout();
    makeRealDb(dbPath);
    writeFile(uploadsDir, 'p1.jpg', 'p1');
    writeFile(uploadsDir, 'p2.jpg', 'p2');
    setFreeSpaceReader(() => 10 * 1024 * 1024 * 1024);

    // Seed the shared photo store once via a photos-only run.
    await runBackup({
      mode: 'photos-only',
      dbPath,
      uploadsDir,
      thumbsDir,
      backupDir,
      retentionCount: 0,
      retentionCountEnv: undefined,
    });
    const storeUploadsBefore = fs.readdirSync(path.join(backupDir, 'photos', 'uploads')).sort();
    expect(storeUploadsBefore).toEqual(['p1.jpg', 'p2.jpg']);

    const timestamps = [
      '20260101-000000',
      '20260102-000000',
      '20260103-000000',
      '20260104-000000',
      '20260105-000000',
    ];
    for (const timestamp of timestamps) {
      await runBackup({
        mode: 'db-only',
        dbPath,
        uploadsDir,
        thumbsDir,
        backupDir,
        retentionCount: 3,
        retentionCountEnv: '3',
        timestamp,
      });
    }

    const entries = fs.readdirSync(backupDir, { withFileTypes: true });
    const snapshotDirs = entries
      .filter((e) => e.isDirectory() && /^\d{8}-\d{6}$/.test(e.name))
      .map((e) => e.name)
      .sort();
    expect(snapshotDirs).toEqual(['20260103-000000', '20260104-000000', '20260105-000000']);

    // photos/ itself must still exist -- not swept up as a "prunable" name --
    // and its contents are byte-for-byte what they were before any pruning.
    expect(entries.some((e) => e.isDirectory() && e.name === 'photos')).toBe(true);
    const storeUploadsAfter = fs.readdirSync(path.join(backupDir, 'photos', 'uploads')).sort();
    expect(storeUploadsAfter).toEqual(storeUploadsBefore);
    expect(fs.readFileSync(path.join(backupDir, 'photos', 'uploads', 'p1.jpg'), 'utf8')).toBe('p1');
  });

  it("pruneBackups never deletes a 'photos' directory sitting alongside timestamped snapshots", () => {
    const { backupDir } = makeLayout();
    fs.mkdirSync(path.join(backupDir, '20260101-000000'), { recursive: true });
    fs.mkdirSync(path.join(backupDir, '20260102-000000'), { recursive: true });
    fs.mkdirSync(path.join(backupDir, 'photos', 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'photos', 'uploads', 'keep.jpg'), 'keep-me');

    // keep=1 would normally delete every snapshot but the newest -- confirm
    // 'photos' is never even a deletion candidate, regardless of keep.
    const deleted = pruneBackups({ backupDir, keep: 1 });

    expect(deleted).not.toContain('photos');
    expect(fs.existsSync(path.join(backupDir, 'photos', 'uploads', 'keep.jpg'))).toBe(true);
  });
});

describe('AC4: refuses to fill the disk, in any mode, before starting any copy', () => {
  it.each(['db-only', 'photos-only', 'default'])(
    'mode=%s aborts non-zero, copies nothing, leaves existing snapshots/store/live data untouched',
    async (mode) => {
      const { dbPath, uploadsDir, thumbsDir, adminHashPath, backupDir } = makeLayout();
      makeRealDb(dbPath);
      writeFile(uploadsDir, 'x.jpg', 'x-bytes-that-are-not-empty');
      writeFile(thumbsDir, 'tx.jpg', 'tx-bytes-that-are-not-empty');

      // A pre-existing snapshot and a pre-existing store entry, so "leaves
      // existing ... untouched" has something concrete to check.
      fs.mkdirSync(path.join(backupDir, '20260101-000000'), { recursive: true });
      fs.writeFileSync(path.join(backupDir, '20260101-000000', 'app.db'), 'old-snapshot');
      fs.mkdirSync(path.join(backupDir, 'photos', 'uploads'), { recursive: true });
      fs.writeFileSync(path.join(backupDir, 'photos', 'uploads', 'already-there.jpg'), 'old');

      const entriesBefore = fs.readdirSync(backupDir).sort();
      const storeUploadsBefore = fs.readdirSync(path.join(backupDir, 'photos', 'uploads')).sort();

      // Free space reader reports 1 byte free -- far below any of the three
      // modes' required bytes given the seeded db/photo files above.
      setFreeSpaceReader(() => 1);

      await expect(
        runBackup({
          mode,
          dbPath,
          uploadsDir,
          thumbsDir,
          adminHashPath,
          backupDir,
          retentionCount: 0,
          retentionCountEnv: undefined,
          timestamp: '20260108-000000',
        })
      ).rejects.toThrow(/1 bytes free/);

      const entriesAfter = fs.readdirSync(backupDir).sort();
      expect(entriesAfter).toEqual(entriesBefore);
      // No new timestamped snapshot appeared.
      expect(entriesAfter).not.toContain('20260108-000000');
      // The pre-existing snapshot is byte-for-byte untouched.
      expect(fs.readFileSync(path.join(backupDir, '20260101-000000', 'app.db'), 'utf8')).toBe(
        'old-snapshot'
      );
      // The photo store gained no new file.
      const storeUploadsAfter = fs.readdirSync(path.join(backupDir, 'photos', 'uploads')).sort();
      expect(storeUploadsAfter).toEqual(storeUploadsBefore);
    }
  );

  it('the abort message names both the free bytes and the bytes needed', async () => {
    const { dbPath, uploadsDir, thumbsDir, backupDir } = makeLayout();
    const dbBytes = makeRealDb(dbPath);
    setFreeSpaceReader(() => 5);

    await expect(
      runBackup({
        mode: 'db-only',
        dbPath,
        uploadsDir,
        thumbsDir,
        backupDir,
        retentionCount: 0,
        retentionCountEnv: undefined,
        timestamp: '20260108-000000',
      })
    ).rejects.toThrow(new RegExp(`5 bytes free.*${dbBytes} bytes`));
  });
});

describe('AC5: pre-flight sizing reflects what the run will actually write', () => {
  it('requiredBytes matches D / S_new / D+S_new for db-only / photos-only / default', () => {
    const { dbPath, uploadsDir, thumbsDir, backupDir } = makeLayout();
    const dbBytes = makeRealDb(dbPath);
    const u1 = writeFile(uploadsDir, 'u1.jpg', 'u-one-bytes');
    const u2 = writeFile(uploadsDir, 'u2.jpg', 'u-two-bytes-longer');
    const t1 = writeFile(thumbsDir, 't1.jpg', 't-one');
    const newPhotoBytes = u1 + u2 + t1; // nothing in the store yet -> S_new === S

    const dbOnly = planBackup({
      mode: 'db-only',
      dbPath,
      uploadsDir,
      thumbsDir,
      backupDir,
      retentionCountEnv: '5',
    });
    expect(dbOnly.requiredBytes).toBe(dbBytes);

    const photosOnly = planBackup({
      mode: 'photos-only',
      dbPath,
      uploadsDir,
      thumbsDir,
      backupDir,
      retentionCountEnv: '5',
    });
    expect(photosOnly.requiredBytes).toBe(newPhotoBytes);

    const defaultMode = planBackup({
      mode: 'default',
      dbPath,
      uploadsDir,
      thumbsDir,
      backupDir,
      retentionCountEnv: '5',
    });
    expect(defaultMode.requiredBytes).toBe(dbBytes + newPhotoBytes);

    // Same operator-facing formula regardless of mode: S + (N + 1) x D.
    const expectedProjection = newPhotoBytes + (5 + 1) * dbBytes;
    expect(dbOnly.projectedRetainedTotal).toBe(expectedProjection);
    expect(photosOnly.projectedRetainedTotal).toBe(expectedProjection);
    expect(defaultMode.projectedRetainedTotal).toBe(expectedProjection);
  });

  it('S_new shrinks to 0 once the store catches up, but the projected total keeps counting the FULL live set S', () => {
    const { dbPath, uploadsDir, thumbsDir, backupDir } = makeLayout();
    const dbBytes = makeRealDb(dbPath);
    const u1 = writeFile(uploadsDir, 'u1.jpg', 'abcdef');

    backupPhotos({ uploadsDir, thumbsDir, backupDir }); // store now has everything live has

    const plan = planBackup({
      mode: 'photos-only',
      dbPath,
      uploadsDir,
      thumbsDir,
      backupDir,
      retentionCountEnv: '2',
    });
    expect(plan.requiredBytes).toBe(0); // S_new === 0, nothing left to copy
    // projectedRetainedTotal still counts the full live set S (u1), not the
    // per-run S_new -- the photo term must never be discounted to what this
    // particular run happens to still need to copy.
    expect(plan.projectedRetainedTotal).toBe(u1 + (2 + 1) * dbBytes);
  });

  it('unset BACKUP_RETENTION_COUNT reports the projected total as unbounded, not a number, and does not weaken AC4', async () => {
    const { dbPath, uploadsDir, thumbsDir, backupDir } = makeLayout();
    makeRealDb(dbPath);
    writeFile(uploadsDir, 'u1.jpg', 'abcdef');

    const planUnset = planBackup({
      mode: 'default',
      dbPath,
      uploadsDir,
      thumbsDir,
      backupDir,
      retentionCountEnv: undefined,
    });
    expect(planUnset.projectedRetainedTotal).toBe(UNBOUNDED);
    expect(planUnset.projectedRetainedTotal).not.toBe(0);
    expect(typeof planUnset.projectedRetainedTotal).not.toBe('number');

    // Blank string counts as "operator gave no value" too.
    const planBlank = planBackup({
      mode: 'default',
      dbPath,
      uploadsDir,
      thumbsDir,
      backupDir,
      retentionCountEnv: '  ',
    });
    expect(planBlank.projectedRetainedTotal).toBe(UNBOUNDED);

    // requiredBytes (what AC4 actually gates on) is unaffected by retention
    // being unset, and the abort still fires under a too-small free-space
    // reading.
    setFreeSpaceReader(() => 1);
    await expect(
      runBackup({
        mode: 'default',
        dbPath,
        uploadsDir,
        thumbsDir,
        backupDir,
        retentionCount: 0, // config.js's own coercion of an unset env var
        retentionCountEnv: undefined,
        timestamp: '20260108-000000',
      })
    ).rejects.toThrow(/1 bytes free/);
    expect(fs.existsSync(path.join(backupDir, '20260108-000000'))).toBe(false);
  });

  it('reports UNBOUNDED for an explicit 0, negative, or non-numeric retention -- matching pruneBackups keep<=0 semantics', () => {
    const { dbPath, uploadsDir, thumbsDir, backupDir } = makeLayout();
    makeRealDb(dbPath);
    writeFile(uploadsDir, 'u1.jpg', 'abcdef');

    // pruneBackups treats keep <= 0 (and non-finite) as "keep everything", so
    // an explicit "0" grows DB snapshots without bound exactly as unset does.
    // The projection must not report S + D for these -- that would tell an
    // operator whose snapshots never get pruned that their backups cost one
    // DB snapshot (the inverted advice AC5 exists to prevent), reachable via
    // an explicit 0 rather than only via unset.
    for (const retentionCountEnv of ['0', '-3', 'abc']) {
      const plan = planBackup({
        mode: 'default',
        dbPath,
        uploadsDir,
        thumbsDir,
        backupDir,
        retentionCountEnv,
      });
      expect(plan.projectedRetainedTotal).toBe(UNBOUNDED);
      expect(typeof plan.projectedRetainedTotal).not.toBe('number');
    }
  });
});
