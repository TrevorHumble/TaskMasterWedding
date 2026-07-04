// tests/onboard-avatar.test.js
// Issue #187: a corrupt or non-image avatar during onboarding must never kill
// the process. POST /onboard used to await saveAvatar() with no try/catch;
// Express 4 does not catch async-handler rejections, so one undecodable file
// (bytes labelled image/jpeg that sharp cannot read) crashed the whole server
// for every guest. A fileFilter rejection (e.g. a PDF) fell through to the
// global 500 handler instead of re-rendering the form.
//
// AC1: corrupt bytes with Content-Type image/jpeg -> 400, and the server still
//      answers the next request (process alive).
// AC2: that 400 re-renders onboarding with the submitted name pre-filled and
//      an error containing "could not use that photo".
// AC3: retrying with only a name (no avatar) completes onboarding.
// AC4: a non-image type (application/pdf) gets the same friendly re-render,
//      writes nothing to UPLOADS_DIR, and the process stays alive.
//
// REQUIRE ORDER: loadApp() must run before any require of config, db, or
// photos (see tests/helpers/testApp.js "REQUIRE ORDER MATTERS").
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const request = require('supertest');
const { loadApp } = require('./helpers/testApp');

let app;
let db;
let config;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;

  // Required AFTER loadApp() so config resolves against the temp DATA_DIR.
  config = require('../config');
});

function insertGuest() {
  const token = `onboard-avatar-${crypto.randomUUID()}`;
  const id = db
    .prepare('INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 0)')
    .run(token, '').lastInsertRowid;
  return { id, token };
}

async function makeGuestAgent(token) {
  const agent = request.agent(app);
  await agent.get('/j/' + token).redirects(1);
  return agent;
}

const CORRUPT_JPEG = Buffer.from('this is not a real jpeg');
const FRIENDLY_ERROR = 'could not use that photo';

describe('AC1 + AC2: corrupt avatar bytes do not kill the process', () => {
  it('responds 400 with the friendly error and the submitted name, and the server survives', async () => {
    const guest = insertGuest();
    const agent = await makeGuestAgent(guest.token);

    const res = await agent
      .post('/onboard')
      .field('name', 'Crash Test Guest')
      .attach('avatar', CORRUPT_JPEG, { filename: 'fake.jpg', contentType: 'image/jpeg' });

    // AC1: a 400 re-render, not a dead socket or a 500 page.
    expect(res.status).toBe(400);

    // AC2: friendly copy + the submitted name pre-filled in the form.
    expect(res.text).toContain(FRIENDLY_ERROR);
    expect(res.text).toContain('Crash Test Guest');

    // The guest is NOT marked onboarded by a failed attempt.
    const row = db.prepare('SELECT onboarded FROM guests WHERE id = ?').get(guest.id);
    expect(row.onboarded).toBe(0);

    // AC1: the server answers the next request on the same session.
    const home = await agent.get('/');
    expect(home.status).toBe(200);
  });
});

describe('AC3: onboarding still completes without an avatar', () => {
  it('redirects to / and marks the guest onboarded on a name-only retry', async () => {
    const guest = insertGuest();
    const agent = await makeGuestAgent(guest.token);

    // First attempt fails on a corrupt avatar…
    const bad = await agent
      .post('/onboard')
      .field('name', 'Retry Guest')
      .attach('avatar', CORRUPT_JPEG, { filename: 'fake.jpg', contentType: 'image/jpeg' });
    expect(bad.status).toBe(400);

    // …then the retry with only a name succeeds.
    const retry = await agent.post('/onboard').field('name', 'Retry Guest');
    expect([301, 302, 303]).toContain(retry.status);
    expect(retry.headers.location).toBe('/');

    const row = db.prepare('SELECT name, onboarded FROM guests WHERE id = ?').get(guest.id);
    expect(row.onboarded).toBe(1);
    expect(row.name).toBe('Retry Guest');
  });
});

describe('AC4: non-image types are rejected with the friendly re-render', () => {
  it('rejects application/pdf without writing a file and stays alive', async () => {
    const guest = insertGuest();
    const agent = await makeGuestAgent(guest.token);

    const uploadsBefore = fs.readdirSync(config.UPLOADS_DIR).sort();

    const res = await agent
      .post('/onboard')
      .field('name', 'PDF Guest')
      .attach('avatar', Buffer.from('%PDF-1.4 not an image'), {
        filename: 'doc.pdf',
        contentType: 'application/pdf',
      });

    // The friendly re-render, not the global 500 page.
    expect(res.status).toBe(400);
    expect(res.text).toContain(FRIENDLY_ERROR);
    expect(res.text).toContain('PDF Guest');

    // Nothing was written to UPLOADS_DIR.
    const uploadsAfter = fs.readdirSync(config.UPLOADS_DIR).sort();
    expect(uploadsAfter).toEqual(uploadsBefore);

    // The process is alive and the guest can continue.
    const home = await agent.get('/');
    expect(home.status).toBe(200);
  });
});
