// tests/upload-concurrency.test.js
// Issue #311 AC3: src/utils/upload-concurrency.js's Semaphore is the peak-
// mitigation primitive src/routes/guest.js wraps submitPhoto in. Unit-tests
// the primitive directly (representative: bounds concurrency and queues the
// over-limit caller; edge: a non-positive configured limit, per
// standards/edge-case-checklist.md's "number" row -- 0/negative) rather than
// driving it through a full HTTP upload, since the concurrency behavior
// itself lives entirely in this module.
//
// Issue #929 adds the avatar gate (avatarSemaphore / withAvatarSlot) to this
// same module -- most of its tests below are unit-level, same rationale as
// #311 above. AC3 ("no avatar-gate slot is held during the HEIC decode") is
// the one exception: that acceptance criterion is about the real wiring
// between src/services/photos/processing.js's saveAvatar and this gate, not about the
// Semaphore primitive itself, so it drives a real HEIC decode through the
// real photos.saveAvatar (same real fixture tests/heic-conversion.test.js
// uses) instead of a fake.
//
// REQUIRE ORDER MATTERS (see tests/helpers/testApp.js): loadApp() must run,
// setting DATA_DIR/DB_PATH, before this file's first require of config, db,
// upload-concurrency, or photos -- all of which read config at module-load
// time. That is why every one of those requires below happens inside
// beforeAll, AFTER loadApp(), rather than at module scope.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadApp } = require('./helpers/testApp');

const HEIC_FIXTURE = fs.readFileSync(
  path.join(__dirname, '../fixtures/sample-photos/sample-heic-01.heic')
);

// Resolved once, outside beforeAll, purely as PATH STRINGS (require.resolve
// does not execute the module) -- used by reloadUploadConcurrency below to
// force a fresh module instance with a different config value, the same
// require.cache-eviction technique tests/config-branches.test.js documents
// (vi.resetModules() does not evict Node's require.cache for a plain CJS
// require()).
const CONFIG_PATH = require.resolve('../config');
const UPLOAD_CONCURRENCY_PATH = require.resolve('../src/utils/upload-concurrency');

let db;
let photos;
let Semaphore;
let withUploadSlot;
let uploadSemaphore;
let avatarSemaphore;
let withAvatarSlot;
let withBoundedSlot;

beforeAll(() => {
  const loaded = loadApp();
  db = loaded.db;

  // Required AFTER loadApp() so config (and everything that reads it)
  // resolves against the temp DATA_DIR.
  photos = require('../src/services/photos');
  ({
    Semaphore,
    withUploadSlot,
    uploadSemaphore,
    avatarSemaphore,
    withAvatarSlot,
    withBoundedSlot,
  } = require('../src/utils/upload-concurrency'));
});

function insertGuest(prefix) {
  const token = `${prefix}-${crypto.randomUUID()}`;
  return db
    .prepare('INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)')
    .run(token, 'Gate Test Guest').lastInsertRowid;
}

/**
 * Force a fresh require of config.js + upload-concurrency.js, picking up
 * whatever AVATAR_CONCURRENCY/AVATAR_SLOT_WAIT_MS/MAX_PENDING_AVATAR_WAITERS
 * env values are set at call time -- gives a test its OWN avatarSemaphore
 * instance, independent of (and never affecting) the singleton `photos` and
 * the outer `avatarSemaphore`/`withAvatarSlot` above are bound to. DATA_DIR/
 * DB_PATH are left untouched, so this never touches the live db.
 */
function reloadUploadConcurrency() {
  delete require.cache[CONFIG_PATH];
  delete require.cache[UPLOAD_CONCURRENCY_PATH];
  return require('../src/utils/upload-concurrency');
}

/** Restore one env var to its saved value (or delete it if it was unset). */
function restoreEnvVar(key, savedValue) {
  if (savedValue === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = savedValue;
  }
}

describe('Semaphore', () => {
  it('bounds concurrent holders to the limit and queues the next acquire until release (representative input: limit=1)', async () => {
    const sem = new Semaphore(1);
    const order = [];

    await sem.acquire();
    order.push('acquired-1');

    let secondAcquired = false;
    const secondAcquire = sem.acquire().then(() => {
      secondAcquired = true;
      order.push('acquired-2');
    });

    // Give the event loop a turn -- the second acquire must still be queued
    // behind the held slot, not resolved.
    await new Promise((resolve) => setImmediate(resolve));
    expect(secondAcquired).toBe(false);

    sem.release(); // frees the slot straight to the queued waiter
    await secondAcquire;

    expect(secondAcquired).toBe(true);
    expect(order).toEqual(['acquired-1', 'acquired-2']);
  });

  it('lets up to `limit` holders in at once without queuing (limit=2)', async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    await sem.acquire(); // second acquire at the limit must resolve immediately, not queue

    let thirdAcquired = false;
    const thirdAcquire = sem.acquire().then(() => {
      thirdAcquired = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(thirdAcquired).toBe(false); // over the limit of 2 -- queued

    sem.release();
    await thirdAcquire;
    expect(thirdAcquired).toBe(true);
  });

  it('edge input: a non-positive configured limit (0) falls back to 1 rather than deadlocking every acquire forever', async () => {
    const sem = new Semaphore(0);
    expect(sem.limit).toBe(1);
    await expect(sem.acquire()).resolves.toBeUndefined(); // must resolve, not hang
  });

  it('edge input: a negative configured limit also falls back to 1', () => {
    const sem = new Semaphore(-5);
    expect(sem.limit).toBe(1);
  });

  it('occupancy is active holders plus queued waiters, tracking both as they change', async () => {
    const sem = new Semaphore(1);
    expect(sem.occupancy).toBe(0);

    await sem.acquire();
    expect(sem.occupancy).toBe(1); // one active holder, nothing queued

    let secondAcquired = false;
    const secondAcquire = sem.acquire().then(() => {
      secondAcquired = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(secondAcquired).toBe(false);
    expect(sem.occupancy).toBe(2); // 1 active + 1 queued

    sem.release(); // ownership transfers straight to the queued waiter
    await secondAcquire;
    expect(sem.occupancy).toBe(1); // still 1 active, queue now empty

    sem.release();
    expect(sem.occupancy).toBe(0);
  });
});

describe('withUploadSlot', () => {
  it('releases the shared upload slot even when the wrapped function throws', async () => {
    const activeBefore = uploadSemaphore.active;

    await expect(withUploadSlot(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');

    // The slot came back -- the active count is exactly what it was before,
    // not left decremented from underneath a still-held slot.
    expect(uploadSemaphore.active).toBe(activeBefore);
  });

  it("returns the wrapped function's resolved value on success", async () => {
    const value = await withUploadSlot(() => Promise.resolve('the actual value'));
    expect(value).toBe('the actual value');
  });
});

// ---------------------------------------------------------------------------
// withBoundedSlot — the shared "ceiling check -> acquire -> timeout-recode ->
// run -> release" primitive both withAvatarSlot (above/below, 'pending' mode)
// and src/services/photos/heic.js's HEIC decode gate ('occupancy' mode) are thin
// callers of (issue #930 round-2 review: those two gates had independently
// hand-rolled the identical shape and drifted apart). withAvatarSlot's own
// suites already exercise 'pending' mode end-to-end through real avatar
// saves; 'occupancy' mode is exercised end-to-end too, through the HEIC
// suites (tests/heic-conversion.test.js, tests/heic-decode-pending-cap.test.js)
// via photos.heicDecodeSemaphore -- but neither drives withBoundedSlot
// directly as a UNIT, against a throwaway Semaphore, isolated from any real
// upload pipeline. These do.
// ---------------------------------------------------------------------------
describe('withBoundedSlot', () => {
  function codedError(message, code) {
    return Object.assign(new Error(message), { code });
  }

  it('occupancy mode: rejects immediately once semaphore.occupancy is at the limit, without ever touching acquire()', async () => {
    const sem = new Semaphore(1);
    await sem.acquire(); // occupancy = 1 (one active holder), at the test's limit of 1
    let fnRan = false;

    await expect(
      withBoundedSlot(
        sem,
        {
          limitKind: 'occupancy',
          limit: 1,
          waitMs: 1000,
          busyError: () => codedError('busy', 'TEST_BUSY'),
          timeoutError: (waitErr) =>
            codedError('timeout', 'TEST_TIMEOUT_' + (waitErr && waitErr.name)),
        },
        () => {
          fnRan = true;
          return Promise.resolve('should never run');
        }
      )
    ).rejects.toMatchObject({ code: 'TEST_BUSY' });

    // Rejected purely on the depth check -- fn never ran, and the semaphore
    // is exactly as it was (no slot was ever requested for this call).
    expect(fnRan).toBe(false);
    expect(sem.occupancy).toBe(1);

    sem.release();
    expect(sem.occupancy).toBe(0);
  });

  it('occupancy mode: admits and runs fn once occupancy is below the limit, releasing the slot on completion', async () => {
    const sem = new Semaphore(2);

    const value = await withBoundedSlot(
      sem,
      {
        limitKind: 'occupancy',
        limit: 2,
        waitMs: 1000,
        busyError: () => codedError('busy', 'TEST_BUSY'),
        timeoutError: () => codedError('timeout', 'TEST_TIMEOUT'),
      },
      () => Promise.resolve('ran')
    );

    expect(value).toBe('ran');
    expect(sem.occupancy).toBe(0); // released -- no leak on the success path
  });

  it('occupancy mode: releases even when fn throws', async () => {
    const sem = new Semaphore(2);

    await expect(
      withBoundedSlot(
        sem,
        {
          limitKind: 'occupancy',
          limit: 2,
          waitMs: 1000,
          busyError: () => codedError('busy', 'TEST_BUSY'),
          timeoutError: () => codedError('timeout', 'TEST_TIMEOUT'),
        },
        () => Promise.reject(new Error('boom'))
      )
    ).rejects.toThrow('boom');

    expect(sem.occupancy).toBe(0); // released -- no leak on the throw path
  });

  it("occupancy mode: a wait admitted under the ceiling but stuck queued behind the Semaphore's own capacity is re-coded via timeoutError on expiry, with no slot leak", async () => {
    const sem = new Semaphore(1); // this Semaphore's OWN concurrency cap is 1
    await sem.acquire(); // hold the only real slot -- occupancy = 1

    // withBoundedSlot's ceiling (2) is ABOVE the Semaphore's own capacity (1)
    // -- exactly the production shape (MAX_PENDING_HEIC_DECODES=12 vs a
    // capacity-1 heicDecodeSemaphore): the depth check admits (1 < 2), but
    // the underlying acquire() still queues because the one real slot is
    // held, so this exercises the WAIT-TIMEOUT path, not the depth-check one.
    let fnRan = false;
    await expect(
      withBoundedSlot(
        sem,
        {
          limitKind: 'occupancy',
          limit: 2,
          waitMs: 50,
          busyError: () => codedError('busy', 'TEST_BUSY'),
          timeoutError: (waitErr) => codedError('timeout: ' + waitErr.name, 'TEST_TIMEOUT'),
        },
        () => {
          fnRan = true;
          return Promise.resolve('should never run');
        }
      )
    ).rejects.toMatchObject({ code: 'TEST_TIMEOUT' });

    expect(fnRan).toBe(false);
    // No slot leak: the expired wait never held a slot, so occupancy is
    // exactly what it was before it ever queued (the one real holder only).
    expect(sem.occupancy).toBe(1);

    sem.release();
    expect(sem.occupancy).toBe(0);
  });

  it('rethrows a non-timeout acquire() rejection unrecoded (does not mislabel it via timeoutError)', async () => {
    const sem = new Semaphore(1);
    const controller = new AbortController();
    controller.abort(new Error('caller cancelled, not a timeout'));

    // A pre-aborted signal makes acquire() reject synchronously with that
    // exact reason, whose .name is NOT 'TimeoutError' -- withBoundedSlot must
    // rethrow it as-is rather than pass it through timeoutError.
    const originalAcquire = sem.acquire.bind(sem);
    sem.acquire = () => originalAcquire({ signal: controller.signal });

    let timeoutErrorCalled = false;
    await expect(
      withBoundedSlot(
        sem,
        {
          limitKind: 'occupancy',
          limit: 1,
          waitMs: 1000,
          busyError: () => codedError('busy', 'TEST_BUSY'),
          timeoutError: () => {
            timeoutErrorCalled = true;
            return codedError('timeout', 'TEST_TIMEOUT');
          },
        },
        () => Promise.resolve('should never run')
      )
    ).rejects.toThrow('caller cancelled, not a timeout');

    expect(timeoutErrorCalled).toBe(false);
  });

  it('pending mode: rejects immediately once semaphore.pending is at the limit, reading .pending not .occupancy', async () => {
    const sem = new Semaphore(1);
    await sem.acquire(); // one active holder -- occupancy = 1, pending = 0
    const filler = withBoundedSlot(
      sem,
      {
        limitKind: 'pending',
        limit: 1,
        waitMs: 1000,
        busyError: () => codedError('busy', 'TEST_BUSY'),
        timeoutError: () => codedError('timeout', 'TEST_TIMEOUT'),
      },
      () => Promise.resolve('filler')
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(sem.pending).toBe(1); // filler is queued -- pending is now at the limit

    // The DISCRIMINATING assertion is the filler's admission above (:367):
    // pending was 0 at its depth check, so 'pending' mode admitted it —
    // occupancy mode would have read 1 (the active holder) >= limit 1 and
    // refused it. This second caller is then rejected in either mode
    // (pending 1 >= 1, occupancy 2 >= 1), so it proves the busy path, not
    // the mode split.
    await expect(
      withBoundedSlot(
        sem,
        {
          limitKind: 'pending',
          limit: 1,
          waitMs: 1000,
          busyError: () => codedError('busy', 'TEST_BUSY'),
          timeoutError: () => codedError('timeout', 'TEST_TIMEOUT'),
        },
        () => Promise.resolve('should never run')
      )
    ).rejects.toMatchObject({ code: 'TEST_BUSY' });

    sem.release(); // frees the held slot straight to the queued filler
    await filler;
    expect(sem.occupancy).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Issue #929 — avatarSemaphore / withAvatarSlot: a SEPARATE, smaller gate for
// avatar processing (see upload-concurrency.js's module header for the full
// raster-arithmetic and head-of-line-inversion rationale).
// ---------------------------------------------------------------------------

describe('withAvatarSlot: basic release contract', () => {
  it('releases the avatar slot even when the wrapped function throws', async () => {
    const activeBefore = avatarSemaphore.active;

    await expect(withAvatarSlot(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');

    expect(avatarSemaphore.active).toBe(activeBefore);
  });

  it("returns the wrapped function's resolved value on success", async () => {
    const value = await withAvatarSlot(() => Promise.resolve('the actual value'));
    expect(value).toBe('the actual value');
  });
});

describe('AC1: avatar concurrency is bounded at the configured value (instrumented ordering)', () => {
  it('AVATAR_CONCURRENCY=1: a second concurrent save does not begin its sharp work until the first completes', async () => {
    const saved = process.env.AVATAR_CONCURRENCY;
    process.env.AVATAR_CONCURRENCY = '1';
    const mod = reloadUploadConcurrency();

    try {
      expect(mod.avatarSemaphore.limit).toBe(1);
      const order = [];
      let resolveFirst;
      const firstGate = new Promise((resolve) => {
        resolveFirst = resolve;
      });

      const first = mod.withAvatarSlot(async () => {
        order.push('first-start');
        await firstGate;
        order.push('first-end');
      });

      await new Promise((resolve) => setImmediate(resolve));
      expect(order).toEqual(['first-start']); // admitted immediately (under the limit)

      let secondStarted = false;
      const second = mod.withAvatarSlot(async () => {
        secondStarted = true;
        order.push('second-start');
      });

      await new Promise((resolve) => setImmediate(resolve));
      // The second save's sharp work has NOT begun while the first still
      // holds the only slot.
      expect(secondStarted).toBe(false);
      expect(order).toEqual(['first-start']);

      resolveFirst();
      await first;
      await second;

      expect(order).toEqual(['first-start', 'first-end', 'second-start']);
    } finally {
      restoreEnvVar('AVATAR_CONCURRENCY', saved);
      reloadUploadConcurrency(); // leave require.cache holding a correctly-configured module
    }
  });

  it('at the default AVATAR_CONCURRENCY=2, a third concurrent save waits until one of the first two completes', async () => {
    const saved = process.env.AVATAR_CONCURRENCY;
    delete process.env.AVATAR_CONCURRENCY; // ensure the default (2) applies
    const mod = reloadUploadConcurrency();

    try {
      expect(mod.avatarSemaphore.limit).toBe(2);
      const running = new Set();
      let resolveFirst;
      const firstGate = new Promise((resolve) => {
        resolveFirst = resolve;
      });

      const first = mod.withAvatarSlot(async () => {
        running.add('first');
        await firstGate;
        running.delete('first');
      });
      const second = mod.withAvatarSlot(async () => {
        running.add('second');
        await new Promise((resolve) => setTimeout(resolve, 20));
        running.delete('second');
      });

      await new Promise((resolve) => setImmediate(resolve));
      expect(running.size).toBe(2); // both admitted at once -- limit is 2, not 1

      let thirdStarted = false;
      const third = mod.withAvatarSlot(async () => {
        thirdStarted = true;
      });

      await new Promise((resolve) => setImmediate(resolve));
      expect(thirdStarted).toBe(false); // peak concurrency bounded at 2

      resolveFirst();
      await first;
      await third; // frees once the first of the two releases
      expect(thirdStarted).toBe(true);
      await second;

      expect(mod.avatarSemaphore.active).toBe(0);
      expect(mod.avatarSemaphore.pending).toBe(0);
    } finally {
      restoreEnvVar('AVATAR_CONCURRENCY', saved);
      reloadUploadConcurrency();
    }
  });
});

describe('withAvatarSlot: depth and wait bounds', () => {
  it('AVATAR_QUEUE_BUSY: a save is rejected immediately once the wait queue is already at MAX_PENDING_AVATAR_WAITERS', async () => {
    const savedConcurrency = process.env.AVATAR_CONCURRENCY;
    const savedMaxWaiters = process.env.MAX_PENDING_AVATAR_WAITERS;
    process.env.AVATAR_CONCURRENCY = '1';
    process.env.MAX_PENDING_AVATAR_WAITERS = '2';
    const mod = reloadUploadConcurrency();

    try {
      // Hold the only slot ourselves so every withAvatarSlot call below queues.
      await mod.avatarSemaphore.acquire();

      const filler1 = mod.withAvatarSlot(() => Promise.resolve());
      const filler2 = mod.withAvatarSlot(() => Promise.resolve());
      await new Promise((resolve) => setImmediate(resolve));
      expect(mod.avatarSemaphore.pending).toBe(2); // at the cap

      // A third arrival, with the queue already at the cap, is rejected
      // IMMEDIATELY -- it must never touch the queue at all.
      await expect(mod.withAvatarSlot(() => Promise.resolve())).rejects.toMatchObject({
        code: 'AVATAR_QUEUE_BUSY',
      });
      expect(mod.avatarSemaphore.pending).toBe(2); // unchanged by the rejected caller

      // Release our held slot -- it cascades through the two queued fillers
      // (each releases its own slot in withAvatarSlot's finally once its fn
      // resolves), draining the queue back to rest.
      mod.avatarSemaphore.release();
      await Promise.all([filler1, filler2]);

      expect(mod.avatarSemaphore.active).toBe(0);
      expect(mod.avatarSemaphore.pending).toBe(0);
    } finally {
      restoreEnvVar('AVATAR_CONCURRENCY', savedConcurrency);
      restoreEnvVar('MAX_PENDING_AVATAR_WAITERS', savedMaxWaiters);
      reloadUploadConcurrency();
    }
  });

  it('AVATAR_SLOT_TIMEOUT: a queued wait that does not free within AVATAR_SLOT_WAIT_MS is rejected, with no slot leak', async () => {
    const savedConcurrency = process.env.AVATAR_CONCURRENCY;
    const savedWaitMs = process.env.AVATAR_SLOT_WAIT_MS;
    process.env.AVATAR_CONCURRENCY = '1';
    process.env.AVATAR_SLOT_WAIT_MS = '150';
    const mod = reloadUploadConcurrency();

    try {
      // Hold the only slot for the whole test -- stands in for #929's
      // "instrumented long crop" that never frees before the wait bound.
      await mod.avatarSemaphore.acquire();
      const activeBefore = mod.avatarSemaphore.active;

      await expect(
        mod.withAvatarSlot(() => Promise.resolve('should never run'))
      ).rejects.toMatchObject({ code: 'AVATAR_SLOT_TIMEOUT' });

      // No slot leak: a timed-out waiter never held a slot, so active/queue
      // are exactly what they were before it ever queued.
      expect(mod.avatarSemaphore.active).toBe(activeBefore);
      expect(mod.avatarSemaphore.pending).toBe(0);

      mod.avatarSemaphore.release(); // release the slot we held
      expect(mod.avatarSemaphore.active).toBe(0);
    } finally {
      restoreEnvVar('AVATAR_CONCURRENCY', savedConcurrency);
      restoreEnvVar('AVATAR_SLOT_WAIT_MS', savedWaitMs);
      reloadUploadConcurrency();
    }
  }, 10000);
});

describe("AC3: no avatar-gate slot is held during the HEIC decode (issue #929's inversion guard)", () => {
  it('the gate is acquired only after the JPEG buffer exists, not while a HEIC decode is in flight', async () => {
    const guestId = insertGuest('ac3-heic-gate');

    // Hold BOTH of the default AVATAR_CONCURRENCY=2 slots ourselves, so any
    // attempt by saveAvatar's gate to acquire immediately queues -- a
    // directly observable signal (queue.length) for exactly when in the
    // call the gate is actually touched.
    await avatarSemaphore.acquire();
    await avatarSemaphore.acquire();
    expect(avatarSemaphore.active).toBe(2);
    expect(avatarSemaphore.pending).toBe(0);

    const savePromise = photos.saveAvatar(HEIC_FIXTURE, guestId);

    // One tick after invocation: if the gate wrapped the WHOLE function (the
    // regression this guards against), saveAvatar would already be blocked
    // trying to acquire -- queue.length would already be 1, well before a
    // real HEIC decode could possibly have finished. Correct wiring runs the
    // HEIC decode UNGATED first, so the queue must still be empty here.
    await new Promise((resolve) => setImmediate(resolve));
    expect(avatarSemaphore.pending).toBe(0);

    // Poll for the decode to finish and the gate to actually be reached --
    // a real HEIC decode plus a fresh worker_thread spawn, so this is a
    // generous real-time bound, not an instant check.
    const deadline = Date.now() + 10000;
    while (avatarSemaphore.pending !== 1) {
      if (Date.now() > deadline) {
        throw new Error(
          'saveAvatar never reached the avatar gate -- the HEIC decode may have failed'
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(avatarSemaphore.pending).toBe(1); // now genuinely queued behind our 2 held slots

    // Release both held slots -- the queued save takes the first one freed.
    avatarSemaphore.release();
    avatarSemaphore.release();

    const savedName = await savePromise;
    expect(savedName).toMatch(/\.jpg$/);
    const row = db.prepare('SELECT avatar_path FROM guests WHERE id = ?').get(guestId);
    expect(row.avatar_path).toBe(savedName);

    // No slot leak: back to the resting state.
    expect(avatarSemaphore.active).toBe(0);
    expect(avatarSemaphore.pending).toBe(0);
  }, 15000);
});
