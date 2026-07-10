// tests/message-card.test.js
// Issue #120: one shared "message card" partial replaces five hand-duplicated
// brand-card pages.
// AC1: GET /j/<unknown-token> -> 404, body renders the shared card.
// AC2: signed-out GET /tasks (guest-gated) -> 302 to /join (issue #241
//      retired the "private link needed" card in favor of a redirect to the
//      shared entry point).
// Also confirms the maintenance (503) and 404 (unmatched route) paths still
// render through the shared partial with their original copy intact.
'use strict';

const request = require('supertest');
const { loadApp } = require('./helpers/testApp');

let app;
let config;

beforeAll(() => {
  const result = loadApp();
  app = result.app;
  config = require('../config');
});

afterAll(() => {
  config.MAINTENANCE = false;
});

describe('AC1: unknown guest token', () => {
  it('GET /j/<unknown-token> returns 404', async () => {
    const res = await request(app).get('/j/this-token-does-not-exist');
    expect(res.status).toBe(404);
  });

  it('GET /j/<unknown-token> body renders the shared card with the "Link Not Recognized" copy', async () => {
    const res = await request(app).get('/j/this-token-does-not-exist');
    expect(res.text).toContain('message-card');
    expect(res.text).toContain('Link Not Recognized');
    expect(res.text).toContain(
      'We could not find that private link. Double-check you scanned the QR code'
    );
  });

  it('does not sign in a cookie for an unknown token', async () => {
    const res = await request(app).get('/j/this-token-does-not-exist');
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('AC2: signed-out visitor on a guest-gated page', () => {
  it('GET /tasks with no guest cookie redirects to /join (issue #241)', async () => {
    const res = await request(app).get('/tasks');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/join');
  });
});

describe('regression: maintenance (503) still renders through the shared partial', () => {
  beforeEach(() => {
    config.MAINTENANCE = true;
  });
  afterEach(() => {
    config.MAINTENANCE = false;
  });

  it('GET / returns 503 with the original "We\'ll be right back" copy, apostrophe intact', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(503);
    expect(res.text).toContain("We'll be right back");
    expect(res.text).not.toContain('&#39;');
  });
});

// Every path under '/' is guest-gated (guest.js runs `router.use(requireGuest)`
// for the whole router), so a signed-out request never reaches the app-level
// 404 handler — it redirects to /join first (issue #241). To exercise the
// true 404 handler (app.js section 7) we sign in as a real guest first, same
// as a returning guest hitting a stale/mistyped URL would.
describe('regression: unmatched route (404) still renders through the shared partial', () => {
  async function signedInAgent() {
    const { db } = require('../src/db');
    db.prepare('INSERT OR IGNORE INTO guests (token, name) VALUES (?, ?)').run(
      'signed-in-token',
      'Signed In Guest'
    );
    const agent = request.agent(app);
    await agent.get('/j/signed-in-token');
    return agent;
  }

  it('GET /this-route-does-not-exist returns 404 with the URL escaped in a <code> tag', async () => {
    const agent = await signedInAgent();
    const res = await agent.get('/this-route-does-not-exist');
    expect(res.status).toBe(404);
    expect(res.text).toContain('Page Not Found');
    expect(res.text).toContain('<code>/this-route-does-not-exist</code>');
  });
});

// req.originalUrl is user-controlled (an attacker picks the request path), and
// the 404 view interpolates it into the card via `{ text, code: url }`. A
// supertest/superagent client always percent-encodes '<' and '>' before they
// ever reach req.originalUrl, so an HTTP-level request can't exercise the raw
// case — render the view directly (as Express's view engine would) with a
// local carrying literal HTML to prove the escaping contract itself.
describe('security: the 404 view escapes a malicious url local instead of rendering it raw', () => {
  it('a url local containing a <script> tag comes out HTML-escaped inside <code>', () => {
    const ejs = require('ejs');
    const fs = require('fs');
    const path = require('path');
    const viewsDir = path.join(__dirname, '..', 'src', 'views');
    const viewPath = path.join(viewsDir, '404.ejs');
    const html = ejs.render(
      fs.readFileSync(viewPath, 'utf8'),
      { url: '<script>alert(1)</script>' },
      { views: [viewsDir], filename: viewPath }
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('AC5: the shared partial never reads res.locals.guest', () => {
  it('message-card.ejs source contains no `guest` code reference outside its doc comment', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'views', 'partials', 'message-card.ejs'),
      'utf8'
    );
    // Strip the leading <%# ... %> doc-comment block (which legitimately
    // documents the "no res.locals.guest" guarantee in prose) before checking
    // the executable template for any actual reference to a `guest` local.
    const withoutLeadingComments = src.replace(/^(\s*<%#[\s\S]*?%>\s*)+/, '');
    expect(withoutLeadingComments).not.toMatch(/\bguest\b/);
  });

  it("a signed-out request to a guest-gated page redirects without ever surfacing another guest's data", async () => {
    // requireGuest now redirects to /join when req.guest is falsy (issue
    // #241) instead of rendering a card — a redirect response carries no
    // page body at all, so this guarantee holds even more directly than
    // before: there is no rendered content to leak a guest's name/avatar/etc.
    const res = await request(app).get('/tasks');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/join');
    expect(res.text).not.toContain('Signed In Guest');
    expect(res.text).not.toContain('Seed Guest');
  });
});
