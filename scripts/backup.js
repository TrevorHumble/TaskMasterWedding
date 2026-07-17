// scripts/backup.js
// Consistent, during-event backup of data/, split into two independently
// runnable pieces with opposite cadences (issue #558):
//
//   - The DATABASE is small and changes minute to minute (points, likes,
//     comments). `--db-only` snapshots app.db (WAL-safe, via better-sqlite3's
//     online backup) plus admin.hash into a new timestamped folder under
//     BACKUP_DIR, and is cheap enough to run often.
//   - PHOTOS are write-once (src/services/photos.js:203-236 never rewrites an
//     existing stored file) and can be large. `--photos-only` copies newly
//     seen files into ONE shared, append-only store at
//     BACKUP_DIR/photos/{uploads,thumbs} -- skip-if-exists, never a fresh
//     per-run copy -- so a repeat run costs only what changed since the last
//     one.
//   - No flag (the default) does both.
//
// Before the first copy in any mode, a disk-budget pre-flight (planBackup)
// sizes exactly what that mode is about to write and aborts the whole run,
// untouched, if BACKUP_DIR does not have room -- see docs/deploy.md
// § "Scheduled backups" for the sizing rule this exists to make affordable.
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { readFreeBytes } = require('../src/utils/free-space');

const PHOTOS_STORE_DIRNAME = 'photos';
const UNBOUNDED = 'unbounded';

/**
 * Build a filesystem-safe, sortable timestamp: YYYYMMDD-HHMMSS (UTC).
 * Sortable so `ls backups/` lists snapshots oldest-to-newest by name.
 * @returns {string}
 */
function makeTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

/**
 * Copy a single file into the backup folder if it exists; a missing source
 * (e.g. an event that has never had the admin password set) is not an error
 * -- there is simply nothing to copy.
 * @param {string} srcFile
 * @param {string} destFile
 */
function copyFileIfPresent(srcFile, destFile) {
  if (!fs.existsSync(srcFile)) return;
  fs.copyFileSync(srcFile, destFile);
}

/**
 * List the plain filenames directly inside `dir` (non-recursive -- uploads/
 * and thumbs/ are always flat; every stored file gets a random
 * hex-plus-timestamp name with no subdirectories, see
 * src/services/photos.js's randomFilename). A missing dir is not an error --
 * there is simply nothing there yet.
 * @param {string} dir
 * @returns {string[]}
 */
function listFilesIfPresent(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

/**
 * Size in bytes of a single file, or 0 if it does not exist (a missing
 * database or photo is "nothing to size," not an error -- the free-space
 * pre-flight must still be able to run against a host that has not taken its
 * first backup yet).
 * @param {string} filePath
 * @returns {number}
 */
function sizeOfFile(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

/**
 * Total bytes of the plain files directly inside `dir`.
 * @param {string} dir
 * @returns {number}
 */
function sizeOfDirFiles(dir) {
  return listFilesIfPresent(dir).reduce((sum, name) => sum + sizeOfFile(path.join(dir, name)), 0);
}

/**
 * The plain filenames in `srcDir` not yet present (by name) in `destDir` --
 * the single owner of the skip-if-exists test that both the sizing pre-flight
 * (sizeOfNewFiles) and the actual copy (copyNewFiles) consume, so the bytes a
 * run is sized for can never drift from the files it copies. Photos are
 * write-once (src/services/photos.js:203-236), so "already present at this
 * name" is a sound proxy for "already backed up" -- content hashing is
 * deliberately not used.
 * @param {string} srcDir
 * @param {string} destDir
 * @returns {string[]}
 */
function newFileNames(srcDir, destDir) {
  const srcFiles = listFilesIfPresent(srcDir);
  if (srcFiles.length === 0) return [];
  const existing = new Set(listFilesIfPresent(destDir));
  return srcFiles.filter((name) => !existing.has(name));
}

/**
 * Bytes of the files in `srcDir` that are NOT yet present (by name) in
 * `destDir` -- sized instead of copied, via the shared newFileNames test.
 * @param {string} srcDir
 * @param {string} destDir
 * @returns {number}
 */
function sizeOfNewFiles(srcDir, destDir) {
  return newFileNames(srcDir, destDir).reduce(
    (sum, name) => sum + sizeOfFile(path.join(srcDir, name)),
    0
  );
}

/**
 * The shared, append-only photo store's uploads/ and thumbs/ paths under a
 * given BACKUP_DIR. Named `photos/` so pruneBackups's snapshot-name regex
 * (`/^\d{8}-\d{6}$/`) can never mistake it for a timestamped DB snapshot.
 * @param {string} backupDir
 * @returns {{ root: string, uploads: string, thumbs: string }}
 */
function photoStoreDirs(backupDir) {
  const root = path.join(backupDir, PHOTOS_STORE_DIRNAME);
  return { root, uploads: path.join(root, 'uploads'), thumbs: path.join(root, 'thumbs') };
}

/**
 * Copy every file present in `srcDir` but not yet in `destDir`, by name,
 * using the shared newFileNames skip-if-exists test (so a copy and its
 * pre-flight sizing always agree on what "new" means).
 * @param {string} srcDir
 * @param {string} destDir
 * @param {(src: string, dest: string) => void} copyFn
 * @returns {number} count of files actually copied
 */
function copyNewFiles(srcDir, destDir, copyFn) {
  const toCopy = newFileNames(srcDir, destDir);
  if (toCopy.length === 0) return 0;
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of toCopy) {
    copyFn(path.join(srcDir, name), path.join(destDir, name));
  }
  return toCopy.length;
}

/**
 * Produce one consistent database snapshot: app.db plus admin.hash (if
 * present), written to a new timestamped folder under backupDir. Touches no
 * photo directory -- callers that also want photos call backupPhotos
 * separately (see runBackup).
 *
 * Uses better-sqlite3's online backup API (Database#backup), which takes
 * SQLite's own backup lock and copies page-by-page even while WAL is active
 * -- unlike a plain fs.copyFile of app.db, which can read a torn/partial
 * file mid-write. This path is unchanged from before issue #558.
 *
 * @param {object} options
 * @param {string} options.dbPath - absolute path to the live app.db
 * @param {string} [options.adminHashPath] - absolute path to the live
 *   admin.hash file. Optional (and possibly nonexistent even when passed) --
 *   an event that has never had `set-admin-password` run has no admin.hash
 *   yet, and that is not a backup failure.
 * @param {string} options.backupDir - absolute path to the backup root (a new
 *   timestamped folder is created directly under this)
 * @param {string} [options.timestamp] - override the folder name; used by
 *   tests for determinism, otherwise generated from the current time
 * @returns {Promise<string>} the absolute path to the created snapshot folder
 */
async function backupDatabase({ dbPath, adminHashPath, backupDir, timestamp }) {
  const stamp = timestamp || makeTimestamp();
  const destDir = path.join(backupDir, stamp);

  // Database#backup requires the destination directory to already exist.
  fs.mkdirSync(destDir, { recursive: true });

  const db = new Database(dbPath, { readonly: true });
  try {
    await db.backup(path.join(destDir, 'app.db'));
  } finally {
    db.close();
  }

  if (adminHashPath) {
    copyFileIfPresent(adminHashPath, path.join(destDir, 'admin.hash'));
  }

  return destDir;
}

/**
 * Incrementally copy new uploads/thumbs into the single shared photo store
 * at BACKUP_DIR/photos/ (issue #558 AC2). A file already present in the
 * store at the same name is never re-copied or overwritten -- the store is
 * append-only, and is never pruned by this tool (AC3): each photo is
 * retained exactly once, and deleting from the store would destroy the only
 * backup copy.
 * @param {object} options
 * @param {string} options.uploadsDir
 * @param {string} options.thumbsDir
 * @param {string} options.backupDir
 * @param {(src: string, dest: string) => void} [options.copyFn] - injectable
 *   copy fn (test seam); defaults to fs.copyFileSync.
 * @returns {number} total files actually copied across both directories
 */
function backupPhotos({ uploadsDir, thumbsDir, backupDir, copyFn = fs.copyFileSync }) {
  const store = photoStoreDirs(backupDir);
  const uploadsCopied = copyNewFiles(uploadsDir, store.uploads, copyFn);
  const thumbsCopied = copyNewFiles(thumbsDir, store.thumbs, copyFn);
  return uploadsCopied + thumbsCopied;
}

/**
 * Does `keep` positively bound how many DB snapshots are retained? A
 * non-finite or non-positive keep means "keep everything" -- the single owner
 * of that threshold rule, so pruneBackups (what actually deletes) and
 * planBackup (what projects the retained total) can never disagree about which
 * retention values are unbounded.
 * @param {number} keep
 * @returns {boolean}
 */
function retentionIsBounded(keep) {
  return Number.isFinite(keep) && keep > 0;
}

/**
 * Delete all but the last `keep` snapshot folders under `backupDir` (issue
 * #287). Only entries that are directories AND whose name matches
 * makeTimestamp()'s exact format (`YYYYMMDD-HHMMSS`) are treated as
 * snapshots -- an operator's own `keep-me` folder, a stray `notes.txt`, and
 * (issue #558) the `photos/` shared store are never deletion candidates.
 * Ascending name sort is safe because the timestamp format sorts
 * lexicographically the same as chronologically, so "keep the last `keep`
 * entries" always keeps the newest ones, including the snapshot this same
 * run just wrote.
 *
 * @param {object} options
 * @param {string} options.backupDir - absolute path to the backup root
 * @param {number} options.keep - number of newest snapshots to retain
 * @returns {string[]} names of the snapshot folders that were deleted
 */
function pruneBackups({ backupDir, keep }) {
  if (!retentionIsBounded(keep)) return [];
  if (!fs.existsSync(backupDir)) return [];

  const SNAPSHOT_NAME = /^\d{8}-\d{6}$/;
  const snapshots = fs
    .readdirSync(backupDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SNAPSHOT_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  const toDelete = snapshots.length > keep ? snapshots.slice(0, snapshots.length - keep) : [];
  for (const name of toDelete) {
    fs.rmSync(path.join(backupDir, name), { recursive: true, force: true });
  }
  return toDelete;
}

/**
 * Pre-flight disk-budget sizing for one backup run (issue #558 AC4/AC5).
 * Computable on its own, before any copy starts, so runBackup can abort
 * cleanly and a test can assert the numbers without touching a real disk.
 *
 * requiredBytes is exactly what THIS mode is about to write: `D` (database
 * size) for db-only, `S_new` (bytes of live photos not yet in the store) for
 * photos-only, `D + S_new` for default. A low-disk host taking only the
 * megabytes-sized DB snapshot is never blocked by a large photo set it is
 * not touching this run.
 *
 * projectedRetainedTotal is the operator-facing high-water mark once the
 * retention schedule has caught up: `S + (N + 1) x D`, where S is the full
 * live photo set's size (every photo eventually lands in the store exactly
 * once, however many runs it takes), N is BACKUP_RETENTION_COUNT, and the
 * `+1` reflects prune-after-success (this run's own snapshot briefly exists
 * alongside the N older ones it will be pruned down to). When retention does
 * not POSITIVELY bound the DB snapshots -- unset, blank, "0", negative, or
 * non-numeric -- nothing caps how many accumulate (pruneBackups treats any
 * `keep <= 0` or non-finite keep as "keep everything"), so the projection is
 * the string 'unbounded' rather than a number: reporting `S + D` here would
 * tell an operator whose snapshots grow forever that their backups cost
 * exactly one DB snapshot, which is the opposite of true. "Unset" and an
 * explicit "0" differ only in config's lossy `parseInt || 0` coercion; both
 * are unbounded here, matching what pruneBackups actually does at runtime.
 *
 * @param {object} options
 * @param {'db-only'|'photos-only'|'default'} options.mode
 * @param {string} options.dbPath
 * @param {string} options.uploadsDir
 * @param {string} options.thumbsDir
 * @param {string} options.backupDir
 * @param {string|undefined} options.retentionCountEnv - the RAW
 *   process.env.BACKUP_RETENTION_COUNT string (or undefined), NOT
 *   config.BACKUP_RETENTION_COUNT -- config coerces an unset value to 0,
 *   which would make "unset" indistinguishable from "prune to zero" here.
 * @returns {{ requiredBytes: number, projectedRetainedTotal: number|'unbounded' }}
 */
function planBackup({ mode, dbPath, uploadsDir, thumbsDir, backupDir, retentionCountEnv }) {
  const store = photoStoreDirs(backupDir);
  const dbBytes = sizeOfFile(dbPath); // D
  const newPhotoBytes =
    sizeOfNewFiles(uploadsDir, store.uploads) + sizeOfNewFiles(thumbsDir, store.thumbs); // S_new

  let requiredBytes;
  if (mode === 'db-only') {
    requiredBytes = dbBytes;
  } else if (mode === 'photos-only') {
    requiredBytes = newPhotoBytes;
  } else {
    requiredBytes = dbBytes + newPhotoBytes;
  }

  const retentionUnset = retentionCountEnv === undefined || retentionCountEnv.trim() === '';
  const parsedRetention = retentionUnset ? NaN : parseInt(retentionCountEnv, 10);
  let projectedRetainedTotal;
  // Any retention that does not positively bound the snapshots (unset, blank,
  // 0, negative, non-numeric) is unbounded -- retentionIsBounded is the single
  // owner of that rule, shared with pruneBackups so the projection can never
  // disagree with what prune actually does.
  if (!retentionIsBounded(parsedRetention)) {
    projectedRetainedTotal = UNBOUNDED;
  } else {
    const livePhotoBytes = sizeOfDirFiles(uploadsDir) + sizeOfDirFiles(thumbsDir); // S
    projectedRetainedTotal = livePhotoBytes + (parsedRetention + 1) * dbBytes;
  }

  return { requiredBytes, projectedRetainedTotal };
}

/**
 * Parse `--db-only` / `--photos-only` from CLI args.
 * @param {string[]} argv - e.g. process.argv.slice(2)
 * @returns {{ mode: 'db-only'|'photos-only'|'default' } | { error: string }}
 */
function parseArgs(argv) {
  const dbOnly = argv.includes('--db-only');
  const photosOnly = argv.includes('--photos-only');
  if (dbOnly && photosOnly) {
    return {
      error:
        '--db-only and --photos-only cannot be used together -- pick one, or omit both to run ' +
        'the default (database snapshot plus incremental photos).',
    };
  }
  if (dbOnly) return { mode: 'db-only' };
  if (photosOnly) return { mode: 'photos-only' };
  return { mode: 'default' };
}

/**
 * Run one backup end to end: pre-flight disk-budget check (AC4/AC5), then
 * the copies the given mode calls for, then DB-snapshot retention.
 *
 * The disk-budget check runs before ANY copy -- no destination folder is
 * created, no file is touched -- so an abort leaves existing snapshots, the
 * photo store, and the live data untouched (AC4).
 *
 * @param {object} options
 * @param {'db-only'|'photos-only'|'default'} options.mode
 * @param {string} options.dbPath
 * @param {string} options.uploadsDir
 * @param {string} options.thumbsDir
 * @param {string} [options.adminHashPath]
 * @param {string} options.backupDir
 * @param {number} options.retentionCount - keep count for pruneBackups
 *   (typically config.BACKUP_RETENTION_COUNT, already coerced to a number).
 * @param {string|undefined} options.retentionCountEnv - raw
 *   process.env.BACKUP_RETENTION_COUNT, passed through to planBackup.
 * @param {string} [options.timestamp]
 * @param {(src: string, dest: string) => void} [options.copyFn]
 * @returns {Promise<{
 *   destDir: string|null,
 *   photosCopied: number,
 *   prunedNames: string[],
 *   plan: { requiredBytes: number, projectedRetainedTotal: number|'unbounded' },
 * }>}
 */
async function runBackup({
  mode,
  dbPath,
  uploadsDir,
  thumbsDir,
  adminHashPath,
  backupDir,
  retentionCount,
  retentionCountEnv,
  timestamp,
  copyFn,
}) {
  const plan = planBackup({ mode, dbPath, uploadsDir, thumbsDir, backupDir, retentionCountEnv });

  const freeBytes = await readFreeBytes(backupDir);
  if (freeBytes < plan.requiredBytes) {
    const err = new Error(
      `Refusing to back up: ${backupDir} has ${freeBytes} bytes free, but this ${mode} run needs ` +
        `${plan.requiredBytes} bytes. No copy was started -- existing snapshots, the photo store, ` +
        `and the live data are untouched.`
    );
    err.isBackupAbort = true;
    throw err;
  }

  let destDir = null;
  let photosCopied = 0;

  if (mode === 'db-only' || mode === 'default') {
    destDir = await backupDatabase({ dbPath, adminHashPath, backupDir, timestamp });
  }
  if (mode === 'photos-only' || mode === 'default') {
    photosCopied = backupPhotos({ uploadsDir, thumbsDir, backupDir, copyFn });
  }

  // Prune AFTER a successful DB backup only (issue #287), so a failed run
  // never loses an old snapshot in exchange for one that didn't get made. A
  // photos-only run wrote no DB snapshot, so there is nothing new for
  // retention to act on -- prune is skipped, not just harmless.
  let prunedNames = [];
  if (destDir) {
    try {
      prunedNames = pruneBackups({ backupDir, keep: retentionCount });
    } catch (err) {
      // A pruning failure (e.g. a locked file mid-delete on Windows) is
      // logged but does not flip the exit code -- the backup itself already
      // succeeded and is not corrupted by a prune that partially failed.
      console.error('Pruning old backups failed (backup itself succeeded):', err);
    }
  }

  return { destDir, photosCopied, prunedNames, plan };
}

if (require.main === module) {
  const config = require('../config');
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.error) {
    console.error(parsed.error);
    process.exitCode = 1;
  } else {
    // backupDatabase/backupPhotos deliberately take SEPARATE resolved paths
    // rather than a single DATA_DIR, so runBackup stays a pure function
    // decoupled from config's shape (this is also the seam tests drive with
    // temp dirs). Each value below is passed already-resolved: config.DB_PATH
    // / UPLOADS_DIR / THUMBS_DIR / ADMIN_HASH_PATH each honor their own env
    // override (e.g. process.env.DB_PATH can point the DB outside DATA_DIR).
    // Do NOT "simplify" this to derive uploads/thumbs/admin.hash from
    // DATA_DIR -- that would silently ignore those per-path overrides and
    // back up the wrong files.
    runBackup({
      mode: parsed.mode,
      dbPath: config.DB_PATH,
      uploadsDir: config.UPLOADS_DIR,
      thumbsDir: config.THUMBS_DIR,
      adminHashPath: config.ADMIN_HASH_PATH,
      backupDir: config.BACKUP_DIR,
      retentionCount: config.BACKUP_RETENTION_COUNT,
      retentionCountEnv: process.env.BACKUP_RETENTION_COUNT,
    })
      .then((result) => {
        if (result.destDir) {
          console.log(`Database snapshot complete: ${result.destDir}`);
        }
        if (parsed.mode !== 'db-only') {
          console.log(
            result.photosCopied > 0
              ? `Photos: ${result.photosCopied} new file(s) copied into the shared store.`
              : 'Photos: nothing new to copy.'
          );
        }
        if (result.prunedNames.length > 0) {
          console.log(
            `Pruned ${result.prunedNames.length} old snapshot(s): ${result.prunedNames.join(', ')}`
          );
        }
        const { requiredBytes, projectedRetainedTotal } = result.plan;
        const projected =
          projectedRetainedTotal === UNBOUNDED
            ? 'unbounded -- BACKUP_RETENTION_COUNT is unset or <= 0, so DB snapshots are never pruned'
            : `${projectedRetainedTotal} bytes`;
        console.log(
          `Disk budget: this run needed ${requiredBytes} bytes; projected retained total on this disk: ${projected}.`
        );
      })
      .catch((err) => {
        console.error(err.isBackupAbort ? err.message : `Backup failed: ${err.message || err}`);
        process.exitCode = 1;
      });
  }
}

module.exports = {
  backupDatabase,
  backupPhotos,
  pruneBackups,
  planBackup,
  parseArgs,
  runBackup,
  UNBOUNDED,
};
