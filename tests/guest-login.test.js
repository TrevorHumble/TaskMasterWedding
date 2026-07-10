// tests/guest-login.test.js
// Issue #241: re-entry login at GET/POST /login — a returning guest signs
// back in on any device with contact + the 4-digit PIN they chose at signup
// (POST /join, issue #240), instead of needing their original private link.
//
// AC1: correct contact (any case/whitespace) + correct PIN -> 302 to '/' with
//      a `gsid` cookie; a follow-up request with that cookie is served as
//      that guest, no new guests row created.
// AC2: wrong PIN -> no cookie, shared "don't match" failure message.
// AC3: unknown contact -> the SAME failure message (no existence oracle).
// AC4: 5 failed attempts for one contact, then a 6th attempt with the
//      CORRECT PIN before the lockout window elapses -> still no cookie, a
//      "Try again" message.
// AC5: signed-out GET / -> 302 to /join (requireGuest no longer walls guests
//      off with a message card).
// AC6: config.js owns GUEST_LOGIN_MAX_ATTEMPTS / GUEST_LOGIN_LOCKOUT_MS.
//
// REQUIRE ORDER: env overrides for GUEST_LOGIN_MAX_ATTEMPTS must be set
// BEFORE loadApp() (which requires config.js) — same rule as
// tests/login-lockout-engages.test.js.
'use strict';

process.env.GUEST_LOGIN_MAX_ATTEMPTS = '5';

const request = require('supertest');
const { loadApp } = require('./helpers/testApp');

let app;
let db;
let config;

beforeAll(() => {
  const result = loadApp();
  app = result.app;
  db = result.db;
  config = require('../config');
});

function countGuests() {
  return db.prepare('SELECT COUNT(*) AS n FROM guests').get().n;
}

function insertGuestRow({ token, name, contact, contactType, pin }) {
  return db
    .prepare(
      `INSERT INTO guests (token, name, onboarded, contact, contact_type, pin)
       VALUES (?, ?, 1, ?, ?, ?)`
    )
    .run(token, name, contact, contactType, pin).lastInsertRowid;
}

function cookiesOf(res) {
  return [].concat(res.headers['set-cookie'] || []);
}

function hasGsidCookie(res) {
  return cookiesOf(res).some((c) => c.startsWith('gsid='));
}

describe('AC1: correct contact + PIN re-enters the account', () => {
  it('normalizes the contact, signs the guest in, and creates no new row', async () => {
    insertGuestRow({
      token: 'ac1-token',
      name: 'Lilly',
      contact: 'lilly@example.com',
      contactType: 'email',
      pin: '0412',
    });
    const before = countGuests();

    const agent = request.agent(app);
    const res = await agent
      .post('/login')
      .type('form')
      .send({ contact: 'Lilly@Example.COM', pin: '0412' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
    expect(hasGsidCookie(res)).toBe(true);
    expect(countGuests()).toBe(before);

    // Follow-up request on the same agent (same cookie jar) is served as
    // that guest — the '/' page renders the signed-in home, not a redirect.
    const home = await agent.get('/');
    expect(home.status).toBe(200);
    expect(home.text).toContain('Lilly');
  });
});

describe('AC2: wrong PIN fails closed', () => {
  it('sets no cookie and reports the shared "don\'t match" message', async () => {
    insertGuestRow({
      token: 'ac2-token',
      name: 'Axel',
      contact: 'axel@example.com',
      contactType: 'email',
      pin: '1111',
    });

    const res = await request(app)
      .post('/login')
      .type('form')
      .send({ contact: 'axel@example.com', pin: '9999' });

    expect(hasGsidCookie(res)).toBe(false);
    expect(res.text).toContain("don't match");
  });
});

describe('AC3: unknown contact fails with the same message', () => {
  it('sets no cookie and reports the identical failure message (no existence oracle)', async () => {
    const res = await request(app)
      .post('/login')
      .type('form')
      .send({ contact: 'nobody@example.com', pin: '1234' });

    expect(hasGsidCookie(res)).toBe(false);
    expect(res.text).toContain("don't match");
  });
});

describe('AC4: throttling engages per contact', () => {
  it('5 failed attempts then the correct PIN on the 6th is still blocked with "Try again"', async () => {
    insertGuestRow({
      token: 'ac4-token',
      name: 'Throttled Guest',
      contact: 'throttled@example.com',
      contactType: 'email',
      pin: '4242',
    });

    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/login')
        .type('form')
        .send({ contact: 'throttled@example.com', pin: '0000' });
    }

    const res = await request(app)
      .post('/login')
      .type('form')
      .send({ contact: 'throttled@example.com', pin: '4242' });

    expect(hasGsidCookie(res)).toBe(false);
    expect(res.text).toContain('Try again');
  });

  it('does not throttle a different contact', async () => {
    insertGuestRow({
      token: 'ac4-sibling-token',
      name: 'Sibling Guest',
      contact: 'sibling@example.com',
      contactType: 'email',
      pin: '8080',
    });

    const res = await request(app)
      .post('/login')
      .type('form')
      .send({ contact: 'sibling@example.com', pin: '8080' });

    expect(hasGsidCookie(res)).toBe(true);
  });

  it('an unknown contact counts toward its own throttle too (no existence oracle via timing)', async () => {
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/login')
        .type('form')
        .send({ contact: 'ghost@example.com', pin: '0000' });
    }

    const res = await request(app)
      .post('/login')
      .type('form')
      .send({ contact: 'ghost@example.com', pin: '1234' });

    expect(hasGsidCookie(res)).toBe(false);
    expect(res.text).toContain('Try again');
  });
});

describe('AC5: signed-out guests are redirected, not walled', () => {
  it('GET / with no gsid cookie redirects to /join', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/join');
  });
});

describe('AC6: guest-login limits are read from config only', () => {
  it('config.js defines GUEST_LOGIN_MAX_ATTEMPTS and GUEST_LOGIN_LOCKOUT_MS', () => {
    expect(typeof config.GUEST_LOGIN_MAX_ATTEMPTS).toBe('number');
    expect(config.GUEST_LOGIN_MAX_ATTEMPTS).toBeGreaterThan(0);
    expect(typeof config.GUEST_LOGIN_LOCKOUT_MS).toBe('number');
    expect(config.GUEST_LOGIN_LOCKOUT_MS).toBeGreaterThan(0);
  });

  it('src/routes/auth.js reads the guest-login limits only from config (no stray literal copies)', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'auth.js'), 'utf8');
    expect(src).toContain('config.GUEST_LOGIN_MAX_ATTEMPTS');
    expect(src).toContain('config.GUEST_LOGIN_LOCKOUT_MS');
  });
});

describe('edge cases', () => {
  it('a missing contact field is rejected with the shared failure message, no throw', async () => {
    const res = await request(app).post('/login').type('form').send({ pin: '1234' });
    expect(res.status).toBe(401);
    expect(hasGsidCookie(res)).toBe(false);
    expect(res.text).toContain("don't match");
  });

  it('a missing pin field is rejected with the shared failure message', async () => {
    insertGuestRow({
      token: 'edge-nopin-token',
      name: 'No Pin Submitted',
      contact: 'nopin-submitted@example.com',
      contactType: 'email',
      pin: '3333',
    });
    const res = await request(app)
      .post('/login')
      .type('form')
      .send({ contact: 'nopin-submitted@example.com' });
    expect(hasGsidCookie(res)).toBe(false);
    expect(res.text).toContain("don't match");
  });

  it('a guest row with a null stored pin never matches any submitted PIN', async () => {
    insertGuestRow({
      token: 'edge-nullpin-token',
      name: 'Legacy Guest',
      contact: 'legacy@example.com',
      contactType: 'email',
      pin: null,
    });
    const res = await request(app)
      .post('/login')
      .type('form')
      .send({ contact: 'legacy@example.com', pin: '0000' });
    expect(hasGsidCookie(res)).toBe(false);
    expect(res.text).toContain("don't match");
  });
});

describe('GET /login prefill', () => {
  it('prefills the contact field from the flash left by a duplicate /join attempt', async () => {
    insertGuestRow({
      token: 'prefill-token',
      name: 'Prefill Guest',
      contact: 'prefill@example.com',
      contactType: 'email',
      pin: '5566',
    });

    const agent = request.agent(app);
    const joinRes = await agent
      .post('/join')
      .type('form')
      .send({ name: 'Someone New', contact: 'prefill@example.com', pin: '9999' });
    expect(joinRes.status).toBe(302);
    expect(joinRes.headers.location).toBe('/login');

    const loginPage = await agent.get('/login');
    expect(loginPage.status).toBe(200);
    expect(loginPage.text).toContain('value="prefill@example.com"');
  });

  it('a fresh visit to GET /login (no prior /join redirect) shows an empty contact field', async () => {
    const res = await request(app).get('/login');
    expect(res.status).toBe(200);
    expect(res.text).toContain('name="contact"');
  });
});
