// tests/retire-token-entry.test.js
// Issue #244: retire the per-guest QR/token entry system. One shared poster
// link (/join) replaces personal place-cards; guests.token stays only as the
// internal gsid session credential.
//
// AC1 — GET /j/<any token, valid or not> is an unconditional 302 to /join
//       with no Set-Cookie for gsid.
// AC2 — GET /admin/poster is 200 with a QR <img> and the literal "/join";
//       GET /admin/qrsheet is 404.
// AC3 — POST /admin/guests and POST /admin/guests/bulk are 404.
// AC4 — GET /onboard and POST /onboard are both a 302 to /join.
// AC5 — a valid signed gsid cookie (minted the same way a real Set-Cookie
//       would be, via signInGuest) still authenticates: GET / is 200 as that
//       guest, not a redirect to /join.
'use strict';

const request = require('supertest');
const { loadApp, seed, makeAdminAgent, signInGuest } = require('./helpers/testApp');

let app;
let db;

beforeAll(() => {
  const result = loadApp();
  app = result.app;
  db = result.db;
});

describe('AC1: GET /j/:token never signs anyone in', () => {
  it('a valid, existing guest token redirects to /join with no gsid cookie', async () => {
    const { guestId } = seed(db); // seeds a guest with token 'seedtoken'
    void guestId;

    const res = await request(app).get('/j/seedtoken');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/join');
    const cookies = [].concat(res.headers['set-cookie'] || []);
    expect(cookies.some((c) => c.startsWith('gsid='))).toBe(false);
  });

  it('an unknown token also redirects to /join with no cookie (no DB lookup)', async () => {
    const res = await request(app).get('/j/this-token-has-never-existed');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/join');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('a previously-valid session is not restored — a guest who follows the redirect is signed out', async () => {
    // The seeded guest's real token from the row above must not authenticate
    // just by being present in the URL.
    const guest = db.prepare("SELECT token FROM guests WHERE token = 'seedtoken'").get();
    expect(guest).toBeTruthy();

    const agent = request.agent(app);
    await agent.get('/j/' + guest.token);
    const res = await agent.get('/tasks');
    // requireGuest sends a signed-out visitor to /join.
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/join');
  });
});

describe('AC2: the poster replaces the QR sheet', () => {
  it('GET /admin/poster is 200 with a QR image and the /join link', async () => {
    const adminAgent = await makeAdminAgent(app);
    const res = await adminAgent.get('/admin/poster');

    expect(res.status).toBe(200);
    expect(res.text).toContain('<img src="data:');
    expect(res.text).toContain('/join');
  });

  it('GET /admin/qrsheet is 404', async () => {
    const adminAgent = await makeAdminAgent(app);
    const res = await adminAgent.get('/admin/qrsheet');

    expect(res.status).toBe(404);
  });
});

describe('AC3: retired guest-creation routes are gone', () => {
  it('POST /admin/guests is 404', async () => {
    const adminAgent = await makeAdminAgent(app);
    const res = await adminAgent.post('/admin/guests').type('form').send({ name: 'Nobody' });

    expect(res.status).toBe(404);
  });

  it('POST /admin/guests/bulk is 404', async () => {
    const adminAgent = await makeAdminAgent(app);
    const res = await adminAgent.post('/admin/guests/bulk').type('form').send({ count: '5' });

    expect(res.status).toBe(404);
  });
});

describe('AC4: /onboard folds into /join', () => {
  it('GET /onboard is a 302 to /join', async () => {
    const res = await request(app).get('/onboard');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/join');
  });

  it('POST /onboard is a 302 to /join', async () => {
    const res = await request(app).post('/onboard').type('form').send({ name: 'Anyone' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/join');
  });
});

describe('AC5: an existing signed gsid session still works', () => {
  it('GET / is 200 as the signed-in guest, not a redirect to /join', async () => {
    const token = 'retire-ac5-token';
    db.prepare('INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)').run(
      token,
      'AC5 Guest'
    );

    const agent = signInGuest(app, token);
    const res = await agent.get('/');

    expect(res.status).toBe(200);
    expect(res.text).toContain('AC5 Guest');
  });

  it('a tampered/forged gsid value does NOT authenticate (the signature check still runs)', async () => {
    const agent = request.agent(app);
    // A syntactically-plausible but unsigned cookie value — cookie-parser
    // requires the 's:<value>.<hmac>' shape; a bare token has neither prefix
    // nor signature and must fail to unsign.
    agent.jar.setCookie('gsid=not-a-signed-value; Path=/');
    const res = await agent.get('/tasks');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/join');
  });
});
