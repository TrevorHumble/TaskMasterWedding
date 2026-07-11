// tests/avatar-initials.test.js
// AC3: avatar fallback uses two initials.
// Tests the initials() helper directly, then verifies the rendered HTML of a
// no-avatar guest at GET /u/:id returns the correct two-letter fallback.
'use strict';

const request = require('supertest');
const { loadApp } = require('./helpers/testApp');

// One shared app + db for the whole file — the Node module cache means a
// second loadApp() would return the same cached modules. Set everything up once.
let app;
let db;
let agent;
let avenguestId;
let cherId;

beforeAll(async () => {
  ({ app, db } = loadApp());

  // Seed the viewing guest (used to sign in) and the two profile guests.
  db.prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`).run(
    'initials-viewer-token',
    'Viewer Guest'
  );

  avenguestId = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run('initials-ava-token', 'Ava Fenwick').lastInsertRowid;

  cherId = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run('initials-cher-token', 'Cher').lastInsertRowid;

  // Sign in as the viewer so requireGuest in guest.js lets requests through.
  agent = request.agent(app);
  await agent.get('/j/initials-viewer-token');
});

// ---------------------------------------------------------------------------
// Unit tests for the helper — must pass regardless of the HTTP layer.
// ---------------------------------------------------------------------------
describe('initials() helper', () => {
  let initials;

  beforeAll(() => {
    initials = require('../src/utils/initials');
  });

  it('two-word name returns first + last initial uppercased', () => {
    expect(initials('Ava Fenwick')).toBe('AF');
  });

  it('single-word name returns just that initial', () => {
    expect(initials('Cher')).toBe('C');
  });

  it('empty string returns empty string (no crash)', () => {
    expect(initials('')).toBe('');
  });

  it('null returns empty string (no crash)', () => {
    expect(initials(null)).toBe('');
  });

  it('extra whitespace is ignored', () => {
    expect(initials('  Ava   Fenwick  ')).toBe('AF');
  });

  it('three words takes first and last', () => {
    expect(initials('Mary Jane Watson')).toBe('MW');
  });

  // Confirm the two-initial logic is exercised: the inverted value must fail.
  it('AF is not FA (order matters)', () => {
    expect(initials('Ava Fenwick')).not.toBe('FA');
  });

  // Surrogate pairs: the first CHARACTER may be two UTF-16 code units.
  // Indexing [0] would return a lone high surrogate — a broken glyph.
  it('emoji-leading name keeps the whole code point', () => {
    const result = initials('👰 Fenwick');
    expect(result).toBe('👰F');
    expect(result.isWellFormed()).toBe(true);
  });

  it('single-word emoji name returns the whole emoji', () => {
    const result = initials('👰');
    expect(result).toBe('👰');
    expect(result.isWellFormed()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration: GET /u/:id renders the two-letter avatar fallback.
// A signed-in agent is required because guest.js's requireGuest middleware
// intercepts all routes at '/' before community.js can handle them.
// ---------------------------------------------------------------------------
describe('public profile avatar fallback', () => {
  it('GET /u/:id shows "AF" in the avatar fallback for "Ava Fenwick"', async () => {
    const res = await agent.get('/u/' + avenguestId);
    expect(res.status).toBe(200);
    // Must contain the two-letter initials, not just the first letter "A".
    expect(res.text).toContain('AF');
    // Must not be a bare single "A" inside the fallback element.
    expect(res.text).not.toMatch(/profile-avatar-empty[^>]*>\s*A\s*</);
  });

  it('GET /u/:id for single-name guest shows "C" in fallback', async () => {
    const res = await agent.get('/u/' + cherId);
    expect(res.status).toBe(200);
    // EJS emits whitespace around the expression; match the initial inside
    // the fallback element regardless of surrounding whitespace.
    expect(res.text).toMatch(/profile-avatar-empty[^>]*>\s*C\s*</);
  });
});
