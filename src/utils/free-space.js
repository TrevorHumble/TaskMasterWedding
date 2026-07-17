// src/utils/free-space.js
// The disk-space guard: read free bytes on a directory's volume, and decide
// whether at least a threshold is available. Originally part of
// src/services/rate-limit.js (issue #247/#283); moved here (issue #558) so a
// caller with no other reason to depend on the rate limiter -- scripts/backup.js's
// disk-budget pre-flight -- can import the disk primitive on its own, instead
// of importing it from a module named after a different concern, without
// duplicating the fs.statfs call and giving one fact two owners.
// src/services/rate-limit.js re-exports hasFreeSpace/setFreeSpaceReader/
// defaultFreeSpaceReader unchanged, so every existing caller and test
// (src/routes/guest.js, tests/memories.test.js) keeps working untouched.
'use strict';

const fs = require('fs');
const config = require('../../config');

/**
 * Default free-space reader: free bytes on `dir`'s volume via fs.statfs.
 *
 * fs.statfs (Node >= 18.15; confirmed available on this app's Node 24) yields
 * a StatFs whose `bsize` (block size) times `bavail` (blocks available to an
 * unprivileged process) is the free bytes an app may actually write. We use
 * bavail, not bfree, because bfree includes root-reserved blocks a normal
 * process cannot use.
 *
 * @param {string} dir - directory on the volume to measure.
 * @returns {Promise<number>} free bytes available on that volume.
 */
function defaultFreeSpaceReader(dir) {
  return new Promise((resolve, reject) => {
    fs.statfs(dir, (err, stats) => {
      if (err) return reject(err);
      resolve(stats.bsize * stats.bavail);
    });
  });
}

// The active free-space reader. Swappable via setFreeSpaceReader so a caller
// wires the real fs.statfs reader while a test injects a stub returning a
// chosen byte count -- no real disk manipulation needed.
let freeSpaceReader = defaultFreeSpaceReader;

/**
 * Replace the free-space reader. A test passes a stub `(dir) => Promise<number>`
 * (or a plain number-returning function) to simulate a full or ample disk;
 * passing nothing restores the real fs.statfs reader.
 * @param {((dir: string) => (number|Promise<number>)) | null} reader
 */
function setFreeSpaceReader(reader) {
  freeSpaceReader = reader || defaultFreeSpaceReader;
}

/**
 * Is there at least `minFreeBytes` free on the given volume?
 *
 * Deep by design: the caller passes only the threshold it cares about and gets
 * a boolean; how free space is read (the injectable reader) stays inside this
 * module.
 *
 * @param {number} [minFreeBytes=config.MIN_FREE_DISK_BYTES]
 * @param {string} [dir=config.DATA_DIR] - volume to measure. Override for a
 *   caller measuring a different volume than the app's own data directory --
 *   e.g. scripts/backup.js measures BACKUP_DIR, not DATA_DIR.
 * @returns {Promise<boolean>} true iff free space >= minFreeBytes.
 */
async function hasFreeSpace(minFreeBytes = config.MIN_FREE_DISK_BYTES, dir = config.DATA_DIR) {
  const free = await freeSpaceReader(dir);
  return free >= minFreeBytes;
}

/**
 * Read the raw free-byte count on `dir` via the currently active reader --
 * the same swappable state hasFreeSpace itself reads. Exposed separately for
 * a caller that needs the actual number rather than a threshold comparison,
 * e.g. scripts/backup.js's disk-budget abort message, which must name both
 * the free bytes and the bytes needed (issue #558 AC4).
 * @param {string} dir
 * @returns {Promise<number>}
 */
async function readFreeBytes(dir) {
  return freeSpaceReader(dir);
}

module.exports = {
  hasFreeSpace,
  setFreeSpaceReader,
  defaultFreeSpaceReader,
  readFreeBytes,
};
