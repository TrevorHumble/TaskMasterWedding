// tests/community-guard-coverage.test.js
// Issue #574 — src/routes/community.js:44 gates its own routes with a
// hand-maintained path-prefix list. That list and the router's actual route
// registrations are two copies of one fact with no mechanical link: a new
// route added under a prefix nobody remembers to add to the list ships
// anonymous-reachable, and tests/community-access.test.js's hand-written
// path list (six paths, frozen at #466's shape) cannot notice a seventh.
//
// This file replaces "enumerate the paths by hand" with "walk the router's
// own stack" — every registered route is discovered from the live Router
// object, not restated, so there is no hand-written list here to drift
// either (a hand-written list here would be a THIRD copy of the same fact —
// the issue explicitly rejects that shape). AC4 below holds to that same
// rule for its own throwaway fixture: it does not copy community.js's real
// guard list either.
'use strict';

const express = require('express');
const request = require('supertest');
const { loadApp } = require('./helpers/testApp');

// Require order matters and is a known trap here (tests/community-access.test.js
// records the same trap in its own comments): config.js and db.js resolve
// DATA_DIR/DB_PATH at first-require time, so loadApp() — which sets those env
// vars and then requires src/app.js (which itself requires
// src/routes/community.js) — MUST run before anything in this file requires
// the community router directly. This has to happen at module-evaluation
// time (not inside a beforeAll) because the it.each block below needs the
// discovered route list synchronously, at test-collection time, before any
// Jest lifecycle hook has run.
loadApp();
const communityRouter = require('../src/routes/community');
const { requireGuest } = require('../src/middleware/session');

/**
 * Intentionally-public community routes (AC3). Empty today: every route this
 * router registers is guest-gated, and the guard list in community.js
 * covers every prefix the router uses. Making a future route deliberately
 * public means adding an explicit { method, path } entry here — a
 * reviewable line, not the absence of one.
 *
 * `path` is the route's own template path exactly as registered with
 * Express (e.g. '/badge/:code'), matched against the SAME template path
 * walkRoutes() below reads off the router — not the substituted request
 * path, so one entry covers every concrete id. `method` is lowercase,
 * matching what Object.keys(layer.route.methods) yields (see walkRoutes).
 */
const PUBLIC_ALLOWLIST = [];

/**
 * Does `allowlist` name this method+templatePath as intentionally public?
 * Takes the allowlist as a parameter (rather than closing over
 * PUBLIC_ALLOWLIST directly) so its matching rule can be pinned in tests
 * against a local fixture, without the pin depending on — or being able to
 * silently pass because of — the real allowlist's current (empty) contents.
 */
function isAllowlisted(method, templatePath, allowlist) {
  return allowlist.some((entry) => entry.method === method && entry.path === templatePath);
}

/**
 * Walk a router's own stack (router.stack) and return every registered
 * route as { method, templatePath, concretePath }. Only layers carrying a
 * `.route` are routes (a router.use(...) middleware layer, like the
 * requireGuest guard itself, has no `.route` and is skipped here — AC5
 * inspects those separately). concretePath substitutes every `:param`
 * segment with the literal '1': the guard this test is proving must fire
 * before any handler resolves an id, so no seeded row is required to reach
 * it — the same reasoning tests/community-access.test.js records for its
 * own literal '/p/1'. `method` is lowercase — Object.keys() on Express's
 * route.methods object yields the lowercase verb names ('get', 'post', ...)
 * it was built from.
 */
function walkRoutes(router) {
  const routes = [];
  for (const layer of router.stack) {
    if (!layer.route) continue;
    const templatePath = layer.route.path;
    const concretePath = templatePath.replace(/:[^/]+/g, '1');
    for (const method of Object.keys(layer.route.methods)) {
      if (layer.route.methods[method]) {
        routes.push({ method, templatePath, concretePath });
      }
    }
  }
  return routes;
}

/**
 * The one assertion AC1 makes per discovered route: an anonymous request
 * (no session cookie) to `method path` on `app` is redirected to /join.
 * Shared between the gated-route suite below and the AC4 negative case, so
 * AC4 demonstrates the SAME check failing, not a differently-worded one.
 */
async function assertGated(app, method, path) {
  const res = await request(app)[method](path);
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe('/join');
}

const discoveredRoutes = walkRoutes(communityRouter);
const gatedRoutes = discoveredRoutes.filter(
  (r) => !isAllowlisted(r.method, r.templatePath, PUBLIC_ALLOWLIST)
);

describe("community router guard coverage, derived from the router's own stack (#574)", () => {
  // A bare Express app: communityRouter mounted alone at '/' with NO
  // guest.js ahead of it, and a 404 handler behind it — same shape as
  // tests/community-access.test.js's AC3 block, so a 302 observed here comes
  // from community.js's own path-scoped requireGuest, not from
  // src/app.js's mount order.
  let bareApp;

  beforeAll(() => {
    bareApp = express();
    bareApp.use('/', communityRouter);
    bareApp.use((req, res) => {
      res.status(404).send('not found');
    });
  });

  it('AC2: the walk discovers at least 12 routes (the number registered today)', () => {
    // A floor, not an exact count: a walk that discovers only what a future
    // Express upgrade happens to still expose in this shape must still find
    // at least everything registered today, or this fails loudly instead of
    // passing vacuously on a near-empty list.
    expect(discoveredRoutes.length).toBeGreaterThanOrEqual(12);
  });

  it('AC2: the allowlist cannot silently empty gatedRoutes down from discoveredRoutes', () => {
    // it.each below is built from gatedRoutes, and vitest passes an it.each
    // over an empty table with zero test cases run — silently green. This
    // floor makes a bug that over-matches in isAllowlisted (or a filter that
    // strips more than the named allowlist entries) fail loudly instead of
    // quietly shrinking the AC1 suite to nothing.
    expect(gatedRoutes.length).toBeGreaterThanOrEqual(
      discoveredRoutes.length - PUBLIC_ALLOWLIST.length
    );
  });

  it('AC3: the public allowlist is declared, and every entry has the { method, path } shape isAllowlisted matches on', () => {
    expect(Array.isArray(PUBLIC_ALLOWLIST)).toBe(true);
    // Deliberately NOT asserting PUBLIC_ALLOWLIST is empty: the day a host
    // legitimately makes a community route public — the exact workflow AC3
    // exists to enable — is the day this array gains its first entry, and a
    // length-0 pin here would turn that legitimate change into a failing
    // test the author has to go delete. What stays pinned is the SHAPE every
    // entry must have to be matched correctly by isAllowlisted, present or
    // future.
    for (const entry of PUBLIC_ALLOWLIST) {
      expect(typeof entry.method).toBe('string');
      expect(entry.method).toBe(entry.method.toLowerCase());
      expect(typeof entry.path).toBe('string');
      expect(entry.path.startsWith('/')).toBe(true);
    }
  });

  it('AC5: the only non-route layer on the router is the requireGuest guard itself', () => {
    // A future `router.use('/hall-of-fame', subRouter)` would add a second
    // non-route layer whose nested routes the walk above never descends
    // into. Asserting there is exactly one, and that it IS requireGuest,
    // catches that the moment it happens instead of letting it slip past
    // while AC2's floor still passes (a sub-router adds layers, but none of
    // them are the sub-router's OWN route layers at this level).
    const nonRouteLayers = communityRouter.stack.filter((layer) => !layer.route);
    expect(nonRouteLayers.length).toBe(1);
    expect(nonRouteLayers[0].handle).toBe(requireGuest);
  });

  it.each(gatedRoutes.map((r) => [r.method, r.concretePath]))(
    'AC1: %s %s -> 302 to /join for an anonymous request',
    async (method, concretePath) => {
      await assertGated(bareApp, method, concretePath);
    }
  );
});

describe('isAllowlisted, pinned against a LOCAL fixture — never the real (currently empty) PUBLIC_ALLOWLIST', () => {
  // A non-empty fixture, scoped to this describe block only, so the match
  // rule itself has coverage independent of what PUBLIC_ALLOWLIST currently
  // holds.
  const fixtureAllowlist = [{ method: 'get', path: '/gallery' }];

  it('matches an entry on template path and (lowercase) method', () => {
    expect(isAllowlisted('get', '/gallery', fixtureAllowlist)).toBe(true);
  });

  it('does not match a different template path', () => {
    expect(isAllowlisted('get', '/feed', fixtureAllowlist)).toBe(false);
  });

  it('does not match an uppercase method — walkRoutes always yields lowercase, so an uppercase allowlist entry would silently fail to match anything', () => {
    expect(isAllowlisted('GET', '/gallery', fixtureAllowlist)).toBe(false);
  });
});

describe('AC4: the derived check actually catches the drift the issue describes', () => {
  it('a route added under a prefix absent from the guard list is reachable, and the AC1 check fails against it', async () => {
    // A temporary router, built inside this test only — src/routes/community.js
    // is never mutated, and this fixture does NOT copy community.js's real
    // seven-prefix guard list either (that would just relocate the same
    // two-copies drift this issue exists to close: if #565 later rescopes
    // the real list, a copy sitting here would go stale and this test would
    // keep passing regardless). One arbitrary gated prefix is enough to
    // reproduce the shape of the drift: '/hall-of-fame' is registered under
    // a DIFFERENT prefix the guard list does not name.
    const tempRouter = express.Router();
    tempRouter.use(['/only-this-prefix-is-gated'], requireGuest);
    tempRouter.get('/hall-of-fame', (req, res) => {
      res.status(200).send('reachable');
    });

    const tempApp = express();
    tempApp.use('/', tempRouter);
    tempApp.use((req, res) => {
      res.status(404).send('not found');
    });

    // Derive the route from the temp router's own stack — the same
    // walkRoutes() the real suite above uses — rather than hand-passing the
    // literal method/path. This proves the WALK finds the ungated route too,
    // not just that assertGated() rejects a literal it was handed: if
    // walkRoutes were later narrowed to skip a class of route, this
    // `.find()` would come back undefined and fail here, rather than the
    // suite quietly losing coverage while AC1/AC2 kept passing.
    const tempRoutes = walkRoutes(tempRouter);
    const hallOfFame = tempRoutes.find(
      (r) => r.templatePath === '/hall-of-fame' && r.method === 'get'
    );
    expect(hallOfFame).toBeDefined();

    // First, prove the hole is real: an anonymous request reaches the
    // handler instead of being redirected.
    const res = await request(tempApp).get(hallOfFame.concretePath);
    expect(res.status).toBe(200);

    // Then prove the AC1 derived check — the exact assertGated() function
    // every case in the suite above runs, fed the WALKED route rather than a
    // hand-typed one — fails when pointed at it. Pinned to the specific
    // assertion assertGated makes (status 200 !== the expected 302), not to
    // "any rejection" — a transport error would also satisfy a bare
    // .rejects.toThrow(), which would prove nothing about the check firing.
    let caught;
    try {
      await assertGated(tempApp, hallOfFame.method, hallOfFame.concretePath);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.name).toBe('AssertionError');
    expect(caught.actual).toBe(200);
    expect(caught.expected).toBe(302);
  });
});
