// tests/logout.test.js
// Issue #529: POST /logout ends a guest's session so the next person to pick
// up a shared phone isn't acting as the previous guest.
//
// AC1: a signed-in guest who POSTs /logout gets a redirect to /join, and a
//      follow-up request with the resulting cookie jar hits a guest-gated
//      page and is bounced to /join (302), not served as that guest.
// AC3: logging out does not destroy the account — after logout the guest
//      row is unchanged and signing back in via POST /login (contact + PIN)
//      resumes the SAME guest row, points intact.
// AC4: an admin cookie present alongside the guest cookie survives guest
//      logout untouched — only gsid is cleared.
//
// Sign-in/out uses real routes (POST /join, POST /login, POST /logout) per
// the post-#244 convention (tests/*session*, tests/guest-login.test.js) so
// Set-Cookie is asserted against actual response headers, not synthesized.
'use strict';

const request = require('supertest');
const { loadApp, makeAdminAgent } = require('./helpers/testApp');

let app;
let db;

beforeAll(() => {
  const result = loadApp();
  app = result.app;
  db = result.db;
});

function cookiesOf(res) {
  return [].concat(res.headers['set-cookie'] || []);
}

function findCookie(res, name) {
  return cookiesOf(res).find((c) => c.startsWith(name + '='));
}

function getGuestRow(contact) {
  return db.prepare('SELECT * FROM guests WHERE contact = ?').get(contact);
}

describe('AC1: POST /logout ends the guest session', () => {
  it('clears gsid, redirects to /join, and a follow-up request is bounced off a guest-gated page', async () => {
    const agent = request.agent(app);
    const joinRes = await agent
      .post('/join')
      .type('form')
      .send({ name: 'Logout Guest', contact: 'logout-ac1@example.com', pin: '1234' });
    expect(joinRes.status).toBe(302);
    expect(findCookie(joinRes, 'gsid')).toBeTruthy();

    // Confirm the session actually works before logging out — otherwise a
    // false pass on the next assertion could just mean sign-in never worked.
    const home = await agent.get('/');
    expect(home.status).toBe(200);

    const logoutRes = await agent.post('/logout');
    expect(logoutRes.status).toBe(302);
    expect(logoutRes.headers.location).toBe('/join');
    // The clearing Set-Cookie: gsid must carry an in-the-past expiry —
    // res.clearCookie's marker — even though attachGuest's rolling refresh
    // (issue #242) ALSO wrote a fresh gsid Set-Cookie earlier in this same
    // response's middleware chain. Both headers are present; this asserts
    // the expiring one exists among them.
    const logoutCookies = cookiesOf(logoutRes);
    const gsidCookies = logoutCookies.filter((c) => c.startsWith('gsid='));
    expect(gsidCookies.length).toBeGreaterThan(0);
    expect(gsidCookies.some((c) => /Expires=Thu, 01 Jan 1970/.test(c))).toBe(true);

    // The real behavioral assertion (AC1): a follow-up request using the
    // agent's resulting cookie jar — the same jar a real browser would hand
    // back, where the expiring Set-Cookie wins over the earlier refresh —
    // hits a guest-gated page and is redirected to /join, not served.
    const after = await agent.get('/');
    expect(after.status).toBe(302);
    expect(after.headers.location).toBe('/join');
  });
});

describe('AC3: logout does not destroy the account', () => {
  it('the guest row and points survive logout, and POST /login resumes the same guest', async () => {
    const agent = request.agent(app);
    const joinRes = await agent
      .post('/join')
      .type('form')
      .send({ name: 'Persistent Guest', contact: 'logout-ac3@example.com', pin: '5678' });
    expect(joinRes.status).toBe(302);

    const before = getGuestRow('logout-ac3@example.com');
    expect(before).toBeTruthy();
    const guestId = before.id;

    // Give the guest some points so "points intact" is a real observable
    // value, not just "the row still exists". bonus_points is a plain
    // integer column on guests (src/db.js) — set it directly, no need to
    // exercise the whole scoring/submission pipeline for this test.
    db.prepare('UPDATE guests SET bonus_points = 7 WHERE id = ?').run(guestId);

    const logoutRes = await agent.post('/logout');
    expect(logoutRes.status).toBe(302);

    // Row unchanged after logout — same id, same points, still exists.
    const afterLogout = getGuestRow('logout-ac3@example.com');
    expect(afterLogout).toBeTruthy();
    expect(afterLogout.id).toBe(guestId);
    expect(afterLogout.bonus_points).toBe(7);

    // Sign back in via the real re-entry route (contact + PIN) — resumes
    // the SAME row (no duplicate created) and the guest-gated home page is
    // reachable again.
    const totalBefore = db.prepare('SELECT COUNT(*) AS n FROM guests').get().n;
    const loginRes = await agent
      .post('/login')
      .type('form')
      .send({ contact: 'logout-ac3@example.com', pin: '5678' });
    expect(loginRes.status).toBe(302);
    // A guest created via POST /join above never reached GET /how-to-play
    // (issue #564's once-ever onboarding card), so guests.onboarded is still
    // 0 and POST /login's redirect target is /how-to-play, not '/' — this is
    // not a logout-related detail, just the pre-existing new-guest routing
    // this test's setup happens to exercise.
    expect(loginRes.headers.location).toBe('/how-to-play');
    expect(findCookie(loginRes, 'gsid')).toBeTruthy();
    expect(db.prepare('SELECT COUNT(*) AS n FROM guests').get().n).toBe(totalBefore);

    const resumed = getGuestRow('logout-ac3@example.com');
    expect(resumed.id).toBe(guestId);
    expect(resumed.bonus_points).toBe(7);

    const home = await agent.get('/');
    expect(home.status).toBe(200);
    expect(home.text).toContain('Persistent Guest');
  });
});

describe('AC4: admin session is unaffected by guest logout', () => {
  it('only gsid is cleared — the admin cookie and admin-gated access survive', async () => {
    const agent = await makeAdminAgent(app, 'logout-ac4-pw');
    // makeAdminAgent already confirmed the admin cookie is set (POST
    // /admin/login). Layer a guest session onto the SAME agent/cookie jar.
    const joinRes = await agent
      .post('/join')
      .type('form')
      .send({ name: 'Shared Device Guest', contact: 'logout-ac4@example.com', pin: '4321' });
    expect(joinRes.status).toBe(302);
    expect(findCookie(joinRes, 'gsid')).toBeTruthy();

    const logoutRes = await agent.post('/logout');
    expect(logoutRes.status).toBe(302);
    // Guest logout must never emit a Set-Cookie for `admin` — that would be
    // this route reaching into a cookie it does not own.
    expect(findCookie(logoutRes, 'admin')).toBeUndefined();

    // The admin cookie in the jar still works: an admin-gated page is
    // reachable on the same agent right after guest logout.
    const adminPage = await agent.get('/admin');
    expect(adminPage.status).toBe(200);

    // And the guest side is genuinely logged out on that same agent.
    const guestHome = await agent.get('/');
    expect(guestHome.status).toBe(302);
    expect(guestHome.headers.location).toBe('/join');
  });
});

describe('edge cases', () => {
  it('POST /logout with no gsid cookie at all still redirects to /join (idempotent, no throw)', async () => {
    const res = await request(app).post('/logout');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/join');
  });
});
