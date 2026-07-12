// tests/pin-management.test.js
// Issue #243: a guest can see their own PIN on their profile-edit page, and
// an admin can view every guest's contact + PIN and change either on the
// spot (no reset flow) — Goal C, "the hosts run the show."
//
// AC1: signed-in guest, GET /me/edit -> body contains their pin and the
//      word "PIN".
// AC2: src/views/me-edit.ejs labels the field "Your user PIN" with
//      explanatory help text (structural).
// AC3: admin session, GET /admin/guests -> body contains a guest's contact
//      and pin.
// AC4: admin sets a new pin via POST /admin/guests/:id/identity -> the row's
//      pin changes AND a subsequent POST /login with that pin succeeds (302
//      to '/').
// AC5: admin edits a contact with the SAME validation as signup — a valid
//      phone normalizes and is stored normalized; an invalid contact leaves
//      the row unchanged and reports "email or phone".
// AC6: an invalid pin ('12ab') leaves the row unchanged and reports "4-digit".
//
// REQUIRE ORDER: loadApp() must run before any require that pulls in config
// or db (see tests/helpers/testApp.js).
'use strict';

const request = require('supertest');
const fs = require('fs');
const path = require('path');
const { loadApp, makeAdminAgent, signInGuest } = require('./helpers/testApp');

let app;
let db;
let adminAgent;

beforeAll(async () => {
  const result = loadApp();
  app = result.app;
  db = result.db;
  adminAgent = await makeAdminAgent(app);
});

function insertGuestRow({ token, name, contact, contactType, pin }) {
  return db
    .prepare(
      `INSERT INTO guests (token, name, onboarded, contact, contact_type, pin)
       VALUES (?, ?, 1, ?, ?, ?)`
    )
    .run(token, name, contact || null, contactType || null, pin || null).lastInsertRowid;
}

// ---------------------------------------------------------------------------
// AC1 — guest sees their own re-entry code
// ---------------------------------------------------------------------------
describe('AC1: GET /me/edit shows the signed-in guest their own PIN', () => {
  it('body contains the guest pin and the word "PIN"', async () => {
    insertGuestRow({
      token: 'meedit-token',
      name: 'Lilly',
      contact: 'lilly-meedit@example.com',
      contactType: 'email',
      pin: '0412',
    });

    const agent = request.agent(app);
    const loginRes = await agent
      .post('/login')
      .type('form')
      .send({ contact: 'lilly-meedit@example.com', pin: '0412' });
    expect(loginRes.status).toBe(302);

    const res = await agent.get('/me/edit');
    expect(res.status).toBe(200);
    expect(res.text).toContain('0412');
    expect(res.text).toContain('PIN');
  });

  it('a guest with no pin (legacy/seed row) does not render the pin field', async () => {
    const token = 'meedit-nopin-token';
    db.prepare('INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)').run(
      token,
      'No Pin Guest'
    );

    // Sign in directly via signInGuest (mints the signed gsid cookie) — this
    // guest has no pin/contact, so POST /login is not an available path in
    // for them.
    const agent = request.agent(app);
    signInGuest(app, token, agent);

    const res = await agent.get('/me/edit');
    expect(res.status).toBe(200);
    // The old assertion here checked res.text does NOT contain the phrase
    // "re-entry code" — but the view never renders that phrase in ANY case
    // (the label reads "Your user PIN"), so that assertion could not fail
    // even if the `<% if (guest.pin) %>` guard around the whole field were
    // deleted. Assert on the field's actual markup instead: this WOULD fail
    // if the guard were inverted (or removed), since the input/label would
    // then render unconditionally.
    expect(res.text).not.toContain('name="pin"');
    expect(res.text).not.toContain('Your user PIN');
  });

  it('a guest WITH a pin does render the pin field (positive control for the above)', async () => {
    insertGuestRow({
      token: 'meedit-haspin-token',
      name: 'Has Pin Guest',
      contact: 'haspin@example.com',
      contactType: 'email',
      pin: '8899',
    });

    const agent = request.agent(app);
    const loginRes = await agent
      .post('/login')
      .type('form')
      .send({ contact: 'haspin@example.com', pin: '8899' });
    expect(loginRes.status).toBe(302);

    const res = await agent.get('/me/edit');
    expect(res.status).toBe(200);
    expect(res.text).toContain('name="pin"');
    expect(res.text).toContain('Your user PIN');
  });
});

// ---------------------------------------------------------------------------
// AC2 — structural: the view's copy names who else can see the code
// ---------------------------------------------------------------------------
describe('AC2: src/views/me-edit.ejs labels the field clearly for the guest', () => {
  it('labels the pin field "Your user PIN" with explanatory help text', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'me-edit.ejs'), 'utf8');
    expect(src).toContain('Your user PIN');
    expect(src).toContain('Your PIN number to log in.');
  });
});

// ---------------------------------------------------------------------------
// AC3 — admin sees contact and PIN
// ---------------------------------------------------------------------------
describe('AC3: GET /admin/guests shows contact and PIN', () => {
  it('body contains the guest contact and pin', async () => {
    insertGuestRow({
      token: 'admin-view-token',
      name: 'Lilly V',
      contact: 'lilly@example.com',
      contactType: 'email',
      pin: '0412',
    });

    const res = await adminAgent.get('/admin/guests');
    expect(res.status).toBe(200);
    expect(res.text).toContain('lilly@example.com');
    expect(res.text).toContain('0412');
  });
});

// ---------------------------------------------------------------------------
// AC4 — admin sets a new PIN, and it works for login
// ---------------------------------------------------------------------------
describe('AC4: POST /admin/guests/:id/identity sets a working PIN', () => {
  it('updates guests.pin, and the new PIN logs the guest in (302 to /)', async () => {
    const guestId = insertGuestRow({
      token: 'ac4-identity-token',
      name: 'Reset Guest',
      contact: 'reset-guest@example.com',
      contactType: 'email',
      pin: '1111',
    });

    const res = await adminAgent
      .post(`/admin/guests/${guestId}/identity`)
      .type('form')
      .send({ pin: '7788' });
    expect(res.status).toBe(303);

    expect(db.prepare('SELECT pin FROM guests WHERE id = ?').get(guestId).pin).toBe('7788');

    const loginRes = await request(app)
      .post('/login')
      .type('form')
      .send({ contact: 'reset-guest@example.com', pin: '7788' });
    expect(loginRes.status).toBe(302);
    expect(loginRes.headers.location).toBe('/');
  });
});

// ---------------------------------------------------------------------------
// AC5 — admin edits a contact with the same validation as signup
// ---------------------------------------------------------------------------
describe('AC5: POST /admin/guests/:id/identity — contact validation', () => {
  it('a valid phone in a human-typed format normalizes and stores contact_type "phone"', async () => {
    const guestId = insertGuestRow({
      token: 'ac5-phone-token',
      name: 'Phone Guest',
      contact: 'phone-guest-old@example.com',
      contactType: 'email',
      pin: '2222',
    });

    const res = await adminAgent
      .post(`/admin/guests/${guestId}/identity`)
      .type('form')
      .send({ contact: '(208) 555-0142' });
    expect(res.status).toBe(303);

    const row = db.prepare('SELECT contact, contact_type FROM guests WHERE id = ?').get(guestId);
    expect(row.contact).toBe('2085550142');
    expect(row.contact_type).toBe('phone');
  });

  it('an invalid contact leaves the row unchanged and reports "email or phone"', async () => {
    const guestId = insertGuestRow({
      token: 'ac5-invalid-token',
      name: 'Invalid Contact Guest',
      contact: 'still-here@example.com',
      contactType: 'email',
      pin: '3333',
    });

    const res = await adminAgent
      .post(`/admin/guests/${guestId}/identity`)
      .type('form')
      .send({ contact: 'not-a-contact' });
    expect(res.status).toBe(303);
    expect(res.headers.location).toContain(encodeURIComponent('email or phone'));

    const row = db.prepare('SELECT contact, contact_type FROM guests WHERE id = ?').get(guestId);
    expect(row.contact).toBe('still-here@example.com');
    expect(row.contact_type).toBe('email');
  });

  it('a contact already used by a different guest is rejected, row unchanged', async () => {
    insertGuestRow({
      token: 'ac5-taken-token',
      name: 'Taken Contact Guest',
      contact: 'taken@example.com',
      contactType: 'email',
      pin: '4444',
    });
    const guestId = insertGuestRow({
      token: 'ac5-collider-token',
      name: 'Collider Guest',
      contact: 'collider@example.com',
      contactType: 'email',
      pin: '5555',
    });

    const res = await adminAgent
      .post(`/admin/guests/${guestId}/identity`)
      .type('form')
      .send({ contact: 'taken@example.com' });
    expect(res.headers.location).toContain(encodeURIComponent('already'));

    const row = db.prepare('SELECT contact FROM guests WHERE id = ?').get(guestId);
    expect(row.contact).toBe('collider@example.com');
  });

  it('re-submitting a guest own current contact is allowed (not a self-collision)', async () => {
    const guestId = insertGuestRow({
      token: 'ac5-self-token',
      name: 'Self Contact Guest',
      contact: 'self@example.com',
      contactType: 'email',
      pin: '6666',
    });

    const res = await adminAgent
      .post(`/admin/guests/${guestId}/identity`)
      .type('form')
      .send({ contact: 'Self@Example.com' });
    expect(res.headers.location).not.toContain(encodeURIComponent('already'));

    const row = db.prepare('SELECT contact FROM guests WHERE id = ?').get(guestId);
    expect(row.contact).toBe('self@example.com');
  });
});

// ---------------------------------------------------------------------------
// AC6 — invalid PIN input is rejected
// ---------------------------------------------------------------------------
describe('AC6: POST /admin/guests/:id/identity — pin validation', () => {
  it('a non-digit pin leaves the row unchanged and reports "4-digit"', async () => {
    const guestId = insertGuestRow({
      token: 'ac6-badpin-token',
      name: 'Bad Pin Guest',
      contact: 'badpin@example.com',
      contactType: 'email',
      pin: '9999',
    });

    const res = await adminAgent
      .post(`/admin/guests/${guestId}/identity`)
      .type('form')
      .send({ pin: '12ab' });
    expect(res.status).toBe(303);
    expect(res.headers.location).toContain(encodeURIComponent('4-digit'));

    const row = db.prepare('SELECT pin FROM guests WHERE id = ?').get(guestId);
    expect(row.pin).toBe('9999');
  });
});

// ---------------------------------------------------------------------------
// Guest self-edit (owner visual-direction update, 2026-07-10) — issue #243
// ACs 1-4: a guest can see AND change their own re-entry code from
// POST /me/edit; an invalid pin is rejected without corrupting the row; an
// empty pin leaves it unchanged while the rest of the form still saves.
// ---------------------------------------------------------------------------
describe("guest self-edit: POST /me/edit changes the signed-in guest's own pin", () => {
  it('a valid new pin updates the row, and the new pin logs the guest in (302 to /)', async () => {
    insertGuestRow({
      token: 'selfedit-valid-token',
      name: 'Self Edit Guest',
      contact: 'selfedit-valid@example.com',
      contactType: 'email',
      pin: '0412',
    });

    const agent = request.agent(app);
    const loginRes = await agent
      .post('/login')
      .type('form')
      .send({ contact: 'selfedit-valid@example.com', pin: '0412' });
    expect(loginRes.status).toBe(302);

    const editRes = await agent
      .post('/me/edit')
      .field('name', 'Self Edit Guest')
      .field('pin', '5566');
    expect([301, 302, 303]).toContain(editRes.status);

    const row = db
      .prepare('SELECT pin FROM guests WHERE contact = ?')
      .get('selfedit-valid@example.com');
    expect(row.pin).toBe('5566');

    // The OLD pin must no longer work, and the NEW pin must.
    const oldPinLogin = await request(app)
      .post('/login')
      .type('form')
      .send({ contact: 'selfedit-valid@example.com', pin: '0412' });
    expect(oldPinLogin.status).toBe(401);

    const newPinLogin = await request(app)
      .post('/login')
      .type('form')
      .send({ contact: 'selfedit-valid@example.com', pin: '5566' });
    expect(newPinLogin.status).toBe(302);
    expect(newPinLogin.headers.location).toBe('/');
  });

  it('an invalid pin (non-digit) leaves the row unchanged and the follow-up page carries "4-digit"', async () => {
    insertGuestRow({
      token: 'selfedit-invalid-token',
      name: 'Invalid Pin Guest',
      contact: 'selfedit-invalid@example.com',
      contactType: 'email',
      pin: '0412',
    });

    const agent = request.agent(app);
    await agent
      .post('/login')
      .type('form')
      .send({ contact: 'selfedit-invalid@example.com', pin: '0412' });

    const editRes = await agent
      .post('/me/edit')
      .field('name', 'Should Not Save Either')
      .field('pin', '12ab');
    expect([301, 302, 303]).toContain(editRes.status);

    const row = db
      .prepare('SELECT name, pin FROM guests WHERE contact = ?')
      .get('selfedit-invalid@example.com');
    expect(row.pin).toBe('0412'); // unchanged
    expect(row.name).toBe('Invalid Pin Guest'); // short-circuited before name saved

    const page = await agent.get('/me/edit');
    expect(page.text).toContain('4-digit');
  });

  it('an empty pin field leaves the pin unchanged while name still saves', async () => {
    insertGuestRow({
      token: 'selfedit-emptypin-token',
      name: 'Empty Pin Guest',
      contact: 'selfedit-emptypin@example.com',
      contactType: 'email',
      pin: '0412',
    });

    const agent = request.agent(app);
    await agent
      .post('/login')
      .type('form')
      .send({ contact: 'selfedit-emptypin@example.com', pin: '0412' });

    const editRes = await agent.post('/me/edit').field('name', 'Renamed Guest').field('pin', '');
    expect([301, 302, 303]).toContain(editRes.status);

    const row = db
      .prepare('SELECT name, pin FROM guests WHERE contact = ?')
      .get('selfedit-emptypin@example.com');
    expect(row.pin).toBe('0412'); // unchanged — blank means "don't touch it"
    expect(row.name).toBe('Renamed Guest'); // name still saved
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
describe('edge cases', () => {
  it('unknown :id redirects with "Guest not found." and writes nothing', async () => {
    const res = await adminAgent
      .post('/admin/guests/999999/identity')
      .type('form')
      .send({ pin: '1234' });
    expect(res.headers.location).toContain(encodeURIComponent('Guest not found.'));
  });

  it('an empty pin alongside a valid contact only changes the contact', async () => {
    const guestId = insertGuestRow({
      token: 'edge-emptypin-token',
      name: 'Empty Pin Field Guest',
      contact: 'emptypin-old@example.com',
      contactType: 'email',
      pin: '1212',
    });

    const res = await adminAgent
      .post(`/admin/guests/${guestId}/identity`)
      .type('form')
      .send({ contact: 'emptypin-new@example.com', pin: '' });
    expect(res.status).toBe(303);

    const row = db.prepare('SELECT contact, pin FROM guests WHERE id = ?').get(guestId);
    expect(row.contact).toBe('emptypin-new@example.com');
    expect(row.pin).toBe('1212'); // unchanged — empty pin means "don't touch it"
  });

  it('neither field submitted changes nothing and reports gracefully', async () => {
    const guestId = insertGuestRow({
      token: 'edge-neither-token',
      name: 'Neither Field Guest',
      contact: 'neither@example.com',
      contactType: 'email',
      pin: '3434',
    });

    const res = await adminAgent.post(`/admin/guests/${guestId}/identity`).type('form').send({});
    expect(res.status).toBe(303);

    const row = db.prepare('SELECT contact, pin FROM guests WHERE id = ?').get(guestId);
    expect(row.contact).toBe('neither@example.com');
    expect(row.pin).toBe('3434');
  });
});
