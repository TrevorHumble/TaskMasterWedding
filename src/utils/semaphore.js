// src/utils/semaphore.js
//
// A generic counting semaphore: at most `limit` concurrent holders; anyone
// past that limit queues (FIFO) until a holder releases. Extracted from
// src/utils/upload-concurrency.js (issue #543) so a caller outside the
// upload pipeline -- src/routes/auth.js's admin-login CPU-bound gate -- can
// depend on the primitive without importing a module whose name and header
// describe only uploads. Re-exported from upload-concurrency.js unchanged
// (see that module's own comment), so its existing callers and
// tests/upload-concurrency.test.js need no change.

'use strict';

class Semaphore {
  /**
   * @param {number} limit - max concurrent holders. A non-positive or
   *   non-integer value falls back to 1 rather than deadlocking every
   *   caller forever (a limit of 0 would mean acquire() never resolves) --
   *   a misconfigured limit must degrade to "serialize everything," never
   *   "accept nothing."
   */
  constructor(limit) {
    this.limit = Number.isInteger(limit) && limit > 0 ? limit : 1;
    this.active = 0;
    this.queue = [];
  }

  /**
   * Wait for a free slot. Resolves immediately if under the limit; otherwise
   * queues and resolves once an earlier holder calls release().
   *
   * @param {{ signal?: AbortSignal }} [opts] - optional cancellation
   *   (issue #543 AC4). Passing an AbortSignal lets a caller withdraw a
   *   QUEUED wait before it acquires a slot -- e.g. a request whose client
   *   already disconnected. A signal that is already aborted before this
   *   call rejects immediately without ever entering the queue. Once a
   *   slot has been granted, the signal is inert: acquiring is a one-way
   *   door, matching release()'s own contract (a held slot is only freed
   *   by calling release(), never by an aborted signal).
   * @returns {Promise<void>}
   */
  acquire(opts) {
    const signal = opts && opts.signal;

    // Checked before the fast path too: a caller whose signal is already
    // aborted (its client is already gone) gets nothing, even if a slot is
    // free -- granting one would spend a compare on a connection that
    // cannot receive the answer.
    if (signal && signal.aborted) {
      return Promise.reject(abortError(signal));
    }

    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      // The queue stores this exact function reference (a bare resolver,
      // same shape release() has always shifted off it) so onAbort can
      // locate and SPLICE it out by identity -- never leaving a dead
      // resolver in place. release()'s `this.queue.shift()` transfers slot
      // ownership by calling whatever it finds at the front; a tombstoned
      // (no-op) entry left behind by a cancelled waiter would hand a slot
      // to nobody and permanently leak it (see this module's callers'
      // edge-case notes). Splicing is what keeps every queued entry live.
      const onAcquire = () => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        const idx = this.queue.indexOf(onAcquire);
        if (idx === -1) {
          // Already acquired (or already removed) -- detaching this
          // listener is onAcquire's very first action, executed before
          // resolve() (see above), so once a waiter has been granted a
          // slot onAbort can no longer run for it at all. This guard is
          // defensive: it is not reachable via the current acquire/release
          // pairing, but it keeps a future reordering of onAcquire from
          // turning a late abort into a double-release.
          return;
        }
        this.queue.splice(idx, 1);
        reject(abortError(signal));
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      this.queue.push(onAcquire);
    });
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

// Both call sites (the pre-aborted fast-reject above, and onAbort's
// reject() -- which only runs because it is itself the listener registered
// on `signal` at :86) guarantee `signal` is truthy here, so there is no
// falsy-signal case for `signal &&` to guard against.
function abortError(signal) {
  return signal.reason || new Error('aborted');
}

module.exports = { Semaphore };
