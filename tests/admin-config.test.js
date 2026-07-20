// tests/admin-config.test.js
// Issue #681 acceptance criteria for GET/POST /admin/config:
//   AC1 — settings persist: saving timezone + dates, then reloading, shows
//         them selected/filled, and getEventConfig() returns them exactly.
//   AC2 — the stored timezone carries its own DST rule: America/Denver and
//         America/Phoenix (same standard-time offset, opposite DST) each
//         round-trip as that exact distinct IANA name.
//   AC4 — admin-guarded: GET or POST with no admin session redirects to
//         /admin/login, never renders the page or mutates settings.
//   AC5 — invalid input (unknown timezone, or start after end) leaves the
//         stored settings unchanged and re-renders with an error flash.
//   AC6 — the admin dashboard HTML contains a link to /admin/config.
//
// REQUIRE ORDER: loadApp() must run before any require that pulls in config
// or db (see tests/helpers/testApp.js).
'use strict';

const { loadApp, makeAdminAgent } = require('./helpers/testApp');

let app;
let adminAgent;
let getEventConfig;

beforeAll(async () => {
  const result = loadApp();
  app = result.app;
  adminAgent = await makeAdminAgent(app);
  // Require only after loadApp() so db.js is already cached against the
  // temp DATA_DIR (see testApp.js's REQUIRE ORDER note).
  ({ getEventConfig } = require('../src/db'));
});

describe('AC1: settings persist across save + reload', () => {
  it('saving America/Phoenix and 2026-08-07..2026-08-09 round-trips through getEventConfig() and the reloaded page', async () => {
    const postRes = await adminAgent.post('/admin/config').type('form').send({
      timezone: 'America/Phoenix',
      start_date: '2026-08-07',
      end_date: '2026-08-09',
    });
    expect(postRes.status).toBe(303);
    expect(postRes.headers.location).toContain(encodeURIComponent('Configuration saved.'));

    expect(getEventConfig()).toEqual({
      timezone: 'America/Phoenix',
      startDate: '2026-08-07',
      endDate: '2026-08-09',
    });

    const getRes = await adminAgent.get('/admin/config');
    expect(getRes.status).toBe(200);
    expect(getRes.text).toContain('value="2026-08-07"');
    expect(getRes.text).toContain('value="2026-08-09"');
    // The Phoenix <option> carries the `selected` attribute; the Denver
    // option (a distinct, adjacent entry at the same UTC offset) must not.
    expect(getRes.text).toMatch(/<option value="America\/Phoenix" selected>/);
    expect(getRes.text).not.toMatch(/<option value="America\/Denver" selected>/);
  });
});

describe('AC2: the stored timezone keeps its own DST rule, never a merged label', () => {
  it('America/Denver (observes DST) and America/Phoenix (does not) each round-trip as that exact name', async () => {
    await adminAgent.post('/admin/config').type('form').send({
      timezone: 'America/Denver',
      start_date: '2026-08-07',
      end_date: '2026-08-09',
    });
    expect(getEventConfig().timezone).toBe('America/Denver');

    await adminAgent.post('/admin/config').type('form').send({
      timezone: 'America/Phoenix',
      start_date: '2026-08-07',
      end_date: '2026-08-09',
    });
    expect(getEventConfig().timezone).toBe('America/Phoenix');
  });

  it('a grouped member (America/Boise) round-trips as America/Boise itself, not folded to America/Denver', async () => {
    await adminAgent.post('/admin/config').type('form').send({
      timezone: 'America/Boise',
      start_date: '2026-08-07',
      end_date: '2026-08-09',
    });
    // setEventConfig stores exactly what was submitted -- resolveSelectedZone
    // only affects which <option> shows `selected`, never the stored value.
    expect(getEventConfig().timezone).toBe('America/Boise');
  });
});

describe('AC4: admin-guarded', () => {
  it('GET /admin/config with no admin session redirects to /admin/login', async () => {
    const request = require('supertest');
    const res = await request(app).get('/admin/config');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin/login');
  });

  it('POST /admin/config with no admin session redirects to /admin/login and does not mutate settings', async () => {
    const request = require('supertest');
    const before = getEventConfig();

    const res = await request(app).post('/admin/config').type('form').send({
      timezone: 'America/Chicago',
      start_date: '2020-01-01',
      end_date: '2020-01-02',
    });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin/login');
    expect(getEventConfig()).toEqual(before);
  });
});

describe('AC5: invalid input is rejected and leaves settings unchanged', () => {
  it('an unknown timezone name is refused with an error flash, settings unchanged', async () => {
    await adminAgent.post('/admin/config').type('form').send({
      timezone: 'America/Denver',
      start_date: '2026-08-07',
      end_date: '2026-08-09',
    });
    const before = getEventConfig();

    const res = await adminAgent.post('/admin/config').type('form').send({
      timezone: 'Not/AZone',
      start_date: '2026-08-07',
      end_date: '2026-08-09',
    });

    expect(res.status).toBe(303);
    expect(res.headers.location).toContain(encodeURIComponent('valid timezone'));
    expect(getEventConfig()).toEqual(before);
  });

  it('a start date after the end date is refused with an error flash, settings unchanged', async () => {
    await adminAgent.post('/admin/config').type('form').send({
      timezone: 'America/Denver',
      start_date: '2026-08-07',
      end_date: '2026-08-09',
    });
    const before = getEventConfig();

    const res = await adminAgent.post('/admin/config').type('form').send({
      timezone: 'America/Denver',
      start_date: '2026-08-09',
      end_date: '2026-08-07',
    });

    expect(res.status).toBe(303);
    expect(res.headers.location).toContain(encodeURIComponent('on or before the end date'));
    expect(getEventConfig()).toEqual(before);
  });

  it('a malformed date string is refused with an error flash, settings unchanged', async () => {
    await adminAgent.post('/admin/config').type('form').send({
      timezone: 'America/Denver',
      start_date: '2026-08-07',
      end_date: '2026-08-09',
    });
    const before = getEventConfig();

    const res = await adminAgent.post('/admin/config').type('form').send({
      timezone: 'America/Denver',
      start_date: 'not-a-date',
      end_date: '2026-08-09',
    });

    expect(res.status).toBe(303);
    expect(res.headers.location).toContain(encodeURIComponent('valid start and end dates'));
    expect(getEventConfig()).toEqual(before);
  });

  it('an impossible calendar date (2026-02-30) is refused and leaves settings unchanged', async () => {
    await adminAgent.post('/admin/config').type('form').send({
      timezone: 'America/Denver',
      start_date: '2026-08-07',
      end_date: '2026-08-09',
    });
    const before = getEventConfig();

    const res = await adminAgent.post('/admin/config').type('form').send({
      timezone: 'America/Denver',
      start_date: '2026-02-30',
      end_date: '2026-08-09',
    });

    expect(res.status).toBe(303);
    expect(res.headers.location).toContain(encodeURIComponent('valid start and end dates'));
    expect(getEventConfig()).toEqual(before);
  });

  it('a rejected save re-renders the flash with error styling (flash-err), not success', async () => {
    const res = await adminAgent
      .post('/admin/config')
      .type('form')
      .send({ timezone: 'Not/AZone', start_date: '2026-08-07', end_date: '2026-08-09' });

    expect(res.status).toBe(303);
    expect(res.headers.location).toContain('err=1');

    const page = await adminAgent.get(res.headers.location);
    expect(page.text).toContain('flash flash-err');
    expect(page.text).not.toContain('flash flash-ok');
  });
});

describe('AC6: the admin dashboard links to the Configuration page', () => {
  it('GET /admin HTML contains href="/admin/config"', async () => {
    const res = await adminAgent.get('/admin');
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/admin/config"');
  });
});

describe('options sourced from @vvo/tzdb', () => {
  it('the rendered <select> offers America/Phoenix and America/Denver as distinct options', async () => {
    const res = await adminAgent.get('/admin/config');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<option value="America/Denver"');
    expect(res.text).toContain('<option value="America/Phoenix"');
  });
});
