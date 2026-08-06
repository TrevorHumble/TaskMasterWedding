// tests/error-report.test.js
// Issue #1020 AC1-AC8: POST /error-report, the one-tap "Send error report"
// button on the shared error page (src/routes/guest/error-report.js), plus
// the reqId wiring src/app.js's global 500 handler now carries.
//
// Legacy CSRF bypass disabled file-wide (same posture as tests/csrf.test.js):
// every POST below supplies a real, minted `_csrf` field, and AC8's
// no-token case needs the real rejection, not the test-env grandfather
// clause silently forgiving it.
//
// REQUIRE ORDER: config / db / app / csrf are required only AFTER loadApp()
// sets DATA_DIR / DB_PATH (see tests/helpers/testApp.js).
'use strict';

const request = require('supertest');
const { loadApp, signInGuest } = require('./helpers/testApp');

let app;
let db;
let config;
let csrf;
let BUG_REPORT_BODY_MAX;
let BUG_REPORT_PAGE_MAX;
let isReqId;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
  config = require('../config');
  csrf = require('../src/middleware/csrf');
  csrf._setLegacyBypassForTest(false);
  ({ BUG_REPORT_BODY_MAX, BUG_REPORT_PAGE_MAX } = require('../src/db'));
  ({ isReqId } = require('../src/middleware/request-log'));
});

function resetTables() {
  db.prepare('DELETE FROM bug_reports').run();
  db.prepare('DELETE FROM guests').run();
}

/** Extract the CSRF token off the <meta name="csrf-token"> tag every page renders. */
function extractToken(html) {
  const m = /<meta name="csrf-token" content="([^"]*)">/.exec(html);
  expect(m).toBeTruthy();
  expect(m[1].length).toBeGreaterThan(0);
  return m[1];
}

/**
 * Extract the incident code off the "Error code:" hint line. The capture
 * itself is loose (any non-`<` run) -- the shape assertion is isReqId
 * (src/middleware/request-log.js), request-log.js's own predicate for what it
 * mints, so this test drifts WITH the mint rather than restating the literal
 * shape as a private copy that a mint change (e.g. a wider randomBytes call)
 * could silently outrun.
 */
function extractErrorCode(html) {
  const m = /Error code:\s*<code>([^<]+)<\/code>/.exec(html);
  expect(m).toBeTruthy();
  expect(isReqId(m[1])).toBe(true);
  return m[1];
}

let guestCounter = 0;
/** A signed-in guest agent that has already GETted a page, minting the real
 * csrf cookie + token. */
async function signedInAgentWithToken() {
  guestCounter += 1;
  const token = `er1020-${guestCounter}-${Date.now()}`;
  const guestId = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run(token, `ER1020 Guest ${guestCounter}`).lastInsertRowid;
  const agent = signInGuest(app, token);
  const homeRes = await agent.get('/tasks');
  const csrfToken = extractToken(homeRes.text);
  return { agent, guestId, csrfToken };
}

/** An anonymous (never signed-in) agent, csrf token minted off GET /join. */
async function anonymousAgentWithToken() {
  const agent = request.agent(app);
  const joinRes = await agent.get('/join');
  const csrfToken = extractToken(joinRes.text);
  return { agent, csrfToken };
}

/**
 * Force a real 500 through the global error handler by making GET /tasks'
 * own task-listing query throw -- same forced-failure technique as
 * tests/request-log.test.js's AC2 (that distinctive LEFT JOIN is unique to
 * this query, so no other route's DB access is disturbed). Returns the
 * signed-in agent (with a real csrf cookie already minted from an earlier,
 * successful GET) plus the rendered 500 page's text.
 */
async function trigger500(agent) {
  const originalPrepare = db.prepare.bind(db);
  const dbSpy = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
    if (sql.includes('LEFT JOIN submissions')) {
      throw new Error('boom: forced #1020 test failure');
    }
    return originalPrepare(sql);
  });
  try {
    const res = await agent.get('/tasks');
    expect(res.status).toBe(500);
    return res.text;
  } finally {
    dbSpy.mockRestore();
  }
}

describe('AC1/AC2/AC3: the 500 page carries reqId, byte-identical to the log line, wired into the approved markup', () => {
  it('the rendered card and its form match the approved shape, and the code matches the log line for this request', async () => {
    resetTables();
    const { agent, csrfToken: pageToken } = await signedInAgentWithToken();
    expect(pageToken.length).toBeGreaterThan(0);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let html;
    let lines;
    try {
      html = await trigger500(agent);
      // Read the captured lines BEFORE mockRestore() below, which clears the
      // spy's call history along with restoring the real console.log.
      lines = logSpy.mock.calls
        .map((argsCall) => argsCall[0])
        .map((raw) => {
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        })
        .filter((parsed) => parsed !== null && typeof parsed.reqId === 'string');
    } finally {
      logSpy.mockRestore();
    }

    // AC1: heading, body message, full-width button, back link, error code line.
    expect(html).toContain('Something Went Wrong');
    expect(html).toContain('Send error report');
    expect(html).toContain('Back to the start');
    // extractErrorCode already asserts the code matches isReqId's shape.
    const code = extractErrorCode(html);

    // AC2: the button is a submit inside a POST /error-report form carrying
    // both the shared csrf-field and a hidden code input valued the reqId.
    expect(html).toMatch(/<form[^>]*action="\/error-report"[^>]*method="POST"[\s\S]*?<\/form>/);
    const formMatch = /<form[^>]*action="\/error-report"[\s\S]*?<\/form>/.exec(html);
    expect(formMatch).toBeTruthy();
    const formHtml = formMatch[0];
    expect(formHtml).toContain('name="_csrf"');
    expect(formHtml).toContain('name="code"');
    expect(formHtml).toContain('value="' + code + '"');
    expect(formHtml).toMatch(/<button type="submit"[^>]*>Send error report<\/button>/);

    // AC3: the code is byte-identical to the reqId this SAME request's log
    // lines carry (a case-insensitive grep of the logs for the quoted code
    // would find them, since it is the raw, un-transformed value).
    expect(lines.some((l) => l.reqId === code)).toBe(true);
  });
});

// AC4 (WCAG AA contrast on the code line and the button, on both the wedding
// and stag themes) is carried entirely by src/public/css/admin.css, which is
// FROZEN at the owner-approved visual hash (issue #1020's "Visual approval
// recorded" note) -- this file makes no wiring change to that CSS, so there
// is nothing for a route/unit test to newly assert here; the approved render
// itself is the acceptance evidence.

describe('AC5: the other rejection pages, and a 500 with no CSRF token, render no button/notice; the 500-without-token case still shows its code', () => {
  it('a 413, a 429, and a 403 page carry no button, no notice, and no Error code line', async () => {
    // 413: a real oversized body against the existing parser limit.
    const oversized = 'a'.repeat(17 * 1024);
    const res413 = await request(app)
      .post('/admin/login')
      .type('form')
      .send('password=' + oversized);
    expect(res413.status).toBe(413);
    expect(res413.text).not.toContain('Send error report');
    expect(res413.text).not.toContain('Error code:');
    expect(res413.text).not.toContain('Report sent');

    // 429: force the IP-keyed login limiter to reject immediately. A real,
    // minted csrf token is required here since this file disables the
    // legacy no-token grandfather clause -- without one this would be
    // rejected 403 by csrfMiddleware before ever reaching the limiter.
    const originalMax = config.RATE_LIMIT_IP_MAX;
    config.RATE_LIMIT_IP_MAX = 0;
    try {
      const { agent: loginAgent, csrfToken: loginCsrf } = await anonymousAgentWithToken();
      const res429 = await loginAgent
        .post('/login')
        .type('form')
        .send({ contact: 'er1020-nobody@example.com', pin: '0000', _csrf: loginCsrf });
      expect(res429.status).toBe(429);
      expect(res429.text).not.toContain('Send error report');
      expect(res429.text).not.toContain('Error code:');
    } finally {
      config.RATE_LIMIT_IP_MAX = originalMax;
    }

    // 403: a POST with a deliberately wrong csrf token (legacy bypass is off
    // for this whole file, and a WRONG token is never forgiven regardless).
    const res403 = await request(app)
      .post('/bug-report')
      .type('form')
      .send({ body: 'irrelevant', _csrf: 'not-a-real-token' });
    expect(res403.status).toBe(403);
    expect(res403.text).not.toContain('Send error report');
    expect(res403.text).not.toContain('Error code:');
  });

  it('a 500 rendered with no csrfToken available still shows its Error code line but no button', () => {
    const ejs = require('ejs');
    const fs = require('fs');
    const path = require('path');
    const viewsDir = path.join(__dirname, '..', 'src', 'views');
    const viewPath = path.join(viewsDir, 'error.ejs');
    const html = ejs.render(
      fs.readFileSync(viewPath, 'utf8'),
      { message: 'Something went wrong on our end. Please try again.', reqId: 'a1b2c3d4' },
      // csrfToken deliberately omitted from locals, exactly like a render
      // that happens before csrfMiddleware has ever run.
      { views: [viewsDir], filename: viewPath }
    );
    expect(html).toContain('Error code:');
    expect(html).toContain('<code>a1b2c3d4</code>');
    expect(html).not.toContain('Send error report');
    expect(html).not.toContain('Report sent');
  });
});

describe("AC6: submitting the form re-renders success, keeping the ORIGINAL code (not the POST's own reqId)", () => {
  it('the success bar replaces the button and the code is unchanged', async () => {
    resetTables();
    const { agent } = await signedInAgentWithToken();

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let html500;
    try {
      html500 = await trigger500(agent);
    } finally {
      logSpy.mockRestore();
    }
    const code = extractErrorCode(html500);
    const pageCsrf = extractToken(html500);

    const res = await agent.post('/error-report').type('form').send({ code, _csrf: pageCsrf });

    expect(res.status).toBe(200);
    expect(res.text).toContain('Report sent. The Wedding Masters have the details.');
    expect(res.text).not.toContain('Send error report');
    expect(extractErrorCode(res.text)).toBe(code);
    // role="status" on the success bar (screen-reader announced, non-stealing focus).
    expect(res.text).toMatch(
      /role="status"[^>]*>Report sent\. The Wedding Masters have the details\.</
    );
  });
});

describe('AC7: signed-out and signed-in submissions each insert exactly one row, with the required fields; a repeat inside the window is suppressed', () => {
  it("a signed-in guest's submission stores guest_id, status=open, page, user_agent, and the code+path in the body", async () => {
    resetTables();
    const { agent, guestId, csrfToken } = await signedInAgentWithToken();

    const res = await agent
      .post('/error-report')
      .set('Referer', 'http://localhost:3000/tasks')
      .set('User-Agent', 'ER1020-test-agent')
      .type('form')
      .send({ code: 'a1b2c3d4', _csrf: csrfToken });

    expect(res.status).toBe(200);

    const row = db.prepare('SELECT * FROM bug_reports WHERE guest_id = ?').get(guestId);
    expect(row).toBeTruthy();
    expect(row.status).toBe('open');
    expect(row.page).toBe('/tasks');
    expect(row.user_agent).toBe('ER1020-test-agent');
    expect(row.body).toContain('a1b2c3d4');
    expect(row.body).toContain('/tasks');

    // A repeat inside the 30-second window inserts no second row.
    const again = await agent
      .post('/error-report')
      .set('Referer', 'http://localhost:3000/tasks')
      .type('form')
      .send({ code: 'a1b2c3d4', _csrf: csrfToken });
    expect(again.status).toBe(200);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM bug_reports WHERE guest_id = ?').get(guestId).n
    ).toBe(1);
  });

  it("a signed-out visitor's submission stores guest_id NULL, and a repeat inside the window is suppressed too", async () => {
    resetTables();
    const { agent, csrfToken } = await anonymousAgentWithToken();

    const res = await agent
      .post('/error-report')
      .set('Referer', 'http://localhost:3000/tasks')
      .type('form')
      .send({ code: 'a1b2c3d4', _csrf: csrfToken });

    expect(res.status).toBe(200);

    const rows = db.prepare('SELECT * FROM bug_reports').all();
    expect(rows.length).toBe(1);
    expect(rows[0].guest_id).toBeNull();
    expect(rows[0].status).toBe('open');
    expect(rows[0].body).toContain('a1b2c3d4');

    // Issue #1020's `guest_id IS ?` fix: a signed-out repeat must ALSO be
    // suppressed, not silently double-inserted (the pre-#1020 `= ?` predicate
    // is never true when guest_id is NULL, which would have missed this).
    const again = await agent
      .post('/error-report')
      .set('Referer', 'http://localhost:3000/tasks')
      .type('form')
      .send({ code: 'a1b2c3d4', _csrf: csrfToken });
    expect(again.status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM bug_reports').get().n).toBe(1);
  });
});

describe('Composed body and page are clamped through the single owner (src/db/bug-reports.js), not a private copy in this route', () => {
  it('a Referer path long enough to push the composed body over BUG_REPORT_BODY_MAX stores the body truncated to exactly the cap', async () => {
    resetTables();
    const { agent, guestId, csrfToken } = await signedInAgentWithToken();

    // The route composes "App-filed error report. Code: <code>. Page: <page>."
    // server-side -- a long enough page pathname pushes that composed string
    // past BUG_REPORT_BODY_MAX on its own, with no user-typed free text
    // involved at all.
    const longPath = '/' + 'a'.repeat(BUG_REPORT_BODY_MAX + 200);
    const res = await agent
      .post('/error-report')
      .set('Referer', 'http://localhost:3000' + longPath)
      .type('form')
      .send({ code: 'a1b2c3d4', _csrf: csrfToken });

    expect(res.status).toBe(200);

    const row = db.prepare('SELECT body FROM bug_reports WHERE guest_id = ?').get(guestId);
    expect(row.body.length).toBe(BUG_REPORT_BODY_MAX);
    expect(row.body.startsWith('App-filed error report. Code: a1b2c3d4. Page: ' + longPath)).toBe(
      false
    );
    expect(row.body.startsWith('App-filed error report. Code: a1b2c3d4. Page: /aaa')).toBe(true);
  });

  it('a Referer path over BUG_REPORT_PAGE_MAX stores the page column truncated to exactly the cap', async () => {
    resetTables();
    const { agent, guestId, csrfToken } = await signedInAgentWithToken();

    const longPath = '/' + 'b'.repeat(BUG_REPORT_PAGE_MAX + 200);
    const res = await agent
      .post('/error-report')
      .set('Referer', 'http://localhost:3000' + longPath)
      .type('form')
      .send({ code: 'a1b2c3d4', _csrf: csrfToken });

    expect(res.status).toBe(200);

    const row = db.prepare('SELECT page FROM bug_reports WHERE guest_id = ?').get(guestId);
    expect(row.page.length).toBe(BUG_REPORT_PAGE_MAX);
    expect(row.page).toBe(longPath.slice(0, BUG_REPORT_PAGE_MAX));
  });
});

describe('AC8: no valid CSRF, a missing/malformed code, or an over-budget caller inserts nothing', () => {
  it('a POST with no CSRF token at all is rejected 403 and inserts no row', async () => {
    resetTables();
    const res = await request(app).post('/error-report').type('form').send({ code: 'a1b2c3d4' });
    expect(res.status).toBe(403);
    expect(db.prepare('SELECT COUNT(*) AS n FROM bug_reports').get().n).toBe(0);
  });

  it('a missing code answers 400 with an error page carrying no code/button/notice, and inserts no row', async () => {
    resetTables();
    const { agent, csrfToken } = await signedInAgentWithToken();

    const res = await agent.post('/error-report').type('form').send({ _csrf: csrfToken });
    expect(res.status).toBe(400);
    expect(res.text).not.toContain('Error code:');
    expect(res.text).not.toContain('Send error report');
    expect(res.text).not.toContain('Report sent');
    expect(db.prepare('SELECT COUNT(*) AS n FROM bug_reports').get().n).toBe(0);
  });

  // Defect fix: the 400 path was rendering ERROR_PAGE_MESSAGE
  // ("Something went wrong on our end") -- status-inaccurate, since this
  // request was rejected for a bad/missing code, not a server failure. It
  // must carry the rejection-specific copy from src/error-copy.js instead,
  // and must NOT carry the 500 copy.
  it('the 400 malformed-code rejection carries rejection-specific copy, not the 500 message', async () => {
    resetTables();
    const { agent, csrfToken } = await signedInAgentWithToken();

    const res = await agent
      .post('/error-report')
      .type('form')
      .send({ code: 'not-hex!!', _csrf: csrfToken });
    expect(res.status).toBe(400);
    expect(res.text).toContain('That report could not be sent. Please try again.');
    expect(res.text).not.toContain('Something went wrong on our end');
  });

  it('a code that is not 8 lowercase hex characters answers 400 and inserts no row', async () => {
    resetTables();
    const { agent, csrfToken } = await signedInAgentWithToken();

    for (const badCode of ['A1B2C3D4', 'a1b2c3d', 'a1b2c3d45', 'not-hex!!', '']) {
      const res = await agent
        .post('/error-report')
        .type('form')
        .send({ code: badCode, _csrf: csrfToken });
      expect(res.status).toBe(400);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM bug_reports').get().n).toBe(0);
  });

  it('a caller over the errorReportRateLimiter budget is rejected and inserts no row', async () => {
    resetTables();
    const originalMax = config.ERROR_REPORT_RATE_MAX;
    config.ERROR_REPORT_RATE_MAX = 0;
    try {
      const { agent, csrfToken } = await signedInAgentWithToken();
      const res = await agent
        .post('/error-report')
        .type('form')
        .send({ code: 'a1b2c3d4', _csrf: csrfToken });
      expect(res.status).toBe(429);
      expect(db.prepare('SELECT COUNT(*) AS n FROM bug_reports').get().n).toBe(0);
    } finally {
      config.ERROR_REPORT_RATE_MAX = originalMax;
    }
  });
});
