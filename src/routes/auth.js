// src/routes/auth.js
'use strict';

const fs = require('fs');
const express = require('express');
const bcrypt = require('bcryptjs');

const config = require('../../config');
const { db, getGuestByContact } = require('../db');
const { setFlash, cookieOpts } = require('../middleware/session');
const photos = require('../services/photos');
const { normalizeContact, isValidPin, makeUniqueToken } = require('../services/identity');
// scoring.awardProfilePhotoPoint (issue #409) — the one-time "Upload your
// profile photo" starter bonus point, called below after a signup avatar
// actually saves.
const scoring = require('../services/scoring');
// Persistent admin-lockout state (issue #283) — replaces the module-scoped
// failedAttempts/lockedUntil scalars this file used to carry. See
// src/services/lockout.js's own header comment for the full rationale.
const lockout = require('../services/lockout');
// Generic counting semaphore (issue #543) -- bounds concurrent bcrypt
// compares on POST /admin/login below. Imported from src/utils/semaphore.js,
// NOT src/utils/upload-concurrency.js: that module's name and header
// describe only the upload pipeline, and importing it here to guard a login
// would be a plainly wrong dependency for a reader to untangle.
const { Semaphore } = require('../utils/semaphore');
// Route-level rate limiting (issue #283). DISTINCT from
// src/services/rate-limit.js (owns POST /memories and the HEIC-decode
// throttle) — see src/middleware/rate-limit.js's file comment for the
// boundary. joinRateLimiter and loginRateLimiter are separate instances
// (each its own Map) even though both are IP-keyed at the same
// config.RATE_LIMIT_IP_MAX: a signup flood must never also lock a returning
// guest out of POST /login from the same venue-NAT IP, and vice versa.
const { createRateLimiter } = require('../middleware/rate-limit');

const router = express.Router();

const joinRateLimiter = createRateLimiter({
  windowMs: () => config.RATE_LIMIT_WINDOW_MS,
  max: () => config.RATE_LIMIT_IP_MAX,
  keyFn: (req) => 'ip:' + req.ip,
});
const loginRateLimiter = createRateLimiter({
  windowMs: () => config.RATE_LIMIT_WINDOW_MS,
  max: () => config.RATE_LIMIT_IP_MAX,
  keyFn: (req) => 'ip:' + req.ip,
});

/**
 * Stash the just-typed contact for 30 seconds (same lifetime as setFlash's
 * one-shot cookie) so GET /login can prefill its contact field right after
 * POST /join's duplicate-signup redirect. Signed + httpOnly, same as every
 * other cookie this app writes.
 */
function stashLoginContact(res, contactValue) {
  res.cookie('loginContact', contactValue, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.COOKIE_SECURE,
    signed: true,
    path: '/',
    maxAge: 30 * 1000,
  });
}

/**
 * Save the avatar buffer via the photos service. Returns the relative
 * filename to store in guests.avatar_path, or null if no file was uploaded.
 */
async function trySaveAvatar(file, guestId) {
  if (!file || !file.buffer || file.buffer.length === 0) {
    return null;
  }
  // photos.saveAvatar(buffer, guestId) is ASYNC (sharp returns a Promise). It
  // writes the avatar file, sets guests.avatar_path, and resolves to the
  // relative filename. Await it.
  return await photos.saveAvatar(file.buffer, guestId);
}

// --- Retired guest link (issue #244) -----------------------------------------

// GET /j/:token  — the old per-guest private link. Retired: the shared poster
// (GET /admin/poster) now sends every guest to /join instead of a personal
// token URL. This route intentionally does NOT look the token up in the
// database and never signs anyone in — a token value found on an old
// printed place-card, valid or not, must never establish a session, so an old
// card kept as a keepsake can't quietly still let someone in.
router.get('/j/:token', (req, res) => {
  res.redirect('/join');
});

// --- Self-serve signup (shared entry link, issue #240) ----------------------
//
// Every guest gets the SAME link (QR poster / email / place card) pointing at
// GET /join, instead of a private per-guest /j/:token link. Signup IS
// onboarding here — there is no separate "create the account" step followed
// by a name/avatar form; one POST does both, matching #241's re-entry
// counterpart (log back in with contact + PIN on any device).

// GET /join — show the signup form. A visitor who already has a valid guest
// session (attachGuest ran before this router and set req.guest) is bounced
// home so re-scanning the shared poster never dead-ends them on a form they
// do not need.
router.get('/join', (req, res) => {
  if (req.guest) {
    res.redirect('/');
    return;
  }
  res.render('join', { title: 'Join the Fun' });
});

// POST /join — create a playing guest from name + contact + self-chosen PIN,
// with an optional avatar, and sign them in immediately.
//
// photos.uploadAvatar is invoked with an explicit callback (same pattern as
// POST /onboard above) so a fileFilter/size rejection or a sharp-undecodable
// image never falls through to the global 500 handler or crashes the process
// (Express 4 does not catch async-handler rejections; issue #187).
router.post('/join', joinRateLimiter, (req, res, next) => {
  photos.uploadAvatar(req, res, async (err) => {
    try {
      const name = ((req.body && req.body.name) || '').trim();

      // A rejected avatar (bad type / too large) is not itself a reason to
      // block signup — the guest is not mid-onboarding here, they are trying
      // to get in the door for the first time. Drop the avatar and continue;
      // they can add one later from their profile.
      const avatarRejected = Boolean(err);

      if (!name) {
        setFlash(res, 'error', 'Please enter your name.');
        res.redirect('/join');
        return;
      }

      const contact = normalizeContact(req.body && req.body.contact);
      if (!contact) {
        setFlash(res, 'error', 'Please enter a valid email or phone number.');
        res.redirect('/join');
        return;
      }

      if (!isValidPin(req.body && req.body.pin)) {
        setFlash(res, 'error', 'Please choose a 4-digit PIN (numbers only).');
        res.redirect('/join');
        return;
      }

      // Duplicate check: one guest per normalized contact. Route them to
      // re-entry instead of silently creating a second account.
      const existing = getGuestByContact(contact.value);
      if (existing) {
        setFlash(res, 'error', 'Looks like you already signed up — enter your PIN to get back in.');
        // Stash the contact they just typed so GET /login (below) can
        // prefill the field — they should not have to retype it. A one-shot
        // signed cookie, not a query parameter: a query parameter would
        // leave the contact sitting in the URL/browser history.
        stashLoginContact(res, contact.value);
        res.redirect('/login');
        return;
      }

      // onboarded is deliberately NOT set here (issue #564) — it takes the
      // guests.onboarded schema default of 0, so this new guest is shown the
      // how-to-play rules once via the redirect below. GET /how-to-play
      // (src/routes/guest.js) is the only writer that ever flips it to 1, and
      // only on that page's actual render.
      const token = makeUniqueToken();
      const info = db
        .prepare(
          `INSERT INTO guests (token, name, contact, contact_type, pin)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(token, name, contact.value, contact.type, req.body.pin);
      const guestId = info.lastInsertRowid;

      if (!avatarRejected) {
        try {
          const avatarPath = await trySaveAvatar(req.file, guestId);
          // Issue #409: award the one-time starter point the moment an
          // avatar actually saves (trySaveAvatar returns null when no file
          // was attached — AC3, no award for a name/PIN-only signup).
          if (avatarPath) {
            scoring.awardProfilePhotoPoint(guestId);
          }
        } catch {
          // sharp could not decode the bytes (corrupt or mislabelled image).
          // The guest account is already created — do not block signup on a
          // bad photo; they can add one later from their profile.
        }
      }

      res.cookie('gsid', token, cookieOpts(config.GUEST_COOKIE_MAX_AGE_MS));
      // Issue #564: every fresh signup has onboarded = 0 (see the INSERT
      // above), so a brand-new guest always lands on the rules card first,
      // not the home page — this is the "shown once, right after joining"
      // half of the once-ever contract (AC1).
      res.redirect('/how-to-play');
    } catch (e) {
      // Anything unexpected in this async callback (e.g. a DB write failure)
      // must not become an unhandled rejection that kills the process —
      // route it to the global error handler (500 page, server stays up).
      next(e);
    }
  });
});

// --- Re-entry / login (issue #241) -------------------------------------------
//
// The signup counterpart at GET/POST /join: a guest who already has an
// account gets back in on ANY device with the same contact + 4-digit PIN
// they chose at signup, instead of needing their original private link.

const LOGIN_TITLE = 'Log In';
const LOGIN_FAIL_MESSAGE = "That contact and code don't match.";

// Per-normalized-contact lockout state. Unlike the admin flow (where a
// correct password always wins, even mid-lockout, since only wrong
// passwords are throttled — issue #49), a guest's credential is a 4-digit PIN
// with only 10,000 possible values, so if the correct PIN always bypassed an
// active lockout the throttle would not actually slow a brute-force script —
// it would just wait out whatever counter and try again. AC4 requires the
// lockout to block EVEN the correct PIN until the window elapses, so here the
// lockout check runs before the credential check (the opposite order from
// admin/login).
//
// Merged (issue #464, absorbed into #283) into ONE Map keyed by
// contact.value -> { fails, lastFailAt, lockedUntil }, replacing the earlier
// two separate Maps (guestFailedAttempts / guestLockedUntil) — same
// information, one lookup instead of two, and one place to apply the bound
// below. Bounded two ways so a flood of distinct made-up contacts cannot
// grow this forever:
//   - sweep-on-write: any entry whose lockout has expired AND whose last
//     failure predates config.GUEST_LOGIN_LOCKOUT_MS is dropped the next
//     time a NEW contact fails (no setInterval — see
//     src/middleware/rate-limit.js's file comment for why this app never
//     uses timers for memory hygiene).
//   - hard cap: config.GUEST_LOGIN_TRACKED_MAX, enforced on every new-contact
//     insert (see evictOneGuestEntry below) so the map's size never exceeds
//     it. The victim is the OLDEST entry that is NOT currently locked, so a
//     locked contact is never evicted while any cheaper victim exists — AC8's
//     "a locked entry is never evicted before its lockout expires", and why
//     an ordinary flood of fresh contacts cannot un-lock anyone.
//     ONE degenerate case is called out honestly rather than papered over:
//     when EVERY tracked entry is currently locked, there is no unlocked
//     victim, and the cap can only hold by evicting the soonest-EXPIRING
//     lockout (the entry nearest to lapsing on its own anyway). Reaching that
//     state costs an attacker GUEST_LOGIN_TRACKED_MAX x
//     GUEST_LOGIN_MAX_ATTEMPTS failed logins (25,000 at the shipped defaults)
//     against the IP-keyed POST /login limiter, and buys only the tail end of
//     one already-expiring lockout. The alternative — refusing to track the
//     new contact — would leave that contact unlockable-out entirely, a
//     strictly worse trade; letting the map grow without limit, which is what
//     this code did before, is worse still.
const guestLockoutState = new Map();

function sweepExpiredGuestLockouts(now) {
  for (const [key, entry] of guestLockoutState) {
    const notLocked = now >= entry.lockedUntil;
    const stale = now - entry.lastFailAt > config.GUEST_LOGIN_LOCKOUT_MS;
    if (notLocked && stale) {
      guestLockoutState.delete(key);
    }
  }
}

/**
 * Free exactly one slot, preferring the least costly victim.
 *
 * Two-tier, and the second tier is what makes the cap a real bound rather
 * than a suggestion: an UNLOCKED entry (oldest last-failure first) is always
 * taken when one exists, so a locked contact is never evicted while a
 * cheaper victim is available. Only when EVERY tracked entry is locked — no
 * unlocked victim exists at all — does this fall back to evicting the
 * soonest-EXPIRING lockout, i.e. the one closest to lapsing on its own
 * anyway. Without that fallback the caller would insert unconditionally and
 * the map would grow past the cap without limit inside one window, which is
 * the exact unbounded-growth failure this cap exists to stop.
 *
 * @param {number} now
 * @returns {boolean} true if an entry was evicted.
 */
function evictOneGuestEntry(now) {
  let unlockedKey = null;
  let oldestFailAt = Infinity;
  let lockedKey = null;
  let soonestLockedUntil = Infinity;

  for (const [key, entry] of guestLockoutState) {
    if (now < entry.lockedUntil) {
      // Locked: only a fallback candidate, and only the soonest to expire.
      if (entry.lockedUntil < soonestLockedUntil) {
        soonestLockedUntil = entry.lockedUntil;
        lockedKey = key;
      }
      continue;
    }
    if (entry.lastFailAt < oldestFailAt) {
      oldestFailAt = entry.lastFailAt;
      unlockedKey = key;
    }
  }

  const victim = unlockedKey !== null ? unlockedKey : lockedKey;
  if (victim === null) return false;
  guestLockoutState.delete(victim);
  return true;
}

/**
 * Record one failed guest-login attempt (wrong PIN, or an unknown contact —
 * see the existence-oracle note on POST /login below) for `contactValue`,
 * engaging a new lockout once config.GUEST_LOGIN_MAX_ATTEMPTS is reached —
 * the same threshold behavior the pre-#464 two-Map version implemented.
 * Sweeps stale entries and enforces config.GUEST_LOGIN_TRACKED_MAX on every
 * NEW contact; an existing contact's repeat failure only updates its own
 * entry, so it can never grow the map.
 * @param {string} contactValue
 * @param {number} [now=Date.now()] - injectable clock for deterministic tests.
 */
function recordGuestLoginFailure(contactValue, now = Date.now()) {
  const existing = guestLockoutState.get(contactValue);
  if (!existing) {
    sweepExpiredGuestLockouts(now);
    // Evict until this insert cannot push the map past the cap. A loop, not a
    // single eviction: config.GUEST_LOGIN_TRACKED_MAX is read fresh here, so
    // a lowered value (a test, or an operator restart) must be converged on
    // rather than approached one entry per request. evictOneGuestEntry
    // returning false means the map is empty, which terminates the loop.
    while (guestLockoutState.size >= config.GUEST_LOGIN_TRACKED_MAX) {
      if (!evictOneGuestEntry(now)) break;
    }
  }

  const fails = (existing ? existing.fails : 0) + 1;
  if (fails >= config.GUEST_LOGIN_MAX_ATTEMPTS) {
    guestLockoutState.set(contactValue, {
      fails: 0,
      lastFailAt: now,
      lockedUntil: now + config.GUEST_LOGIN_LOCKOUT_MS,
    });
  } else {
    const lockedUntil = existing ? existing.lockedUntil : 0;
    guestLockoutState.set(contactValue, { fails, lastFailAt: now, lockedUntil });
  }
}

// GET /login — show the re-entry form. A visitor who already has a valid
// guest session is bounced home, same as GET /join. Prefills the contact
// field from the one-shot `loginContact` cookie stashed by POST /join's
// duplicate-signup redirect above, if present.
router.get('/login', (req, res) => {
  if (req.guest) {
    res.redirect('/');
    return;
  }
  const rawContact = req.signedCookies && req.signedCookies.loginContact;
  const contact = typeof rawContact === 'string' ? rawContact : '';
  if (contact) {
    res.clearCookie('loginContact', { path: '/' });
  }
  res.render('login', { title: LOGIN_TITLE, contact: contact, error: null });
});

// POST /login — contact + 4-digit PIN re-entry.
//
// One shared failure message for both an unknown contact and a wrong PIN
// (AC2/AC3) — anything else would let a visitor learn whether a given
// contact is registered just from the response, an account-existence oracle.
// For the same reason, the per-contact throttle below counts an
// unknown-contact attempt too: if only real accounts were throttled, hitting
// the lockout message would itself reveal the contact exists.
router.post('/login', loginRateLimiter, (req, res) => {
  const contact = normalizeContact(req.body && req.body.contact);
  const rawContact = (req.body && req.body.contact) || '';
  const submittedPin = req.body && req.body.pin;

  // A contact that does not even parse to a normalized key has nothing to
  // throttle against — fail closed with the same shared message, no counter
  // touched (AC: missing/invalid contact -> shared "don't match" failure).
  if (!contact) {
    res.status(401).render('login', {
      title: LOGIN_TITLE,
      contact: rawContact,
      error: LOGIN_FAIL_MESSAGE,
    });
    return;
  }

  const key = contact.value;
  const now = Date.now();
  const existingEntry = guestLockoutState.get(key);
  const lockedUntil = existingEntry ? existingEntry.lockedUntil : 0;

  if (now < lockedUntil) {
    res.status(429).render('login', {
      title: LOGIN_TITLE,
      contact: rawContact,
      error: 'Too many attempts. Try again in a few minutes.',
    });
    return;
  }

  const guest = getGuestByContact(key);
  // guest.pin can be null/empty for an older admin-created guest that never
  // set one (issue #239) — that must never match a submitted PIN, hence the
  // explicit non-empty-string check before the equality compare.
  const pinOk =
    Boolean(guest) &&
    typeof guest.pin === 'string' &&
    guest.pin.length > 0 &&
    typeof submittedPin === 'string' &&
    guest.pin === submittedPin;

  if (pinOk) {
    guestLockoutState.delete(key);
    res.cookie('gsid', guest.token, cookieOpts(config.GUEST_COOKIE_MAX_AGE_MS));
    // Issue #564: the "shown once, right after joining OR the rare re-entry
    // that never saw it" half of the once-ever contract (AC3/AC4). `guest`
    // is already the row getGuestByContact(key) loaded above for the pinOk
    // check — no second lookup needed to read its onboarded column. Every
    // existing guest at ship time already has onboarded = 1 (it was
    // hardcoded at signup before this issue), so this branch is a live path
    // only for a guest who signed up after this change and lost their
    // session before ever reaching /how-to-play.
    res.redirect(guest.onboarded ? '/' : '/how-to-play');
    return;
  }

  // Wrong PIN, or no guest at all for this contact — count toward the
  // per-contact throttle either way (see the existence-oracle note above).
  recordGuestLoginFailure(key, now);

  res.status(401).render('login', {
    title: LOGIN_TITLE,
    contact: rawContact,
    error: LOGIN_FAIL_MESSAGE,
  });
});

// --- Test-only seam (issue #283 AC7/AC8) -------------------------------------
// The guest-login lockout Map above is module-scoped in this routes file (the
// issue's plan keeps it here rather than extracting a separate service), so
// these hooks are attached directly to the exported router — not used by any
// route. `_guestLockoutTrackedCount` exposes the Map's current size;
// `_recordGuestLoginFailureForTest` drives the SAME internal
// sweep/cap/lockout logic POST /login itself calls, parameterized by an
// injectable `now` so a test can assert the stale-sweep (AC7) and bounded-cap
// (AC8) behavior deterministically instead of sleeping in real time.
router._guestLockoutTrackedCount = () => guestLockoutState.size;
router._recordGuestLoginFailureForTest = (contactValue, now) =>
  recordGuestLoginFailure(contactValue, now);
// Raw entry accessor (a shallow copy) so a test can assert a specific
// contact's exact { fails, lastFailAt, lockedUntil } — e.g. confirming a
// locked contact survived a cap-eviction flood with its lockedUntil intact,
// not just that the map's overall size stayed bounded.
router._guestLockoutEntryForTest = (contactValue) => {
  const entry = guestLockoutState.get(contactValue);
  return entry ? { ...entry } : undefined;
};

// --- Retired onboarding step (issue #244) -------------------------------------
//
// /onboard used to be the separate first-run form (name/avatar/socials) a
// guest hit right after their private /j/:token link signed them in. Signup
// at /join now collects name + avatar in the same POST that creates the
// account (#240), so there is nothing left for a standalone onboarding step
// to do — both verbs just send a visitor on to /join.
//
// Issue #409 note: this route is dead (redirect only), so the "award the
// profile-photo starter point at onboarding" hook lives on POST /join above
// (the actual signup-time saveAvatar call site) instead of here.
router.get('/onboard', (req, res) => {
  res.redirect('/join');
});

router.post('/onboard', (req, res) => {
  res.redirect('/join');
});

// --- Admin login / logout ---------------------------------------------------

// Lockout state persists to SQLite via src/services/lockout.js (issue #283),
// replacing the module-scoped failedAttempts/lockedUntil scalars this file
// used to carry — a single-admin app still warrants one global counter (no
// per-IP tracking needed, see issue #37), but that counter must now survive a
// process restart (AC5). See lockout.js's own header comment for why.

const ADMIN_LOGIN_TITLE = 'Admin Login';

// Module-level singleton (issue #543), same pattern as
// src/utils/upload-concurrency.js's uploadSemaphore -- the limit only means
// something if every POST /admin/login request shares one counter, not a
// fresh one per request. Sized from config so an operator can retune
// ADMIN_LOGIN_MAX_CONCURRENT_COMPARES per event/host without a code change.
// `let`, not `const`: see _resetAdminLoginSemaphoreForTest below.
let adminLoginSemaphore = new Semaphore(config.ADMIN_LOGIN_MAX_CONCURRENT_COMPARES);

// Every _*ForTest seam below is gated on NODE_ENV === 'test' (which vitest
// sets by default, see tests/cookie-secure.test.js's own comment) and is
// INERT -- a true no-op, not a throw -- everywhere else. These are
// module-internal today (nothing over HTTP can reach a require()'d router's
// own properties), but router._setCompareImplForTest below can authenticate
// every password (`_setCompareImplForTest(() => true)`), in the module that
// mints the admin cookie, on a host public for weeks pre-event -- gating it
// closes that off as defense-in-depth even though it is not a live hole
// today, rather than relying solely on "nothing reaches it" staying true.
const isTestEnv = () => process.env.NODE_ENV === 'test';

// Test-only seam: replaces the semaphore with a fresh instance. Needed
// because it is module-level singleton state that outlives any one test —
// a test that fails or times out with an unsettled fake compare still holding
// a slot would otherwise leak that slot into every later test in the file
// (including this file's own vitest.config.mjs `retry: 2` re-attempts of the
// SAME test), permanently starving the gate. Real production traffic has no
// equivalent reset; this exists purely to give each test a clean gate.
router._resetAdminLoginSemaphoreForTest = () => {
  if (!isTestEnv()) return;
  adminLoginSemaphore = new Semaphore(config.ADMIN_LOGIN_MAX_CONCURRENT_COMPARES);
};

// Test-only seam (issue #543 AC1-AC4): the real compare (bcrypt.compare,
// cost 10-12) is too slow to drive 50 concurrent requests through
// deterministically in a unit test, and its settle timing can't be
// controlled from outside. Production always calls the real bcrypt.compare;
// only a test with access to this router's internals can swap it out.
const defaultCompare = (password, hash) => bcrypt.compare(password, hash);
let compareImpl = defaultCompare;
router._setCompareImplForTest = (fn) => {
  if (!isTestEnv()) return;
  compareImpl = fn || defaultCompare;
};
// Exposes the live semaphore instance so a test can assert queue length /
// active count directly (e.g. AC4's "the gate's queue length ... returns to
// 0"). Returns undefined outside a test environment rather than handing out
// a live reference a caller could acquire()/release() against directly.
router._adminLoginSemaphoreForTest = () => (isTestEnv() ? adminLoginSemaphore : undefined);

/**
 * Run `fn` inside the admin-login CPU-bound gate (issue #543): acquire a
 * slot from adminLoginSemaphore, run `fn`, and always release the slot
 * afterward. Mirrors src/utils/upload-concurrency.js's withUploadSlot(fn) --
 * the same acquire/try/finally-owning idiom -- extended with the one thing
 * withUploadSlot doesn't need: a cancellable wait, because an admin-login
 * waiter can queue behind an unauthenticated flood and its client can
 * disconnect before ever reaching the front (AC4).
 *
 * A QUEUED waiter holds no slot yet -- dropping it from the queue on
 * disconnect (the catch below) is a different action from releasing an
 * already-held slot (the finally below, which runs regardless of
 * disconnect). The abort listener inside Semaphore.acquire is removed the
 * instant a slot is granted, so 'close' firing again after a normal
 * response (it always does) is a no-op here, never a double-release.
 *
 * Listens on `res` ('close'), not `req`: req's readable stream is already
 * fully drained by the time this runs (the global urlencoded body parser
 * reads the whole body before calling next()), and on this Node runtime
 * req's own 'close' fires the instant that read finishes -- i.e.
 * immediately, for every request, not on an actual disconnect. Verified
 * empirically while building this gate: wiring req.on('close') aborted
 * every queued waiter within the same tick it queued, which would make this
 * gate cancel-only and never actually bound anything. res's 'close' fires
 * only when the underlying connection ends, whether that is a normal
 * post-response cleanup (harmless no-op here, per the paragraph above) or a
 * genuine premature disconnect (AC4).
 *
 * Returns a discriminated result object rather than unioning "the compare's
 * answer" with "no compare happened" into one truthy-capable channel (a
 * cancellation sentinel would sit only a `===` check away from a `boolean`
 * in the same slot, one call site away from a truthy sentinel accidentally
 * minting the admin cookie). `cancelled` must be checked first; `ok` is
 * only meaningful when `cancelled` is false.
 *
 * @template T
 * @param {import('express').Response} res
 * @param {() => Promise<T>} fn
 * @returns {Promise<{ cancelled: true } | { cancelled: false, ok: T }>}
 */
async function withCompareSlot(res, fn) {
  // Captured once so a mid-flight _resetAdminLoginSemaphoreForTest cannot
  // acquire against one Semaphore instance and release against another --
  // acquire and release below always agree on which instance they mean.
  const sem = adminLoginSemaphore;
  const controller = new AbortController();
  const onClose = () => controller.abort();
  res.on('close', onClose);

  try {
    await sem.acquire({ signal: controller.signal });
  } catch (err) {
    // Semaphore.acquire's JSDoc describes cancellation via AbortSignal but
    // never promises abort is the ONLY rejection reason -- checking
    // controller.signal.aborted here, rather than assuming every rejection
    // is a disconnect, is what keeps that promise from being silently
    // load-bearing. A genuine abort (the client is already gone) has no
    // response to send and no slot to release (acquire() never granted
    // one); AC4: this must never consume a compare.
    res.removeListener('close', onClose);
    if (controller.signal.aborted) {
      return { cancelled: true };
    }
    // Some other rejection reason: rethrow so the caller's catch (around
    // withCompareSlot, in POST /admin/login below) renders a 500 instead of
    // this request hanging with no response ever sent.
    throw err;
  }

  try {
    const ok = await fn();
    return { cancelled: false, ok };
  } finally {
    // Release regardless of throw (a corrupt/unreadable admin.hash reaching
    // compareImpl despite the caller's readFileSync guard would otherwise
    // leak the slot forever) or of the client having disconnected
    // mid-compare (that request already holds its slot; only a QUEUED wait
    // is cancellable).
    sem.release();
    res.removeListener('close', onClose);
  }
}

/**
 * Render the same generic 500 admin-login page for both ways this route can
 * fail to reach a real yes/no answer: an unreadable/missing admin.hash (the
 * readFileSync guard below) and a readable-but-corrupt hash that makes
 * compareImpl's bcrypt.compare REJECT instead of resolving false (issue
 * #543 tightening — three independent reviewers demonstrated a corrupt
 * 60-char hash makes bcryptjs throw "Illegal salt length", and since the
 * route handler is async, Express 4 does not route that rejection to
 * next(err) — see :113-118 — so without this catch the request hangs
 * forever instead of ever reaching this render). One render, two callers,
 * so the copy and status code have a single owner instead of drifting
 * between call sites. Never leaks `err` into the response — an admin.hash
 * failure of any kind, unreadable or corrupt, gets the same host-facing
 * "not set up yet" copy, not the underlying exception.
 */
function renderAdminSetupError(res) {
  res.status(500).render('admin-login', {
    title: ADMIN_LOGIN_TITLE,
    error: 'The admin area is not set up yet. Please ask the host to finish setup.',
  });
}

// GET /admin/login — show the password form.
router.get('/admin/login', (req, res) => {
  res.render('admin-login', { title: ADMIN_LOGIN_TITLE, error: null });
});

// POST /admin/login — check password against the bcrypt hash on disk.
// Note: app.js (section 01) already parses urlencoded bodies globally, so we
// do NOT add an inline body parser here — req.body.password is already populated.
//
// Security note (issue #49): the password is evaluated BEFORE the lockout check.
// A correct password always authenticates and clears the failure counter, so the
// real admin cannot be locked out by others' failed attempts. Only wrong passwords
// increment the counter and are throttled.
//
// CPU-bound gate (issue #543): every caller here is unauthenticated by
// construction (this route is what MINTS the admin cookie -- nothing before
// the compare can tell the admin apart from an attacker, and DESIGN.md's "No
// limiter on POST /admin/login" note records that IP doesn't separate them
// either, since admin and attacker can share one venue-NAT IP). That is why
// this is a CONCURRENCY gate, not a rate limiter: it wraps the compare below
// in adminLoginSemaphore so at most ADMIN_LOGIN_MAX_CONCURRENT_COMPARES run
// at once, but it never refuses an ARRIVING request -- an over-limit caller
// queues (uncapped depth) and is still answered, so the real admin's correct
// password is never turned away even deep in a flood (AC2). The only
// deliberate refusal is a QUEUED waiter whose client has already
// disconnected (res.on('close') inside withCompareSlot, above): that caller
// cannot be "refused" because there is no one left to answer, so dropping it
// from the queue bounds queue depth by live connections at no cost to AC2.
// This gate is not a rate limiter; it addresses event-loop share, a
// distinct exposure the lockout does not bound (a fully locked-out
// attacker still forces a complete bcrypt compare on every request).
router.post('/admin/login', async (req, res) => {
  // A non-string password (e.g. a duplicated `password=a&password=b` field,
  // which express.urlencoded({ extended: false })'s underlying querystring
  // parser turns into the ARRAY ["a", "b"]) is truthy and survives a bare
  // `|| ''`. bcrypt.compare then rejects with "Illegal arguments: object,
  // string" -- and since this handler is async, Express 4 does not route
  // that rejection to next(err) (see :113-118 above), so no response is
  // ever sent and the socket pins forever. Coercing anything non-string to
  // '' here turns that case into an ordinary wrong password (401) instead.
  const password = typeof req.body.password === 'string' ? req.body.password : '';

  let hash;
  try {
    hash = fs.readFileSync(config.ADMIN_HASH_PATH, 'utf8').trim();
  } catch (err) {
    renderAdminSetupError(res);
    return;
  }

  // withCompareSlot (above) owns the whole acquire/cancel/release lifecycle
  // for the CPU-bound gate (issue #543) -- see its own comment for the
  // res-vs-req 'close' rationale and the queued-vs-held-slot distinction.
  //
  // Tightening (three independent reviewers): withCompareSlot's inner try
  // has a finally but deliberately no catch (it needs to release the slot
  // on either outcome, then let a compareImpl rejection propagate) -- but
  // that means a REJECTION (e.g. bcryptjs throwing on a readable-but-corrupt
  // admin.hash the readFileSync guard above can't detect, since it only
  // catches an unreadable file, not a corrupt one) would otherwise escape
  // this async handler uncaught. Express 4 does not route an async handler's
  // rejection to next(err) (see :113-118 above), so without this try/catch
  // the request hangs forever instead of ever getting a response. Same
  // failure class as the non-string-password fix a few lines up, one line
  // away, in this same handler.
  let result;
  try {
    result = await withCompareSlot(res, () => compareImpl(password, hash));
  } catch (err) {
    renderAdminSetupError(res);
    return;
  }
  if (result.cancelled) return;

  if (result.ok) {
    // Correct password — clear any active lockout and authenticate (issue
    // #49: this branch runs regardless of lockout state; a correct password
    // always wins).
    lockout.clear();
    res.cookie('admin', '1', cookieOpts(config.ADMIN_COOKIE_MAX_AGE_MS));
    // Lands on the admin dashboard, mounted at /admin.
    res.redirect('/admin');
    return;
  }

  // Wrong password — check lockout window first, then record the failure.
  const { lockedUntil } = lockout.getState();
  if (Date.now() < lockedUntil) {
    res.status(429).render('admin-login', {
      title: ADMIN_LOGIN_TITLE,
      error: 'Too many failed attempts. Please wait before trying again.',
    });
    return;
  }

  lockout.recordFailure();
  res.status(401).render('admin-login', {
    title: ADMIN_LOGIN_TITLE,
    error: 'Incorrect password. Please try again.',
  });
});

// POST /admin/logout — clear the admin cookie.
router.post('/admin/logout', (req, res) => {
  res.clearCookie('admin', { path: '/' });
  res.redirect('/admin/login');
});

module.exports = router;
