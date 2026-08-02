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
// Issue #875 acceptance criteria for the date-field markup (the calendar-
// button click behavior and the client-side range wiring live in the
// separate tests/date-field-script.test.js — this file only covers what the
// SERVER renders and enforces):
//   AC2 — the rendered start/end inputs carry the stored values, and the end
//         field's `min` is pinned to the stored start date.
//   AC3 (server half) — a crafted POST that inverts the range is still
//         rejected server-side regardless of what the client did (covered by
//         the pre-existing "a start date after the end date is refused..."
//         test under AC5 above — issue #681's server guard is exactly issue
//         #875's AC3 server half, unchanged by this issue).
//   AC4 — a valid save round-trips through getEventConfig() and the
//         re-rendered page (covered by the pre-existing AC1 test above —
//         this issue changes the control, not the persistence path).
//   AC5/AC6 (server halves) — each date input's <label for> matches its own
//         id (so it announces "Wedding starts"/"Wedding ends"), and the
//         calendar button renders `hidden` with a distinct aria-label naming
//         its action rather than reading as an unlabelled button. AC6's
//         CSS half (that `hidden` actually means invisible, not just an
//         attribute in the markup) is asserted separately, against the
//         stylesheet text via tests/helpers/theme-css.js.
//
// REQUIRE ORDER: loadApp() must run before any require that pulls in config
// or db (see tests/helpers/testApp.js).
'use strict';

const fs = require('fs');
const path = require('path');
const { loadApp, makeAdminAgent } = require('./helpers/testApp');
const { readThemeCss } = require('./helpers/theme-css');

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

describe("issue #875 AC2: date-field markup carries the stored values and the end field's pinned min", () => {
  it("renders the start value, the end value, and the end field's min pinned to the stored start date", async () => {
    await adminAgent.post('/admin/config').type('form').send({
      timezone: 'America/Denver',
      start_date: '2026-08-07',
      end_date: '2026-08-09',
    });

    const res = await adminAgent.get('/admin/config');
    expect(res.status).toBe(200);

    const startInput = res.text.match(/<input[^>]*id="start_date"[^>]*>/);
    const endInput = res.text.match(/<input[^>]*id="end_date"[^>]*>/);
    expect(startInput).toBeTruthy();
    expect(endInput).toBeTruthy();

    expect(startInput[0]).toContain('value="2026-08-07"');
    // Issue #875's Notes: bounds are one-directional. The start field never
    // carries a min/max of its own — only the end field is bounded, so a
    // regression that started pinning the start field too would fail here.
    expect(startInput[0]).not.toMatch(/\bmin=/);

    expect(endInput[0]).toContain('value="2026-08-09"');
    expect(endInput[0]).toContain('min="2026-08-07"');
  });
});

describe('issue #875 AC5/AC6 (server halves): labels stay wired to their inputs, calendar button is hidden with its own aria-label', () => {
  it('each date input\'s <label for> matches its own id, so it announces "Wedding starts"/"Wedding ends"', async () => {
    const res = await adminAgent.get('/admin/config');
    expect(res.status).toBe(200);

    expect(res.text).toContain('<label class="form-label" for="start_date">Wedding starts</label>');
    expect(res.text).toContain('<label class="form-label" for="end_date">Wedding ends</label>');
  });

  it('each calendar button renders hidden and carries a distinct aria-label naming its action, not an unlabelled button', async () => {
    const res = await adminAgent.get('/admin/config');
    expect(res.status).toBe(200);

    // Rendered hidden server-side (date-field.js is what unhides it) --
    // this is the markup half of AC6; the CSS half (that `hidden` really
    // means invisible) is asserted separately below against the stylesheet.
    const buttons = res.text.match(
      /<button class="date-open" type="button" hidden aria-label="[^"]+">/g
    );
    expect(buttons).toHaveLength(2);

    expect(res.text).toContain('aria-label="Open the calendar for Wedding starts"');
    expect(res.text).toContain('aria-label="Open the calendar for Wedding ends"');
  });
});

describe('issue #875 (review MAJOR 1): the served page carries every hook date-field.js queries for', () => {
  it('serves data-date-range on the form, data-range-start/-end on their inputs, data-range-error on the message, and loads /js/date-field.js', async () => {
    const res = await adminAgent.get('/admin/config');
    expect(res.status).toBe(200);

    // tests/date-field-script.test.js builds its OWN fixture markup with all
    // four hooks present, so every wireRange()/enhanceButtons() selector in
    // date-field.js is satisfied there regardless of what the real view
    // renders. These assertions are the only ones checking the view itself:
    // an edit that drops a hook from admin-config.ejs or date-field.ejs
    // leaves every other test green while a live host silently loses the
    // client-side range message.
    // Scoped to the config form specifically -- the page's header also
    // renders an unrelated logout <form>, and a bare /<form\b[^>]*>/ finds
    // that one first.
    const formOpenTag = res.text.match(/<form[^>]*action="\/admin\/config"[^>]*>/);
    expect(formOpenTag).toBeTruthy();
    expect(formOpenTag[0]).toMatch(/\bdata-date-range\b/);

    const startInput = res.text.match(/<input[^>]*id="start_date"[^>]*>/);
    const endInput = res.text.match(/<input[^>]*id="end_date"[^>]*>/);
    expect(startInput).toBeTruthy();
    expect(endInput).toBeTruthy();
    expect(startInput[0]).toMatch(/\bdata-range-start\b/);
    expect(endInput[0]).toMatch(/\bdata-range-end\b/);
    // Each field carries exactly its own role, never the other's.
    expect(startInput[0]).not.toMatch(/\bdata-range-end\b/);
    expect(endInput[0]).not.toMatch(/\bdata-range-start\b/);

    expect(res.text).toContain(
      '<p class="form-error date-range-error" role="alert" data-range-error hidden></p>'
    );

    expect(res.text).toContain('<script src="/js/date-field.js" defer></script>');
  });

  // enhanceButtons()'s half of the same contract: it finds the buttons through
  // `.date-field .date-open` and then the field through
  // `button.parentNode.querySelector('.date-input')`. Consolidating the input
  // onto `.form-input` alone, or renaming the wrapper, makes that lookup return
  // null -- both buttons then stay `hidden` forever and `.js-date` is never
  // set, so the approved calendar glyph disappears from the page entirely
  // while the jsdom fixture (which supplies both class names itself) stays
  // green. These two assertions are what make that edit fail a test.
  it('serves the .date-field wrapper and the .date-input class enhanceButtons() looks the field up by', async () => {
    const res = await adminAgent.get('/admin/config');
    expect(res.status).toBe(200);

    expect(res.text).toContain('<div class="date-field">');

    const startInput = res.text.match(/<input[^>]*id="start_date"[^>]*>/);
    const endInput = res.text.match(/<input[^>]*id="end_date"[^>]*>/);
    expect(startInput[0]).toMatch(/\bdate-input\b/);
    expect(endInput[0]).toMatch(/\bdate-input\b/);

    // The button the wrapper must contain for that lookup to be reached at all.
    expect(res.text).toMatch(/<button class="date-open"/);
  });
});

describe('issue #875 (review MINOR 4): the .js-date CSS gate that collapses the native picker indicator exists', () => {
  it('the theme CSS scopes the ::-webkit-calendar-picker-indicator collapse behind .date-field.js-date', () => {
    const css = readThemeCss();
    const gateMatch = css.match(
      /\.date-field\.js-date \.date-input::-webkit-calendar-picker-indicator\s*\{\s*opacity:\s*0;[\s\S]*?\}/
    );
    expect(gateMatch).toBeTruthy();
    // Scoped to .date-field.js-date, not a bare .js-date on the document root
    // or a bare .date-field -- the per-field promise the code comment and
    // DESIGN.md make must be a per-field selector too, not a document-wide or
    // always-on one.
    expect(gateMatch[0]).toMatch(/^\.date-field\.js-date /);
  });
});

describe('issue #875 AC6 (CSS half): every icon-in-field button class a view renders hidden has a [hidden] companion', () => {
  it('scans every view for a hidden icon-in-field button and confirms the theme CSS restates display:none !important for its class', () => {
    const css = readThemeCss();

    // The shared icon-in-field button rule (guest.css's "Icon-in-field
    // controls" block) -- fingerprinted on properties unique to that rule
    // (the 10px right inset plus the primary-color glyph treatment) rather
    // than a line number, so reordering the sheet does not break this.
    const ruleMatch = css.match(
      /([^{}]+)\{\s*position:\s*absolute;\s*top:\s*50%;\s*right:\s*10px;[\s\S]*?display:\s*flex;[\s\S]*?color:\s*var\(--color-primary\);[\s\S]*?\}/
    );
    expect(ruleMatch).toBeTruthy();
    const iconButtonClasses = ruleMatch[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    // Sanity check that the fingerprint really found the shared rule and not
    // some other display:flex block -- both known consumers must be in it.
    expect(iconButtonClasses).toEqual(expect.arrayContaining(['.pin-reveal', '.date-open']));

    const viewsDir = path.join(__dirname, '..', 'src', 'views');
    const viewFiles = fs
      .readdirSync(viewsDir, { recursive: true })
      .filter((f) => f.endsWith('.ejs'))
      .map((f) => path.join(viewsDir, f));

    // Scope the invariant by what the views actually render `hidden`, not by
    // the whole shared selector list -- .pin-reveal is in the same
    // display:flex list but is never rendered hidden (me-edit.ejs always
    // emits it live), and requiring a [hidden] companion for a class no view
    // ever hides would be asserting dead CSS.
    const classesRenderedHidden = new Set();
    for (const cls of iconButtonClasses) {
      const bareName = cls.slice(1);
      const hiddenRe = new RegExp('<button[^>]*class="' + bareName + '"[^>]*\\bhidden\\b[^>]*>');
      const renderedHidden = viewFiles.some((file) => hiddenRe.test(fs.readFileSync(file, 'utf8')));
      if (renderedHidden) classesRenderedHidden.add(cls);
    }

    expect(classesRenderedHidden.has('.date-open')).toBe(true);
    expect(classesRenderedHidden.has('.pin-reveal')).toBe(false);

    // For every class actually rendered hidden (today: .date-open; a future
    // member of the shared selector list a new view renders hidden joins
    // this loop automatically), the theme CSS must restate `display: none
    // !important` for it -- deleting .date-open[hidden]'s companion, or
    // adding a new hidden-rendered consumer without its own, fails here.
    for (const cls of classesRenderedHidden) {
      const companionRe = new RegExp(
        '\\' + cls + '\\[hidden\\]\\s*\\{\\s*display:\\s*none\\s*!important;\\s*\\}'
      );
      expect(css).toMatch(companionRe);
    }
  });
});
