// tests/upload-concurrency.test.js
// Issue #311 AC3: src/utils/upload-concurrency.js's Semaphore is the peak-
// mitigation primitive src/routes/guest.js wraps submitPhoto in. Unit-tests
// the primitive directly (representative: bounds concurrency and queues the
// over-limit caller; edge: a non-positive configured limit, per
// standards/edge-case-checklist.md's "number" row -- 0/negative) rather than
// driving it through a full HTTP upload, since the concurrency behavior
// itself lives entirely in this module.
'use strict';

const { Semaphore, withUploadSlot, uploadSemaphore } = require('../src/utils/upload-concurrency');

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
