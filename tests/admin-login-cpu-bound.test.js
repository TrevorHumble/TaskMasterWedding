// tests/admin-login-cpu-bound.test.js
// Issue #543 AC1-AC4: POST /admin/login bounds concurrent bcrypt compares to
// a config-overridable N, queues over-limit callers rather than refusing
// them (AC2, AC3), and drops a QUEUED waiter whose client disconnected
// without ever consuming a compare (AC4). AC5 (existing lockout tests pass
// unmodified) is exercised by those files themselves, not here.
//
// Drives the REAL route handler function directly (extracted from the
// router via introspection below) with hand-built mock req/res objects,
// rather than through real HTTP/supertest. Two independent reasons:
//   - An injected fake compare (router._setCompareImplForTest) replaces
//     bcrypt.compare: the real thing at cost 10+ is both too slow to drive
//     50 concurrent requests through deterministically and gives no way to
//     control exactly when a given compare settles, which every assertion
//     here depends on.
//   - Real sockets, even over loopback against a single persistent server,
//     measured highly variable multi-second stalls on this host under 6-50
//     concurrent connections (a keep-alive http.Agent did not fix it) --
//     unrelated to the gate's own logic (confirmed correct by running single
//     requests through it), but enough to make timing-sensitive HTTP-level
//     assertions unusably flaky. The mock req/res below implements just the
//     surface the handler touches (req.body, req/res.on/removeListener for
//     'close', res.status/cookie/redirect/render), so every assertion here
//     is driven by microtask flushes, not wall-clock waits, per the repo's
//     own flake history with timing-sensitive tests.
'use strict';

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Semaphore } = require('../src/utils/semaphore');

// Set env overrides BEFORE loadApp() so config picks them up on first
// require. The lockout threshold is raised out of reach so a flood of wrong
// passwords in these tests never trips a 429 from src/services/lockout.js
// and confounds the "which response codes came from THIS gate" assertions —
// AC5's own tests already cover the lockout's 429 behavior.
//
// Deliberately 3, not config.js's own default of 2: if src/routes/auth.js
// ever hardcoded a literal 2 instead of reading this env var, a suite that
// also used 2 would still pass and the regression would go unnoticed. Every
// N below is 3 (or derived from it) so the assertions only pass if the live
// semaphore actually followed the override.
process.env.ADMIN_LOGIN_MAX_CONCURRENT_COMPARES = '3';
process.env.ADMIN_LOGIN_MAX_ATTEMPTS = '100000';

const { loadApp } = require('./helpers/testApp');

const CORRECT_PASSWORD = 'CorrectHorse!543';

let authRouter;
let handler;

beforeAll(() => {
  loadApp();

  // Require config only after loadApp() — it is now cached with the temp DATA_DIR.
  const config = require('../config');
  const hashPath = config.ADMIN_HASH_PATH;

  // A real hash file must exist for the readFileSync guard ahead of the
  // semaphore to pass — its CONTENTS are irrelevant here since compareImpl
  // is swapped out below and never reads it.
  fs.mkdirSync(path.dirname(hashPath), { recursive: true });
  fs.writeFileSync(hashPath, bcrypt.hashSync(CORRECT_PASSWORD, 4), 'utf8');

  authRouter = require('../src/routes/auth');
  handler = getAdminLoginHandler(authRouter);
});

beforeEach(() => {
  // Fresh gate for every test: adminLoginSemaphore is module-level singleton
  // state, so a prior test's leftover active/queued state would otherwise
  // leak forward and starve the next test.
  authRouter._resetAdminLoginSemaphoreForTest();
});

afterEach(() => {
  // Restore the real bcrypt.compare so any test outside this file (if the
  // suite ever shares a router instance) never sees a fake left behind.
  authRouter._setCompareImplForTest(null);
});

/**
 * Pull the actual POST /admin/login handler function off the router via
 * Express's own route-table introspection (router.stack), rather than
 * reimplementing or duplicating it — this test drives the SAME function
 * production traffic hits.
 */
function getAdminLoginHandler(router) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === '/admin/login' && l.route.methods.post
  );
  if (!layer) throw new Error('POST /admin/login route not found on router.stack');
  return layer.route.stack[0].handle;
}

/**
 * Minimal req/res mock covering exactly what the handler touches: req.body,
 * res .on()/.removeListener() for the 'close' event, and
 * res.status()/cookie()/redirect()/render(). `_fireClose()` simulates the
 * underlying connection closing (AC4's disconnect, or the normal
 * post-response cleanup event every response fires once done). req carries
 * no .on()/.removeListener() -- withCompareSlot listens on res's 'close',
 * never req's (see src/routes/auth.js's own comment on why), so a req-side
 * listener mock would be dead scaffolding nothing ever calls.
 */
function makeMockReqRes(password) {
  const resListeners = {};

  const req = {
    body: { password },
  };

  const res = {
    statusCode: 200,
    _cookies: [],
    _redirect: null,
    _rendered: null,
    on(event, cb) {
      (resListeners[event] = resListeners[event] || []).push(cb);
      return res;
    },
    removeListener(event, cb) {
      if (resListeners[event]) resListeners[event] = resListeners[event].filter((fn) => fn !== cb);
      return res;
    },
    status(code) {
      res.statusCode = code;
      return res;
    },
    cookie(name, value) {
      res._cookies.push({ name, value });
      return res;
    },
    redirect(url) {
      res._redirect = url;
      res.statusCode = 302; // matches Express's own default for res.redirect(url)
      return res;
    },
    render(view, locals) {
      res._rendered = { view, locals };
      return res;
    },
    _fireClose() {
      resListeners.close.slice().forEach((fn) => fn());
    },
  };

  return { req, res };
}

/**
 * A controllable stand-in for bcrypt.compare: records every call (started),
 * the running in-flight count and its high-water mark, and returns a
 * Promise that stays pending until the test explicitly settles it —
 * matching a real password against CORRECT_PASSWORD, everything else false.
 */
function makeControlledCompare() {
  let started = 0;
  let settledCount = 0;
  let inFlight = 0;
  let highWater = 0;
  const pending = [];

  function compareImpl(password) {
    started += 1;
    inFlight += 1;
    highWater = Math.max(highWater, inFlight);
    return new Promise((resolve) => {
      pending.push({ password, resolve });
    });
  }

  function settleOne() {
    const next = pending.shift();
    if (!next) return false;
    inFlight -= 1;
    settledCount += 1;
    next.resolve(next.password === CORRECT_PASSWORD);
    return true;
  }

  function settleAllPending() {
    let n = 0;
    while (settleOne()) n += 1;
    return n;
  }

  return {
    compareImpl,
    settleOne,
    settleAllPending,
    counts: () => ({ started, settledCount, inFlight, highWater, pendingCount: pending.length }),
  };
}

// No real I/O happens anywhere in this file (see the file header), so
// letting the promise chain (acquire -> compareImpl -> release -> next
// acquire -> next compareImpl) advance only ever needs a couple of
// microtask/macrotask ticks, never a wall-clock wait.
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitUntil(predicate, describeState, maxTicks = 200) {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error(`waitUntil: condition not met after ${maxTicks} ticks (${describeState()})`);
}

/**
 * Repeatedly settle whatever is currently pending and let the freed slots'
 * next waiters start, until `totalExpected` compares have settled overall.
 */
async function drainAll(fake, totalExpected) {
  await waitUntil(
    () => {
      fake.settleAllPending();
      return fake.counts().settledCount >= totalExpected;
    },
    () => `settled ${fake.counts().settledCount}/${totalExpected}, started=${fake.counts().started}`
  );
}

describe('POST /admin/login CPU-bound gate (#543)', () => {
  it('AC1: bounds concurrent compares to N=3 (the live ADMIN_LOGIN_MAX_CONCURRENT_COMPARES override) and all 6 wrong-password requests still receive a final response', async () => {
    const fake = makeControlledCompare();
    authRouter._setCompareImplForTest(fake.compareImpl);
    const semaphore = authRouter._adminLoginSemaphoreForTest();
    // Proves the live gate actually picked up the env override (3), not
    // config.js's own hardcoded default (2) — see the file-header comment.
    expect(semaphore.limit).toBe(3);

    const mocks = [];
    const promises = [];
    for (let i = 0; i < 6; i++) {
      const m = makeMockReqRes('wrong' + i);
      mocks.push(m);
      promises.push(handler(m.req, m.res));
    }

    // Let the 3 fast-path acquires progress past their `await` and into
    // compareImpl(); the other 3 queue behind the semaphore without calling
    // compareImpl at all.
    await waitUntil(
      () => fake.counts().started === 3,
      () => `started=${fake.counts().started}, expected exactly 3 in flight before any settle`
    );
    expect(fake.counts().inFlight).toBe(3);

    await drainAll(fake, 6);
    await Promise.all(promises);

    mocks.forEach((m) => {
      // Never a hang (Promise.all above already proves that) and never a
      // 500 — a final response is exactly a 401 (wrong password) here,
      // since ADMIN_LOGIN_MAX_ATTEMPTS is set far out of reach.
      expect(m.res.statusCode).toBe(401);
    });
    // The bound was never exceeded at any point during the whole run, not
    // just at the first snapshot above.
    expect(fake.counts().highWater).toBeLessThanOrEqual(3);
    expect(fake.counts().started).toBe(6);
  });

  it('AC2: a correct password still wins with the bound saturated and 20+ wrong attempts already queued ahead of it', async () => {
    const fake = makeControlledCompare();
    authRouter._setCompareImplForTest(fake.compareImpl);
    const semaphore = authRouter._adminLoginSemaphoreForTest();

    // 3 saturate the bound, 20 more queue behind it — 23 total ahead of the
    // correct-password request sent next.
    const wrongMocks = [];
    const wrongPromises = [];
    for (let i = 0; i < 23; i++) {
      const m = makeMockReqRes('wrong' + i);
      wrongMocks.push(m);
      wrongPromises.push(handler(m.req, m.res));
    }
    await waitUntil(
      () => semaphore.queue.length === 20,
      () => `queue.length=${semaphore.queue.length}, started=${fake.counts().started}`
    );
    expect(fake.counts().inFlight).toBe(3);

    const correctMock = makeMockReqRes(CORRECT_PASSWORD);
    const correctPromise = handler(correctMock.req, correctMock.res);
    await waitUntil(
      () => semaphore.queue.length === 21,
      () => `queue.length=${semaphore.queue.length}`
    );
    // The correct-password request queued behind the 20 — it did not jump
    // the line and start its compare early.
    expect(fake.counts().started).toBe(3);

    // Drain the whole queue (23 wrong + the correct one = 24 total compares).
    await drainAll(fake, 24);
    await correctPromise;

    expect(correctMock.res.statusCode).toBe(302); // never 429/503 from this gate
    expect(correctMock.res._redirect).toBe('/admin');
    expect(correctMock.res._cookies.some((c) => c.name === 'admin')).toBe(true);

    await Promise.all(wrongPromises);
    wrongMocks.forEach((m) => expect(m.res.statusCode).toBe(401));
  });

  it('AC3: 50 concurrent wrong-password requests all receive a final response and the high-water mark never exceeds the bound', async () => {
    const fake = makeControlledCompare();
    authRouter._setCompareImplForTest(fake.compareImpl);

    const mocks = [];
    const promises = [];
    for (let i = 0; i < 50; i++) {
      const m = makeMockReqRes('wrong' + i);
      mocks.push(m);
      promises.push(handler(m.req, m.res));
    }

    await drainAll(fake, 50);
    await Promise.all(promises);

    mocks.forEach((m) => {
      expect(m.res.statusCode).not.toBe(503);
      expect(m.res.statusCode).not.toBe(429); // ruled out by the raised ADMIN_LOGIN_MAX_ATTEMPTS
      expect(m.res.statusCode).toBe(401);
    });
    expect(fake.counts().highWater).toBeLessThanOrEqual(3);
    expect(fake.counts().started).toBe(50);
  });

  it('AC4: a disconnected QUEUED waiter is dropped without ever consuming a compare, and a correct password afterward still wins', async () => {
    const fake = makeControlledCompare();
    authRouter._setCompareImplForTest(fake.compareImpl);
    const semaphore = authRouter._adminLoginSemaphoreForTest();

    // Saturate the bound with 3 in-flight wrong-password requests.
    const activeMocks = [];
    const activePromises = [];
    for (let i = 0; i < 3; i++) {
      const m = makeMockReqRes('active' + i);
      activeMocks.push(m);
      activePromises.push(handler(m.req, m.res));
    }
    await waitUntil(
      () => fake.counts().started === 3,
      () => `started=${fake.counts().started}`
    );
    expect(fake.counts().inFlight).toBe(3);

    // 20 more queue behind the saturated bound.
    const queuedMocks = [];
    const queuedPromises = [];
    for (let i = 0; i < 20; i++) {
      const m = makeMockReqRes('queued' + i);
      queuedMocks.push(m);
      queuedPromises.push(handler(m.req, m.res));
    }
    await waitUntil(
      () => semaphore.queue.length === 20,
      () => `queue.length=${semaphore.queue.length}`
    );
    expect(fake.counts().started).toBe(3); // none of the 20 has started a compare

    // All 20 queued clients disconnect before acquiring a slot.
    queuedMocks.forEach((m) => m.res._fireClose());

    // Queue length returns to 0 (spliced out, not tombstoned) and no
    // compare ran on behalf of any of the 20 — started stays exactly the
    // 3 still-connected in-flight callers.
    await waitUntil(
      () => semaphore.queue.length === 0,
      () => `queue.length=${semaphore.queue.length} after disconnecting all 20 queued clients`
    );
    expect(fake.counts().started).toBe(3);

    // Free the 3 active slots (their compares were never touched by the
    // disconnects above — they already held their slots).
    fake.settleAllPending();
    await Promise.all(activePromises);
    activeMocks.forEach((m) => expect(m.res.statusCode).toBe(401));

    // With the queue empty and all slots free again, no leaked slot should
    // block a subsequent correct-password login (the failure mode a
    // tombstoning implementation would produce instead of splicing).
    expect(semaphore.active).toBe(0);
    expect(semaphore.queue.length).toBe(0);

    const correctMock = makeMockReqRes(CORRECT_PASSWORD);
    const correctPromise = handler(correctMock.req, correctMock.res);
    await waitUntil(
      () => fake.counts().inFlight === 1,
      () => `inFlight=${fake.counts().inFlight}`
    );
    fake.settleAllPending();
    await correctPromise;

    expect(correctMock.res.statusCode).toBe(302);
    expect(correctMock.res._redirect).toBe('/admin');
    expect(correctMock.res._cookies.some((c) => c.name === 'admin')).toBe(true);

    // Total compares started across the whole test never exceeded the
    // number of still-connected callers (3 active + 1 correct = 4), never
    // the 23 that were sent (3 active + 20 queued-then-disconnected).
    expect(fake.counts().started).toBe(4);

    // The 20 disconnected requests' handler calls already resolved (their
    // acquire() rejected and the handler returned early) — await them so
    // nothing is left dangling.
    await Promise.all(queuedPromises);
  });

  it("edge case: res 'close' firing again after a normal response is a no-op, never a double-release", async () => {
    // Every response's underlying connection eventually closes, including a
    // normal, successful one — 'close' firing a second time after the
    // handler already resolved (acquired, compared, released) must not
    // corrupt the semaphore's active count.
    const fake = makeControlledCompare();
    authRouter._setCompareImplForTest(fake.compareImpl);
    const semaphore = authRouter._adminLoginSemaphoreForTest();

    const m = makeMockReqRes(CORRECT_PASSWORD);
    const promise = handler(m.req, m.res);
    await waitUntil(
      () => fake.counts().started === 1,
      () => `started=${fake.counts().started}`
    );
    fake.settleAllPending();
    await promise;

    expect(m.res.statusCode).toBe(302);
    expect(semaphore.active).toBe(0); // released normally, fast-path acquire never touched the queue

    // Simulate the connection's 'close' firing again after the response
    // already completed.
    expect(() => m.res._fireClose()).not.toThrow();
    expect(semaphore.active).toBe(0); // unchanged -- not decremented into negative
    expect(semaphore.queue.length).toBe(0);
  });

  it("security: a non-string password (e.g. the ARRAY express.urlencoded produces for a duplicated password=a&password=b field) is coerced to '' before reaching compareImpl, and the handler still sends a final 401 — never hangs", async () => {
    // Reproduces the reviewer-found DoS: querystring parses a repeated
    // `password` field into an array, which is truthy and used to survive a
    // bare `req.body.password || ''`. The real bcrypt.compare rejects on a
    // non-string argument, and since this handler is async, Express 4 never
    // routes that rejection anywhere (see src/routes/auth.js:113-118) — no
    // response is ever sent and the socket pins forever. This test doesn't
    // need the real bcrypt to prove the fix: it asserts directly that
    // compareImpl only ever sees a string, which is what makes the real
    // bcrypt.compare's rejection path unreachable from this route.
    let receivedPassword;
    authRouter._setCompareImplForTest((password) => {
      receivedPassword = password;
      return Promise.resolve(false);
    });

    const m = makeMockReqRes(['a', 'b']); // simulates password=a&password=b
    await handler(m.req, m.res);

    expect(typeof receivedPassword).toBe('string');
    expect(receivedPassword).toBe('');
    expect(m.res.statusCode).toBe(401); // final response sent — no hang
  });

  it("security: a non-string, non-array password (e.g. an object body value) is also coerced to '' and gets a final 401", async () => {
    let receivedPassword;
    authRouter._setCompareImplForTest((password) => {
      receivedPassword = password;
      return Promise.resolve(false);
    });

    const m = makeMockReqRes({ nested: 'value' });
    await handler(m.req, m.res);

    expect(receivedPassword).toBe('');
    expect(m.res.statusCode).toBe(401);
  });

  it('reviewer-demonstrated hang (#543 tightening): a rejecting compare yields a final 500, never a hang, and the gate slot is released so a later correct password still gets its 302', async () => {
    // Same failure class as the non-string-password fix above, one line
    // away, in code src/routes/auth.js itself documents at :681-691:
    // withCompareSlot's inner try has a finally but no catch, so a
    // compareImpl REJECTION propagates out of the async route handler
    // uncaught -- and Express 4 does not route an async handler's
    // rejection to next(err) (see src/routes/auth.js:113-118), so without
    // the route-level try/catch this test guards, `await handler(...)`
    // below would never resolve.
    authRouter._setCompareImplForTest(() => Promise.reject(new Error('Illegal salt length')));

    const m = makeMockReqRes(CORRECT_PASSWORD);
    // If the route handler let this rejection escape uncaught, this await
    // would hang forever instead of resolving (the runner's own test
    // timeout is what would fail this test, not an assertion below).
    await handler(m.req, m.res);

    expect(m.res.statusCode).toBe(500);
    expect(m.res._rendered).not.toBeNull();
    expect(m.res._rendered.view).toBe('admin-login');
    // Reuses the existing generic setup-error copy -- never leaks the
    // underlying exception message into the response.
    expect(m.res._rendered.locals.error).toBe(
      'The admin area is not set up yet. Please ask the host to finish setup.'
    );

    // withCompareSlot's finally runs on either outcome, so the slot was
    // released despite the rejection -- prove it structurally (not just by
    // the request not hanging) and then behaviorally: a genuinely correct
    // password sent next still wins rather than queueing behind a leaked
    // slot forever.
    const semaphore = authRouter._adminLoginSemaphoreForTest();
    expect(semaphore.active).toBe(0);
    expect(semaphore.queue.length).toBe(0);

    authRouter._setCompareImplForTest(() => Promise.resolve(true));
    const okMock = makeMockReqRes(CORRECT_PASSWORD);
    await handler(okMock.req, okMock.res);

    expect(okMock.res.statusCode).toBe(302);
    expect(okMock.res._redirect).toBe('/admin');
    expect(okMock.res._cookies.some((c) => c.name === 'admin')).toBe(true);
  });

  it('a non-abort acquire() rejection propagates through withCompareSlot as a thrown error, not a silent cancellation (#543 tightening)', async () => {
    // Semaphore.acquire's JSDoc documents cancellation via AbortSignal but
    // never promises abort is the ONLY way acquire() can reject -- today it
    // happens to be, but withCompareSlot must not rely on that as an
    // unstated exclusivity. Monkey-patch the live semaphore's acquire() to
    // reject for an unrelated reason while the request's own
    // controller.signal is never aborted (the mock res never fires
    // 'close'), and confirm withCompareSlot does NOT swallow it as
    // `{ cancelled: true }` (which would send no response at all, per
    // AC4's tests above) -- it must propagate so the route handler's catch
    // renders the generic 500 instead.
    const semaphore = authRouter._adminLoginSemaphoreForTest();
    const realAcquire = semaphore.acquire.bind(semaphore);
    semaphore.acquire = () => Promise.reject(new Error('some unrelated acquire failure'));
    authRouter._setCompareImplForTest(() => Promise.resolve(true)); // must never be reached

    const m = makeMockReqRes(CORRECT_PASSWORD);
    try {
      await handler(m.req, m.res);
    } finally {
      semaphore.acquire = realAcquire;
    }

    expect(m.res.statusCode).toBe(500);
    expect(m.res._rendered.view).toBe('admin-login');
    // Never authenticated -- proves the rejection short-circuited before
    // fn() (the compare) ever ran, not after.
    expect(m.res._cookies.some((c) => c.name === 'admin')).toBe(false);
  });

  it('reviewer-demonstrated hang, reproduced with the real bcryptjs.compare: a readable-but-corrupt 60-char admin.hash rejects instead of resolving false, and the route still returns a final 500', async () => {
    // The exact scenario three independent reviewers demonstrated live: a
    // 60-character string (a real bcrypt hash's length, so a naive
    // length-only guard would not catch it) that is not valid bcrypt hash
    // content. A hash of some OTHER length resolves false and is harmless
    // -- 60 is the trigger. This test uses the REAL bcrypt.compare (no
    // fake compareImpl) so it proves the fix against the actual library
    // behavior, not just an assumption about how it fails.
    authRouter._setCompareImplForTest(null); // restore the real bcrypt.compare

    const config = require('../config');
    const hashPath = config.ADMIN_HASH_PATH;
    const originalHash = fs.readFileSync(hashPath, 'utf8');
    const corruptHash = '$2a$12$' + '!'.repeat(53);
    expect(corruptHash.length).toBe(60);
    fs.writeFileSync(hashPath, corruptHash, 'utf8');

    try {
      const m = makeMockReqRes(CORRECT_PASSWORD);
      await handler(m.req, m.res); // hangs forever pre-fix; must resolve here

      expect(m.res.statusCode).toBe(500);
      expect(m.res._rendered.view).toBe('admin-login');
    } finally {
      // Restore the valid hash so no later test in this file that falls
      // through to the real compareImpl (none currently do besides this
      // one) sees a corrupt admin.hash left behind.
      fs.writeFileSync(hashPath, originalHash, 'utf8');
    }
  });
});

// Direct unit tests of Semaphore's cancellation API (src/utils/semaphore.js),
// separate from the route-handler tests above. The handler tests above DO
// saturate the bound and DO register abort listeners: AC1/AC2/AC3/AC4 all
// push the gate past ADMIN_LOGIN_MAX_CONCURRENT_COMPARES and queue waiters,
// and AC4 specifically queues 20 waiters and aborts every one of them --
// this suite's only coverage of the splice-out-by-identity branch in
// onAbort (`this.queue.splice(idx, 1)`).
//
// What the handler tests cannot reach is the PRE-aborted fast-reject branch
// (semaphore.js:50, `if (signal && signal.aborted) return ...`): the route
// handler always creates a fresh AbortController and only aborts it later,
// via res's 'close' listener, so there is no handler path that calls
// acquire() with a signal that is already aborted. The direct test below
// closes exactly that gap.
//
// The "already acquired" guard (`idx === -1` at semaphore.js:73, its
// `return` at :81) is NOT covered by either the handler tests or the direct
// tests below, and cannot be by construction: onAcquire detaches onAbort
// (semaphore.js:68) as its very first action, before resolve(), so once a
// slot is granted onAbort can no longer run for that waiter at all -- there
// is no call path left that reaches the idx === -1 branch with a live
// listener still attached. It is deliberately-uncovered defensive code,
// kept only in case a future reordering of onAcquire/onAbort ever changes
// that invariant; coverage confirms this (semaphore.js:81 is uncovered
// across the whole suite). Do not read the assertions below as proof this
// guard works -- they can't reach it.
describe('Semaphore cancellation API (#543 direct unit coverage)', () => {
  it('acquire() with an already-aborted signal rejects immediately and never spends a slot', async () => {
    const sem = new Semaphore(1);
    const controller = new AbortController();
    controller.abort();

    // If the pre-aborted fast-reject branch were removed or inverted, this
    // would resolve instead of reject.
    await expect(sem.acquire({ signal: controller.signal })).rejects.toBeTruthy();

    // The rejected caller must not have consumed the only slot -- a fresh,
    // un-aborted caller can still acquire it.
    expect(sem.active).toBe(0);
    expect(sem.queue.length).toBe(0);
    await sem.acquire();
    expect(sem.active).toBe(1);
  });

  it('a waiter granted its slot via the queue is immune to a later abort on its own signal', async () => {
    const sem = new Semaphore(1);

    // Fill the only slot.
    await sem.acquire();
    expect(sem.active).toBe(1);

    // Two more callers queue behind it.
    const c2 = new AbortController();
    const c3 = new AbortController();
    const p2 = sem.acquire({ signal: c2.signal });
    const p3 = sem.acquire({ signal: c3.signal });
    expect(sem.queue.length).toBe(2);

    // Release the held slot -- ownership transfers straight to the front
    // queued waiter (p2) via the queue; active does not dip to 0 first.
    sem.release();
    await p2; // must resolve, never reject, once granted via the queue
    expect(sem.active).toBe(1);
    expect(sem.queue.length).toBe(1); // only p3 remains queued

    // p2 already holds its slot. Aborting its signal now must be a no-op --
    // but NOT because the idx === -1 guard catches it. onAcquire detaches
    // onAbort (signal.removeEventListener, semaphore.js:68) as its first
    // action, before resolve(), so by the time p2 was granted its slot the
    // abort listener was already gone: this abort() call has no listener
    // left to invoke, and onAbort (and its idx === -1 guard) never runs at
    // all. This assertion proves active/queue state survives a
    // post-acquisition abort unchanged (no double-release, no accidental
    // queue mutation) -- it does NOT exercise or validate the idx === -1
    // guard itself, which stays uncovered (see this describe block's own
    // header comment above).
    c2.abort();
    expect(sem.active).toBe(1);
    expect(sem.queue.length).toBe(1);

    // Prove p3 is still genuinely queued and reachable: release again and
    // confirm p3 resolves via the queue rather than hanging forever.
    sem.release();
    await p3;
    expect(sem.active).toBe(1);
    expect(sem.queue.length).toBe(0);
  });
});
