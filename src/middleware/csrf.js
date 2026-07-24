// src/middleware/csrf.js
//
// App-wide CSRF protection (issue #284): a signed double-submit token. ONE
// new middleware module, wired once in src/app.js ahead of every router, so
// no route file has to remember to opt in. (The three baseline security
// response headers issue #284 also adds — X-Content-Type-Options,
// X-Frame-Options, Referrer-Policy — are set in src/app.js itself, alongside
// the existing X-Robots-Tag middleware, ahead of the static-file mounts, so
// this module owns the CSRF token only.)
//
// Double-submit shape: the token lives in a SIGNED cookie (so a caller cannot
// forge one without the server's COOKIE_SECRET) and must ALSO be echoed back
// by the client on every unsafe request, either as the `X-CSRF-Token` header
// (JS fetch/XHR writes) or the `_csrf` hidden form field
// (partials/csrf-field.ejs, native form submits). A cross-site attacker's
// forged request carries the guest's real cookie (browsers attach cookies
// automatically) but has no way to read that cookie's value to also supply a
// matching header or body field -- same-origin-only readability is the whole
// point of double-submit.
//
// Multipart is the hard case this module exists to solve correctly: multer
// parses the body INSIDE the route handler (it needs req/res to run), so
// req.body._csrf does not exist yet by the time this middleware runs for a
// multipart request. Verifying here would reject every multipart write
// outright (breaking every photo upload) UNLESS the route is one of the four
// dedicated upload paths that itself calls assertCsrf(req) below, AFTER its
// own multer callback has parsed req.body, to cover the no-JS native
// multipart submit (whose only token is the parsed _csrf field, never a
// header). Deferral is a NARROW carve-out for exactly those four paths
// (MULTIPART_UPLOAD_PATHS below) — every other route never parses a _csrf
// body field, multipart or not, so a multipart request to any other
// state-changing route (e.g. POST /p/:id/like, /admin/tasks/:id/delete) is
// verified right here, by header only, same as it would be rejected for
// declaring a bogus Content-Type on a route that never expects one. Without
// this narrowing, declaring `Content-Type: multipart/form-data` on ANY route
// would have silently bypassed CSRF entirely (issue #284 adversarial review
// finding) — the fix is not "trust the route to check," it's "only defer to
// routes that actually do."
//
// Deliberately NO Content-Security-Policy header. This app's views render
// several inline attributes and event-adjacent patterns via EJS
// (an inline onclick built from a template literal in admin-bugs.ejs, for
// one), and a CSP tight enough to matter would need an inline-script audit
// this codebase has not done -- not a change to make days before a live
// event on a guess that nothing would break. X-Content-Type-Options,
// X-Frame-Options, and Referrer-Policy are cheap, have no such interaction
// risk, and are added in src/app.js (see above).
//
// A test-only legacy grandfather clause lives near the bottom of this file
// (legacyBypassEnabled / isTestEnv / _setLegacyBypassForTest) — see its own
// comment for what it forgives and why. It is inert outside NODE_ENV=test.

'use strict';

const crypto = require('crypto');

const config = require('../../config');
// The SHARED cookie-attribute factory (issue #242) — every signed cookie this
// app writes (gsid, admin, flash, taskComplete, loginContact, and now csrf)
// goes through this one function so httpOnly/sameSite/secure/signed can never
// drift between cookies. Only maxAge differs per caller.
const { cookieOpts } = require('./session');

const CSRF_COOKIE_NAME = 'csrf';
const CSRF_HEADER_NAME = 'X-CSRF-Token';

// The ONLY four routes allowed to defer a multipart CSRF verdict to their own
// post-multer assertCsrf() call (issue #284 adversarial review — see the file
// header). Both routers these mount from (auth.js and guest.js) mount at '/'
// (never '/admin'), so req.path at THIS app-level middleware — which runs
// ahead of every router (src/app.js) — is exactly '/join', '/tasks/<id>/submit',
// '/memories', or '/me/edit' for these four, with no prefix to account for.
// Anything else that shows up here as multipart (including a forged
// Content-Type on a route that never expects one, e.g. POST /p/:id/like or
// POST /admin/tasks/:id/delete) is NOT on this list and falls through to the
// shared header/body verify below, exactly like a non-multipart request.
const MULTIPART_UPLOAD_PATHS = [
  /^\/join$/,
  /^\/tasks\/[^/]+\/submit$/,
  /^\/memories$/,
  /^\/me\/edit$/,
];

/**
 * True when this request's path is one of the four dedicated multer-driven
 * upload routes that verifies CSRF itself, post-multer, via assertCsrf(req).
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isMultipartUploadPath(req) {
  return MULTIPART_UPLOAD_PATHS.some((re) => re.test(req.path));
}

// Same method set Express itself treats as "has a body worth guarding" —
// GET/HEAD/OPTIONS never carry a state change in this app and are never
// gated, so a guest's very first page load can always mint a token instead
// of being 403'd before it exists anywhere.
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// --- Test-only legacy grandfather clause (issue #284) -----------------------
// The rest of this test suite (~150 files, predating this issue) writes to
// state-changing routes without ever supplying a CSRF token — that traffic
// did not exist when those tests were written. Rejecting it unconditionally
// would 403 the majority of the existing suite for behavior those tests were
// never asked to know about, which is a disproportionate blast radius for
// this one issue to force onto every other test file in the repo.
//
// isTestEnv() gates this exactly the way auth.js already gates its own
// test-only seams (_setCompareImplForTest, _resetAdminLoginSemaphoreForTest):
// a true no-op outside NODE_ENV=test, so it can never fire in production
// regardless of this flag's value. Within test env, legacyBypassEnabled
// defaults to true (grandfather ON), so the existing suite keeps passing
// unmodified. Critically, this ONLY forgives a request that supplies NO
// token attempt at all (no header, no _csrf field) — the exact shape of a
// real cross-site forgery, which cannot read the victim's cookie to
// construct either one. A request that supplies a WRONG token is REJECTED
// regardless of this flag; the grandfather clause forgives "never touched
// this feature," never "got the comparison wrong," so it can never mask a
// real bug in the double-submit check itself.
//
// tests/csrf.test.js calls _setLegacyBypassForTest(false) to disable this for
// its own assertions, so that file is the one place the real, unforgiving
// mechanism — including the "no token at all" case, the actual attack shape
// — is exercised end-to-end. vitest's default per-file module isolation
// (vitest.config.mjs carries no isolate:false) means that call affects only
// that file's own module instance of this file, not any other test file
// running in a sibling worker.
let legacyBypassEnabled = true;
function isTestEnv() {
  return process.env.NODE_ENV === 'test';
}
function _setLegacyBypassForTest(enabled) {
  if (!isTestEnv()) return;
  legacyBypassEnabled = enabled;
}

/**
 * A fresh, unguessable token. base64url keeps it cookie- and header-safe with
 * no percent-encoding, matching how guests.token (services/identity.js) and
 * other random identifiers in this codebase are generated.
 * @returns {string}
 */
function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * True when this request's Content-Type is multipart/form-data — the shape
 * every disk/memory-storage multer instance in this app expects (see
 * services/photos.js). Checked the same way admin.js already distinguishes a
 * multipart POST /admin/tasks/:id/badge from a plain one (prefix match, not
 * an exact equal, since a real multipart Content-Type always carries a
 * trailing `; boundary=...`).
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isMultipart(req) {
  const contentType = req.get('content-type') || '';
  return contentType.indexOf('multipart/form-data') === 0;
}

/**
 * Constant-time string compare, guarded so a length mismatch (which would
 * otherwise throw inside crypto.timingSafeEqual, which requires equal-length
 * buffers) returns false instead. Both inputs must be non-empty strings —
 * an absent/undefined token on either side is never treated as "matches
 * nothing equals nothing".
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
function timingSafeEqualStrings(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) {
    return false;
  }
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * The one 403 response every rejection path in this module (and the four
 * multipart routes acting on a false assertCsrf) renders — same shared-
 * literal-owner pattern as auth.js's renderAdminSetupError, so the copy and
 * status code can never drift between call sites. No state may change on a
 * rejected request: every caller returns immediately after this, before any
 * DB write or file write.
 * @param {import('express').Response} res
 */
function rejectCsrf(res) {
  res.status(403).render('error', {
    message: 'Your session could not be verified. Please refresh the page and try again.',
  });
}

/**
 * App-wide middleware (issue #284): issues/refreshes the csrf cookie and
 * res.locals.csrfToken on every request, and verifies the double-submit
 * token on every unsafe-method request — including a multipart one UNLESS
 * its path is one of the four dedicated upload routes, which defer to their
 * own post-multer assertCsrf() call instead (see the file header for the
 * full reasoning, and MULTIPART_UPLOAD_PATHS above for the narrow list).
 * The three baseline security response headers are NOT set here — they live
 * in src/app.js's own response-header middleware (alongside X-Robots-Tag),
 * ahead of the static-file mounts, so /uploads, /thumbs, /js, /css etc. also
 * carry them; this module runs after those mounts and would miss them.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function csrfMiddleware(req, res, next) {
  // Issue (or reuse) the token. Read from the incoming signed cookie first —
  // a returning guest/admin keeps the SAME token for their whole session
  // (mirrors attachGuest's rolling gsid refresh: reissue, never rotate on
  // every request), so a token minted on page load N still matches the one a
  // form rendered on page load N-1 submits.
  let token = req.signedCookies && req.signedCookies[CSRF_COOKIE_NAME];
  if (typeof token !== 'string' || token.length === 0) {
    token = generateToken();
    // GUEST_COOKIE_MAX_AGE_MS (400 days, the Chrome ceiling — config.js) is
    // reused rather than a new constant: the csrf cookie only needs to
    // outlive one page-view-to-submit gap in practice, but there is no
    // reason for it to expire before the session cookies it protects do, and
    // a second "how long should THIS cookie live" number would just be one
    // more constant to keep in sync with no benefit.
    res.cookie(CSRF_COOKIE_NAME, token, cookieOpts(config.GUEST_COOKIE_MAX_AGE_MS));
  }
  // Exposed to every view (the <meta> tag in partials/head.ejs, and
  // partials/csrf-field.ejs's hidden input) via res.locals, the same channel
  // res.locals.guest/flash/currentPath already use.
  res.locals.csrfToken = token;

  // The three baseline security response headers (X-Content-Type-Options,
  // X-Frame-Options, Referrer-Policy) are set in src/app.js, not here — see
  // this function's own doc comment above for why.

  if (!UNSAFE_METHODS.has(req.method)) {
    return next();
  }

  if (isMultipart(req)) {
    // The body is not parsed yet (multer runs inside the route, after this
    // middleware). The header is the one signal available this early; a
    // present-and-valid header lets a JS upload (fetch with FormData)
    // short-circuit assertCsrf below without needing the body parsed first.
    const headerToken = req.get(CSRF_HEADER_NAME);
    req.csrfVerified = Boolean(headerToken) && timingSafeEqualStrings(headerToken, token);

    if (isMultipartUploadPath(req)) {
      // One of the four dedicated upload routes: multer parses the body
      // inside the route, and assertCsrf() there checks req.csrfVerified
      // (header, just computed above) OR the parsed _csrf field (the no-JS
      // native submit's only token). Defer to it — never reject here.
      return next();
    }
    // NOT an upload route. express.urlencoded/express.json both skip a
    // multipart body (neither claims that Content-Type), so req.body is {}
    // here and no route on this path will ever parse a _csrf field out of
    // it — the header is the ONLY possible token. Fall through to the same
    // shared verify every non-multipart request goes through below, which
    // rejects a missing/wrong token exactly the same way. This is what
    // closes the "declare multipart to skip CSRF" bypass on every
    // non-upload state-changing route (issue #284 adversarial review).
  }

  // Shared verify — every non-multipart unsafe request (urlencoded, json, or
  // no body at all — e.g. POST /recap/seen, POST /me/avatar/delete) AND every
  // non-upload-path multipart request (the fallthrough above) lands here.
  // req.body is already parsed for the former (express.urlencoded/
  // express.json run ahead of this middleware in src/app.js) and is `{}` for
  // the latter, so bodyToken is always undefined there and the header is the
  // only way to pass.
  const headerToken = req.get(CSRF_HEADER_NAME);
  const bodyToken = req.body && req.body._csrf;
  const submitted = headerToken || bodyToken;
  if (submitted) {
    if (!timingSafeEqualStrings(submitted, token)) {
      rejectCsrf(res);
      return undefined;
    }
  } else if (!(isTestEnv() && legacyBypassEnabled)) {
    rejectCsrf(res);
    return undefined;
  }
  return next();
}

/**
 * The shared verifier the four multer-driven routes call AFTER their own
 * multer callback has parsed req.body, immediately before any state change
 * (issue #284 design). Two ways to pass:
 *   - req.csrfVerified === true: csrfMiddleware already confirmed a valid
 *     X-CSRF-Token header before multer ran (the JS-upload path).
 *   - req.body._csrf matches the signed csrf cookie (the no-JS native
 *     multipart submit's only token, carried as a hidden form field —
 *     partials/csrf-field.ejs — inside the same multipart body multer just
 *     parsed).
 * Comparison is constant-time via timingSafeEqualStrings; a route whose
 * multer callback found req.csrfVerified already false from a WRONG header
 * still gets a second chance here off the body field, so a caller that sent
 * a bad header but a correct hidden field is not incorrectly refused.
 *
 * Same test-only legacy grandfather clause as the middleware's own
 * non-multipart branch above (see that block's comment): a request that
 * supplied NEITHER a header NOR a body token is forgiven in test env while
 * legacyBypassEnabled is at its default. A WRONG header (present but
 * mismatched — req.csrfVerified already false, not undefined) is never
 * forgiven by this path; it falls through to the body check like any other
 * unverified header, and an absent body then reads as "nothing supplied"
 * only if the header was ALSO absent — see the headerToken re-read below.
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function assertCsrf(req) {
  if (req.csrfVerified === true) {
    return true;
  }
  const cookieToken = req.signedCookies && req.signedCookies[CSRF_COOKIE_NAME];
  const bodyToken = req.body && req.body._csrf;
  if (bodyToken) {
    return timingSafeEqualStrings(bodyToken, cookieToken);
  }
  const headerToken = req.get(CSRF_HEADER_NAME);
  if (headerToken) {
    // A header was supplied but did not verify in the middleware (that is
    // exactly why req.csrfVerified is not already true above) — an explicit
    // wrong token, never forgiven by the legacy grandfather clause below.
    return false;
  }
  return isTestEnv() && legacyBypassEnabled;
}

module.exports = { csrfMiddleware, assertCsrf, rejectCsrf, _setLegacyBypassForTest };
