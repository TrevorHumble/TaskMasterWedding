// tests/onboarding-how-to-play.test.js
// Issue #564: guests.onboarded goes from a dead write-only column to a live
// flag that drives where POST /join and POST /login send a guest. Covers
// AC1-AC5 (AC6 — the pre-existing redirect-target tests updated to the new
// contract — is covered by tests/join-signup.test.js,
// tests/onboard-avatar.test.js, tests/avatar-intake.test.js,
// tests/avatar-upload-limit.test.js, and tests/e2e-guest-happy-path.test.js).
// tests/guest-login.test.js needed no change: its fixture guests are inserted
// with onboarded = 1, so their POST /login -> '/' assertions already match the
// new contract (AC4).
//
// AC1: a brand-new guest's POST /join is a 302 to /how-to-play, and their
//      onboarded column reads back 0.
// AC2: that guest's GET /how-to-play then GET / — the second request is a
//      normal 200 home render (no redirect back to the rules), and onboarded
//      now reads back 1.
// AC3: an existing guest with onboarded = 0 who signs in via POST /login is
//      302'd to /how-to-play.
// AC4: an existing guest with onboarded = 1 who signs in via POST /login is
//      302'd to / — unchanged existing behavior.
// AC5: an onboarded = 1 guest's GET /how-to-play still renders 200 normally
//      (re-readable on demand) and leaves onboarded at 1 (no state change).
//
// These tests drive the REAL POST /join / POST /login routes rather than
// signInGuest (tests/helpers/testApp.js) — per repo practice (see
// tests/join-signup.test.js's own note), signInGuest mints a session directly
// and never touches the redirect logic under test here.
//
// REQUIRE ORDER: loadApp() must run before any require of config or db (see
// tests/helpers/testApp.js "REQUIRE ORDER MATTERS").
'use strict';

const request = require('supertest');
const { loadApp } = require('./helpers/testApp');

let app;
let db;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
});

function insertGuestRow({ token, name, contact, contactType, pin, onboarded }) {
  return db
    .prepare(
      `INSERT INTO guests (token, name, onboarded, contact, contact_type, pin)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(token, name, onboarded ? 1 : 0, contact, contactType, pin).lastInsertRowid;
}

function onboardedFlagFor(contact) {
  return db.prepare('SELECT onboarded FROM guests WHERE contact = ?').get(contact).onboarded;
}

describe('AC1: a brand-new guest is routed to the rules after signup', () => {
  it('POST /join is a 302 to /how-to-play and the new row reads onboarded = 0', async () => {
    const res = await request(app)
      .post('/join')
      .type('form')
      .send({ name: 'Onboarding Guest One', contact: 'onboard-ac1@example.com', pin: '1010' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/how-to-play');
    expect(onboardedFlagFor('onboard-ac1@example.com')).toBe(0);
  });
});

describe('AC2: the rules are shown once, then never again', () => {
  it('GET /how-to-play then GET / — the second request is a plain 200 home render, and onboarded flips to 1', async () => {
    const agent = request.agent(app);
    const joinRes = await agent
      .post('/join')
      .type('form')
      .send({ name: 'Onboarding Guest Two', contact: 'onboard-ac2@example.com', pin: '2020' });
    expect(joinRes.status).toBe(302);
    expect(joinRes.headers.location).toBe('/how-to-play');
    // Not yet marked — the redirect alone does not flip the flag, only an
    // actual render of /how-to-play does (AC2's own "never again" half
    // depends on this: a guest who closes the tab before rendering the rules
    // must be shown them again next time, not silently marked done).
    expect(onboardedFlagFor('onboard-ac2@example.com')).toBe(0);

    const rulesRes = await agent.get('/how-to-play');
    expect(rulesRes.status).toBe(200);
    // The render is what flips it.
    expect(onboardedFlagFor('onboard-ac2@example.com')).toBe(1);

    const homeRes = await agent.get('/');
    expect(homeRes.status).toBe(200);
    // A real value assertion, not just "not a redirect": confirms this is
    // the actual home page, not e.g. an error page that also happens to be 200.
    expect(homeRes.text).toContain('Onboarding Guest Two');
    // Still 1 — visiting home does not touch the flag either way.
    expect(onboardedFlagFor('onboard-ac2@example.com')).toBe(1);
  });
});

describe('AC3: a returning guest who never saw the rules gets them on login', () => {
  it('POST /login for an onboarded = 0 guest is a 302 to /how-to-play', async () => {
    insertGuestRow({
      token: 'onboard-ac3-token',
      name: 'Onboarding Guest Three',
      contact: 'onboard-ac3@example.com',
      contactType: 'email',
      pin: '3030',
      onboarded: false,
    });

    const res = await request(app)
      .post('/login')
      .type('form')
      .send({ contact: 'onboard-ac3@example.com', pin: '3030' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/how-to-play');
    // The login itself does not mark the guest onboarded — only rendering
    // the rules page does (same rule as AC2).
    expect(onboardedFlagFor('onboard-ac3@example.com')).toBe(0);
  });
});

describe('AC4: a guest who has seen the rules is never re-shown them on login', () => {
  it('POST /login for an onboarded = 1 guest is a 302 to / (existing behavior, unchanged)', async () => {
    insertGuestRow({
      token: 'onboard-ac4-token',
      name: 'Onboarding Guest Four',
      contact: 'onboard-ac4@example.com',
      contactType: 'email',
      pin: '4040',
      onboarded: true,
    });

    const res = await request(app)
      .post('/login')
      .type('form')
      .send({ contact: 'onboard-ac4@example.com', pin: '4040' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
    expect(onboardedFlagFor('onboard-ac4@example.com')).toBe(1);
  });
});

describe('AC5: the rules page stays freely re-readable', () => {
  it('an onboarded = 1 guest GETs /how-to-play as a normal 200, with no state change', async () => {
    const guestId = insertGuestRow({
      token: 'onboard-ac5-token',
      name: 'Onboarding Guest Five',
      contact: 'onboard-ac5@example.com',
      contactType: 'email',
      pin: '5050',
      onboarded: true,
    });

    const agent = request.agent(app);
    const loginRes = await agent
      .post('/login')
      .type('form')
      .send({ contact: 'onboard-ac5@example.com', pin: '5050' });
    expect(loginRes.status).toBe(302);
    expect(loginRes.headers.location).toBe('/');

    const res = await agent.get('/how-to-play');
    expect(res.status).toBe(200);
    expect(res.text).toContain('How to play');
    // Still 1 — being "done" with onboarding never blocks re-reading, and
    // re-reading does not toggle anything.
    expect(db.prepare('SELECT onboarded FROM guests WHERE id = ?').get(guestId).onboarded).toBe(1);
  });
});
