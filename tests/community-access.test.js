// tests/community-access.test.js
// Issue #466 — pins the community layer's actual access behavior: anonymous
// requests are guest-gated (302 -> /join), signed-in requests succeed, and
// the gate is enforced by src/routes/community.js's own path-scoped
// requireGuest, not by src/app.js's mount order (AC1-AC3).
'use strict';

const express = require('express');
const request = require('supertest');
const { loadApp, seed, signInGuest } = require('./helpers/testApp');

// A single app/db instance for the whole file: config.js and db.js read
// DATA_DIR/DB_PATH at first require time only (see testApp.js's loadApp
// doc comment), so a second loadApp() call in the same process would silently
// reuse the FIRST temp database rather than getting a fresh one — reseeding
// the same 'seedtoken' into it would collide on guests.token's UNIQUE
// constraint. One loadApp()/seed() pair, shared across AC1 and AC2 below.
let app;
let db;
let ids;

beforeAll(() => {
  const result = loadApp();
  app = result.app;
  db = result.db;
  ids = seed(db);
});

describe('anonymous access to community pages (AC1)', () => {
  it.each([['/gallery'], ['/feed'], ['/leaderboard'], ['/p/1'], ['/u/1'], ['/badge/anything']])(
    'GET %s with no session cookie -> 302 to /join',
    async (path) => {
      // /p/1 and /u/1 use literal ids on purpose (AC1): the gate fires before
      // either handler resolves an id, so no seeded row is required here.
      const res = await request(app).get(path);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/join');
    }
  );
});

describe('signed-in access to community pages is unchanged (AC2)', () => {
  let agent;

  beforeAll(() => {
    agent = request.agent(app);
    signInGuest(app, 'seedtoken', agent);
  });

  it.each([['/gallery'], ['/feed'], ['/leaderboard']])(
    'GET %s as a signed-in guest -> 200',
    async (path) => {
      const res = await agent.get(path);
      expect(res.status).toBe(200);
    }
  );

  it('GET /p/:id for a real seeded photo -> 200', async () => {
    const res = await agent.get('/p/' + ids.submissionId);
    expect(res.status).toBe(200);
  });

  it('GET /u/:id for a real seeded guest -> 200', async () => {
    const res = await agent.get('/u/' + ids.guestId);
    expect(res.status).toBe(200);
  });
});

describe('the community router enforces its own gate, independent of mount order (AC3)', () => {
  // A bare Express app: communityRouter mounted at '/' with NO guest.js ahead
  // of it, and a 404 handler behind it — proving the gate comes from the
  // router's own path-scoped requireGuest, not from src/app.js's mount order.
  let bareApp;

  beforeAll(() => {
    // app/db/config are already loaded (and DATA_DIR/DB_PATH already set) by
    // the file-level beforeAll above — see its comment on why loadApp() is
    // called only once per file.
    const communityRouter = require('../src/routes/community');
    bareApp = express();
    bareApp.use('/', communityRouter);
    bareApp.use((req, res) => {
      res.status(404).send('not found');
    });
  });

  it.each([['/gallery'], ['/feed'], ['/leaderboard'], ['/p/1'], ['/u/1'], ['/badge/x']])(
    'GET %s with no session cookie -> 302 to /join',
    async (path) => {
      const res = await request(bareApp).get(path);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/join');
    }
  );

  it('GET /no-such-path -> reaches the 404 handler, not swallowed by the guard', async () => {
    const res = await request(bareApp).get('/no-such-path');
    expect(res.status).toBe(404);
  });
});
