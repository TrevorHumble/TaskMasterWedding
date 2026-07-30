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
//
// The Semaphore class itself lives in src/utils/semaphore.js (issue #543) --
// it is generic and has a second caller now (src/routes/auth.js's
// admin-login CPU-bound gate). Re-exported here unchanged so this module's
// existing callers (and tests/upload-concurrency.test.js, which imports
// Semaphore from THIS path) need no change.
//
// A SECOND, SEPARATE semaphore -- avatarSemaphore -- gates avatar processing
// (issue #929). It is deliberately NOT a share of uploadSemaphore above. The
// raster-size arithmetic that justifies a separate, smaller limit is worked
// out ONCE, in DESIGN.md's "Avatar processing: a dedicated small avatar gate,
// not a share of the upload semaphore (#929)" section -- not restated here,
// so a remeasure updates one place, not two:
//
//   1. Raster arithmetic. Sharing uploadSemaphore's MAX_CONCURRENT_UPLOADS
//      limit would reproduce the exact OOM this gate exists to prevent --
//      admitting avatars at that limit is not a bound, it's the crash.
//   2. Head-of-line inversion. src/services/photos.js's saveAvatar runs the
//      (process-wide-serialized) HEIC decode BEFORE the sharp crop this gate
//      wraps. An avatar holding a SHARED slot while parked on that decode
//      would stall task-submit/memory-batch waiters behind it -- a guest's
//      task photo delayed by someone's avatar, an inversion that does not
//      exist today and must not be introduced by sharing the gate.
//
// Avatar semantics are therefore also different: uploadSemaphore's callers
// queue patiently forever (losing an upload is never acceptable); an avatar
// is disposable (the guest can add one later from their profile), so
// withAvatarSlot fails FAST -- immediate rejection past a queue-depth cap,
// and a bounded wait past that -- rather than joining an unbounded queue.

'use strict';

const config = require('../../config');
const { Semaphore } = require('./semaphore');

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

// The dedicated avatar gate (issue #929, see the module header above for why
// it is not a share of uploadSemaphore). Sized from config.AVATAR_CONCURRENCY
// so an operator can retune it per event/host without a code change, same as
// uploadSemaphore.
//
// Config-binding split: AVATAR_CONCURRENCY binds HERE, once, at module load
// time -- it sizes the Semaphore instance itself, which cannot be resized
// after construction. AVATAR_SLOT_WAIT_MS and MAX_PENDING_AVATAR_WAITERS
// (read inside withAvatarSlot below) are NOT bound at load time -- each is
// read fresh from config on every call, so retuning either takes effect on
// the very next withAvatarSlot invocation with no restart needed. (Tests
// that need a different AVATAR_CONCURRENCY therefore reload this whole
// module -- see tests/upload-concurrency.test.js's reloadUploadConcurrency.)
const avatarSemaphore = new Semaphore(config.AVATAR_CONCURRENCY);

/**
 * Run `fn` inside a semaphore-backed bounded slot -- the ONE owner of the
 * "reject fast on depth, else wait-with-timeout, then run and release" shape
 * both withAvatarSlot below and src/services/photos.js's HEIC decode gate
 * need (issue #930 round-2 review: those two gates had independently
 * hand-rolled the identical shape and drifted apart -- this is the single
 * place that shape now lives).
 *
 * Depth check and `semaphore.acquire()` run in ONE synchronous turn (no
 * `await` between them) -- an async gap there would open a check-then-enqueue
 * race that could admit a caller past `limit`. A caller whose wait is
 * rejected or times out never held a slot (Semaphore.acquire splices an
 * aborted queue entry out by identity -- see semaphore.js), so that path
 * never releases; only a successful acquire enters the try/finally that
 * guarantees release.
 *
 * @template T
 * @param {import('./semaphore').Semaphore} semaphore
 * @param {{
 *   limitKind: 'occupancy'|'pending',
 *   limit: number,
 *   waitMs: number,
 *   busyError: () => Error,
 *   timeoutError: (waitErr: Error) => Error,
 * }} opts - `limitKind` picks which depth reading the ceiling check reads:
 *   'occupancy' (`semaphore.occupancy` -- active holders count toward the
 *   cap too, the HEIC decode gate's shape) or 'pending' (`semaphore.pending`
 *   -- only queued waiters count, the avatar gate's shape). `busyError()`
 *   builds the error thrown when the depth check itself fails (no slot ever
 *   touched). `timeoutError(waitErr)` re-codes ONLY a genuine
 *   AbortSignal.timeout expiry (`waitErr.name === 'TimeoutError'`); any other
 *   rejection from `acquire()` is rethrown as-is, unrecoded.
 * @param {() => Promise<T>} fn - runs only once a slot is actually granted.
 * @returns {Promise<T>}
 */
async function withBoundedSlot(semaphore, opts, fn) {
  const { limitKind, limit, waitMs, busyError, timeoutError } = opts;
  let depth;
  if (limitKind === 'pending') {
    depth = semaphore.pending;
  } else if (limitKind === 'occupancy') {
    depth = semaphore.occupancy;
  } else {
    // An unknown kind must fail loudly, not silently pick a mode — a typo'd
    // 'queued' quietly gating on occupancy would miscount by the active
    // holder and reject every caller at limit === capacity.
    throw new Error('withBoundedSlot: unknown limitKind ' + limitKind);
  }
  if (depth >= limit) {
    throw busyError();
  }

  try {
    await semaphore.acquire({ signal: AbortSignal.timeout(waitMs) });
  } catch (waitErr) {
    if (!waitErr || waitErr.name !== 'TimeoutError') {
      throw waitErr;
    }
    throw timeoutError(waitErr);
  }

  try {
    return await fn();
  } finally {
    semaphore.release();
  }
}

/**
 * Run `fn` (a zero-argument function returning a Promise) inside the avatar
 * concurrency gate: fail fast when the wait queue is already deep, otherwise
 * wait up to config.AVATAR_SLOT_WAIT_MS for a free slot, run `fn`, and always
 * release the slot afterward. A thin call through withBoundedSlot above --
 * this function owns only the avatar-specific SEMANTICS (which depth reading
 * gates it, its two error codes/messages), not the gate mechanics.
 *
 * Avatar semantics are "skip, never stall" (issue #929): losing an avatar
 * costs the guest nothing (they can add one from their profile later), while
 * stalling a join or piling up held raster memory costs the party. So this
 * never queues indefinitely like withUploadSlot -- it has two distinct
 * failure modes, each surfaced with its own error code so a caller (or a
 * test) can tell them apart:
 *
 *   - AVATAR_QUEUE_BUSY: thrown IMMEDIATELY, before ever touching the
 *     semaphore, when avatarSemaphore.pending is already at or past
 *     config.MAX_PENDING_AVATAR_WAITERS. A caller this deep in the queue
 *     would wait the full AVATAR_SLOT_WAIT_MS anyway (issue #929's own
 *     acceptance criteria treat that as an unacceptable stall for an
 *     interactive join) -- reject now rather than admit a wait no one will
 *     benefit from.
 *   - AVATAR_SLOT_TIMEOUT: thrown when an admitted wait does not resolve
 *     within config.AVATAR_SLOT_WAIT_MS. Only a rejection whose error name is
 *     'TimeoutError' (what AbortSignal.timeout's own abort reason carries) is
 *     re-coded into AVATAR_SLOT_TIMEOUT; anything else `acquire` rejects with
 *     is rethrown as-is rather than mislabeled as a timeout it may not be --
 *     the same discrimination src/routes/auth.js's withCompareSlot makes for
 *     the identical acquire-with-signal pattern (its own comment:
 *     "Semaphore.acquire's JSDoc describes cancellation via AbortSignal but
 *     never promises abort is the ONLY rejection reason").
 *
 * config.MAX_PENDING_AVATAR_WAITERS/AVATAR_SLOT_WAIT_MS are read fresh from
 * config on every call (not bound once at module load, unlike
 * AVATAR_CONCURRENCY which sizes avatarSemaphore itself) -- see the module
 * header's "Config-binding split" note above.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withAvatarSlot(fn) {
  return withBoundedSlot(
    avatarSemaphore,
    {
      limitKind: 'pending',
      limit: config.MAX_PENDING_AVATAR_WAITERS,
      waitMs: config.AVATAR_SLOT_WAIT_MS,
      busyError: () => {
        // Diagnostic only -- no guest ever sees this string (saveAvatar's
        // caller maps this .code to a guest-safe outcome; see photos.js's
        // saveAvatar).
        const err = new Error('avatar gate: wait queue at MAX_PENDING_AVATAR_WAITERS');
        err.code = 'AVATAR_QUEUE_BUSY';
        return err;
      },
      timeoutError: (waitErr) => {
        // Diagnostic only -- no guest ever sees this string (see the
        // QUEUE_BUSY comment above).
        const err = new Error('avatar gate: no slot within AVATAR_SLOT_WAIT_MS', {
          cause: waitErr,
        });
        err.code = 'AVATAR_SLOT_TIMEOUT';
        return err;
      },
    },
    fn
  );
}

// The gate's two rejection codes, owned HERE beside the throw sites so a
// consumer matching on them (photos.saveAvatar's null-disposition) can import
// the set instead of re-authoring the strings — a new/renamed code then
// changes exactly one file.
const AVATAR_GATE_CODES = new Set(['AVATAR_QUEUE_BUSY', 'AVATAR_SLOT_TIMEOUT']);

module.exports = {
  Semaphore,
  uploadSemaphore,
  withUploadSlot,
  avatarSemaphore,
  withAvatarSlot,
  AVATAR_GATE_CODES,

  // The shared bounded-slot primitive (issue #930 round-2 review) --
  // exported so src/services/photos.js's HEIC decode gate can be a thin
  // caller too, same as withAvatarSlot above.
  withBoundedSlot,
};
