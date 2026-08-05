// tests/ceremony-notice.test.js
// Issue #1042 — the ceremony photo-notice: a host-controlled toggle + date
// that (a) puts a rule row on /how-to-play, (b) shows a dismissable red band
// on every guest page on the configured day only, (c) adds one recap row the
// day of, and (d) an always-reachable /no-photos explainer.
//
//   AC1 — the setting round-trips through GET/POST /admin/config.
//   AC2 — a bad ceremony date (outside the submitted start/end, or not a
//         real date) persists nothing and redirects with an error flash.
//   AC3 — the band appears only on the ceremony date, links to /no-photos,
//         and dismisses (sessionStorage, not localStorage).
//   AC4 — the onboarding row is gated on the toggle alone, any date.
//   AC5 — exactly one recap row, day-of, counted; absent otherwise.
//   AC6 — GET /no-photos renders the approved copy whether the toggle is on
//         or off.
//
// Plus: the phase-1 fake (a hard-coded row pushed inside header.ejs) must be
// gone, and the shared row-shaping map (notifications.js step 8a) must leave
// every OTHER announce derivation byte-identical.
//
// "Today" is pinned via the same shared-module-object monkeypatch technique
// tests/oneday-guest-surface.test.js uses (eventDaysSvc.eventLocalDateString),
// since src/middleware/session.js's clock and src/services/notifications.js's
// own eventDays reference are the same cached module object.
//
// REQUIRE ORDER: config / db / app / services are required only via
// loadApp() — see tests/helpers/testApp.js "REQUIRE ORDER MATTERS".
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const { JSDOM } = require('jsdom');
const { loadApp, makeAdminAgent, signInGuest } = require('./helpers/testApp');

let app;
let db;
let adminAgent;
let getEventConfig;
let notifications;
let eventDaysSvc;

const TIMEZONE = 'America/Boise'; // src/db.js's getEventConfig fallback.
const START_DATE = '2026-08-07';
const END_DATE = '2026-08-09';
const D = '2026-08-08'; // the ceremony date used by every positive-case test.
const D_MINUS_1 = '2026-08-07';
const D_PLUS_1 = '2026-08-09';

beforeAll(async () => {
  const result = loadApp();
  app = result.app;
  db = result.db;
  adminAgent = await makeAdminAgent(app);
  ({ getEventConfig } = require('../src/db'));
  notifications = require('../src/services/notifications');
  eventDaysSvc = require('../src/services/event-days');
});

let originalEventLocalDateString;
function pinToday(dateIso) {
  originalEventLocalDateString = eventDaysSvc.eventLocalDateString;
  eventDaysSvc.eventLocalDateString = () => dateIso;
}
function unpinToday() {
  if (originalEventLocalDateString) {
    eventDaysSvc.eventLocalDateString = originalEventLocalDateString;
  }
}
afterEach(unpinToday);

/**
 * Save event config through the real POST route — timezone/start/end are
 * always the fixed defaults above; `notice`/`date` control the two fields
 * under test. `notice: undefined` omits the checkbox key entirely (an
 * unchecked box), matching what a real browser submits.
 */
function saveCeremonyConfig({ notice, date } = {}) {
  const body = { timezone: TIMEZONE, start_date: START_DATE, end_date: END_DATE };
  if (notice) body.ceremony_notice = '1';
  if (date !== undefined) body.ceremony_date = date;
  return adminAgent.post('/admin/config').type('form').send(body);
}

let seq = 0;
function insertGuest() {
  seq += 1;
  const token = `ceremony-guest-${seq}-${crypto.randomUUID()}`;
  const id = db
    .prepare('INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)')
    .run(token, 'Ceremony Guest').lastInsertRowid;
  return { id, token };
}

function backdateGuest(guestId, createdAt) {
  db.prepare(`UPDATE guests SET created_at = ? WHERE id = ?`).run(createdAt, guestId);
}

function insertTask(overrides) {
  seq += 1;
  const cols = Object.assign(
    {
      title: `Ceremony Suite Task ${seq}`,
      worth: 3,
      special_mode: 'none',
      special_date: null,
      special_bonus: null,
      flash_start_at: null,
      flash_minutes: null,
      flash_bonus: null,
      live_since: null,
    },
    overrides
  );
  return db
    .prepare(
      `INSERT INTO tasks
         (title, worth, special_mode, special_date, special_bonus,
          flash_start_at, flash_minutes, flash_bonus, live_since)
       VALUES (@title, @worth, @special_mode, @special_date, @special_bonus,
               @flash_start_at, @flash_minutes, @flash_bonus, @live_since)`
    )
    .run(cols).lastInsertRowid;
}

function partsText(parts) {
  return (parts || []).map((part) => part.text).join('');
}

// ---------------------------------------------------------------------------
// AC1: the setting round-trips.
// ---------------------------------------------------------------------------
describe('AC1: the ceremony setting round-trips', () => {
  it('off + default date reads back off + 2026-08-07; then checking the box and moving the date to 2026-08-08 round-trips both', async () => {
    // Establish the "off, still at default" precondition explicitly, rather
    // than assuming a fresh DB (issue #1042 AC1's own wording: the asserted
    // date is deliberately NOT the default, so this first save proves the
    // default was real before the second save changes it).
    const offRes = await saveCeremonyConfig({});
    expect(offRes.status).toBe(303);
    expect(getEventConfig().ceremonyNotice).toBe(false);
    expect(getEventConfig().ceremonyDate).toBe('2026-08-07');

    const onRes = await saveCeremonyConfig({ notice: true, date: '2026-08-08' });
    expect(onRes.status).toBe(303);
    expect(getEventConfig()).toMatchObject({ ceremonyNotice: true, ceremonyDate: '2026-08-08' });

    const page = await adminAgent.get('/admin/config');
    expect(page.status).toBe(200);
    expect(page.text).toMatch(
      /<input type="checkbox" id="ceremony_notice" name="ceremony_notice" value="1" checked>/
    );
    expect(page.text).toContain('id="ceremony_date" name="ceremony_date" value="2026-08-08"');
  });

  it('unchecking the box persists false — an absent checkbox key must clear it, not leave it alone', async () => {
    await saveCeremonyConfig({ notice: true, date: '2026-08-08' });
    expect(getEventConfig().ceremonyNotice).toBe(true);

    await saveCeremonyConfig({ notice: false });
    expect(getEventConfig().ceremonyNotice).toBe(false);
    // The date is untouched by an unrelated checkbox-only save.
    expect(getEventConfig().ceremonyDate).toBe('2026-08-08');
  });

  it('an absent ceremony_date key keeps the stored date unchanged', async () => {
    await saveCeremonyConfig({ notice: true, date: '2026-08-09' });
    expect(getEventConfig().ceremonyDate).toBe('2026-08-09');

    // Save again, sending every other field but omitting ceremony_date
    // entirely (a stale cached form) — the stored date must survive.
    await adminAgent.post('/admin/config').type('form').send({
      timezone: TIMEZONE,
      start_date: START_DATE,
      end_date: END_DATE,
      ceremony_notice: '1',
    });
    expect(getEventConfig().ceremonyDate).toBe('2026-08-09');
  });
});

// ---------------------------------------------------------------------------
// AC2: a bad ceremony date persists nothing.
// ---------------------------------------------------------------------------
describe('AC2: a bad ceremony date rejects the whole save', () => {
  it('a ceremony date outside the submitted start/end range is refused, settings unchanged', async () => {
    await saveCeremonyConfig({ notice: true, date: D });
    const before = getEventConfig();

    const res = await adminAgent.post('/admin/config').type('form').send({
      timezone: TIMEZONE,
      start_date: START_DATE,
      end_date: END_DATE,
      ceremony_notice: '1',
      ceremony_date: '2026-08-12',
    });

    expect(res.status).toBe(303);
    expect(res.headers.location).toContain('err=1');
    expect(res.headers.location).toContain(
      encodeURIComponent('valid ceremony day within the wedding dates')
    );
    expect(getEventConfig()).toEqual(before);
  });

  it('a non-real ceremony date is refused, settings unchanged', async () => {
    await saveCeremonyConfig({ notice: true, date: D });
    const before = getEventConfig();

    const res = await adminAgent.post('/admin/config').type('form').send({
      timezone: TIMEZONE,
      start_date: START_DATE,
      end_date: END_DATE,
      ceremony_notice: '1',
      ceremony_date: '2026-02-30',
    });

    expect(res.status).toBe(303);
    expect(res.headers.location).toContain('err=1');
    expect(res.headers.location).toContain(
      encodeURIComponent('valid ceremony day within the wedding dates')
    );
    expect(getEventConfig()).toEqual(before);
  });

  it('the wedding dates AND the ceremony day judged together — moving all three coherently in one save succeeds', async () => {
    // start 2026-08-07 -> 2026-08-10, end unchanged at 2026-08-09 would be
    // invalid on its own terms (start > end); instead widen the end date too
    // and move the ceremony day to the new last day, all in one request.
    const res = await adminAgent.post('/admin/config').type('form').send({
      timezone: TIMEZONE,
      start_date: START_DATE,
      end_date: '2026-08-10',
      ceremony_notice: '1',
      ceremony_date: '2026-08-10',
    });
    expect(res.status).toBe(303);
    expect(res.headers.location).not.toContain('err=1');
    expect(getEventConfig()).toMatchObject({
      startDate: START_DATE,
      endDate: '2026-08-10',
      ceremonyNotice: true,
      ceremonyDate: '2026-08-10',
    });

    // Restore the fixed default range for every later test in this file.
    await saveCeremonyConfig({ notice: true, date: D });
  });
});

// ---------------------------------------------------------------------------
// AC3: the band appears only on the ceremony date, links to /no-photos, and
// dismisses.
// ---------------------------------------------------------------------------
describe('AC3: the band is date-gated and dismisses', () => {
  it('a signed-in guest sees the band, linking to /no-photos, on the ceremony date', async () => {
    await saveCeremonyConfig({ notice: true, date: D });
    pinToday(D);

    const guest = insertGuest();
    const agent = signInGuest(app, guest.token);
    const res = await agent.get('/tasks');

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/class="recap-strip ceremony-strip"/);
    expect(res.text).toContain('href="/no-photos"');
    expect(res.text).toContain('No photos during the ceremony');
  });

  it('no band the day before the ceremony', async () => {
    await saveCeremonyConfig({ notice: true, date: D });
    pinToday(D_MINUS_1);

    const guest = insertGuest();
    const agent = signInGuest(app, guest.token);
    const res = await agent.get('/tasks');

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('ceremony-strip');
  });

  it('no band the day after the ceremony', async () => {
    await saveCeremonyConfig({ notice: true, date: D });
    pinToday(D_PLUS_1);

    const guest = insertGuest();
    const agent = signInGuest(app, guest.token);
    const res = await agent.get('/tasks');

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('ceremony-strip');
  });

  it('no band on the ceremony date when the notice is off', async () => {
    await saveCeremonyConfig({ notice: false, date: D });
    pinToday(D);

    const guest = insertGuest();
    const agent = signInGuest(app, guest.token);
    const res = await agent.get('/tasks');

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('ceremony-strip');

    // Restore for later tests.
    await saveCeremonyConfig({ notice: true, date: D });
  });
});

describe('AC3: dismiss behaviour (src/public/js/ceremony-notice.js)', () => {
  const SCRIPT_PATH = require.resolve('../src/public/js/ceremony-notice.js');

  function bandMarkup() {
    return (
      '<div class="recap-strip ceremony-strip" id="ceremony-line">' +
      '<a class="recap-strip-open ceremony-strip-open" href="/no-photos">' +
      '<span class="recap-strip-text"><strong>No photos during the ceremony</strong></span>' +
      '</a>' +
      '<button type="button" class="recap-strip-dismiss" id="ceremony-dismiss" aria-label="Dismiss">&#215;</button>' +
      '</div>'
    );
  }

  function loadScript(html) {
    const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
      url: 'http://localhost/',
      runScripts: 'outside-only',
    });
    const keys = ['window', 'document'];
    const saved = {};
    keys.forEach((key) => {
      saved[key] = Object.getOwnPropertyDescriptor(global, key);
      Object.defineProperty(global, key, {
        value: dom.window[key],
        configurable: true,
        writable: true,
      });
    });
    delete require.cache[SCRIPT_PATH];
    require(SCRIPT_PATH);
    return {
      doc: dom.window.document,
      restore() {
        keys.forEach((key) => {
          if (saved[key]) Object.defineProperty(global, key, saved[key]);
          else delete global[key];
        });
      },
    };
  }

  it('clicking the dismiss button removes the band and stores the flag in sessionStorage', () => {
    const { doc, restore } = loadScript(bandMarkup());
    try {
      expect(doc.getElementById('ceremony-line')).not.toBeNull();
      doc
        .getElementById('ceremony-dismiss')
        .dispatchEvent(new doc.defaultView.Event('click', { bubbles: true }));
      expect(doc.getElementById('ceremony-line')).toBeNull();
      expect(doc.defaultView.sessionStorage.getItem('ceremonyNoticeDismissed')).toBe('1');
      expect(doc.defaultView.localStorage.getItem('ceremonyNoticeDismissed')).toBeNull();
    } finally {
      restore();
    }
  });

  it('a session already carrying the dismissed flag removes the band on load, before it can flash', () => {
    const dom = new JSDOM(`<!doctype html><html><body>${bandMarkup()}</body></html>`, {
      url: 'http://localhost/',
    });
    dom.window.sessionStorage.setItem('ceremonyNoticeDismissed', '1');
    const keys = ['window', 'document'];
    const saved = {};
    keys.forEach((key) => {
      saved[key] = Object.getOwnPropertyDescriptor(global, key);
      Object.defineProperty(global, key, {
        value: dom.window[key],
        configurable: true,
        writable: true,
      });
    });
    try {
      delete require.cache[SCRIPT_PATH];
      require(SCRIPT_PATH);
      expect(dom.window.document.getElementById('ceremony-line')).toBeNull();
    } finally {
      keys.forEach((key) => {
        if (saved[key]) Object.defineProperty(global, key, saved[key]);
        else delete global[key];
      });
    }
  });

  it('a sessionStorage read that throws leaves the band showing', () => {
    const dom = new JSDOM(`<!doctype html><html><body>${bandMarkup()}</body></html>`, {
      url: 'http://localhost/',
    });
    Object.defineProperty(dom.window, 'sessionStorage', {
      value: {
        getItem() {
          throw new Error('blocked');
        },
        setItem() {
          throw new Error('blocked');
        },
      },
      configurable: true,
    });
    const keys = ['window', 'document'];
    const saved = {};
    keys.forEach((key) => {
      saved[key] = Object.getOwnPropertyDescriptor(global, key);
      Object.defineProperty(global, key, {
        value: dom.window[key],
        configurable: true,
        writable: true,
      });
    });
    try {
      delete require.cache[SCRIPT_PATH];
      require(SCRIPT_PATH);
      expect(dom.window.document.getElementById('ceremony-line')).not.toBeNull();
    } finally {
      keys.forEach((key) => {
        if (saved[key]) Object.defineProperty(global, key, saved[key]);
        else delete global[key];
      });
    }
  });
});

// ---------------------------------------------------------------------------
// AC4: the onboarding row is gated on the toggle alone, any date.
// ---------------------------------------------------------------------------
describe('AC4: the how-to-play onboarding row is gated on the toggle alone', () => {
  it('present when the notice is on, on an ordinary (non-ceremony) date', async () => {
    await saveCeremonyConfig({ notice: true, date: D });
    pinToday(D_MINUS_1); // deliberately NOT the ceremony date -- AC4 is date-independent.

    const guest = insertGuest();
    const agent = signInGuest(app, guest.token);
    const res = await agent.get('/how-to-play');

    expect(res.status).toBe(200);
    expect(res.text).toContain('rule-row-notice');
    expect(res.text).toContain('No photos during the ceremony');
    expect(res.text).toContain('href="/no-photos"');
  });

  it('absent when the notice is off', async () => {
    await saveCeremonyConfig({ notice: false, date: D });

    const guest = insertGuest();
    const agent = signInGuest(app, guest.token);
    const res = await agent.get('/how-to-play');

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('rule-row-notice');

    await saveCeremonyConfig({ notice: true, date: D });
  });
});

// ---------------------------------------------------------------------------
// AC5: one recap row, day-of, counted.
// ---------------------------------------------------------------------------
describe('AC5: the recap row is day-of, exactly one, and counted', () => {
  it('present, keyed announce-ceremony-notice, linking to /no-photos, counted, when checkpoint predates day start', async () => {
    await saveCeremonyConfig({ notice: true, date: D });
    const guest = insertGuest();
    backdateGuest(guest.id, '2020-01-01 00:00:00');

    const dayStartMs = eventDaysSvc.dayOpensAt(D, TIMEZONE).getTime();
    const clock = { todayIso: D, nowMs: dayStartMs + 60000, timezone: TIMEZONE };

    const rows = notifications.getRecap(guest.id, { clock }).rows;
    const ceremonyRows = rows.filter((r) => r.key === 'announce-ceremony-notice');
    expect(ceremonyRows).toHaveLength(1);
    expect(ceremonyRows[0].href).toBe('/no-photos');
    expect(ceremonyRows[0].kind).toBe('ceremony');
    expect(partsText(ceremonyRows[0].parts)).toBe('No photos during the ceremony');

    // The delta, not a bare >= 1 (review fix, M-i): a floor of 1 cannot tell
    // "the ceremony row counted" apart from "something else unread happened
    // to be nonzero too". Turning the notice off removes exactly one from
    // the count.
    const countWithNoticeOn = notifications.getUnreadCount(guest.id, clock);
    await saveCeremonyConfig({ notice: false, date: D });
    const countWithNoticeOff = notifications.getUnreadCount(guest.id, clock);
    expect(countWithNoticeOn).toBe(countWithNoticeOff + 1);

    // Restore for any later test in this file that assumes the notice is on.
    await saveCeremonyConfig({ notice: true, date: D });
  });

  it('absent on the day before the ceremony', async () => {
    const guest = insertGuest();
    backdateGuest(guest.id, '2020-01-01 00:00:00');
    const dayStartMs = eventDaysSvc.dayOpensAt(D_MINUS_1, TIMEZONE).getTime();
    const clock = { todayIso: D_MINUS_1, nowMs: dayStartMs + 60000, timezone: TIMEZONE };

    const rows = notifications.getRecap(guest.id, { clock }).rows;
    expect(rows.some((r) => r.key === 'announce-ceremony-notice')).toBe(false);
  });

  it('absent on the day after the ceremony', async () => {
    const guest = insertGuest();
    backdateGuest(guest.id, '2020-01-01 00:00:00');
    const dayStartMs = eventDaysSvc.dayOpensAt(D_PLUS_1, TIMEZONE).getTime();
    const clock = { todayIso: D_PLUS_1, nowMs: dayStartMs + 60000, timezone: TIMEZONE };

    const rows = notifications.getRecap(guest.id, { clock }).rows;
    expect(rows.some((r) => r.key === 'announce-ceremony-notice')).toBe(false);
  });

  it('absent on the ceremony date when the notice is off', async () => {
    await saveCeremonyConfig({ notice: false, date: D });
    const guest = insertGuest();
    backdateGuest(guest.id, '2020-01-01 00:00:00');
    const dayStartMs = eventDaysSvc.dayOpensAt(D, TIMEZONE).getTime();
    const clock = { todayIso: D, nowMs: dayStartMs + 60000, timezone: TIMEZONE };

    const rows = notifications.getRecap(guest.id, { clock }).rows;
    expect(rows.some((r) => r.key === 'announce-ceremony-notice')).toBe(false);

    await saveCeremonyConfig({ notice: true, date: D });
  });

  it('absent when the guest already checked the recap later that day (checkpoint past day start)', async () => {
    const guest = insertGuest();
    const dayStartMs = eventDaysSvc.dayOpensAt(D, TIMEZONE).getTime();
    backdateGuest(
      guest.id,
      new Date(dayStartMs + 120000).toISOString().slice(0, 19).replace('T', ' ')
    );

    const clock = { todayIso: D, nowMs: dayStartMs + 180000, timezone: TIMEZONE };
    const rows = notifications.getRecap(guest.id, { clock }).rows;
    expect(rows.some((r) => r.key === 'announce-ceremony-notice')).toBe(false);
  });

  it('end-to-end: the row and its red icon render through the real request pipeline', async () => {
    await saveCeremonyConfig({ notice: true, date: D });
    pinToday(D);

    const guest = insertGuest();
    backdateGuest(guest.id, '2020-01-01 00:00:00');
    const agent = signInGuest(app, guest.token);
    const res = await agent.get('/tasks');

    expect(res.status).toBe(200);
    expect(res.text).toContain('recap-row-ceremony');
    expect(res.text).toContain('/no-photos');
  });
});

// ---------------------------------------------------------------------------
// AC6: the explainer renders either way.
// ---------------------------------------------------------------------------
describe('AC6: GET /no-photos renders regardless of the toggle', () => {
  const PARAGRAPHS = [
    'Lilly and Axel have professional photographers covering the ceremony. Please keep phones and cameras down for all of it, from the first walk down the aisle to the last one back up it.',
    'A raised screen lands in the middle of the shot they have been hired to get. This is a moment worth watching with your own eyes, not through a lens.',
    'The game picks back up afterwards.',
  ];

  it('with the notice on', async () => {
    await saveCeremonyConfig({ notice: true, date: D });
    const guest = insertGuest();
    const agent = signInGuest(app, guest.token);
    const res = await agent.get('/no-photos');

    expect(res.status).toBe(200);
    expect(res.text).toContain('No photos during the ceremony');
    PARAGRAPHS.forEach((p) => expect(res.text).toContain(p));
  });

  it('with the notice off', async () => {
    await saveCeremonyConfig({ notice: false, date: D });
    const guest = insertGuest();
    const agent = signInGuest(app, guest.token);
    const res = await agent.get('/no-photos');

    expect(res.status).toBe(200);
    PARAGRAPHS.forEach((p) => expect(res.text).toContain(p));

    await saveCeremonyConfig({ notice: true, date: D });
  });

  it('a signed-out visitor is redirected, never shown the page', async () => {
    const res = await request(app).get('/no-photos');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/join');
  });
});

// ---------------------------------------------------------------------------
// The phase-1 fake must be gone.
// ---------------------------------------------------------------------------
describe('The phase-1 fake ceremony row is deleted from header.ejs', () => {
  it('partials/header.ejs contains no hard-coded announce-ceremony-notice literal', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'views', 'partials', 'header.ejs'),
      'utf8'
    );
    expect(source).not.toContain('announce-ceremony-notice');
    expect(source).not.toContain('PHASE-1 MOCK');
  });

  it('admin-config.ejs and how-to-play.ejs no longer carry a PHASE-1 MOCK marker', () => {
    const adminConfigSrc = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'views', 'admin-config.ejs'),
      'utf8'
    );
    const howToPlaySrc = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'views', 'how-to-play.ejs'),
      'utf8'
    );
    expect(adminConfigSrc).not.toContain('PHASE-1 MOCK');
    expect(howToPlaySrc).not.toContain('PHASE-1 MOCK');
  });
});

// ---------------------------------------------------------------------------
// Regression guard (issue #1042 plan step 8a): with the ceremony notice off,
// every OTHER announce derivation (live-transition, challenge-unseal,
// flash-open) still comes back with kind 'announce', href '/tasks', and the
// announce glyph — unchanged by the per-fact override plumbing.
// ---------------------------------------------------------------------------
describe('Regression: existing announce derivations are unaffected by the override plumbing', () => {
  // A substring unique to the announce glyph's SVG path data (KIND_GLYPH.announce
  // in src/services/notifications.js) — proves the row did NOT fall through to
  // the new `ceremony` glyph.
  const ANNOUNCE_GLYPH_MARKER = 'M6 5c3-1.4 5 1.4 8 0v8c-3 1.4-5-1.4-8 0V5Z';

  beforeAll(async () => {
    await saveCeremonyConfig({ notice: false, date: D });
  });

  it('a live-transition row keeps kind announce, href /tasks, and the announce glyph', () => {
    const guest = insertGuest();
    backdateGuest(guest.id, '2020-01-01 00:00:00');
    insertTask({
      title: 'Regression Live Task',
      special_mode: 'none',
      live_since: '2020-06-01 00:00:00',
    });

    const rows = notifications.getRecap(guest.id).rows;
    const row = rows.find((r) => partsText(r.parts).includes('Regression Live Task'));
    expect(row).toBeDefined();
    expect(row.kind).toBe('announce');
    expect(row.href).toBe('/tasks');
    expect(row.glyph).toContain(ANNOUNCE_GLYPH_MARKER);
  });

  it('a challenge-unseal row keeps kind announce, href /tasks, and the announce glyph', () => {
    const guest = insertGuest();
    backdateGuest(guest.id, '2020-01-01 00:00:00');
    insertTask({
      title: 'Regression Unseal Task',
      special_mode: 'oneday',
      special_date: D,
      special_bonus: 2,
    });

    const dayStartMs = eventDaysSvc.dayOpensAt(D, TIMEZONE).getTime();
    const clock = { todayIso: D, nowMs: dayStartMs + 60000, timezone: TIMEZONE };
    const rows = notifications.getRecap(guest.id, { clock }).rows;
    const row = rows.find((r) => partsText(r.parts).includes('Regression Unseal Task'));
    expect(row).toBeDefined();
    expect(row.kind).toBe('announce');
    expect(row.href).toBe('/tasks');
    expect(row.glyph).toContain(ANNOUNCE_GLYPH_MARKER);
  });

  it('a flash-open row keeps kind announce, href /tasks, and the announce glyph', () => {
    const guest = insertGuest();
    backdateGuest(guest.id, '2020-01-01 00:00:00');
    const start = new Date('2026-08-08T10:00:00.000Z');
    insertTask({
      title: 'Regression Flash Task',
      special_mode: 'none',
      flash_start_at: start.toISOString(),
      flash_minutes: 20,
      flash_bonus: 2,
    });

    const clock = { todayIso: D, nowMs: start.getTime() + 5 * 60000, timezone: TIMEZONE };
    const rows = notifications.getRecap(guest.id, { clock }).rows;
    const row = rows.find((r) => partsText(r.parts).includes('Regression Flash Task'));
    expect(row).toBeDefined();
    expect(row.kind).toBe('announce');
    expect(row.href).toBe('/tasks');
    expect(row.glyph).toContain(ANNOUNCE_GLYPH_MARKER);
  });
});
