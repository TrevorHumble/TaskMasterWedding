// scripts/backup.js
// Consistent, during-event backup of data/: a WAL-safe SQLite snapshot plus
// copies of the photo directories and the admin password hash, written to a
// timestamped folder under BACKUP_DIR (default: <ROOT>/backups, deliberately
// outside data/ itself -- see config.js for why).
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

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
 * Copy a directory tree into the backup folder if it exists; a missing
 * source (e.g. no uploads yet) is not an error -- there is simply nothing
 * to copy for that folder.
 * @param {string} srcDir
 * @param {string} destDir
 */
function copyPhotoDirIfPresent(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  fs.cpSync(srcDir, destDir, { recursive: true });
}

/**
 * Copy a single file into the backup folder if it exists; a missing source
 * (e.g. an event that has never had the admin password set) is not an error
 * -- there is simply nothing to copy. Mirrors copyPhotoDirIfPresent's
 * if-exists tolerance, but for a single file rather than a directory tree.
 * @param {string} srcFile
 * @param {string} destFile
 */
function copyFileIfPresent(srcFile, destFile) {
  if (!fs.existsSync(srcFile)) return;
  fs.copyFileSync(srcFile, destFile);
}

/**
 * Produce one consistent backup of the database plus the photo directories.
 *
 * The DB snapshot uses better-sqlite3's online backup API (Database#backup),
 * which takes SQLite's own backup lock and copies page-by-page even while
 * WAL is active -- unlike a plain fs.copyFile of app.db, which can read a
 * torn/partial file mid-write. uploads/ and thumbs/ are plain recursive
 * copies: they are write-once (photos are never edited after upload), so a
 * copy racing an upload can at worst miss that one new file, not corrupt an
 * existing one.
 *
 * @param {object} options
 * @param {string} options.dbPath - absolute path to the live app.db
 * @param {string} options.uploadsDir - absolute path to the live uploads/ dir
 * @param {string} options.thumbsDir - absolute path to the live thumbs/ dir
 * @param {string} [options.adminHashPath] - absolute path to the live
 *   admin.hash file. Optional (and possibly nonexistent even when passed) --
 *   an event that has never had `set-admin-password` run has no admin.hash
 *   yet, and that is not a backup failure.
 * @param {string} options.backupDir - absolute path to the backup root (a new
 *   timestamped folder is created directly under this)
 * @param {string} [options.timestamp] - override the folder name; used by
 *   tests for determinism, otherwise generated from the current time
 * @returns {Promise<string>} the absolute path to the created backup folder
 */
async function backupData({ dbPath, uploadsDir, thumbsDir, adminHashPath, backupDir, timestamp }) {
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

  copyPhotoDirIfPresent(uploadsDir, path.join(destDir, 'uploads'));
  copyPhotoDirIfPresent(thumbsDir, path.join(destDir, 'thumbs'));
  if (adminHashPath) {
    copyFileIfPresent(adminHashPath, path.join(destDir, 'admin.hash'));
  }

  return destDir;
}

if (require.main === module) {
  const config = require('../config');
  // backupData deliberately takes five SEPARATE resolved paths rather than a
  // single DATA_DIR, so it stays a pure function decoupled from config's shape
  // (this is also the seam tests drive with temp dirs). Each value below is
  // passed already-resolved: config.DB_PATH / UPLOADS_DIR / THUMBS_DIR /
  // ADMIN_HASH_PATH each honor their own env override (e.g. process.env.DB_PATH
  // can point the DB outside DATA_DIR). Do NOT "simplify" this to derive
  // uploads/thumbs/admin.hash from DATA_DIR -- that would silently ignore
  // those per-path overrides and back up the wrong files.
  backupData({
    dbPath: config.DB_PATH,
    uploadsDir: config.UPLOADS_DIR,
    thumbsDir: config.THUMBS_DIR,
    adminHashPath: config.ADMIN_HASH_PATH,
    backupDir: config.BACKUP_DIR,
  })
    .then((destDir) => {
      console.log(`Backup complete: ${destDir}`);
    })
    .catch((err) => {
      console.error('Backup failed:', err);
      process.exitCode = 1;
    });
}

module.exports = { backupData };
