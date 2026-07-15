// src/utils/upload-concurrency.js
//
// Bounds how many callers may run the HEAVY upload pipeline at once (issue
// #311 AC3): src/routes/guest.js wraps its submissions.submitPhoto() call
// (sharp thumbnailing + a synchronous better-sqlite3 write) in
// withUploadSlot() so no more than config.MAX_CONCURRENT_UPLOADS of those
// pipelines run simultaneously.
//
// Why a semaphore and not a hard reject: the #311 load test found that
// enough of these synchronous heavy pipelines running back-to-back can
// occupy the single JS thread long enough to make Node shed a few brand-new
// incoming connections at the OS accept-backlog level, even though the app
// itself never returned a 5xx. QUEUING an over-limit caller (rather than
// rejecting it) turns that into "a guest whose upload lands mid-burst waits
// a little longer," never a dropped connection or a failed request.
//
// No new dependency: this is a small in-process counter + FIFO queue, sized
// for one Node process serving one weekend event on one laptop -- the same
// reasoning src/services/rate-limit.js gives for its in-memory guards.

'use strict';

const config = require('../../config');

/**
 * A counting semaphore: at most `limit` concurrent holders; anyone past that
 * limit queues (FIFO) until a holder releases.
 */
class Semaphore {
  /**
   * @param {number} limit - max concurrent holders. A non-positive or
   *   non-integer value falls back to 1 rather than deadlocking every
   *   caller forever (a limit of 0 would mean acquire() never resolves) --
   *   a misconfigured MAX_CONCURRENT_UPLOADS must degrade to "serialize
   *   everything," never "accept nothing."
   */
  constructor(limit) {
    this.limit = Number.isInteger(limit) && limit > 0 ? limit : 1;
    this.active = 0;
    this.queue = [];
  }

  /**
   * Wait for a free slot. Resolves immediately if under the limit; otherwise
   * queues and resolves once an earlier holder calls release().
   * @returns {Promise<void>}
   */
  acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  /**
   * Free a slot. If another caller is queued, the slot passes straight to
   * them (this.active is unchanged -- ownership transfers, it does not dip
   * to zero and get re-acquired); otherwise the active count drops by one.
   */
  release() {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.active -= 1;
    }
  }
}

// The one upload semaphore this process uses, sized from config so an
// operator can retune MAX_CONCURRENT_UPLOADS per event/host without a code
// change. A module-level singleton (not a per-request instance) is the whole
// point -- the limit only means something if every submit call shares it.
const uploadSemaphore = new Semaphore(config.MAX_CONCURRENT_UPLOADS);

/**
 * Run `fn` (a zero-argument function returning a Promise) inside the upload
 * concurrency limit: wait for a free slot, run `fn`, then release the slot
 * whether `fn` resolved or threw.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withUploadSlot(fn) {
  await uploadSemaphore.acquire();
  try {
    return await fn();
  } finally {
    uploadSemaphore.release();
  }
}

module.exports = { Semaphore, uploadSemaphore, withUploadSlot };
