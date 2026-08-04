// tests/join-signup.test.js
// Issue #240: a shared entry link at GET /join, self-serve signup (name +
// email-or-phone contact + self-chosen 4-digit PIN + optional avatar), with
// signup itself acting as account creation, no separate /onboard step.
//
// AC1: GET /join is public and its body carries the form field names and the
//      exact PIN-helper phrase "not your bank PIN".
// AC2: POST /join with a fresh contact creates a playing guest (normalized
//      contact, unique token) and signs them in via a `gsid` cookie,
//      redirecting to /how-to-play (issue #564: onboarded starts at its
//      schema default 0, "not yet shown the rules" — see
//      tests/onboarding-how-to-play.test.js for the once-ever contract).
// AC3: POST /join with a contact that already has a guest routes to /login
//      instead of creating a second account.
// AC4: a malformed PIN is rejected with a flash containing "4-digit"; no row
//      is created.
// AC5: a malformed contact is rejected with a flash containing "email or
//      phone"; no row is created.
// AC6: a valid avatar upload at signup is saved and recorded on the new row.
//
// Issue #1091 adds:
// AC2 (#1091): the rendered <label for="avatar"> carries exactly
//      "btn btn-secondary btn-block" (the stacked full-width picker
//      treatment, reused from the task upload form rather than a /join
//      one-off).
// AC3 (#1091): the /join and /tasks/:id picker labels both carry
//      btn-secondary and btn-block, and the now-dead .join-photo selector/
//      class are gone from admin.css and join.ejs.
// AC4 (#1091): the .form-row--tight gap has one owner, expressed in tokens
//      (guest.css): the row's own margin-bottom is var(--space-4), and the
//      picker label's caption margin inside that row is zeroed, with
//      neither declaration a raw px/rem length.
//
// REQUIRE ORDER: loadApp() must run before any require of config, db, or
// photos (see tests/helpers/testApp.js "REQUIRE ORDER MATTERS").
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const request = require('supertest');
const { loadApp, signInGuest } = require('./helpers/testApp');

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

const JOIN_VIEW_PATH = path.join(__dirname, '..', 'src', 'views', 'join.ejs');
const ADMIN_CSS_PATH = path.join(__dirname, '..', 'src', 'public', 'css', 'admin.css');
const GUEST_CSS_PATH = path.join(__dirname, '..', 'src', 'public', 'css', 'guest.css');

function countGuests() {
  return db.prepare('SELECT COUNT(*) AS n FROM guests').get().n;
}

// Returns the opening <label> tag only, not its text or closing tag: the
// class attribute is all any caller here asserts on. upload-field.ejs renders
// the label with its attributes inline on one line, so [^>]* suffices and no
// dotAll flag is needed.
function extractLabel(html, forId) {
  const re = new RegExp(`<label[^>]*for="${forId}"[^>]*>`);
  const match = html.match(re);
  return match ? match[0] : null;
}

function insertTask(title) {
  return db.prepare('INSERT INTO tasks (title) VALUES (?)').run(title).lastInsertRowid;
}

// Flash cookie values are URL-encoded (cookie-parser signs + encodes them),
// so a raw substring check against e.g. "email or phone" would never match
// the encoded "email%20or%20phone". Decode before asserting.
function joinedCookies(res) {
  return decodeURIComponent([].concat(res.headers['set-cookie'] || []).join('\n'));
}

describe('AC1: GET /join is public', () => {
  it('returns 200 with the signup form fields and the PIN helper copy', async () => {
    const res = await request(app).get('/join');
    expect(res.status).toBe(200);
    expect(res.text).toContain('name="name"');
    expect(res.text).toContain('name="contact"');
    expect(res.text).toContain('name="pin"');
    expect(res.text).toContain('not your bank PIN');
  });
});

describe('AC2: POST /join creates a playing guest and signs them in', () => {
  it('normalizes the contact, leaves onboarded at its not-yet-seen default, and sets the gsid cookie', async () => {
    const before = countGuests();

    const res = await request(app)
      .post('/join')
      .type('form')
      .send({ name: 'Lilly', contact: ' Lilly@Example.COM ', pin: '0412' });

    expect(res.status).toBe(302);
    // Issue #564: a fresh signup is routed to the rules card first, not
    // straight home.
    expect(res.headers.location).toBe('/how-to-play');

    const cookies = joinedCookies(res);
    expect(cookies).toContain('gsid=');

    expect(countGuests()).toBe(before + 1);

    const row = db.prepare('SELECT * FROM guests WHERE contact = ?').get('lilly@example.com');
    expect(row).toBeTruthy();
    expect(row.contact_type).toBe('email');
    expect(row.pin).toBe('0412');
    // Issue #564: onboarded now starts at the schema default (0, "not yet
    // shown the rules") instead of being hardcoded to 1 at signup — GET
    // /how-to-play is the only thing that ever flips it.
    expect(row.onboarded).toBe(0);
    expect(typeof row.token).toBe('string');
    expect(row.token.length).toBeGreaterThan(0);
  });
});

describe('AC3: duplicate signup routes to re-entry, not a second account', () => {
  it('leaves the guest count unchanged and redirects to /login with an "already" flash', async () => {
    // A distinct contact from AC2's, so this test does not depend on test
    // execution order within the shared temp database.
    db.prepare(
      `INSERT INTO guests (token, name, onboarded, contact, contact_type, pin)
       VALUES (?, ?, 1, ?, ?, ?)`
    ).run('dup-token', 'Existing Guest', 'existing@example.com', 'email', '9999');

    const before = countGuests();

    const res = await request(app)
      .post('/join')
      .type('form')
      .send({ name: 'Someone Else', contact: 'existing@example.com', pin: '1234' });

    expect(countGuests()).toBe(before);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
    expect(joinedCookies(res)).toContain('already');
  });
});

describe('AC4: a bad PIN is rejected', () => {
  it('creates no guest and flashes a message containing "4-digit"', async () => {
    const before = countGuests();

    const res = await request(app)
      .post('/join')
      .type('form')
      .send({ name: 'Bad Pin Guest', contact: 'badpin@example.com', pin: '12' });

    expect(countGuests()).toBe(before);
    expect(joinedCookies(res)).toContain('4-digit');

    const row = db.prepare('SELECT 1 FROM guests WHERE contact = ?').get('badpin@example.com');
    expect(row).toBeUndefined();
  });
});

describe('AC5: a bad contact is rejected', () => {
  it('creates no guest and flashes a message containing "email or phone"', async () => {
    const before = countGuests();

    const res = await request(app)
      .post('/join')
      .type('form')
      .send({ name: 'Bad Contact Guest', contact: 'not-a-contact', pin: '4321' });

    expect(countGuests()).toBe(before);
    expect(joinedCookies(res)).toContain('email or phone');
  });
});

describe('an empty name is rejected', () => {
  it('creates no guest and flashes a message containing "name"', async () => {
    const before = countGuests();

    const res = await request(app)
      .post('/join')
      .type('form')
      .send({ name: '   ', contact: 'noname@example.com', pin: '2468' });

    expect(countGuests()).toBe(before);
    expect(joinedCookies(res)).toContain('name');

    const row = db.prepare('SELECT 1 FROM guests WHERE contact = ?').get('noname@example.com');
    expect(row).toBeUndefined();
  });
});

describe('AC6: an optional avatar at signup is saved', () => {
  it('records a non-null avatar_path and writes the file to UPLOADS_DIR', async () => {
    const jpeg = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 100, b: 50 } },
    })
      .jpeg()
      .toBuffer();

    const res = await request(app)
      .post('/join')
      .field('name', 'Avatar Guest')
      .field('contact', 'avatar-guest@example.com')
      .field('pin', '5678')
      .attach('avatar', jpeg, { filename: 'a.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(302);
    // Issue #564: same fresh-signup redirect as AC2, whether or not an
    // avatar was attached.
    expect(res.headers.location).toBe('/how-to-play');

    const row = db
      .prepare('SELECT avatar_path FROM guests WHERE contact = ?')
      .get('avatar-guest@example.com');
    expect(row).toBeTruthy();
    expect(row.avatar_path).toBeTruthy();
    expect(fs.existsSync(path.join(config.UPLOADS_DIR, row.avatar_path))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Issue #1091 AC2: the picker markup, behavioral.
// ---------------------------------------------------------------------------
describe('#1091 AC2: the avatar picker label carries the stacked full-width class set', () => {
  it('GET /join renders <label for="avatar" class="btn btn-secondary btn-block">', async () => {
    const res = await request(app).get('/join');
    expect(res.status).toBe(200);

    const labelTag = extractLabel(res.text, 'avatar');
    expect(labelTag).not.toBeNull();
    expect(labelTag).toMatch(/class="btn btn-secondary btn-block"/);
  });
});

// ---------------------------------------------------------------------------
// Issue #1091 AC3: one shared treatment, not a /join one-off.
// ---------------------------------------------------------------------------
describe('#1091 AC3: the picker treatment is shared with /tasks/:id, not a /join one-off', () => {
  it('both /join and /tasks/:id picker labels carry btn-secondary and btn-block', async () => {
    const token = `join-align-${crypto.randomUUID()}`;
    db.prepare('INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)').run(
      token,
      'Join Align Guest'
    );
    const taskId = insertTask('#1091 parity task');
    const agent = signInGuest(app, token);

    const joinRes = await request(app).get('/join');
    const taskRes = await agent.get(`/tasks/${taskId}`);

    expect(joinRes.status).toBe(200);
    expect(taskRes.status).toBe(200);

    const joinLabel = extractLabel(joinRes.text, 'avatar');
    const taskLabel = extractLabel(taskRes.text, 'photo');
    expect(joinLabel).not.toBeNull();
    expect(taskLabel).not.toBeNull();

    [joinLabel, taskLabel].forEach((tag) => {
      expect(tag).toMatch(/\bbtn-secondary\b/);
      expect(tag).toMatch(/\bbtn-block\b/);
    });
  });

  it('admin.css contains no .join-photo selector', () => {
    const css = fs.readFileSync(ADMIN_CSS_PATH, 'utf8');
    expect(css).not.toMatch(/\.join-photo\b/);
  });

  it('join.ejs contains no join-photo class', () => {
    const view = fs.readFileSync(JOIN_VIEW_PATH, 'utf8');
    expect(view).not.toMatch(/\bjoin-photo\b/);
  });
});

// ---------------------------------------------------------------------------
// Issue #1091 AC4: the 16px gap has exactly one owner, expressed in tokens.
// ---------------------------------------------------------------------------
describe('#1091 AC4: .form-row--tight owns the stacked-pair gap alone, in tokens', () => {
  it("guest.css's .form-row--tight sets margin-bottom to var(--space-4) with no raw px/rem", () => {
    const css = fs.readFileSync(GUEST_CSS_PATH, 'utf8');
    const ruleMatch = css.match(/\.form-row--tight\s*\{([^}]*)\}/);
    expect(ruleMatch).not.toBeNull();
    const ruleBody = ruleMatch[1];

    expect(ruleBody).toMatch(/margin-bottom:\s*var\(--space-4\)/);
    // (?:\d*\.)?\d+ so a leading-dot length such as .5rem is caught too.
    expect(ruleBody).not.toMatch(/(?:\d*\.)?\d+(?:px|rem)/);
  });

  it('guest.css zeroes the picker label caption margin inside .form-row--tight, with no raw px/rem', () => {
    const css = fs.readFileSync(GUEST_CSS_PATH, 'utf8');
    const ruleMatch = css.match(/\.form-row--tight \.upload-field label\.btn\s*\{([^}]*)\}/);
    expect(ruleMatch).not.toBeNull();
    const ruleBody = ruleMatch[1];

    expect(ruleBody).toMatch(/margin-bottom:\s*0\s*;/);
    // (?:\d*\.)?\d+ so a leading-dot length such as .5rem is caught too.
    expect(ruleBody).not.toMatch(/(?:\d*\.)?\d+(?:px|rem)/);
  });
});
