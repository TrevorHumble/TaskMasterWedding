// tests/rate-limit.test.js
// Issue #283: AC1-AC4, AC4b — the fixed-window rate limiter
// (src/middleware/rate-limit.js) at the unit level (AC1, a fake clock, no
// HTTP) and wired through real routes (AC2-AC4b, supertest against the
// exported app).
//
// ONE loadApp() for the whole file (issue: within a single test file,
// `require('../../src/app')` is cached after its FIRST call — a second
// loadApp() call in the same file changes process.env but returns the
// already-cached app/db from the first call, silently ignoring the new temp
// DATA_DIR. So all HTTP-driving describe blocks below share ONE app/db/set
// of rate-limiter instances, same as every other test file in this repo).
// Each describe block lowers a config.RATE_LIMIT_* value for its own test and
// restores it in a finally block. AC3 (POST /login) and AC4 (POST /join) use
// SEPARATE limiter instances (src/routes/auth.js) so they cannot interfere
// with each other even sharing one app; AC2/AC4b are guest-keyed so they
// cannot interfere with the IP-keyed tests or each other's own guests.
'use strict';

const request = require('supertest');
const { loadApp, signInGuest } = require('./helpers/testApp');

// REQUIRE ORDER (the #313 live-DB guard catches getting this wrong): NOTHING
// that pulls in config.js may be required at file scope. src/middleware/
// rate-limit.js requires config, and config caches DATA_DIR at ITS first
// require — so a file-scope require here would freeze config on the LIVE
// data/ dir before loadApp() ever sets the temp override, and the later
// src/db.js require would then open the real app.db. Both the app and the
// middleware are therefore required inside the file-level beforeAll below,
// after loadApp() has set DATA_DIR.
let app;
let db;
let config;
let createRateLimiter;

beforeAll(() => {
  const result = loadApp();
  app = result.app;
  db = result.db;
  config = require('../config');
  createRateLimiter = require('../src/middleware/rate-limit').createRateLimiter;
});

// ---------------------------------------------------------------------------
// AC1: createRateLimiter unit behavior with a fake clock (no HTTP, no app).
// ---------------------------------------------------------------------------
describe('#283 AC1: createRateLimiter unit behavior', () => {
  function fakeRes() {
    return {
      statusCode: null,
      headers: {},
      rendered: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      set(name, value) {
        this.headers[name] = value;
        return this;
      },
      render(view, locals) {
        this.rendered = { view, locals };
      },
    };
  }

  it('allows requests 1-3, 429s request 4 with a clamped Retry-After, then allows again once the window elapses', () => {
    let clock = 1_000_000;
    const limiter = createRateLimiter({
      windowMs: 60000,
      max: 3,
      keyFn: () => 'k',
      now: () => clock,
    });

    let nextCalls = 0;
    const next = () => {
      nextCalls += 1;
    };

    for (let i = 0; i < 3; i++) {
      limiter({}, fakeRes(), next);
    }
    expect(nextCalls).toBe(3);

    const res4 = fakeRes();
    limiter({}, res4, next);
    expect(nextCalls).toBe(3); // request 4 did NOT call next()
    expect(res4.statusCode).toBe(429);
    expect(res4.rendered.view).toBe('error');
    expect(typeof res4.rendered.locals.message).toBe('string');

    const retryAfter = parseInt(res4.headers['Retry-After'], 10);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);

    // Advance the clock past the window: a 5th request is allowed again.
    clock += 60001;
    limiter({}, fakeRes(), next);
    expect(nextCalls).toBe(4);
  });

  it('sweeps expired entries once the map reaches trackedMax, bounding memory without a timer', () => {
    let clock = 0;
    const limiter = createRateLimiter({
      windowMs: 100,
      max: 1,
      keyFn: (req) => req.key,
      now: () => clock,
      trackedMax: 3,
    });
    const next = () => {};
    const res = fakeRes();

    limiter({ key: 'a' }, res, next);
    limiter({ key: 'b' }, res, next);
    limiter({ key: 'c' }, res, next);
    expect(limiter._size()).toBe(3);

    // Advance past the window: a/b/c are now all expired.
    clock = 1000;
    // A 4th, genuinely NEW key triggers the sweep-on-insert (map size already
    // at trackedMax).
    limiter({ key: 'd' }, res, next);
    expect(limiter._size()).toBe(1); // a/b/c swept away; only 'd' remains
  });

  it('holds trackedMax under a distinct-key flood INSIDE one window, where nothing is expired and a sweep frees nothing', () => {
    // The bound that matters on the IP-keyed limiters: an attacker floods
    // distinct source IPs faster than any window retires, so the sweep above
    // has nothing to reclaim. Without a hard cap the map grows per key
    // without limit and each new-key insert pays an O(size) scan.
    const clock = 1_000_000; // frozen: no key ever expires during this test
    const limiter = createRateLimiter({
      windowMs: 600000, // the production RATE_LIMIT_WINDOW_MS default
      max: 5,
      keyFn: (req) => req.key,
      now: () => clock,
      trackedMax: 3,
    });
    const next = () => {};
    const res = fakeRes();

    for (let i = 0; i < 30; i++) {
      limiter({ key: `ip:198.51.100.${i}` }, res, next);
    }

    // 30 distinct keys, none expired, cap 3.
    expect(limiter._size()).toBe(3);
  });

  it('evicts the SOONEST-EXPIRING key, so a fresher key survives a flood', () => {
    let clock = 0;
    const limiter = createRateLimiter({
      windowMs: 1000,
      max: 5,
      keyFn: (req) => req.key,
      now: () => clock,
      trackedMax: 2,
    });
    const next = () => {};
    const res = fakeRes();

    limiter({ key: 'oldest' }, res, next); // resetAt = 1000
    clock = 100;
    limiter({ key: 'newer' }, res, next); // resetAt = 1100
    expect(limiter._size()).toBe(2);

    clock = 200;
    limiter({ key: 'newest' }, res, next); // forces one eviction

    expect(limiter._size()).toBe(2);
    // 'oldest' (soonest resetAt) was the victim; 'newer' kept its live count.
    // Proven through behavior, not internals: 'newer' has already spent 1 of
    // its 5, so 4 more requests pass and the 5th is refused — an evicted-and-
    // reinserted 'newer' would have a full budget and let all 5 through.
    for (let i = 0; i < 4; i++) {
      const r = fakeRes();
      limiter({ key: 'newer' }, r, next);
      expect(r.statusCode).toBe(null); // allowed
    }
    const over = fakeRes();
    limiter({ key: 'newer' }, over, next);
    expect(over.statusCode).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// AC2-AC4b: wired through real routes. ONE shared app/db for this whole file
// (see file header) — every test below uses uniquely-named contacts/tokens
// and delta-based counts so it is independent of what earlier tests in this
// file already wrote.
// ---------------------------------------------------------------------------
describe('#283 AC2-AC4b: rate limiter wired through real routes', () => {
  // Uses the file-level app/db/config (set in the file-level beforeAll above);
  // no second loadApp() — one app instance per file, since Node caches
  // src/app.js after its first require regardless.

  it('AC2: per-guest keying — guest 1 hits the per-guest comment limit, guest 2 (same IP) is unaffected', async () => {
    const original = config.RATE_LIMIT_SOCIAL_MAX;
    config.RATE_LIMIT_SOCIAL_MAX = 2;
    try {
      const taskId = db
        .prepare(`INSERT INTO tasks (title) VALUES (?)`)
        .run('AC2 task').lastInsertRowid;
      const guest1Id = db
        .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
        .run('ac2-g1', 'AC2 Guest One').lastInsertRowid;
      db.prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`).run('ac2-g2', 'AC2 Guest Two');
      const submissionId = db
        .prepare(
          `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
           VALUES (?, ?, ?, ?, 0)`
        )
        .run(guest1Id, taskId, 'ac2.jpg', 'ac2t.jpg').lastInsertRowid;

      const agent1 = signInGuest(app, 'ac2-g1');
      const agent2 = signInGuest(app, 'ac2-g2');

      const r1 = await agent1
        .post(`/p/${submissionId}/comments`)
        .type('form')
        .send({ body: 'guest1 comment 1' });
      const r2 = await agent1
        .post(`/p/${submissionId}/comments`)
        .type('form')
        .send({ body: 'guest1 comment 2' });
      const r3 = await agent2
        .post(`/p/${submissionId}/comments`)
        .type('form')
        .send({ body: 'guest2 comment 1' });

      expect(r1.status).toBe(302);
      expect(r2.status).toBe(302);
      expect(r3.status).toBe(302); // guest 2's own budget is untouched by guest 1's usage

      const r4 = await agent1
        .post(`/p/${submissionId}/comments`)
        .type('form')
        .send({ body: 'guest1 comment 3 (over budget)' });
      expect(r4.status).toBe(429);
    } finally {
      config.RATE_LIMIT_SOCIAL_MAX = original;
    }
  });

  it('AC3: PIN-guessing throttle on POST /login (IP-keyed) — 4th wrong-credential POST is 429; GET /healthz is unaffected', async () => {
    const original = config.RATE_LIMIT_IP_MAX;
    config.RATE_LIMIT_IP_MAX = 3;
    try {
      for (let i = 0; i < 3; i++) {
        const res = await request(app)
          .post('/login')
          .type('form')
          .send({ contact: 'ac3-nobody@example.com', pin: '0000' });
        expect(res.status).toBe(401);
      }

      const res4 = await request(app)
        .post('/login')
        .type('form')
        .send({ contact: 'ac3-nobody@example.com', pin: '0000' });
      expect(res4.status).toBe(429);

      const health = await request(app).get('/healthz');
      expect(health.status).toBe(200);
    } finally {
      config.RATE_LIMIT_IP_MAX = original;
    }
  });

  it('AC4: signup-flood throttle on POST /join (IP-keyed) — 4th signup POST is 429 and at most 3 NEW guest rows are created', async () => {
    const original = config.RATE_LIMIT_IP_MAX;
    config.RATE_LIMIT_IP_MAX = 3;
    try {
      const before = db.prepare('SELECT COUNT(*) AS n FROM guests').get().n;

      for (let i = 0; i < 3; i++) {
        const res = await request(app)
          .post('/join')
          .type('form')
          .send({ name: 'AC4 Guest ' + i, contact: `ac4-guest${i}@example.com`, pin: '1234' });
        expect(res.status).toBe(302);
      }

      const res4 = await request(app)
        .post('/join')
        .type('form')
        .send({ name: 'AC4 Guest X', contact: 'ac4-guestx@example.com', pin: '1234' });
      expect(res4.status).toBe(429);

      // Exactly 3 — asserts the real value, and still satisfies AC4's "at
      // most 3 guest rows were created". A <= 3 assertion would also pass if
      // the 3 allowed signups had silently created nothing.
      const after = db.prepare('SELECT COUNT(*) AS n FROM guests').get().n;
      expect(after - before).toBe(3);
    } finally {
      config.RATE_LIMIT_IP_MAX = original;
    }
  });

  it('AC4b: bug-report throttle (carried from #369) — 3rd bug-report from one guest is 429; a second guest on the same IP is unaffected', async () => {
    const original = config.RATE_LIMIT_SOCIAL_MAX;
    config.RATE_LIMIT_SOCIAL_MAX = 2;
    try {
      db.prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`).run('ac4b-g1', 'AC4b Guest One');
      db.prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`).run('ac4b-g2', 'AC4b Guest Two');

      const agent1 = signInGuest(app, 'ac4b-g1');
      const agent2 = signInGuest(app, 'ac4b-g2');

      const r1 = await agent1.post('/bug-report').type('form').send({ body: 'bug 1' });
      const r2 = await agent1.post('/bug-report').type('form').send({ body: 'bug 2' });
      expect(r1.status).toBe(302);
      expect(r2.status).toBe(302);

      const r3 = await agent1
        .post('/bug-report')
        .type('form')
        .send({ body: 'bug 3 (over budget)' });
      expect(r3.status).toBe(429);

      // A second guest, same source IP as agent1 (both hit the same test
      // server), has its OWN untouched budget (guest-keyed, not IP-keyed).
      const r4 = await agent2.post('/bug-report').type('form').send({ body: 'guest2 bug report' });
      expect(r4.status).toBe(302);
    } finally {
      config.RATE_LIMIT_SOCIAL_MAX = original;
    }
  });
});
