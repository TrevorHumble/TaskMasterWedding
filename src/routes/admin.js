// src/routes/admin.js
// Admin router. Every route here is behind requireAdmin (applied below).
// Routes:
//   GET  /admin                          dashboard
//   GET  /admin/guests                   guests table
//   POST /admin/guests/:id/edit          rename a guest / set gallery pin
//   POST /admin/guests/:id/delete        delete a guest (cascades submissions/badges; deletes photo files)
//   POST /admin/guests/:id/points        award bonus points (scoring.addBonusPoints)
//   POST /admin/guests/:id/badge         award OR remove a special badge
//   GET  /admin/poster                   the single shared entry-link poster (issue #244)
//   GET  /admin/config                   event timezone + wedding dates (issue #681)
//   POST /admin/config                   save event timezone + wedding dates (issue #681)
//   GET  /admin/tasks                    task list + add form
//   POST /admin/tasks                    create a task (3-step wizard: title/
//                                         description/worth/special_mode/
//                                         REQUIRED badge — issue #682)
//   POST /admin/tasks/:id/edit           edit a task's title/description/
//                                         worth/badge/special_mode together
//                                         (issue #682)
//   POST /admin/tasks/:id/badge          set a task's badge name/art
//   POST /admin/tasks/:id/delete         delete a task (cascades submissions)
//   POST /admin/tasks/:id/active         toggle special_mode (none/hidden)
//   POST /admin/tasks/reorder-all        persist a full drag-reordered
//                                         task-id list (issue #682; does NOT
//                                         call recompute — pure reorder never
//                                         changes the active-task set). The
//                                         old neighbor-swap POST /admin/tasks/
//                                         reorder (up/down/top) was REMOVED —
//                                         the redesign deleted its up/down/top
//                                         UI and its sort_order semantics
//                                         diverged from this route's 0..n-1
//                                         regime.
//   GET  /admin/photos                   guest-gallery-parity photo wall (issue #259);
//                                         each photo carries its real comment thread,
//                                         hidden comments included (issue #684)
//   POST /admin/photos/:id/takedown      hide a photo + recompute auto-badges (kebab menu, #684)
//   POST /admin/photos/:id/restore       unhide a photo + recompute auto-badges
//   POST /admin/photos/:id/points        RETIRED (issue #684) -> 404 (renderNotFound)
//   POST /admin/photos/:id/favorite      toggle the host-scoped favorite flag (issue #259)
//   POST /admin/photos/:id/badge         award/remove a photo as a give-a-badge winner
//                                         (issue #259; award-only, no moderation — #684)
//   GET  /admin/comments                 RETIRED (issue #684) -> 404 (renderNotFound)
//   POST /admin/comments/:id/hide        hide a comment (redirects to its photo's feed card, #684)
//   POST /admin/comments/:id/restore     unhide a comment (redirects to its photo's feed card, #684)
//   GET  /admin/bugs                     bug report queue (unresolved, then resolved)
//   POST /admin/bugs/:id/resolve         mark a bug report resolved
//   GET  /admin/export                   defined in 09-export (see ADD-THIS there)
//
// NOTE: GET/POST /admin/login and POST /admin/logout live in 03-auth (routes/auth.js).
//       Do NOT define them here.

const express = require('express');

const config = require('../../config');
const { db, getGuestByContact, getEventConfig, setEventConfig } = require('../db');
const { requireAdmin } = require('../middleware/session');
const qr = require('../services/qr');
const scoring = require('../services/scoring');
const photos = require('../services/photos');
const taskBadges = require('../services/task-badges');
// The one active-task owner (issue #727) — every liveness check/write below
// consults tasks.liveTaskWhere()/isTaskLive()/MODE_NONE/MODE_HIDDEN instead of
// a hand-written is_active/special_mode literal.
const tasks = require('../services/tasks');
const badgeIcons = require('../services/badge-icons');
const favoritesSvc = require('../services/favorites');
const photoBadges = require('../services/photo-badges');
const feed = require('../services/feed');
const { streamExportZip } = require('../services/export');
const { normalizeContact, isValidPin } = require('../services/identity');
const { relativeTime } = require('../services/relative-time');
const {
  timezoneOptions,
  isKnownTimezone,
  resolveSelectedZone,
  eventDays: computeEventDays,
  singleDayLabel,
} = require('../services/event-days');

const router = express.Router();

// Guard the whole router. Section 03's requireAdmin redirects to /admin/login
// when the signed admin cookie is not "1".
router.use(requireAdmin);

// Mark every admin page as an admin context so partials/header.ejs renders the
// ADMIN nav (Dashboard/Tasks/Guests/Photos/Poster/Log out) and the logout
// button, instead of the GUEST nav. Set once here so no individual res.render
// has to remember to pass isAdmin.
router.use((req, res, next) => {
  res.locals.isAdmin = true;
  next();
});

// ---------------------------------------------------------------------------
// Small local helpers
// ---------------------------------------------------------------------------

// Build a redirect target with a human message in the ?msg= query. An
// optional anchor lands the admin back at the element they acted on
// (fragment goes after the query, per URL syntax).
function redirectWithMsg(res, path, msg, anchor) {
  const sep = path.indexOf('?') === -1 ? '?' : '&';
  const hash = anchor ? '#' + anchor : '';
  res.redirect(303, path + sep + 'msg=' + encodeURIComponent(msg) + hash);
}

// Validate and resolve a posted badge-icon pick (review fix, issue #682) —
// the ONE place POST /admin/tasks, POST /admin/tasks/:id/edit, and POST
// /admin/tasks/:id/badge all parse a posted `icon` id against
// src/services/badge-icons.js's catalog, so the three routes can never drift
// on what counts as a valid pick or how a missing one is treated.
//
// Performs NO write — the caller still calls task-badges.setTaskBadge itself.
// This is deliberate: POST /admin/tasks must validate BEFORE it INSERTs a
// task row (a missing/invalid badge must create no row at all), so there is
// no taskId yet at the point this runs for that caller.
//
// `required: true` (create) refuses a missing/blank icon outright
// (`{ok:false, reason:'missing'}`). `required: false` (edit / the dedicated
// badge route) treats a missing/blank icon as "nothing to change about the
// badge" (`{ok:true, provided:false}`) rather than an error — but a NAME-only
// submit with no icon is still meaningful there, so `provided` reflects only
// whether an icon was posted; a caller checks `name` too before deciding
// whether to call setTaskBadge at all.
//
// A blank name is passed through as '' unconditionally — task-badges.js's
// setTaskBadge already has its own "blank name keeps the existing badge name"
// rule (so a host who swaps icons without retyping a custom name doesn't get
// it silently overwritten by the icon's generic catalog name); create's own
// caller applies its OWN icon-name fallback afterward, since a brand-new task
// has no prior name to preserve in the first place.
//
// @param {unknown} iconId - the posted icon field (badge_icon or icon).
// @param {unknown} rawName - the posted name field (badge_name or name).
// @param {{required: boolean}} opts
// @returns {{ok:true, provided:boolean, name:string, artPath:string|undefined}
//   | {ok:false, reason:'missing'|'invalid'}}
function resolveBadgeIcon(iconId, rawName, { required }) {
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (typeof iconId !== 'string' || !iconId) {
    if (required) {
      return { ok: false, reason: 'missing' };
    }
    return { ok: true, provided: false, name, artPath: undefined };
  }
  if (!badgeIcons.isValidIconId(iconId)) {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, provided: true, name, artPath: badgeIcons.resolveIconPath(iconId) };
}

// Redirect back to GET /admin/photos after a favorite/badge/moderation
// mutation, preserving the admin's current view/q (issue #259 AC7: "a
// restore/takedown POST returns to the same view") instead of resetting to
// Recent. Every mutating admin-photos form carries hidden `view`/`q`/`panel`
// fields (src/views/admin-photos.ejs) so a POST from a filtered/grouped view,
// or from inside the inline feed, lands back exactly there. `panel=feed`
// additionally anchors the redirect at the acted-on photo's feed card
// (#feed-photo-<id>) so the give-a-badge/favorite dialog's own JS can detect
// the fragment on load and re-open the feed scrolled to it (see the
// bottom-of-page <script> in admin-photos.ejs).
//
// Reuses redirectWithMsg's own encodeURIComponent scheme for `msg` (query
// string is built manually here, not via URLSearchParams, specifically so the
// two helpers can never disagree on how a message is escaped —
// tests/admin-moderation-guards.test.js's `toContain(encodeURIComponent(...))`
// check depends on the exact %20-style escaping encodeURIComponent produces,
// not URLSearchParams' '+'-for-space form). When no view/q was submitted
// (e.g. the existing not-found-guard tests, which POST an empty body) this
// degrades to the exact same '/admin/photos?msg=...' redirectWithMsg already
// produced before this issue, so that pre-existing coverage is unaffected.
function redirectToPhotos(req, res, msg, submissionId) {
  const view = typeof req.body.view === 'string' ? req.body.view.trim() : '';
  const q = typeof req.body.q === 'string' ? req.body.q.trim() : '';
  const panel = typeof req.body.panel === 'string' ? req.body.panel.trim() : '';

  const parts = [];
  if (view) parts.push('view=' + encodeURIComponent(view));
  if (q) parts.push('q=' + encodeURIComponent(q));
  const path = '/admin/photos' + (parts.length ? '?' + parts.join('&') : '');

  const anchor = panel === 'feed' && submissionId ? 'feed-photo-' + submissionId : undefined;
  redirectWithMsg(res, path, msg, anchor);
}

// ---------------------------------------------------------------------------
// Retired routes (issue #244 AC2/AC3): guest-creation (POST /guests, POST
// /guests/bulk) and the per-guest QR sheet (GET /qrsheet) must respond 404,
// not just fall out of this router unhandled. That distinction matters here:
// app.js mounts guest.js (at '/') right after this router, and guest.js runs
// `router.use(requireGuest)` unconditionally for every path it sees — so a
// path this router doesn't recognize does NOT reach app.js's real 404
// handler, it falls through into guest.js and comes back as a 302 to /join
// instead (requireGuest has no guest session to check for an admin-only
// visitor). Rendering the same 404 view these three retired paths used to
// return before they existed is not needed for anything else on this
// router — every path a guest can legitimately reach here still has its own
// route above/below and never reaches this block.
// ---------------------------------------------------------------------------
function renderNotFound(req, res) {
  res.status(404).render('404', { url: req.originalUrl });
}
router.post('/guests', renderNotFound);
router.post('/guests/bulk', renderNotFound);
router.get('/qrsheet', renderNotFound);

// ---------------------------------------------------------------------------
// GET /admin  — dashboard
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  const activeTaskCountRow = db
    .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE ${tasks.liveTaskWhere('')}`)
    .get();
  const counts = {
    guests: db.prepare('SELECT COUNT(*) AS n FROM guests').get().n,
    activeTasks: activeTaskCountRow.n,
    submissions: db.prepare('SELECT COUNT(*) AS n FROM submissions').get().n,
    livePhotos: db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE taken_down = 0').get().n,
    takenDown: db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE taken_down = 1').get().n,
    badgesAwarded: db.prepare('SELECT COUNT(*) AS n FROM guest_badges').get().n,
  };

  // Sixth stat cell (issue #256 / #245): unresolved bug-report count.
  const openBugs = db.prepare('SELECT COUNT(*) AS n FROM bug_reports WHERE resolved = 0').get().n;

  // Pulse line (issue #256): the newest VISIBLE submission. feed.js owns the
  // visibility predicate and newest-first ordering (its VISIBLE_WHERE /
  // ORDER_NEWEST_FIRST single owners), so this route consumes
  // feed.newestVisibleSubmission() rather than re-typing the SQL — the pulse
  // then agrees with the gallery on "which is newest" and never surfaces a
  // photo the admin just took down.
  const newestVisible = feed.newestVisibleSubmission();
  const lastPhoto = newestVisible
    ? { rel: relativeTime(newestVisible.created_at), name: newestVisible.name || '' }
    : null;

  res.render('admin-dashboard', {
    title: 'Admin Dashboard',
    counts,
    openBugs,
    lastPhoto,
    msg: req.query.msg || '',
    isAdmin: true,
  });
});

// ---------------------------------------------------------------------------
// GET /admin/config  — event timezone + wedding dates (issue #681). Every
// date-aware feature (day chips, daily challenges, the dashboard checklist)
// reads getEventConfig() as its single owner, set exactly once here.
// ---------------------------------------------------------------------------
router.get('/config', (req, res) => {
  const eventConfig = getEventConfig();
  res.render('admin-config', {
    title: 'Configuration',
    isAdmin: true,
    msg: req.query.msg || '',
    err: Boolean(req.query.err),
    timezones: timezoneOptions(),
    config: {
      // A grouped member stored earlier (e.g. America/Boise) pre-selects its
      // group's canonical <option> (America/Denver) — same DST rule, one
      // fewer near-duplicate row in the dropdown.
      timezone: resolveSelectedZone(eventConfig.timezone),
      startDate: eventConfig.startDate,
      endDate: eventConfig.endDate,
    },
  });
});

// tasks.isRealDateString is the one owner of "shaped like a date AND a real
// calendar day" — it round-trips y/m/d through Date.UTC(), so 2026-02-30
// rolls to Mar 2 and fails, and 2026-13-45 fails outright. Three callers here
// need exactly that question answered: the config route (an impossible date
// reaching setEventConfig makes eventDays() yield zero day chips downstream —
// #682/#646), GET /admin/tasks (does this task get a day chip), and POST
// /admin/tasks/:id/active (may un-hide restore 'oneday').
//
// This is NOT the check every OTHER reader of special_date runs:
// src/routes/guest.js checks SHAPE only (tasks.isValidDateString), not
// reality. That is accepted, unchanged behavior — guest.js is not on issue
// #755's Touches list — not a claim that every reader shares this guard.

// True for a value that is a real date AND inside the CURRENTLY configured
// wedding range (issue #755 criterion 3) — the write-path validator, used
// only by resolveSpecialPairWrite below. A value can be a real calendar date
// yet fail this, being dated outside a range the host has since narrowed —
// exactly criterion 3b's stale-date case, which this refuses and the plain
// reality check does not.
function isConfiguredEventDay(value) {
  if (!tasks.isRealDateString(value)) return false;
  const cfg = getEventConfig();
  return computeEventDays(cfg.startDate, cfg.endDate).some((d) => d.iso === value);
}

// Reason CODES resolveSpecialPairWrite refuses with (review fix, issue #755
// design-philosophy pass) — mirrors resolveBadgeIcon's own
// `{ok:false, reason:'missing'|'invalid'}` shape a few lines above: the
// resolver reports WHAT went wrong, never HOW to word it, so create and edit
// can phrase their own host-facing message. This matters concretely here —
// unlike a bad badge pick, a refused CREATE discards the host's entire draft
// (title, description, worth, badge — nothing was written), which the edit
// route's refusal does not, so the two messages should not be forced to
// share one string.
const PAIR_REASON_INVALID_DATE = 'invalid_date';
const PAIR_REASON_INVALID_BONUS = 'invalid_bonus';
const PAIR_REASON_LOCKED = 'locked';

// The ONE owner of "would this save touch the (special_date, special_bonus)
// pair, and if so is that touch allowed, and what is the pair afterward"
// (issue #755 criteria 3 and 4) — the create and edit routes below both call
// this before writing, so the two paths can never disagree about what counts
// as a pair change, an invalid pair, or a locked task.
//
// Branches on the RAW posted `special_mode` (`rawMode`), never the
// normalized value — criterion 3's own instruction. A `hidden` write and an
// absent `special_mode` both leave the pair untouched: the RESOLVED
// `writeDate`/`writeBonus` this function returns on success is the STORED
// pair unchanged in that case, never a null the caller might mistake for "no
// value" and use to clobber a real stored date (review fix — the caller no
// longer branches on a separate `writes` flag to decide this; the resolved
// pair already IS the answer). A `none` write clears the pair (resolved
// `writeDate`/`writeBonus` both `null`). An `oneday` write carries the
// posted date/bonus through as the resolved pair.
//
// `pairChanged` (internal) compares the pair this save WOULD write against
// the pair currently stored — the single fact both refusals below key off.
// For CREATE, pass `storedDate`/`storedBonus` as `undefined` (deliberately
// NOT `null` — a real task row's stored special_date IS `null` for an
// ordinary task, and that must compare as UNCHANGED against a posted `(null,
// null)` `none`/no-op write; CREATE has no stored task at all, a different
// fact, and `undefined !== null` is what makes "every posted pair differs"
// hold on CREATE even for an empty `oneday` posted pair — see criterion 3's
// own note on this). The RESOLVED pair returned on a no-touch CREATE path
// still comes back `null`/`null` (never `undefined`, which better-sqlite3's
// bind() rejects) — `undefined` is only ever the SENTINEL passed in, never
// what comes back out.
//
// Two refusals, evaluated in the order the issue's own pseudocode lists
// them:
//   1. validation (criterion 3) — only when `rawMode === 'oneday'` AND
//      `pairChanged`: the posted date must be a currently configured wedding
//      day, and the posted bonus must be an integer 1-3. This gate is why a
//      `none` write (posted pair `(null, null)`, always "changed" relative
//      to a dated stored pair) is never validated as a missing date — the
//      whole point of `none` is to clear it.
//   2. the lock (criterion 4) — whenever `pairChanged` (any mode) AND the
//      task already carries at least one submission (visible or taken
//      down): refused, full stop. This gate carries no mode restriction —
//      it is the one rule with three faces described in the issue's
//      criterion 4.
//
// @param {object} opts
// @param {unknown} opts.rawMode - req.body.special_mode, unmodified.
// @param {unknown} opts.rawDate - req.body.special_date, unmodified.
// @param {unknown} opts.rawBonus - req.body.special_bonus, unmodified.
// @param {string|null|undefined} opts.storedDate - the task's CURRENT
//   special_date, or `undefined` on CREATE (no stored task yet — see the
//   comment above on why this must not be `null`).
// @param {number|null|undefined} opts.storedBonus - the task's CURRENT
//   special_bonus, or `undefined` on CREATE.
// @param {number} opts.submissionCount - submissions (visible + taken down)
//   already posted to this task; 0 on CREATE (no task exists yet to post to).
// @returns {{ok: true, writeDate: string|null, writeBonus: number|null}
//   | {ok: false, reason: 'invalid_date'|'invalid_bonus'|'locked'}}
function resolveSpecialPairWrite({
  rawMode,
  rawDate,
  rawBonus,
  storedDate,
  storedBonus,
  submissionCount,
}) {
  const writes = rawMode === tasks.MODE_NONE || rawMode === tasks.MODE_ONEDAY;

  let writeDate = null;
  let writeBonus = null;
  if (rawMode === tasks.MODE_ONEDAY) {
    writeDate = typeof rawDate === 'string' && rawDate.trim() ? rawDate.trim() : null;
    const parsedBonus = parseInt(rawBonus, 10);
    writeBonus = Number.isInteger(parsedBonus) ? parsedBonus : null;
  }

  const pairChanged = writes && (writeDate !== storedDate || writeBonus !== storedBonus);

  if (rawMode === tasks.MODE_ONEDAY && pairChanged) {
    if (!isConfiguredEventDay(writeDate)) {
      return { ok: false, reason: PAIR_REASON_INVALID_DATE };
    }
    if (writeBonus === null || writeBonus < 1 || writeBonus > 3) {
      return { ok: false, reason: PAIR_REASON_INVALID_BONUS };
    }
  }

  if (pairChanged && submissionCount > 0) {
    return { ok: false, reason: PAIR_REASON_LOCKED };
  }

  // Resolved pair: `writes` decides source (the computed pair vs. the
  // stored one), and `undefined` (the CREATE no-stored-task sentinel) is
  // normalized to `null` here so this function's OUTPUT never leaks the
  // sentinel its INPUT uses — the caller gets a plain nullable pair either
  // way, never a third undefined state to handle.
  const resolvedDate = writes ? writeDate : (storedDate ?? null);
  const resolvedBonus = writes ? writeBonus : (storedBonus ?? null);
  return { ok: true, writeDate: resolvedDate, writeBonus: resolvedBonus };
}

// Word a resolveSpecialPairWrite refusal for the HOST-FACING create flash
// message. CREATE-specific: a refused create discards the whole draft (no
// task row of ANY kind was written — title, description, worth, badge all
// gone), which the wording says explicitly so the host doesn't wonder
// whether a partial task landed.
function describeCreatePairRefusal(reason) {
  switch (reason) {
    case PAIR_REASON_INVALID_DATE:
      return 'Choose one of the configured wedding days — your task was not created.';
    case PAIR_REASON_INVALID_BONUS:
      return 'Choose a bonus of +1, +2, or +3 for that day — your task was not created.';
    default:
      return 'That day/bonus could not be saved — your task was not created.';
  }
}

// Word a resolveSpecialPairWrite refusal for the HOST-FACING edit flash
// message. EDIT-specific: nothing about the task is discarded — the refusal
// is scoped to the pair alone, and the rest of the save this POST carried
// (title/description/worth/badge) is simply never applied either, since the
// whole edit is one refuse-or-apply unit.
function describeEditPairRefusal(reason) {
  switch (reason) {
    case PAIR_REASON_INVALID_DATE:
      return 'Choose one of the configured wedding days.';
    case PAIR_REASON_INVALID_BONUS:
      return 'Choose a bonus of +1, +2, or +3 for that day.';
    case PAIR_REASON_LOCKED:
      return 'A guest has already posted to this task — its day and bonus are locked.';
    default:
      return 'That day/bonus could not be saved.';
  }
}

// POST /admin/config  — validate and persist. Timezone must be a real IANA
// name the tzdb list recognizes (never a bare offset the admin typed by
// hand — there is no free-text field, but a crafted POST could still try
// one); start date must be on or before end date. On either failure, the
// stored settings are left completely unchanged (setEventConfig is never
// called) and the page re-renders with an error flash naming the problem.
router.post('/config', (req, res) => {
  const timezone = typeof req.body.timezone === 'string' ? req.body.timezone.trim() : '';
  const startDate = typeof req.body.start_date === 'string' ? req.body.start_date.trim() : '';
  const endDate = typeof req.body.end_date === 'string' ? req.body.end_date.trim() : '';

  if (!isKnownTimezone(timezone)) {
    return redirectWithMsg(res, '/admin/config?err=1', 'Please choose a valid timezone.');
  }
  if (!tasks.isRealDateString(startDate) || !tasks.isRealDateString(endDate)) {
    return redirectWithMsg(res, '/admin/config?err=1', 'Please enter valid start and end dates.');
  }
  if (startDate > endDate) {
    return redirectWithMsg(
      res,
      '/admin/config?err=1',
      'The wedding start date must be on or before the end date.'
    );
  }

  setEventConfig({ timezone, startDate, endDate });
  redirectWithMsg(res, '/admin/config', 'Configuration saved.');
});

// ---------------------------------------------------------------------------
// GET /admin/guests  — table of guests
// ---------------------------------------------------------------------------
router.get('/guests', (req, res) => {
  const guests = db.prepare('SELECT * FROM guests ORDER BY created_at ASC, id ASC').all();

  // List of admin-awardable badges (special + custom, issue #80 AC5) so the
  // per-guest award control can offer them. 'metric'/'transferable' are
  // system-owned and never appear here.
  const specialBadges = db
    .prepare("SELECT * FROM badges WHERE type IN ('special', 'custom') ORDER BY type ASC, name ASC")
    .all();

  // For each guest, attach link, points, completed count, and held badge codes.
  const heldStmt = db.prepare(
    `SELECT b.code FROM guest_badges gb
       JOIN badges b ON b.id = gb.badge_id
      WHERE gb.guest_id = ?`
  );
  const rows = guests.map((g) => {
    const held = heldStmt.all(g.id).map((r) => r.code);
    return {
      id: g.id,
      name: g.name || '',
      bonus_points: g.bonus_points,
      pinned: g.pinned,
      points: scoring.getPoints(g.id),
      completed: scoring.getCompletedCount(g.id),
      heldCodes: held,
      // contact/pin (issue #243) so the admin can view and edit a guest's
      // re-entry identity — recovery on the spot at the reception, no reset
      // flow. '' rather than null so the EJS text-input `value=` never
      // renders the literal string "null".
      contact: g.contact || '',
      pin: g.pin || '',
    };
  });

  // Denominator for each card's "done/total tasks" meta line. ALL tasks, not
  // just active ones: the completed numerator (scoring.getCompletedCount)
  // counts visible submissions on hidden tasks too, and UNIQUE(guest_id,
  // task_id) + ON DELETE CASCADE bound it by the number of existing tasks —
  // so this denominator can never show "4/3 tasks". (Guest home clamps a
  // percentage instead; here the raw pair is displayed, so the denominator
  // must dominate.)
  const totalTasks = db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;

  res.render('admin-guests', {
    title: 'Guests',
    guests: rows,
    specialBadges,
    totalTasks,
    msg: req.query.msg || '',
    isAdmin: true,
  });
});

// POST /admin/guests/:id/edit  — rename a guest and set their gallery pin.
// The pin (guests.pinned, issue #251) hoists this guest's section to the top
// of the gallery's By-person view — meant for the couple's own rows. An
// unchecked checkbox posts no `pinned` field at all, which is exactly the
// "unpin" signal.
router.post('/guests/:id/edit', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const name = (req.body.name || '').trim();
  const pinned = req.body.pinned ? 1 : 0;
  const guest = db.prepare('SELECT id FROM guests WHERE id = ?').get(id);
  if (!guest) {
    return redirectWithMsg(res, '/admin/guests', 'Guest not found.');
  }
  db.prepare('UPDATE guests SET name = ?, pinned = ? WHERE id = ?').run(name, pinned, id);
  redirectWithMsg(res, '/admin/guests', 'Guest updated.');
});

// POST /admin/guests/:id/identity  — admin sets a guest's contact and/or
// re-entry PIN (issue #243). Goal C: the host can read a locked-out guest's
// PIN back to them on the spot, or fix a mistyped contact, with no reset
// flow. Both fields are optional and independent — an empty/absent field
// means "leave this one alone" (a host correcting only the PIN should not be
// forced to retype a correct contact, and vice versa).
//
// Validation is the SAME rule signup uses (normalizeContact / isValidPin
// from services/identity.js) — this route does not re-encode either rule,
// it calls the single owner both places already share.
router.post('/guests/:id/identity', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const guest = db.prepare('SELECT id, contact, pin FROM guests WHERE id = ?').get(id);
  if (!guest) {
    return redirectWithMsg(res, '/admin/guests', 'Guest not found.');
  }

  const rawPin = typeof req.body.pin === 'string' ? req.body.pin.trim() : '';
  const rawContact = typeof req.body.contact === 'string' ? req.body.contact.trim() : '';

  // Validate PIN first (matches the plan's ordering) so a bad PIN never lets
  // a valid contact half-apply — either everything submitted is valid, or
  // nothing is written.
  if (rawPin) {
    if (!isValidPin(rawPin)) {
      return redirectWithMsg(res, '/admin/guests', 'Please choose a 4-digit PIN (numbers only).');
    }
  }

  let normalized = null;
  if (rawContact) {
    normalized = normalizeContact(rawContact);
    if (!normalized) {
      return redirectWithMsg(res, '/admin/guests', 'Please enter a valid email or phone number.');
    }
    // Collision check: one guest per normalized contact. Only a DIFFERENT
    // guest already holding this contact is a conflict — re-submitting the
    // guest's own current contact (unchanged, or just re-cased/reformatted)
    // must be allowed.
    const existing = getGuestByContact(normalized.value);
    if (existing && existing.id !== id) {
      return redirectWithMsg(
        res,
        '/admin/guests',
        'That contact is already in use by another guest.'
      );
    }
  }

  if (!rawPin && !normalized) {
    // Neither field submitted (or both blank) — nothing to change.
    return redirectWithMsg(res, '/admin/guests', 'Nothing to update.');
  }

  // The collision check above is a pre-check, not a lock — a concurrent
  // request could still slip a colliding contact past it and into the
  // idx_guests_contact UNIQUE index before this UPDATE runs. Guard the write
  // itself the same way POST /admin/badges guards createCustomBadge's insert
  // above: catch the constraint violation and answer with the same friendly
  // "already in use" wording as the pre-check, instead of a bare 500.
  try {
    if (rawPin && normalized) {
      db.prepare('UPDATE guests SET pin = ?, contact = ?, contact_type = ? WHERE id = ?').run(
        rawPin,
        normalized.value,
        normalized.type,
        id
      );
    } else if (rawPin) {
      db.prepare('UPDATE guests SET pin = ? WHERE id = ?').run(rawPin, id);
    } else {
      db.prepare('UPDATE guests SET contact = ?, contact_type = ? WHERE id = ?').run(
        normalized.value,
        normalized.type,
        id
      );
    }
  } catch (err) {
    if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return redirectWithMsg(
        res,
        '/admin/guests',
        'That contact is already in use by another guest.'
      );
    }
    throw err;
  }

  redirectWithMsg(res, '/admin/guests', 'Guest contact/PIN updated.');
});

// POST /admin/guests/:id/delete  — delete a guest. The FK cascade removes their
// submission rows and badge rows, but it does NOT touch the image files on disk.
// To keep disk and DB in sync (and avoid orphaned originals + thumbs that no
// export will ever pick up), we hard-delete each of the guest's photo files AND
// their avatar file (issue #196 — the avatar was the one file class this pass
// missed, leaving a deleted guest's portrait still fetchable at /uploads/<file>)
// BEFORE deleting the guest. This is irreversible — the confirm dialog in the
// view warns the operator.
router.post('/guests/:id/delete', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const guest = db.prepare('SELECT id, avatar_path FROM guests WHERE id = ?').get(id);
  if (!guest) {
    return redirectWithMsg(res, '/admin/guests', 'Guest not found.');
  }

  // Collect this guest's submissions so we can remove their files from disk.
  const subs = db.prepare('SELECT id FROM submissions WHERE guest_id = ?').all(id);
  for (const sub of subs) {
    try {
      // Removes the original photo file AND its thumbnail from disk (section 05).
      // If your photos service names this differently (e.g. deleteOriginalFile +
      // deleteThumbFile), call those instead.
      photos.hardDelete(sub.id);
    } catch (err) {
      // Don't abort the whole delete just because one stray file was already
      // gone; log and continue so the DB row still gets removed.
      console.error('Failed to delete files for submission', sub.id, err);
    }
  }

  // Remove the guest's avatar file, if any. deleteOriginalFile no-ops on a
  // null/empty path and already ignores ENOENT (a file already gone from disk
  // does not abort the delete — same policy as the submission files above).
  try {
    photos.deleteOriginalFile(guest.avatar_path);
  } catch (err) {
    console.error('Failed to delete avatar for guest', id, err);
  }

  // Now remove the guest; FK cascade clears submissions + guest_badges rows.
  db.prepare('DELETE FROM guests WHERE id = ?').run(id);

  // The deleted guest's own per-guest badges died with the FK cascade above,
  // and no OTHER guest's per-guest badge (COMPLETIONIST, the BLOOM/BOUQUET/
  // GARDEN auto badges) depends on a different guest's existence — only a
  // registered transferable badge's relative standings would (registry
  // currently empty, #711). If the deleted guest was a sole holder, the
  // next-qualifying guest never got a chance to
  // pick it up until some later, unrelated event triggered a recompute
  // (issue #715 — the one mutation #701's recompute seam did not cover).
  scoring.recomputeTransferableBadges();

  redirectWithMsg(res, '/admin/guests', 'Guest and their photos deleted.');
});

// POST /admin/guests/:id/points  — add (or subtract) bonus points
router.post('/guests/:id/points', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const delta = parseInt(req.body.delta, 10);
  const guest = db.prepare('SELECT id FROM guests WHERE id = ?').get(id);
  if (!guest) {
    return redirectWithMsg(res, '/admin/guests', 'Guest not found.');
  }
  if (isNaN(delta) || delta === 0) {
    return redirectWithMsg(res, '/admin/guests', 'Enter a non-zero point amount.');
  }
  // scoring.addBonusPoints is additive (bonus_points = bonus_points + delta).
  // It IS floor-clamped at 0: the UPDATE's MAX(0, ...) (scoring.js's
  // stmtAddBonus) means a large negative delta can never drive a guest's
  // bonus below zero. The admin sees the running total in the UI.
  scoring.addBonusPoints(id, delta);
  redirectWithMsg(
    res,
    '/admin/guests',
    (delta > 0 ? 'Awarded ' : 'Removed ') + Math.abs(delta) + ' bonus point(s).'
  );
});

// POST /admin/guests/:id/badge  — award OR remove a special OR custom badge.
// Body: code = badge code (EARLYBIRD/SHUTTERBUG/CROWDFAV/CHOICE, or any
//       admin-created custom code), action = "award", "remove", or "toggle"
//       ("toggle" resolves against the guest's current held state server-side,
//       so the badge-select form stays correct with JavaScript disabled).
// 'metric'/'transferable' codes are refused (issue #80 AC5) — those types are
// system-owned by scoring.recomputeBadges/recomputeTransferableBadges, and an
// admin award/remove attempt on one must not create or delete a guest_badges
// row.
router.post('/guests/:id/badge', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const code = (req.body.code || '').trim().toUpperCase();
  const action = (req.body.action || 'award').trim();

  const guest = db.prepare('SELECT id FROM guests WHERE id = ?').get(id);
  if (!guest) {
    return redirectWithMsg(res, '/admin/guests', 'Guest not found.');
  }
  const badge = db
    .prepare("SELECT * FROM badges WHERE code = ? AND type IN ('special', 'custom')")
    .get(code);
  if (!badge) {
    return redirectWithMsg(res, '/admin/guests', 'Unknown special or custom badge.');
  }

  let effective = action;
  if (action === 'toggle') {
    const held = db
      .prepare('SELECT 1 FROM guest_badges WHERE guest_id = ? AND badge_id = ?')
      .get(id, badge.id);
    effective = held ? 'remove' : 'award';
  }

  if (effective === 'remove') {
    scoring.removeSpecialBadge(id, code);
    redirectWithMsg(res, '/admin/guests', 'Removed badge "' + badge.name + '".');
  } else {
    scoring.awardSpecialBadge(id, code);
    redirectWithMsg(res, '/admin/guests', 'Awarded badge "' + badge.name + '".');
  }
});

// POST /admin/badges  — create a new host-defined CUSTOM badge.
// Body: name (required), art_path (required, non-empty — an image path or an
// emoji string), description (optional).
// Always creates type = 'custom' — this route can never be used to create a
// 'metric'/'transferable' catalog row (those are seeded by scripts/seed.js
// only, keyed to a registry function in src/services/badges.js). The code is
// derived from the name (uppercased, non-alnum stripped) so the admin never
// has to invent a machine code by hand; scoring.createCustomBadge's UNIQUE
// constraint on `code` still guards against a collision.
router.post('/badges', (req, res) => {
  const name = (req.body.name || '').trim();
  const artPath = (req.body.art_path || '').trim();
  const description = (req.body.description || '').trim();

  if (!name) {
    return redirectWithMsg(res, '/admin/guests', 'A custom badge needs a name.');
  }
  if (!artPath) {
    return redirectWithMsg(
      res,
      '/admin/guests',
      'A custom badge needs art (an image path or emoji).'
    );
  }

  const code = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 40);
  if (!code) {
    return redirectWithMsg(
      res,
      '/admin/guests',
      'That name has no usable characters for a badge code.'
    );
  }

  try {
    const badge = scoring.createCustomBadge({ code, name, type: 'custom', artPath, description });
    if (!badge) {
      return redirectWithMsg(
        res,
        '/admin/guests',
        'Refused: custom badges cannot be metric/transferable.'
      );
    }
    redirectWithMsg(res, '/admin/guests', 'Created custom badge "' + badge.name + '".');
  } catch (err) {
    if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return redirectWithMsg(res, '/admin/guests', 'A badge with that code already exists.');
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// GET /admin/poster  — the one shared entry-link poster (issue #244). One QR
// pointing at GET /join, printed once instead of a hundred personal
// place-cards — every guest scans the SAME code, then signs themselves up.
// ---------------------------------------------------------------------------
router.get('/poster', async (req, res, next) => {
  try {
    const base = config.BASE_URL.replace(/\/+$/, '');
    const joinUrl = base + '/join';
    // qr.qrDataUrl returns a PNG data-URI string we can drop into <img src>.
    const dataUri = await qr.qrDataUrl(joinUrl);

    res.render('admin-poster', {
      title: 'Entry Poster',
      joinUrl,
      qr: dataUri,
      isAdmin: true,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /admin/tasks  — list + add form
// ---------------------------------------------------------------------------
router.get('/tasks', (req, res) => {
  // Named `taskRows` (not `tasks`) so it never shadows the tasks.js service
  // module required at the top of this file.
  const taskRows = db.prepare('SELECT * FROM tasks ORDER BY sort_order ASC, id ASC').all();

  // Attach how many live submissions each task has (informational).
  const subStmt = db.prepare(
    'SELECT COUNT(*) AS n FROM submissions WHERE task_id = ? AND taken_down = 0'
  );
  const rows = taskRows.map((t, idx) => {
    // resolveTaskBadge lazily inserts the task's own badge row (default
    // ribbon art) the first time a task's card is rendered (issue #483) —
    // every task always has a badge to show, never a missing-badge branch.
    const badge = taskBadges.resolveTaskBadge(t.id);
    // Hoisted (issue #755 review fix — minor) so `oneday`/`dayLabel` below
    // never evaluate the same guard twice per row.
    const hasDate = tasks.isRealDateString(t.special_date);
    return {
      id: t.id,
      title: t.title,
      description: t.description || '',
      sort_order: t.sort_order,
      // Real worth/special_mode (issue #682/#727) — the admin card's "+N pts"
      // and Hidden chip render these directly now; no more (id % 3) + 1
      // placeholder.
      worth: t.worth,
      special_mode: t.special_mode,
      // Derived compat field so admin-tasks.ejs's is-hidden class check keeps
      // reading a plain boolean, sourced from the one active-task owner
      // instead of a real is_active column (which no longer exists).
      is_active: tasks.isTaskLive(t) ? 1 : 0,
      // Raw pair (issue #755) — admin-tasks.ejs emits these as the card's
      // data-special-date/data-special-bonus attributes, which
      // admin-tasks.js's openEdit() reads back to drive the edit popup's
      // day/bonus chips (and the hidden stale-date input for criterion 3b).
      // Raw, not gated by the reality check — the popup needs the true
      // stored value even when it is stale/invalid.
      special_date: t.special_date,
      special_bonus: t.special_bonus,
      // Derived pair for the board chip (criterion 5): `hasDate` guards BOTH
      // shape and reality (tasks.isRealDateString). special_date is a
      // free-form TEXT column with no shape constraint (src/db.js), and
      // singleDayLabel() throws a RangeError on a regex-shaped-but-impossible
      // value like '2026-13-45' — this guard is what keeps GET /admin/tasks
      // from 500ing on that value; a task failing it renders no chip rather
      // than crashing the whole board.
      oneday: hasDate,
      dayLabel: hasDate ? singleDayLabel(t.special_date) : '',
      submissions: subStmt.get(t.id).n,
      isFirst: idx === 0,
      isLast: idx === taskRows.length - 1,
      badge: Object.assign({}, taskBadges.toTaskBadgeView(badge), {
        // "Still the default" drives whether the upload control shows
        // (AC10) — compared by path, not by a separate stored flag, so it
        // can never desync from what art_path actually renders.
        isDefault: badge.art_path === taskBadges.DEFAULT_RIBBON_ART_PATH,
      }),
    };
  });

  // The day-chip catalog both dialog partials render (issue #755) — EJS
  // merges this local into partials/task-create-dialog.ejs and
  // partials/task-edit-dialog.ejs (and, through them, special-oneday-
  // option.ejs) since `include()` shares the calling template's scope by
  // default. getEventConfig() is already imported at the top of this file.
  const eventConfig = getEventConfig();
  const eventDaysList = computeEventDays(eventConfig.startDate, eventConfig.endDate);

  res.render('admin-tasks', {
    title: 'Tasks',
    tasks: rows,
    badgeIcons: badgeIcons.listIcons().map((ic) => ({
      id: ic.id,
      name: ic.name,
      artPath: badgeIcons.iconArtPath(ic.id),
    })),
    eventDays: eventDaysList,
    msg: req.query.msg || '',
    isAdmin: true,
  });
});

// POST /admin/tasks  — create a task (issue #682: the 3-step wizard —
// Details/Special/Badge — collapses to one POST). Bottom of the order by
// default; an `add_to_top` field (issue #258; no longer exposed by the
// wizard's own UI, but still honored so a direct POST can still ask for it)
// puts it at position 1 so a mid-event task can be featured without a
// click-reload reorder marathon.
//
// Body: title (required), description (optional), worth (1-3, falls back to
// tasks.DEFAULT_WORTH if missing/out of range — tasks.normalizeWorth), and
// special_mode ('none'/'hidden'/'oneday', falls back to tasks.MODE_NONE for
// anything else — tasks.normalizeMode; the SAME write-side owner POST
// /admin/tasks/:id/edit routes through below, so the two can never disagree
// on what an unrecognized mode becomes), special_date/special_bonus (issue
// #755 — required and validated only when special_mode is 'oneday' and
// differs from the (nonexistent) stored pair; see resolveSpecialPairWrite),
// badge_icon (a src/services/badge-icons.js catalog id — REQUIRED, AC-A: no
// valid icon means no task row is written at all), badge_name (optional —
// falls back to the icon's own catalog display name).
//
// The special_mode is part of the single INSERT below, not a follow-up
// UPDATE — a task created as Hidden is hidden from its very first row, never
// briefly live between create and a later edit (owner-flagged gap, the
// "Owner-approved design" section of #682).
router.post('/tasks', (req, res) => {
  const title = (req.body.title || '').trim();
  const description = (req.body.description || '').trim();
  if (!title) {
    return redirectWithMsg(res, '/admin/tasks', 'A task needs a title.');
  }

  const worth = tasks.normalizeWorth(req.body.worth, tasks.DEFAULT_WORTH);
  const specialMode = tasks.normalizeMode(req.body.special_mode, tasks.MODE_NONE);

  // special_date/special_bonus (issue #755) — validated BEFORE any write, same
  // discipline as the badge check just below: a bad pair on CREATE means NO
  // task row is written at all (criterion 3), the same shape an invalid badge
  // already takes. storedDate/storedBonus are `undefined` (no stored task
  // yet, so every posted 'oneday' pair "differs from stored" — see
  // resolveSpecialPairWrite's own comment) and submissionCount is 0 (a
  // brand-new task can have no submissions, so the lock never fires here).
  const pairResolved = resolveSpecialPairWrite({
    rawMode: req.body.special_mode,
    rawDate: req.body.special_date,
    rawBonus: req.body.special_bonus,
    storedDate: undefined,
    storedBonus: undefined,
    submissionCount: 0,
  });
  if (!pairResolved.ok) {
    return redirectWithMsg(res, '/admin/tasks', describeCreatePairRefusal(pairResolved.reason));
  }

  // Badge is REQUIRED (AC-A) — the wizard's own step 3 already disables its
  // submit button until a badge is chosen, but the server is the real gate:
  // a POST with no valid catalog icon id creates NO task row. Validated
  // BEFORE any write below — resolveBadgeIcon performs no DB write itself.
  const badgeResolved = resolveBadgeIcon(req.body.badge_icon, req.body.badge_name, {
    required: true,
  });
  if (!badgeResolved.ok) {
    return redirectWithMsg(res, '/admin/tasks', 'Choose a badge before creating the task.');
  }
  // A brand-new task has no prior badge name to preserve, unlike edit — a
  // blank name falls back to the icon's own catalog display name here only.
  const badgeName = badgeResolved.name || badgeIcons.iconName(req.body.badge_icon);

  let order;
  if (req.body.add_to_top) {
    const minRow = db.prepare('SELECT MIN(sort_order) AS m FROM tasks').get();
    order = (minRow.m == null ? 1 : minRow.m) - 1;
  } else {
    const maxRow = db.prepare('SELECT MAX(sort_order) AS m FROM tasks').get();
    order = (maxRow.m == null ? -1 : maxRow.m) + 1;
  }

  // Atomic (review fix): the task INSERT and its badge write are one
  // transaction — if setTaskBadge threw, a bare sequential pair could commit
  // the task row alone, leaving a task with no badge despite badge being
  // supposedly required. better-sqlite3 nests transaction functions via
  // SAVEPOINTs, so calling setTaskBadge (itself a db.transaction) from inside
  // this one is safe.
  const createTask = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO tasks (title, description, sort_order, worth, special_mode, special_date, special_bonus)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        title,
        description,
        order,
        worth,
        specialMode,
        pairResolved.writeDate,
        pairResolved.writeBonus
      );
    const taskId = info.lastInsertRowid;

    // One task, one badge (issue #483) — resolveTaskBadge would otherwise
    // lazily insert the shared default-ribbon row the first time this task's
    // card renders; the wizard always supplies a real chosen badge up front,
    // so write it now through the same single writer POST /admin/tasks/:id/badge
    // uses below.
    taskBadges.setTaskBadge(taskId, { name: badgeName, artPath: badgeResolved.artPath });
    return taskId;
  });
  createTask();

  // A newly created LIVE task can make an existing COMPLETIONIST holder
  // stale (issue #701 AC1) by growing the active set; a task created Hidden
  // does not change the active set at all, so this stays conditional
  // (review fix) instead of firing unconditionally on every create. Goes
  // through tasks.isTaskLive — the SAME liveness predicate every other reader
  // uses — rather than a second hand-written `!== MODE_HIDDEN` check (review
  // fix: a hand-written comparison here would be a second liveness predicate,
  // the exact drift class this module exists to prevent).
  if (tasks.isTaskLive({ special_mode: specialMode })) {
    scoring.recomputeAfterTaskChange();
  }
  redirectWithMsg(res, '/admin/tasks', 'Task added.');
});

// POST /admin/tasks/:id/edit  — the single edit-popup save (issue #682):
// title, description, worth, badge, and special_mode together in one submit.
//
// Body: title (required), description (optional), worth (1-3 — falls back to
// the task's CURRENT worth if missing/out of range via tasks.normalizeWorth,
// so a direct partial POST — e.g. the pre-#682 title/description-only tests —
// leaves it untouched), special_mode ('none'/'hidden'/'oneday' — same "keep
// current on anything else" guard, via tasks.normalizeMode — the SAME
// write-side owner POST /admin/tasks routes through above, so the two can
// never disagree on what an unrecognized mode becomes), special_date/
// special_bonus (issue #755 — cleared on 'none', untouched on 'hidden' or an
// absent special_mode, validated and written on 'oneday' only when the pair
// differs from what is stored, refused if that changed pair is invalid OR
// this task already carries a submission; see resolveSpecialPairWrite),
// badge_icon (optional — a catalog id; when present it MUST be valid, or the
// whole edit is refused, mirroring POST /admin/tasks/:id/badge's own
// validation), badge_name (optional — a name-only submit with no icon still
// updates just the name, same contract that route already offered).
router.post('/tasks/:id/edit', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const title = (req.body.title || '').trim();
  const description = (req.body.description || '').trim();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) {
    return redirectWithMsg(res, '/admin/tasks', 'Task not found.');
  }
  if (!title) {
    return redirectWithMsg(res, '/admin/tasks', 'A task needs a title.');
  }

  const worth = tasks.normalizeWorth(req.body.worth, task.worth);
  const specialMode = tasks.normalizeMode(req.body.special_mode, task.special_mode);

  // special_date/special_bonus (issue #755) — validated BEFORE any write,
  // same discipline as the badge check just below. submissionCount feeds
  // criterion 4's lock: a submission on THIS task (visible or taken down)
  // refuses any save that would change the pair, no matter which of the
  // three doors (ordinary->oneday, day/bonus move, oneday->none) it comes
  // through — resolveSpecialPairWrite is the one place all three are refused
  // by the same rule.
  const submissionCount = db
    .prepare('SELECT COUNT(*) AS n FROM submissions WHERE task_id = ?')
    .get(id).n;
  const pairResolved = resolveSpecialPairWrite({
    rawMode: req.body.special_mode,
    rawDate: req.body.special_date,
    rawBonus: req.body.special_bonus,
    storedDate: task.special_date,
    storedBonus: task.special_bonus,
    submissionCount,
  });
  if (!pairResolved.ok) {
    return redirectWithMsg(
      res,
      '/admin/tasks',
      describeEditPairRefusal(pairResolved.reason),
      'task-' + id
    );
  }
  // The resolved pair IS what gets written — resolveSpecialPairWrite already
  // decided whether that means the stored pair unchanged (a `hidden` write
  // or an absent `special_mode`, criterion 6's partial-POST contract) or the
  // validated posted pair (possibly `(null, null)` for a `none` clear).
  const nextSpecialDate = pairResolved.writeDate;
  const nextSpecialBonus = pairResolved.writeBonus;

  // A posted icon must resolve, or the WHOLE edit is refused (AC1-style
  // validation from POST /admin/tasks/:id/badge) — never silently drop just
  // the badge half of a combined submit. No DB write happens here yet.
  const badgeResolved = resolveBadgeIcon(req.body.badge_icon, req.body.badge_name, {
    required: false,
  });
  if (!badgeResolved.ok) {
    return redirectWithMsg(res, '/admin/tasks', 'That badge icon is not recognized.', 'task-' + id);
  }

  // Atomic (review fix): the task UPDATE and its conditional badge write are
  // one transaction — if setTaskBadge threw, a bare sequential pair could
  // commit the title/worth/mode change alone while leaving the badge half
  // silently un-applied. better-sqlite3 nests transaction functions via
  // SAVEPOINTs, so calling setTaskBadge (itself a db.transaction) from inside
  // this one is safe.
  const saveEdit = db.transaction(() => {
    db.prepare(
      `UPDATE tasks
          SET title = ?, description = ?, worth = ?, special_mode = ?,
              special_date = ?, special_bonus = ?
        WHERE id = ?`
    ).run(title, description, worth, specialMode, nextSpecialDate, nextSpecialBonus, id);

    // No icon AND no name submitted (the common "didn't touch the badge
    // step" case) leaves the badge row completely untouched — same as
    // POST /admin/tasks/:id/badge's own contract for a body carrying neither.
    if (badgeResolved.name || badgeResolved.artPath) {
      taskBadges.setTaskBadge(id, { name: badgeResolved.name, artPath: badgeResolved.artPath });
    }
  });
  saveEdit();

  // A special_mode change can move the active-task set (issue #701 parity).
  // issue #755 review fix: a special_date CHANGE must trigger the same
  // recompute even when the mode string itself is unchanged (e.g. a
  // stale-date repair, or an ordinary/oneday task's date narrowing/widening
  // without a mode flip is not actually possible today, but the pairing rule
  // does not guarantee it never will be) — badges.js's COMPLETIONIST
  // denominator excludes tasks by `special_date IS NULL`, so a date that
  // starts or stops being set can move who holds it even with special_mode
  // untouched. A worth or badge-only edit still never does, so this call
  // stays conditional rather than firing on every save.
  if (specialMode !== task.special_mode || nextSpecialDate !== task.special_date) {
    scoring.recomputeAfterTaskChange();
  }

  redirectWithMsg(res, '/admin/tasks', 'Task updated.', 'task-' + id);
});

// POST /admin/tasks/:id/badge  — set a task's badge name and icon (issue
// #410). The badge-icon picker (src/views/partials/badge-picker.ejs) is the
// ONLY badge source now — no file upload. Body: name (optional — blank
// leaves the existing name unchanged) and icon (a catalog id from
// src/services/badge-icons.js). An unknown/missing icon with no name is
// rejected via the same redirectWithMsg pattern the route used for a
// rejected upload; a name-only submit (icon absent) is still valid and
// leaves art_path unchanged, same as setTaskBadge always allowed.
//
// RETAINED, no longer a live UI path (issue #682 review fix): the picker's
// own submit is now intercepted client-side by admin-tasks.js whenever it was
// opened from the create wizard or the edit popup (the two ONLY ways a host
// reaches the picker today), so in practice this route is never hit from the
// current UI. Kept as a real endpoint anyway for its own direct test coverage
// and as a stable API surface (a future non-JS or automated caller), not
// dead code to prune — a future reader should not "clean this up" expecting
// no caller exists.
router.post('/tasks/:id/badge', (req, res, next) => {
  const id = parseInt(req.params.id, 10);

  // The picker posts application/x-www-form-urlencoded (icon + name), never
  // a file. A multipart request is the old upload path (#410 removed it) —
  // express.urlencoded/json never populate req.body for multipart, so
  // reject explicitly here rather than silently treating it as an empty
  // name-only submit (AC4: "a multipart POST ... is rejected").
  const contentType = req.headers['content-type'] || '';
  if (contentType.indexOf('multipart/form-data') === 0) {
    return redirectWithMsg(
      res,
      '/admin/tasks',
      'Badge art can no longer be uploaded — pick an icon instead.',
      'task-' + id
    );
  }

  const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(id);
  if (!task) {
    return redirectWithMsg(res, '/admin/tasks', 'Task not found.');
  }

  const badgeResolved = resolveBadgeIcon(req.body.icon, req.body.name, { required: false });
  if (!badgeResolved.ok) {
    return redirectWithMsg(res, '/admin/tasks', 'That badge icon is not recognized.', 'task-' + id);
  }

  try {
    taskBadges.setTaskBadge(id, { name: badgeResolved.name, artPath: badgeResolved.artPath });
    redirectWithMsg(res, '/admin/tasks', 'Badge updated.', 'task-' + id);
  } catch (saveErr) {
    next(saveErr);
  }
});

// POST /admin/tasks/:id/delete  — delete a task and its photo files.
// ON DELETE CASCADE removes submission rows AND the task's own badges row,
// but NOT any files on disk. Hard-delete each submission's files first so no
// orphaned originals or thumbnails remain (and so direct-URL access is
// closed — the file is gone).
router.post('/tasks/:id/delete', (req, res) => {
  const id = parseInt(req.params.id, 10);

  // Collect this task's submissions so we can remove their files from disk.
  const subs = db.prepare('SELECT id FROM submissions WHERE task_id = ?').all(id);
  for (const sub of subs) {
    try {
      photos.hardDelete(sub.id);
    } catch (err) {
      // Don't abort the whole delete just because one stray file was already
      // gone; log and continue so the DB row still gets removed.
      console.error('Failed to delete files for submission', sub.id, err);
    }
  }

  // Resolve the task's badge art BEFORE the DELETE below — ON DELETE CASCADE
  // removes the badges row along with the task, and its art_path cannot be
  // read back afterward (issue #501). Uses the non-lazy getTaskBadge (not
  // resolveTaskBadge): a task that was never customized (and never had its
  // admin card rendered) may have no badges row at all, and there is no
  // reason to insert one here just to unlink nothing and immediately cascade
  // it away. unlinkUploadedArt no-ops on the shared default ribbon SVG, same
  // policy as the avatar cleanup above (guest delete).
  const badge = taskBadges.getTaskBadge(id);
  if (badge) {
    try {
      taskBadges.unlinkUploadedArt(badge.art_path);
    } catch (err) {
      console.error('Failed to delete badge art for task', id, err);
    }
  }

  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  // Deleting a task shrinks the active set AND cascades away its
  // submissions, so both metric badges (COMPLETIONIST) and the
  // count-based/transferable badges can move (issue #701 AC4) — run the
  // full all-guests recompute, not a Completionist-only shortcut.
  scoring.recomputeAfterTaskChange();
  // No anchor: the card this id pointed at no longer exists.
  redirectWithMsg(res, '/admin/tasks', 'Task deleted.');
});

// POST /admin/tasks/:id/active  — toggle visibility to guests (writes
// special_mode, issue #727 — the route/param name stays "active" for the
// existing form/URL contract; only the underlying column changed).
//
// RETAINED, no longer a live UI path (issue #682 review fix): the redesign's
// Special radio (None/Hidden/One day only, in the create wizard and the edit
// popup) is now the only host-facing way to change special_mode, and it
// saves through POST /admin/tasks/:id/edit, not this route — no current view
// links or posts here. This is now a SECOND UI-less writer of special_mode
// (the edit route is the other), kept as a stable, independently-tested
// toggle endpoint rather than dead code; a future reader should not assume
// some hidden button still calls it.
//
// Its transitions are NOT a plain none<->hidden flip (issue #755 criterion
// 6): a live task un-hides back to 'oneday', not 'none', when it still
// carries a real special_date, per tasks.isRealDateString() — the one owner
// of that combined shape-and-reality check. Falling back to 'none'
// unconditionally would strand an Aug 9/+3 challenge's date behind a mode
// that no longer marks it as one — isSealed() reads the date, not the mode,
// so guests would keep seeing a locked mystery box for a task the board no
// longer shows as dated. Hiding itself never touches special_date/
// special_bonus at all — hide only ever writes special_mode.
router.post('/tasks/:id/active', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const task = db.prepare('SELECT special_mode, special_date FROM tasks WHERE id = ?').get(id);
  if (!task) {
    return redirectWithMsg(res, '/admin/tasks', 'Task not found.');
  }
  const wasLive = tasks.isTaskLive(task);
  let nextMode;
  if (wasLive) {
    nextMode = tasks.MODE_HIDDEN;
  } else {
    nextMode = tasks.isRealDateString(task.special_date) ? tasks.MODE_ONEDAY : tasks.MODE_NONE;
  }
  db.prepare('UPDATE tasks SET special_mode = ? WHERE id = ?').run(nextMode, id);
  // Un-hiding grows the active set (can strip a now-stale COMPLETIONIST,
  // issue #701 AC2); hiding shrinks it (can award a newly-earned one, AC3).
  // Either direction needs the same all-guests recompute.
  scoring.recomputeAfterTaskChange();
  redirectWithMsg(
    res,
    '/admin/tasks',
    wasLive ? 'Task is now hidden from guests.' : 'Task is now active.',
    'task-' + id
  );
});

// POST /admin/tasks/reorder-all  — issue #682: persist a full drag-reordered
// task-id list in one write. The admin-tasks.js drag handle lets a card land
// at ANY position, so the client posts its whole current on-screen order
// after every drop and this route re-numbers sort_order 0..n-1 to match it
// exactly. Called via fetch (JSON body), not a page form post — a full
// navigation after a drag-drop the DOM already reflects would be a jarring
// reload for no reason, so this is the one XHR-style admin route rather than
// a redirect. (The old neighbor-swap POST /admin/tasks/reorder — up/down/top
// — was REMOVED: the redesign deleted its UI, and its sort_order semantics,
// a swap between two existing values, diverged from this route's contiguous
// 0..n-1 renumbering.)
//
// Body (JSON): { order: [taskId, taskId, ...] } — every entry coerced with
// parseInt; a non-integer entry is dropped.
//
// Set-integrity guard (review fix): the posted id list, once coerced, MUST
// equal the COMPLETE current set of task ids — same length AND every posted
// id an existing task, with no existing task left out. A stale or partial
// post (e.g. a second drag racing an in-flight first one, or a client bug
// that dropped a card) is refused with no rows touched, rather than
// renumbering only the posted subset 0..n-1 and leaving every omitted task's
// sort_order collided at whatever it already was — a silent, hard-to-notice
// data corruption a full-page reload would then render in an arbitrary order.
// The current-set SELECT that guard reads runs INSIDE the same transaction as
// the write below (review fix) — better-sqlite3 is synchronous and this
// process is the only writer, so nothing could interleave between a bare
// SELECT-then-UPDATE today, but nesting the read makes that a structural
// guarantee (the whole check-then-write is one atomic unit) rather than an
// argument that happens to hold given today's single-process deployment.
//
// Pure reorder never changes WHICH tasks are active, only their display
// order, so this does NOT call scoring.recomputeAfterTaskChange().
router.post('/tasks/reorder-all', (req, res) => {
  const order = Array.isArray(req.body.order) ? req.body.order : [];
  const ids = order.map((v) => parseInt(v, 10)).filter((n) => Number.isInteger(n));

  if (ids.length === 0) {
    return res.status(400).json({ ok: false, error: 'No task order provided.' });
  }

  const stmtCurrentIds = db.prepare('SELECT id FROM tasks');
  const stmtSetOrder = db.prepare('UPDATE tasks SET sort_order = ? WHERE id = ?');

  // Returns null on a set-mismatch refusal (nothing to apply), or true once
  // the write has been applied — the route below branches on that instead of
  // throwing/catching, since a refusal here is an ordinary, expected outcome
  // (a racing concurrent host), not an exceptional one.
  const applyOrderIfComplete = db.transaction((idList) => {
    const currentIds = stmtCurrentIds.all().map((row) => row.id);
    const postedSet = new Set(idList);
    const currentSet = new Set(currentIds);
    const isCompleteMatch =
      postedSet.size === idList.length && // no duplicate ids in the posted list
      postedSet.size === currentSet.size &&
      currentIds.every((id) => postedSet.has(id));
    if (!isCompleteMatch) {
      return false;
    }
    idList.forEach((taskId, index) => {
      stmtSetOrder.run(index, taskId);
    });
    return true;
  });

  if (!applyOrderIfComplete(ids)) {
    return res
      .status(400)
      .json({ ok: false, error: 'Posted order does not match the current full task set.' });
  }

  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /admin/photos  — the full guest-gallery-parity screen (issue #259).
//
// view=recent (default): every submission (including taken-down — an admin
//              wall shows everything, moderation state is a visual overlay,
//              not a filter; the guest gallery's own taken-down EXCLUSION does
//              not apply here). No search box (AC3).
// view=fav:    every FAVORITED submission, same "show everything" rule as
//              recent (a photo favorited before a later takedown still shows,
//              marked taken-down, rather than silently vanishing). No search
//              box (AC3).
// view=task:   LIVE (taken-down excluded) submissions grouped by task,
//              q-filtered by heading. Search box shown (AC3).
// view=user:   LIVE submissions grouped by guest, q-filtered by heading.
//              Search box shown (AC3).
// Anything else falls back to recent (HTTP 200, no error) — same contract as
// GET /gallery (src/routes/community.js).
//
// The inline feed panel (src/views/admin-photos.ejs; no separate route per
// the issue's Touches list) always renders the FULL submission set
// (including taken-down, matching Recent) so tapping any tile from any view
// can land on that photo's card.
// ---------------------------------------------------------------------------
const VALID_PHOTO_VIEWS = new Set(['recent', 'task', 'user', 'fav']);

// Partition `list` into groups by `keyFn`, in first-seen order. `list` is
// already newest-first (the caller's SQL ORDER BY), so a group's first-seen
// position is exactly its newest photo's position — no separate "order
// groups by recency" pass is needed, unlike feed.js's grouped() (which also
// caps each group at 6 preview tiles for the guest gallery; the admin wall
// intentionally shows every photo in a group, uncapped, so a host can act on
// any of them).
function groupPhotos(list, keyFn, headingFn) {
  const byKey = new Map();
  const order = [];
  for (const p of list) {
    const key = keyFn(p);
    if (!byKey.has(key)) {
      byKey.set(key, { heading: headingFn(p), photos: [] });
      order.push(key);
    }
    byKey.get(key).photos.push(p);
  }
  return order.map((key) => byKey.get(key));
}

// Attach every comment on each loaded photo, hidden ones included — the admin
// judges a hidden comment in place (struck-through, with Restore). This is NOT
// community.js:attachComments, which is private to that file, filters to
// visible-only (c.taken_down = 0), and is keyed on submission_id rather than
// this route's `id` alias. One grouped query (not one per photo). Oldest-first
// (mirrors community.js:228's ORDER BY) so the view's `_cmts.slice(-2)` surfaces
// the 2 MOST-recent comments, not the 2 oldest. `guest_id`/`name` are carried
// raw so the view links the author to /u/<id> with the same 'Guest' fallback as
// the guest feed.
function attachAdminComments(photoRows) {
  if (photoRows.length === 0) return;
  const placeholders = photoRows.map(() => '?').join(', ');
  const commentRows = db
    .prepare(
      `SELECT c.submission_id AS submission_id,
              c.id            AS id,
              c.body          AS body,
              c.taken_down    AS taken_down,
              g.id            AS guest_id,
              g.name          AS name
         FROM comments c
         JOIN guests g ON g.id = c.guest_id
        WHERE c.submission_id IN (${placeholders})
        ORDER BY c.created_at ASC, c.id ASC`
    )
    .all(...photoRows.map((p) => p.id));

  const bySubmission = new Map();
  for (const row of commentRows) {
    if (!bySubmission.has(row.submission_id)) bySubmission.set(row.submission_id, []);
    bySubmission.get(row.submission_id).push({
      id: row.id,
      guest_id: row.guest_id,
      name: row.name,
      body: row.body,
      hidden: Boolean(row.taken_down),
    });
  }
  for (const p of photoRows) {
    p.comments = bySubmission.get(p.id) || [];
  }
}

router.get('/photos', (req, res) => {
  const view = VALID_PHOTO_VIEWS.has(req.query.view) ? req.query.view : 'recent';
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

  // LEFT JOIN tasks (not JOIN): a memory (issue #247, s.task_id IS NULL) has
  // no task row to join — it must still appear here, with task_title coming
  // back NULL; the view falls back to "a shared memory" / "Memories".
  const photoRows = db
    .prepare(
      `SELECT s.id          AS id,
              s.task_id      AS task_id,
              s.photo_path   AS photo_path,
              s.thumb_path   AS thumb_path,
              s.caption      AS caption,
              s.taken_down   AS taken_down,
              s.resubmitted  AS resubmitted,
              s.photo_bonus  AS photo_bonus,
              s.created_at   AS created_at,
              g.id           AS guest_id,
              g.name         AS guest_name,
              t.title        AS task_title
         FROM submissions s
         JOIN guests g ON g.id = s.guest_id
         LEFT JOIN tasks  t ON t.id = s.task_id
        ORDER BY s.created_at DESC, s.id DESC`
    )
    .all();

  // Real favorite + badge-winner state, attached once so every derived view
  // below (and the inline feed) shares the same row objects — no view can
  // disagree with another about a given photo's state within one request.
  const favIds = favoritesSvc.favoriteIdSet();
  for (const p of photoRows) {
    p._fav = favIds.has(p.id);
    p._winnerCodes = photoBadges.winnerCodesFor(p.id);
    p._badged = p._winnerCodes.length > 0;
  }

  // Attach every comment (hidden ones included) to each photo — the admin
  // judges a hidden comment in place. See attachAdminComments above.
  attachAdminComments(photoRows);

  const favorites = photoRows.filter((p) => p._fav);

  let groups = [];
  if (view === 'task' || view === 'user') {
    const livePhotos = photoRows.filter((p) => !p.taken_down);
    groups =
      view === 'task'
        ? groupPhotos(
            livePhotos,
            (p) => (p.task_id == null ? 'memory' : 't' + p.task_id),
            (p) => p.task_title || 'Memories'
          )
        : groupPhotos(
            livePhotos,
            (p) => 'g' + p.guest_id,
            (p) => p.guest_name || 'Guest #' + p.guest_id
          );
    if (q !== '') {
      const needle = q.toLowerCase();
      groups = groups.filter((g) => g.heading.toLowerCase().includes(needle));
    }
  }

  res.render('admin-photos', {
    title: 'Photos',
    photos: photoRows,
    favorites,
    groups,
    view,
    q,
    badgeCatalog: photoBadges.catalogWithCounts(),
    msg: req.query.msg || '',
    isAdmin: true,
  });
});

// POST /admin/photos/:id/takedown  — hide a photo. photos.hideSubmission is the
// single writer of taken_down for moderation: it flips the flag and recomputes
// the guest's auto-badges in one transaction, so a hidden photo can never keep
// counting toward points or auto-badges even for an instant. Reachable from
// the give-a-badge dialog's moderate control (issue #259 AC7).
router.post('/photos/:id/takedown', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const guestId = photos.hideSubmission(id);
  if (guestId === undefined) {
    return redirectToPhotos(req, res, 'Submission not found.', id);
  }
  redirectToPhotos(req, res, 'Photo taken down.', id);
});

// POST /admin/photos/:id/restore  — unhide a photo. photos.restoreSubmission
// flips the flag and recomputes the guest's auto-badges in one transaction —
// see the takedown route above. Reachable from the same give-a-badge dialog
// control (issue #259 AC7).
router.post('/photos/:id/restore', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const guestId = photos.restoreSubmission(id);
  if (guestId === undefined) {
    return redirectToPhotos(req, res, 'Submission not found.', id);
  }
  redirectToPhotos(req, res, 'Photo restored.', id);
});

// POST /admin/photos/:id/favorite  — toggle the host-scoped favorite flag on
// a photo (issue #259 AC4). Reachable from a tile's heart or the inline
// feed's heart, both real form posts (favorites.js persists it, so it survives
// a reload — no client-only state).
router.post('/photos/:id/favorite', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const submission = db.prepare('SELECT id FROM submissions WHERE id = ?').get(id);
  if (!submission) {
    return redirectToPhotos(req, res, 'Submission not found.', id);
  }
  const nowFavorited = favoritesSvc.toggleFavorite(id);
  redirectToPhotos(req, res, nowFavorited ? 'Added to favorites.' : 'Removed from favorites.', id);
});

// POST /admin/photos/:id/badge  — award OR remove a photo as one of a
// give-a-badge category's winners (issue #259 AC6/AC8).
// Body: code = one of the five photo-badges.js catalog codes,
//       action = "award", "remove", or "toggle" ("toggle" resolves against
//       the photo's current winner state server-side, mirroring POST
//       /admin/guests/:id/badge's own toggle action — the dialog's Award/
//       Remove label is a client-side hint, not the source of truth, so a
//       stale label can never award/remove the wrong direction).
// Writes NO points (points/ranking are issue #661 — this table only records
// "who's a candidate winner").
router.post('/photos/:id/badge', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const code = (req.body.code || '').trim().toUpperCase();
  const action = (req.body.action || 'toggle').trim();

  const submission = db.prepare('SELECT id FROM submissions WHERE id = ?').get(id);
  if (!submission) {
    return redirectToPhotos(req, res, 'Submission not found.', id);
  }
  if (!photoBadges.isValidCode(code)) {
    return redirectToPhotos(req, res, 'Unknown badge.', id);
  }

  let effective = action;
  if (effective !== 'award' && effective !== 'remove') {
    effective = photoBadges.isWinner(code, id) ? 'remove' : 'award';
  }

  const name = photoBadges.badgeName(code);
  if (effective === 'remove') {
    photoBadges.remove(code, id);
    redirectToPhotos(req, res, 'Removed "' + name + '" badge.', id);
  } else {
    photoBadges.award(code, id);
    redirectToPhotos(req, res, 'Awarded "' + name + '".', id);
  }
});

// POST /admin/photos/:id/points  — RETIRED (issue #684). The owner called the
// freeform per-photo points override "unfair" — this write path is gone, not
// merely unlinked: registered to renderNotFound so a stale form/bookmark gets
// a real 404, not a fall-through 302 to /join (see renderNotFound's own doc
// comment above). submissions.photo_bonus itself, and any value a host
// already set through this route before it retired, are untouched and still
// count in scoring (src/services/scoring.js still reads the column) — only
// the write path is gone.
router.post('/photos/:id/points', renderNotFound);

// ---------------------------------------------------------------------------
// GET /admin/comments  — RETIRED (issue #684). Comment moderation now happens
// in context, under each photo in GET /admin/photos (real per-photo comments
// attached above, hidden ones included), not on a separate all-comments page.
// Registered to renderNotFound, not merely left unregistered, so this path
// returns a real 404 instead of falling through into guest.js's requireGuest
// and coming back a 302 to /join (see renderNotFound's own doc comment
// above).
// ---------------------------------------------------------------------------
router.get('/comments', renderNotFound);

// POST /admin/comments/:id/hide  — hide a comment (taken_down = 1).
//
// Comment moderation uses "hide", not the "takedown" verb the photo routes
// use, because the two actions are not the same operation. A photo takedown
// removes a SCORED submission: it must recompute the guest's auto-badges in a
// transaction (photos.hideSubmission), because a hidden photo can no longer
// count toward points or badges. A comment carries no score and no badge, so
// hiding one is lighter, text-only moderation — a plain taken_down flag flip
// with no scoring side effect. The different verb marks the different weight.
//
// Redirects via redirectToPhotos (issue #684), not the removed /admin/comments
// page: reads back the comment's own submission_id so the host lands on the
// photos feed at that photo's card (#feed-photo-<id>) when the form's hidden
// panel field is "feed" — never a dead page.
router.post('/comments/:id/hide', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const comment = db.prepare('SELECT id, submission_id FROM comments WHERE id = ?').get(id);
  if (!comment) {
    return redirectToPhotos(req, res, 'Comment not found.');
  }
  db.prepare('UPDATE comments SET taken_down = 1 WHERE id = ?').run(id);
  redirectToPhotos(req, res, 'Comment hidden.', comment.submission_id);
});

// POST /admin/comments/:id/restore  — restore a hidden comment (taken_down = 0).
// Same redirect-to-the-feed-card shape as hide, above (issue #684).
router.post('/comments/:id/restore', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const comment = db.prepare('SELECT id, submission_id FROM comments WHERE id = ?').get(id);
  if (!comment) {
    return redirectToPhotos(req, res, 'Comment not found.');
  }
  db.prepare('UPDATE comments SET taken_down = 0 WHERE id = ?').run(id);
  redirectToPhotos(req, res, 'Comment restored.', comment.submission_id);
});

// ---------------------------------------------------------------------------
// GET /admin/bugs  — bug report queue (issue #245). Unresolved reports first
// (newest first within that group), then resolved reports collapsed at the
// bottom (also newest first) — one ORDER BY does both: resolved=0 sorts
// before resolved=1, and created_at DESC breaks ties inside each group.
// ---------------------------------------------------------------------------
router.get('/bugs', (req, res) => {
  const reports = db
    .prepare(
      `SELECT r.id          AS id,
              r.body        AS body,
              r.page        AS page,
              r.resolved    AS resolved,
              r.created_at  AS created_at,
              g.id          AS guest_id,
              g.name        AS guest_name
         FROM bug_reports r
         JOIN guests g ON g.id = r.guest_id
        ORDER BY r.resolved ASC, r.created_at DESC, r.id DESC`
    )
    .all();

  res.render('admin-bugs', {
    title: 'Bugs',
    reports,
    msg: req.query.msg || '',
    isAdmin: true,
  });
});

// POST /admin/bugs/:id/resolve  — mark a bug report resolved. One-way (there
// is no "reopen" affordance per the design), so this always sets resolved to
// 1 rather than toggling.
router.post('/bugs/:id/resolve', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const report = db.prepare('SELECT id FROM bug_reports WHERE id = ?').get(id);
  if (!report) {
    return redirectWithMsg(res, '/admin/bugs', 'Bug report not found.');
  }
  db.prepare('UPDATE bug_reports SET resolved = 1 WHERE id = ?').run(id);
  redirectWithMsg(res, '/admin/bugs', 'Bug report resolved.');
});

// ---------------------------------------------------------------------------
// GET /admin/export  — one-click export: streams a ZIP (per-guest photo folders)
// plus summary.xlsx. Defined per 09-export.md. Protected by requireAdmin
// (applied to this router above), so this route is too.
// ---------------------------------------------------------------------------
router.get('/export', async (req, res, next) => {
  try {
    await streamExportZip(res);
  } catch (err) {
    // If nothing has been sent yet, hand off to the Express error handler.
    if (!res.headersSent) {
      next(err);
    } else {
      console.error('[admin/export] failed mid-stream:', err);
      res.destroy(err);
    }
  }
});

module.exports = router;
