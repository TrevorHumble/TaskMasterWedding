// src/routes/admin.js
// Admin router. Every route here is behind requireAdmin (applied below).
// Routes:
//   GET  /admin                          dashboard (issue #646: live checklist)
//   POST /admin/checklist/:id/toggle     toggle a manual checklist item (issue #646)
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
const eventDaysSvc = require('../services/event-days');
const {
  timezoneOptions,
  isKnownTimezone,
  resolveSelectedZone,
  eventDays: computeEventDays,
  singleDayLabel,
} = eventDaysSvc;
const hostChecklist = require('../services/host-checklist');

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
// Recent. Every mutating admin-photos form carries hidden `view`/`q`/`panel`/
// `task` fields (src/views/admin-photos.ejs) so a POST from a filtered/grouped
// view, from inside the inline feed, or from a scoped view=task&task=<id>
// request (issue #748), lands back exactly there. `panel=feed` additionally
// anchors the redirect at the acted-on photo's feed card (#feed-photo-<id>)
// so the give-a-badge/favorite dialog's own JS can detect the fragment on
// load and re-open the feed scrolled to it (see the bottom-of-page <script>
// in admin-photos.ejs).
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
  // Task scope (issue #748) — read the same way view/q/panel are read, and
  // carried through only when posted and non-empty, so a pre-#748 POST (no
  // `task` field at all — e.g. the not-found-guard fixtures in
  // tests/admin-photos-ui.test.js and tests/admin-moderation-guards.test.js)
  // produces the exact same URL it produced before this issue.
  const task = typeof req.body.task === 'string' ? req.body.task.trim() : '';

  const parts = [];
  if (view) parts.push('view=' + encodeURIComponent(view));
  if (q) parts.push('q=' + encodeURIComponent(q));
  if (task) parts.push('task=' + encodeURIComponent(task));
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
  // The flat checklist (issue #646): host-checklist.js is the single owner
  // of row definitions, bucket ordering, the bug pin, and the tips gate — it
  // already walks guests/tasks/bug_reports to build those rows, so it is
  // also the single owner of the three stat-grid counts (`stats`, issue #646
  // review fix). This route consumes buildRows() once and re-queries none of
  // its tables itself.
  const { rows, openCount, urgentCount, stats } = hostChecklist.buildRows();

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
    counts: { guests: stats.guests, activeTasks: stats.activeTasks },
    openBugs: stats.openBugs,
    lastPhoto,
    rows,
    openCount,
    urgentCount,
    msg: req.query.msg || '',
    isAdmin: true,
  });
});

// ---------------------------------------------------------------------------
// POST /admin/checklist/:id/toggle  — flip one manual checklist item's
// checked state (issue #646 AC5). The only writer of `settings` keys
// `checklist.<id>`.
//
// Writes the OPPOSITE of the `checked` field the form posts back (issue #646
// review fix), not the opposite of a fresh isManualChecked() read at request
// time — the form's hidden `checked` field carries the state the page
// rendered WITH, so a double-tap (two rapid submits of the same rendered
// button, before the first redirect lands) posts the identical `checked`
// value twice and both requests compute the identical target state, landing
// idempotently instead of one flip cancelling the other. A malformed or
// missing `checked` field (a stale/hand-crafted POST) falls back to the
// current DB read, matching the old toggle-on-read behavior rather than
// refusing the request.
// ---------------------------------------------------------------------------
router.post('/checklist/:id/toggle', (req, res) => {
  const id = req.params.id;
  if (!hostChecklist.isValidManualId(id)) {
    return redirectWithMsg(res, '/admin', 'Unknown checklist item.');
  }
  const postedChecked = req.body.checked;
  const asRendered =
    postedChecked === '1' || postedChecked === '0'
      ? postedChecked === '1'
      : hostChecklist.isManualChecked(id);
  hostChecklist.setManualChecked(id, !asRendered);
  redirectWithMsg(res, '/admin', 'Checklist updated.', 'checklist');
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
//
// Exception (issue #650): POST /tasks/:id/edit's one-day locked-refusal
// branch additionally applies the lucky-pair CLEAR even when this exact
// refusal fires (a save cancelling an existing lucky pick via Special=None
// on a row whose one-day pair is separately locked) — see that route's own
// comment for why the lucky clear cannot wait for a door the lock never
// opens.
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

// ---------------------------------------------------------------------------
// The lucky pair (issue #650) — its OWN resolver, deliberately NOT folded
// into resolveSpecialPairWrite above. That function is documented as "the
// one place all three [one-day doors] are refused by the same rule", and its
// caller turns a single ok:false into an early return that writes nothing —
// threading a second pair through it would mean one refusal verdict covering
// two INDEPENDENT decisions. Concretely, that trap is: a task can carry BOTH
// a past special_date and a lucky_date at once (a past challenge is not
// spokenFor, so the exclusivity guard below permits lucky on it); cancelling
// the lucky pick via Special=None also makes the one-day pair "changed"
// (clearing it), and with submissions present the one-day LOCK would refuse
// the WHOLE save under one shared verdict — stranding lucky_date forever,
// with no door left to cancel it through ("One day only" refused by
// exclusivity, "Hidden" leaves lucky_date intact by design, "None" bounces).
// See POST /tasks/:id/edit below for how the two resolvers' verdicts are
// combined to close that trap.
// ---------------------------------------------------------------------------
const LUCKY_REASON_INVALID_DATE = 'lucky_invalid_date';
const LUCKY_REASON_INVALID_BONUS = 'lucky_invalid_bonus';

// The ONE owner of "would this save touch the (lucky_date, lucky_bonus)
// pair, and if so is that touch allowed, and what is the pair afterward" —
// the lucky counterpart to resolveSpecialPairWrite above, sharing its exact
// shape (writes/pairChanged/resolved-pair) but never its lock: a lucky
// bonus is BANKED onto the submission row at submit time (canon rule 11), so
// clearing or changing lucky_date/lucky_bonus can never re-score a photo a
// guest already posted — there is nothing here for a submission-count lock
// to protect, unlike the one-day pair's retroactive on-day bonus.
//
// Branches on the RAW posted special_mode, never the normalized value, for
// the same reason resolveSpecialPairWrite does: a 'lucky' write sources the
// resolved pair from rawDate/rawBonus; a 'none' write clears it (both null —
// the host's ONLY cancel path, AC4); 'hidden' or an absent/other value
// leaves the pair exactly as currently stored (a lucky task can be hidden
// with its pick intact — "Deliberate omissions, recorded" in the issue).
//
// @param {object} opts
// @param {unknown} opts.rawMode - req.body.special_mode, unmodified.
// @param {unknown} opts.rawDate - req.body.lucky_date, unmodified.
// @param {unknown} opts.rawBonus - req.body.lucky_bonus, unmodified.
// @param {string|null|undefined} opts.storedDate - the task's CURRENT
//   lucky_date, or `undefined` on CREATE (no stored task yet).
// @param {number|null|undefined} opts.storedBonus - the task's CURRENT
//   lucky_bonus, or `undefined` on CREATE.
// @returns {{ok: true, writeDate: string|null, writeBonus: number|null}
//   | {ok: false, reason: 'lucky_invalid_date'|'lucky_invalid_bonus'}}
function resolveLuckyPairWrite({ rawMode, rawDate, rawBonus, storedDate, storedBonus }) {
  const writes = rawMode === tasks.SPECIAL_LUCKY || rawMode === tasks.MODE_NONE;

  let writeDate = null;
  let writeBonus = null;
  if (rawMode === tasks.SPECIAL_LUCKY) {
    writeDate = typeof rawDate === 'string' && rawDate.trim() ? rawDate.trim() : null;
    const parsedBonus = parseInt(rawBonus, 10);
    writeBonus = Number.isInteger(parsedBonus) ? parsedBonus : null;
  }

  const pairChanged = writes && (writeDate !== storedDate || writeBonus !== storedBonus);

  // Validated only when the pair actually CHANGED (mirroring the one-day
  // pair's own pairChanged-gated validation) — this is what lets the lucky
  // stale-date hidden input (admin-tasks.js) survive a host narrowing the
  // wedding dates after picking a lucky day: a re-posted, no-longer-configured
  // lucky_date that matches what is already stored is NOT a change, so it is
  // never bounced by a title-only edit.
  if (rawMode === tasks.SPECIAL_LUCKY && pairChanged) {
    if (!isConfiguredEventDay(writeDate)) {
      return { ok: false, reason: LUCKY_REASON_INVALID_DATE };
    }
    if (
      writeBonus === null ||
      writeBonus < tasks.LUCKY_MIN_BONUS ||
      writeBonus > tasks.LUCKY_MAX_BONUS
    ) {
      return { ok: false, reason: LUCKY_REASON_INVALID_BONUS };
    }
  }

  const resolvedDate = writes ? writeDate : (storedDate ?? null);
  const resolvedBonus = writes ? writeBonus : (storedBonus ?? null);
  return { ok: true, writeDate: resolvedDate, writeBonus: resolvedBonus };
}

// Word a resolveLuckyPairWrite refusal for the HOST-FACING create flash
// message — CREATE-specific wording mirrors describeCreatePairRefusal's own
// "your task was not created" framing, for the identical reason: a refused
// lucky pair on create writes NO task row at all.
function describeCreateLuckyRefusal(reason) {
  switch (reason) {
    case LUCKY_REASON_INVALID_DATE:
      return 'Choose one of the configured wedding days for the lucky pick — your task was not created.';
    case LUCKY_REASON_INVALID_BONUS:
      return 'Choose a secret bonus of +1, +2, or +3 — your task was not created.';
    default:
      return 'That lucky day/bonus could not be saved — your task was not created.';
  }
}

// Word a resolveLuckyPairWrite refusal for the HOST-FACING edit flash
// message — mirrors describeEditPairRefusal's own scoped-to-the-pair
// framing (no LOCKED case here: lucky is never locked, see
// resolveLuckyPairWrite's own comment).
function describeEditLuckyRefusal(reason) {
  switch (reason) {
    case LUCKY_REASON_INVALID_DATE:
      return 'Choose one of the configured wedding days for the lucky pick.';
    case LUCKY_REASON_INVALID_BONUS:
      return 'Choose a secret bonus of +1, +2, or +3.';
    default:
      return 'That lucky day/bonus could not be saved.';
  }
}

// ---------------------------------------------------------------------------
// The flash trio (issue #763) — its OWN resolver, following the exact shape
// resolveSpecialPairWrite/resolveLuckyPairWrite already establish (report
// reason CODES, never sentences; validate BEFORE any write; leave the task's
// stored trio untouched on any refusal), but never folded into either of
// them: flash is never a stored special_mode member (src/services/tasks.js's
// MODES comment), its trio is never locked by an existing submission (a
// flash bonus is banked on the submission row at submit time, same reasoning
// resolveLuckyPairWrite's own comment gives for lucky), and it carries its
// own no-op rule the day/bonus pairs above do not need (see the wire-format
// note below).
// ---------------------------------------------------------------------------
const FLASH_REASON_INVALID_MINUTES = 'invalid_minutes';
const FLASH_REASON_INVALID_BONUS = 'invalid_bonus';
const FLASH_REASON_INVALID_DAY = 'invalid_day';
const FLASH_REASON_INVALID_TIME = 'invalid_time';
const FLASH_REASON_PAST_INSTANT = 'past_instant';
const FLASH_REASON_NOT_LIVE = 'not_live';

// The <input type="time"> shape, HH:MM 24-hour (issue #763 criterion 4) — the
// one shape check run before a posted flash_time reaches
// event-days.js's eventLocalInstant(), so a blank or malformed time (the field
// carries no `required`, so "Pick a time" left blank posts "") is refused
// here rather than reaching `new Date(NaN).toISOString()`, which throws a
// RangeError and would 500 the save.
const FLASH_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// A posted field parsed as a non-negative WHOLE integer, or null for
// anything that isn't exactly that shape (missing, blank, negative, a
// decimal, or non-numeric) — deliberately stricter than parseInt() alone,
// which would accept "5.5" (parses to 5) or "5abc" (parses to 5) as valid.
// Shared by flash_minutes and flash_bonus below: both are free-entry-shaped
// fields issue #763's own criterion 4 says must "refuse loudly rather than
// coerce to a default", unlike tasks.normalizeWorth's forgiving parseInt.
function parseWholeNumber(raw) {
  if (raw == null) return null;
  const str = String(raw).trim();
  if (!/^\d+$/.test(str)) return null;
  return parseInt(str, 10);
}

/**
 * The ONE owner of "would this save touch the flash trio (flash_bonus,
 * flash_minutes, flash_start_at), and if so is that touch allowed, and what
 * is the trio afterward" (issue #763 plan step 2) — the flash counterpart to
 * resolveSpecialPairWrite/resolveLuckyPairWrite above. Called by both the
 * create and edit routes before any write.
 *
 * Branches on the RAW posted special_mode, mirroring the two pair resolvers:
 * `flash_cancel=1` short-circuits EVERY other flash field and refusal code
 * (wire format table) and returns first, before `rawMode` is even read — the
 * Cancel button submits the same form as Save, so a host who left the
 * duration empty must still be able to end a running window. A `none` write
 * clears the whole trio (the same convention resolveLuckyPairWrite already
 * follows for the lucky pair — otherwise a host who set the task back to
 * None would watch the board keep counting down). `hidden`, `oneday`,
 * `lucky`, or an absent/unrecognized special_mode leaves the trio untouched.
 * Only `flash` itself is an arm/re-arm attempt.
 *
 * The no-op rule (issue #763 "Wire format" section — load-bearing scope,
 * read that section before touching this): on a task whose flash is
 * PRESENTLY `scheduled` or `active` (tasks.flashState against `clock.nowMs`),
 * a posted bonus and duration that both equal the STORED values, with Starts
 * left on `now`, is a no-op on the window — `flash_start_at` is returned
 * UNCHANGED rather than re-derived from `clock.nowMs`. This only runs on
 * EDIT (`storedRow` present — CREATE has nothing to compare against) and
 * never on an EXPIRED or unarmed flash (criterion 1: a task whose window has
 * expired is always a real re-arm — the trio survives expiry by design, and
 * the status strip/Cancel escape this rule leans on does not render on an
 * expired flash). `not_live` is NOT checked for a no-op save (see below) —
 * only a genuine arm/re-arm can be refused for a hidden task; resaving an
 * already-armed task's title must not suddenly break because the host later
 * hid it through the Hidden radio (which never touches this trio).
 *
 * @param {object} opts
 * @param {unknown} opts.rawMode - req.body.special_mode, unmodified.
 * @param {unknown} opts.rawCancel - req.body.flash_cancel, unmodified.
 * @param {unknown} opts.rawBonus - req.body.flash_bonus, unmodified.
 * @param {unknown} opts.rawMinutes - req.body.flash_minutes, unmodified.
 * @param {unknown} opts.rawStartMode - req.body.flash_start_mode, unmodified.
 * @param {unknown} opts.rawDate - req.body.flash_date, unmodified.
 * @param {unknown} opts.rawTime - req.body.flash_time, unmodified.
 * @param {object|undefined} opts.storedRow - the task's CURRENT row
 *   (flash_bonus/flash_minutes/flash_start_at read off it), or `undefined`
 *   on CREATE (no stored task yet).
 * @param {string} opts.resolvedSpecialMode - the special_mode value THIS
 *   save is actually going to write (tasks.normalizeMode's own output) —
 *   what `not_live` checks liveness against, via tasks.isTaskLive(), never a
 *   hand-written predicate.
 * @param {{todayIso: string, nowMs: number}} opts.clock
 * @param {string} opts.timezone - #681's configured event timezone; the
 *   ONE zone a "Pick a time" day+time pair is interpreted in.
 * @returns {{ok: true, writeBonus: number|null, writeMinutes: number|null, writeStartAt: string|null}
 *   | {ok: false, reason: 'invalid_minutes'|'invalid_bonus'|'invalid_day'|'invalid_time'|'past_instant'|'not_live'}}
 */
function resolveFlashWrite({
  rawMode,
  rawCancel,
  rawBonus,
  rawMinutes,
  rawStartMode,
  rawDate,
  rawTime,
  storedRow,
  resolvedSpecialMode,
  clock,
  timezone,
}) {
  if (rawCancel === '1') {
    return { ok: true, writeBonus: null, writeMinutes: null, writeStartAt: null };
  }

  const stored = storedRow || {};
  const storedTrio = {
    writeBonus: stored.flash_bonus ?? null,
    writeMinutes: stored.flash_minutes ?? null,
    writeStartAt: stored.flash_start_at ?? null,
  };

  if (rawMode === tasks.MODE_NONE) {
    return { ok: true, writeBonus: null, writeMinutes: null, writeStartAt: null };
  }
  if (rawMode !== tasks.SPECIAL_FLASH) {
    return { ok: true, ...storedTrio };
  }

  // rawMode === 'flash' from here on: an arm or re-arm attempt.
  const minutes = parseWholeNumber(rawMinutes);
  // The floor (a positive integer) is owned by tasks.flashWindow() (issue
  // #763 PR review fix, M4) — probing it with the candidate minutes against
  // a known-valid bonus and instant makes flashWindow() itself the validity
  // oracle for "is this a duration the engine will ever pay", rather than
  // re-stating its floor as a bare `minutes < 1` here. Without this, a future
  // move of the engine's floor would let the writer save a trio the engine
  // then refuses to ever fire, with no error anywhere. The probe's bonus/
  // instant are fixed to known-good values so a null result here can only
  // mean `minutes` itself failed the engine's own check — `bonus` is
  // resolved and checked separately, immediately below.
  const minutesProbe = tasks.flashWindow({
    flash_start_at: new Date(clock.nowMs).toISOString(),
    flash_minutes: minutes,
    flash_bonus: tasks.FLASH_MIN_BONUS,
  });
  if (minutesProbe === null) {
    return { ok: false, reason: FLASH_REASON_INVALID_MINUTES };
  }
  const bonus = parseWholeNumber(rawBonus);
  if (bonus === null || bonus < tasks.FLASH_MIN_BONUS || bonus > tasks.FLASH_MAX_BONUS) {
    return { ok: false, reason: FLASH_REASON_INVALID_BONUS };
  }
  const startMode = rawStartMode === 'later' ? 'later' : 'now';

  if (storedRow && startMode === 'now') {
    const currentState = tasks.flashState(stored, clock.nowMs);
    const isReplayable =
      currentState === tasks.FLASH_SCHEDULED || currentState === tasks.FLASH_ACTIVE;
    if (isReplayable && bonus === stored.flash_bonus && minutes === stored.flash_minutes) {
      return { ok: true, ...storedTrio };
    }
  }

  // Only a genuine arm/re-arm reaches this liveness gate (issue #763 AC4) —
  // consumes tasks.isTaskLive(), never a hand-written predicate, against the
  // special_mode value THIS save is actually about to write.
  if (!tasks.isTaskLive({ special_mode: resolvedSpecialMode })) {
    return { ok: false, reason: FLASH_REASON_NOT_LIVE };
  }

  let startAtMs;
  if (startMode === 'now') {
    startAtMs = clock.nowMs;
  } else {
    const day = typeof rawDate === 'string' ? rawDate.trim() : '';
    if (!isConfiguredEventDay(day)) {
      return { ok: false, reason: FLASH_REASON_INVALID_DAY };
    }
    const time = typeof rawTime === 'string' ? rawTime.trim() : '';
    const match = FLASH_TIME_RE.exec(time);
    if (!match) {
      return { ok: false, reason: FLASH_REASON_INVALID_TIME };
    }
    const hour = parseInt(match[1], 10);
    const minute = parseInt(match[2], 10);
    startAtMs = eventDaysSvc.eventLocalInstant(day, timezone, hour, minute).getTime();
  }

  if (startAtMs < clock.nowMs) {
    return { ok: false, reason: FLASH_REASON_PAST_INSTANT };
  }

  const writeStartAt = new Date(startAtMs).toISOString();
  // Defensive (issue #763 plan step 2 — this resolver "consumes
  // tasks.isValidFlashInstant()"): Date#toISOString() emits the pinned
  // 4-digit-year shape for every ordinary date, but NOT for one past year
  // 9999 — toISOString() switches to an expanded `+010000-01-01T...` form
  // there. That branch is NOT reachable through any current input: a year
  // >= 10000 can never be a configured event day, because
  // tasks.isRealDateString gates every one of them on a 4-digit-year regex
  // (and year 9999 itself still emits the pinned shape). Asserting here,
  // rather than only trusting construction, means that extreme case — or a
  // future refactor that changes how startAtMs becomes a string — cannot
  // silently start writing a value #761's flashState() would read as 'none'
  // forever.
  if (!tasks.isValidFlashInstant(writeStartAt)) {
    throw new Error(`resolveFlashWrite: constructed an invalid flash instant ${writeStartAt}`);
  }

  return { ok: true, writeBonus: bonus, writeMinutes: minutes, writeStartAt };
}

// Word a resolveFlashWrite refusal for the HOST-FACING create flash
// message — CREATE-specific wording mirrors describeCreatePairRefusal's own
// "your task was not created" framing (a refused create writes no task row
// of any kind).
function describeCreateFlashRefusal(reason) {
  switch (reason) {
    case FLASH_REASON_INVALID_MINUTES:
      return 'Enter a whole number of minutes (1 or more) for the flash — your task was not created.';
    case FLASH_REASON_INVALID_BONUS:
      return 'Choose a flash bonus of +1, +2, or +3 — your task was not created.';
    case FLASH_REASON_INVALID_DAY:
      return 'Choose one of the configured wedding days for the flash to start — your task was not created.';
    case FLASH_REASON_INVALID_TIME:
      return 'Choose a time for the flash to start — your task was not created.';
    case FLASH_REASON_PAST_INSTANT:
      return "That flash start time has already passed — your task wasn't created.";
    case FLASH_REASON_NOT_LIVE:
      return 'A hidden task cannot carry a flash — your task was not created.';
    default:
      return 'That flash could not be saved — your task was not created.';
  }
}

// Word a resolveFlashWrite refusal for the HOST-FACING edit flash message —
// EDIT-specific wording mirrors describeEditPairRefusal's own scoped-to-the-
// field framing (nothing else about the task is discarded).
function describeEditFlashRefusal(reason) {
  switch (reason) {
    case FLASH_REASON_INVALID_MINUTES:
      return 'Enter a whole number of minutes (1 or more) for the flash.';
    case FLASH_REASON_INVALID_BONUS:
      return 'Choose a flash bonus of +1, +2, or +3.';
    case FLASH_REASON_INVALID_DAY:
      return 'Choose one of the configured wedding days for the flash to start.';
    case FLASH_REASON_INVALID_TIME:
      return 'Choose a time for the flash to start.';
    case FLASH_REASON_PAST_INSTANT:
      return 'That flash start time has already passed.';
    case FLASH_REASON_NOT_LIVE:
      return 'A hidden task cannot carry a flash — un-hide it first.';
    default:
      return 'That flash could not be saved.';
  }
}

// The exclusivity guard's first production callers (issue #650 plan step 3 —
// tasks.whatSpecial's own doc comment, src/services/tasks.js, names this
// exact call site as the reason it ships with no production caller yet).
// Runs from both the create and edit handlers below, whenever the posted RAW
// special_mode itself names a special kind — 'oneday' (checked against
// tasks.SPECIAL_DAILY), 'lucky' (tasks.SPECIAL_LUCKY), or 'flash' (issue
// #763, tasks.SPECIAL_FLASH) — and is SKIPPED for 'none'/'hidden', which must
// stay the host's cancel/hide paths and never get refused by this guard.
// `currentRow` is `{}` on CREATE (no stored task yet,
// so tasks.whatSpecial always answers null and this is vacuous by
// construction) and the real row on EDIT — where it naturally never refuses
// a task re-saving the SAME kind it already is (whatSpecial(task, clock)
// reflects the task's OWN current data, so it can only disagree with
// `settingKind` when a DIFFERENT rule already owns the row: e.g. a task
// already lucky (a live lucky_date) that the host tries to date as One day
// only — AC7(c)'s "reverse" case).
//
// @param {object} currentRow - the task's current row, or {} on CREATE.
// @param {{todayIso: string, nowMs: number}} clock
// @param {string} settingKind - one of tasks.SPECIAL_DAILY/SPECIAL_FLASH/
//   SPECIAL_LUCKY — the exported constant, never derived from the posted
//   special_mode (neither flash nor lucky stores one to derive it from).
// @returns {{ok: true} | {ok: false, existingKind: string}}
function checkExclusivity(currentRow, clock, settingKind) {
  const existingKind = tasks.whatSpecial(currentRow, clock);
  if (existingKind && existingKind !== settingKind) {
    return { ok: false, existingKind };
  }
  return { ok: true };
}

// The ONE place a posted RAW special_mode maps to the SPECIAL_* kind
// checkExclusivity is asked to guard (issue #650 PR review fix, Finding C).
// Before this helper existed, the create and edit handlers each carried an
// identical, hand-written ternary doing this same mapping — character-for-
// character duplicated, with no shared owner, so a third special type would
// have to edit both by hand and nothing would fail if only one copy were
// updated (the create-side copy is vacuous by construction today — CREATE
// has no stored row, so the guard it feeds never refuses anything — which is
// exactly why a missed update there would go unnoticed). Returns null for
// 'none'/'hidden'/anything else — the guard is skipped entirely for those,
// never called with a null settingKind.
//
// @param {unknown} rawMode - req.body.special_mode, unmodified.
// @returns {string|null} one of tasks.SPECIAL_DAILY/SPECIAL_FLASH/
//   SPECIAL_LUCKY, or null.
function specialKindBeingSet(rawMode) {
  if (rawMode === tasks.MODE_ONEDAY) return tasks.SPECIAL_DAILY;
  if (rawMode === tasks.SPECIAL_LUCKY) return tasks.SPECIAL_LUCKY;
  // Issue #763 plan step 3: teach the existing mapper about flash's raw
  // sentinel too — before this, a flash arm skipped the guard entirely (this
  // function returned null for 'flash', so checkExclusivity was never even
  // called), letting a flash get armed on top of an already-live one-day-only
  // challenge or the lucky task with no refusal anywhere.
  if (rawMode === tasks.SPECIAL_FLASH) return tasks.SPECIAL_FLASH;
  return null;
}

// Word an exclusivity refusal, naming what the task already is (AC7's own
// wording requirement) — the one message both the one-day and lucky setters
// share, since the refusal is symmetric ("already X" reads correctly from
// either direction).
function describeExclusivityRefusal(existingKind) {
  const label =
    existingKind === tasks.SPECIAL_DAILY
      ? 'a one-day-only challenge'
      : existingKind === tasks.SPECIAL_FLASH
        ? 'a flash task'
        : existingKind === tasks.SPECIAL_LUCKY
          ? 'the lucky task'
          : // Neutral fallback (issue #650 PR review fix, Finding J), never the
            // bare kind string — `existingKind` here would be an unrecognized
            // SPECIAL_RULES `kind` value, and printing it verbatim would render
            // ungrammatical host-facing text like "already flash" (missing its
            // article) if a future rule's kind spelling doesn't happen to read
            // as a noun phrase on its own.
            'another special task';
  return 'This task is already ' + label + ' — cancel that first.';
}

// This file's one clock (issue #650 plan step 3 — this file previously had
// none at all). Built the same way src/services/submissions.js's submitPhoto
// builds its own clock, around the same two calls submitPhoto assembles:
// `eventLocalDateString(getEventConfig().timezone)` for the event-local day,
// `Date.now()` for the instant. Passing `{todayIso}` alone is not a partial
// success — tasks.whatSpecial() reaches flashState() for any row daily has
// not spoken for, and that throws on a non-finite nowMs, so every admin task
// save on a non-daily task would 500 without the second half.
function currentClock() {
  // eventDaysSvc.eventLocalDateString (a live property lookup, not a
  // destructured constant — issue #650 review self-check) so a test can
  // monkeypatch it the same way tests/flash-engine.test.js and
  // tests/oneday-challenge-engine.test.js already do for guest.js/
  // submissions.js's identical clock, instead of this route silently reading
  // whatever the real wall clock happens to be during a test run.
  return {
    todayIso: eventDaysSvc.eventLocalDateString(getEventConfig().timezone),
    nowMs: Date.now(),
  };
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

  // This route's one clock (issue #650 PR review fix, Finding A) — hoisted
  // above the row-building map so every row's specialKind (below) is
  // evaluated against the same instant, the same discipline currentClock()
  // itself documents.
  const clock = currentClock();

  // Hoisted above the row-building map (issue #763 plan step 4) — the flash
  // projection below needs the configured timezone for formatFlashWhen(),
  // and the day-chip catalog further down needs the same config object; one
  // read, not two.
  const eventConfig = getEventConfig();

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

    // The flash projection (issue #763 plan step 4): flashState plus the
    // derived remaining-time/when labels the board chip AND the edit
    // popup's status strip both read (data-flash-* attributes, admin-
    // tasks.ejs / admin-tasks.js). The remaining-time arithmetic comes from
    // tasks.flashWindow() — its own doc comment says it exists so a second
    // caller does not hand-roll `flash_start_at + minutes` again and let the
    // clock and the fill disagree — never computed inline here.
    const flashState = tasks.flashState(t, clock.nowMs);
    const flashWindowVal = tasks.flashWindow(t);
    let flashMinutesLeft = null;
    if (flashState === tasks.FLASH_ACTIVE && flashWindowVal) {
      // Ceiling, floored at 1: an active flash with real time left never
      // reads "0 min left" on the board just because it is inside its last
      // minute.
      flashMinutesLeft = Math.max(1, Math.ceil((flashWindowVal.endMs - clock.nowMs) / 60000));
    }
    let flashWhenLabel = '';
    if (flashState === tasks.FLASH_SCHEDULED && t.flash_start_at) {
      flashWhenLabel = hostChecklist.formatFlashWhen(t.flash_start_at, eventConfig.timezone, {
        style: 'timeOnly',
      });
    }
    // The status strip's own ready-made sentence (issue #763 criteria 1/2/6)
    // — the edit popup is ONE shared dialog reused for every card, so its
    // strip cannot be server-rendered per task; admin-tasks.js's openEdit()
    // reads this back verbatim off the tapped card's data-flash-strip-label
    // attribute rather than re-assembling the sentence client-side from
    // flashMinutesLeft/flashWhenLabel, so the wording has exactly one owner.
    let flashStripLabel = '';
    if (flashState === tasks.FLASH_ACTIVE) {
      flashStripLabel = `Live now — ${flashMinutesLeft} min left`;
    } else if (flashState === tasks.FLASH_SCHEDULED) {
      flashStripLabel = `Starts at ${flashWhenLabel}`;
    }

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
      // Raw pair (issue #650 plan step 6) — emitted as data-lucky-date/
      // data-lucky-bonus so admin-tasks.js's openEdit() can restore a stored
      // lucky pick (and check the Lucky radio off it, since a lucky task
      // never stores special_mode='oneday' to derive that from). No board
      // chip for this pair (unlike special_date/special_bonus's oneday chip
      // above) — deliberate, recorded in the issue's "Deliberate omissions"
      // section: the edit popup is the host's way to see the current pick.
      lucky_date: t.lucky_date,
      lucky_bonus: t.lucky_bonus,
      // Raw trio (issue #763 plan step 4/6/7) — emitted as data-flash-bonus/
      // data-flash-minutes so admin-tasks.js's openEdit() can prefill the
      // bonus chip and duration field on an armed task. flash_start_at is
      // deliberately NOT emitted raw: the write path never needs the client
      // to echo it back (resolveFlashWrite reads the CURRENT stored row
      // straight off the DB for its no-op comparison), so there is nothing
      // for the client to carry.
      flash_bonus: t.flash_bonus,
      flash_minutes: t.flash_minutes,
      // Derived flash state/labels for the board chip (admin-tasks.ejs) AND
      // the edit popup's status strip (admin-tasks.js's openEdit(), via the
      // data-flash-state/data-flash-strip-label attributes below).
      flashState: flashState,
      flashMinutesLeft: flashMinutesLeft,
      flashWhenLabel: flashWhenLabel,
      flashStripLabel: flashStripLabel,
      // The server-derived answer to "which Special radio does this task's
      // edit popup open on" (issue #650 PR review fix, Finding A). Before
      // this field existed, admin-tasks.js hand-copied the daily rule's
      // spokenFor predicate (isSealed||isOnDay) client-side to decide whether
      // a stored special_date should win the Lucky radio over a lucky_date —
      // a second owner of a rule tasks.js's whatSpecial() already owns, and
      // one that could not see a live flash window at all. Emitting
      // tasks.whatSpecial()'s own answer here (as data-special-kind, read by
      // openEdit()) makes the popup's radio precedence consult the SAME
      // single ordered SPECIAL_RULES walk every other exclusivity decision
      // in this app already goes through, instead of a browser-side re-guess
      // that drifts the moment the rule set changes.
      specialKind: tasks.whatSpecial(t, clock),
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
  // default. `eventConfig` was already read above, before the row map.
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
  const rawSpecialMode = req.body.special_mode;
  const specialMode = tasks.normalizeMode(rawSpecialMode, tasks.MODE_NONE);

  // special_date/special_bonus (issue #755) — validated BEFORE any write, same
  // discipline as the badge check just below: a bad pair on CREATE means NO
  // task row is written at all (criterion 3), the same shape an invalid badge
  // already takes. storedDate/storedBonus are `undefined` (no stored task
  // yet, so every posted 'oneday' pair "differs from stored" — see
  // resolveSpecialPairWrite's own comment) and submissionCount is 0 (a
  // brand-new task can have no submissions, so the lock never fires here).
  const pairResolved = resolveSpecialPairWrite({
    rawMode: rawSpecialMode,
    rawDate: req.body.special_date,
    rawBonus: req.body.special_bonus,
    storedDate: undefined,
    storedBonus: undefined,
    submissionCount: 0,
  });
  if (!pairResolved.ok) {
    return redirectWithMsg(res, '/admin/tasks', describeCreatePairRefusal(pairResolved.reason));
  }

  // Lucky pair (issue #650) — same "validated BEFORE any write" discipline,
  // storedDate/storedBonus undefined for the identical CREATE reason as the
  // one-day pair above.
  const luckyPairResolved = resolveLuckyPairWrite({
    rawMode: rawSpecialMode,
    rawDate: req.body.lucky_date,
    rawBonus: req.body.lucky_bonus,
    storedDate: undefined,
    storedBonus: undefined,
  });
  if (!luckyPairResolved.ok) {
    return redirectWithMsg(
      res,
      '/admin/tasks',
      describeCreateLuckyRefusal(luckyPairResolved.reason)
    );
  }

  // One clock for this request (issue #763 PR review, minor 5 — matches
  // currentClock()'s own comment intent and what the GET handler already
  // does): both the flash resolver and the exclusivity guard below need "the
  // same instant", so this is called once, not once per use.
  const clock = currentClock();

  // The flash trio (issue #763) — same "validated BEFORE any write"
  // discipline. storedRow is `undefined` (no stored task yet, so the no-op
  // rule never fires on CREATE — see resolveFlashWrite's own comment) and
  // resolvedSpecialMode is the ALREADY-normalized `specialMode` this save is
  // about to write (never 'flash' itself — see tasks.js's MODES comment —
  // so `not_live` here is vacuous by construction on CREATE, same as the
  // exclusivity guard below).
  const flashResolved = resolveFlashWrite({
    rawMode: rawSpecialMode,
    rawCancel: req.body.flash_cancel,
    rawBonus: req.body.flash_bonus,
    rawMinutes: req.body.flash_minutes,
    rawStartMode: req.body.flash_start_mode,
    rawDate: req.body.flash_date,
    rawTime: req.body.flash_time,
    storedRow: undefined,
    resolvedSpecialMode: specialMode,
    clock,
    timezone: getEventConfig().timezone,
  });
  if (!flashResolved.ok) {
    return redirectWithMsg(res, '/admin/tasks', describeCreateFlashRefusal(flashResolved.reason));
  }

  // Exclusivity (issue #650 plan step 3) — CREATE has no stored row, so `{}`;
  // the guard is vacuous by construction here, kept anyway so create and edit
  // share one shape. specialKindBeingSet() (issue #650 PR review fix, Finding
  // C) is the one place a posted raw special_mode maps to the SPECIAL_* kind
  // this guard checks — a future setter (e.g. flash gaining a settable pick)
  // has that one function to extend, not this ternary duplicated a third
  // time.
  const settingKind = specialKindBeingSet(rawSpecialMode);
  if (settingKind) {
    const exclusivity = checkExclusivity({}, clock, settingKind);
    if (!exclusivity.ok) {
      return redirectWithMsg(
        res,
        '/admin/tasks',
        describeExclusivityRefusal(exclusivity.existingKind)
      );
    }
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
        `INSERT INTO tasks (title, description, sort_order, worth, special_mode, special_date, special_bonus, lucky_date, lucky_bonus, flash_bonus, flash_minutes, flash_start_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        title,
        description,
        order,
        worth,
        specialMode,
        pairResolved.writeDate,
        pairResolved.writeBonus,
        luckyPairResolved.writeDate,
        luckyPairResolved.writeBonus,
        flashResolved.writeBonus,
        flashResolved.writeMinutes,
        flashResolved.writeStartAt
      );
    const taskId = info.lastInsertRowid;

    // One lucky task per day (issue #650) — writing lucky_date = D first
    // clears lucky_date/lucky_bonus on any OTHER task already holding that
    // day, in the SAME transaction as the insert. Touches only the two lucky
    // columns — never special_mode (see the edit route's identical clear,
    // below, for why that matters).
    if (luckyPairResolved.writeDate) {
      db.prepare(
        `UPDATE tasks SET lucky_date = NULL, lucky_bonus = NULL WHERE lucky_date = ? AND id != ?`
      ).run(luckyPairResolved.writeDate, taskId);
    }

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
  const rawSpecialMode = req.body.special_mode;
  const specialMode = tasks.normalizeMode(rawSpecialMode, task.special_mode);

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
    rawMode: rawSpecialMode,
    rawDate: req.body.special_date,
    rawBonus: req.body.special_bonus,
    storedDate: task.special_date,
    storedBonus: task.special_bonus,
    submissionCount,
  });

  // The lucky pair (issue #650) — resolved BEFORE the one-day refusal check
  // below, and never locked (a lucky bonus is banked on the submission row
  // at submit time, canon rule 11, so clearing/changing lucky_date/
  // lucky_bonus can never re-score a photo already posted).
  const luckyPairResolved = resolveLuckyPairWrite({
    rawMode: rawSpecialMode,
    rawDate: req.body.lucky_date,
    rawBonus: req.body.lucky_bonus,
    storedDate: task.lucky_date,
    storedBonus: task.lucky_bonus,
  });

  // One clock for this request (issue #763 PR review, minor 5 — matches
  // currentClock()'s own comment intent and what the GET handler already
  // does): both the flash resolver and the exclusivity guard further down
  // need "the same instant", so this is called once, not once per use.
  const clock = currentClock();

  // The flash trio (issue #763) — resolved BEFORE the one-day refusal check
  // below, same "validate everything first" discipline the lucky pair just
  // above follows. `task` is the row's CURRENT flash trio (resolveFlashWrite
  // reads it for both the no-op comparison and tasks.flashState()), and
  // `specialMode` is the ALREADY-normalized value this save is about to
  // write — never 'flash' itself (tasks.js's MODES comment), so `not_live`
  // checks liveness against whatever real mode (none/hidden/oneday) this
  // save resolves to.
  const flashResolved = resolveFlashWrite({
    rawMode: rawSpecialMode,
    rawCancel: req.body.flash_cancel,
    rawBonus: req.body.flash_bonus,
    rawMinutes: req.body.flash_minutes,
    rawStartMode: req.body.flash_start_mode,
    rawDate: req.body.flash_date,
    rawTime: req.body.flash_time,
    storedRow: task,
    resolvedSpecialMode: specialMode,
    clock,
    timezone: getEventConfig().timezone,
  });

  if (!pairResolved.ok) {
    // The one-day refusal still discards the whole rest of the edit exactly
    // as before (title/description/worth/badge/the one-day pair) — EXCEPT a
    // Special=None cancel of an EXISTING lucky pick, which must always land
    // (issue #650 plan step 3's "trap": a task can carry both a past
    // special_date and a lucky_date, and cancelling lucky via Special=None
    // also makes the one-day pair "changed", which the lock above refuses
    // whenever submissions exist — stranding lucky_date with no door left to
    // cancel it through, unless this clear runs regardless of that refusal).
    // Touches only the two lucky columns — never special_mode/special_date,
    // which stay refused and unchanged exactly as describeEditPairRefusal
    // already says.
    let msg = describeEditPairRefusal(pairResolved.reason);
    // Gate on the LUCKY resolver's OWN result (issue #650 PR review fix,
    // Finding B), not a re-derived `rawSpecialMode === tasks.MODE_NONE` check
    // — resolveLuckyPairWrite already decided the resolved lucky pair above,
    // and a resolved-to-null pair on a task that WAS lucky is exactly and
    // only "this save cancels the lucky pick," across every reachable
    // rawSpecialMode that can land in this branch (see resolveLuckyPairWrite:
    // the pair only resolves to null when the raw mode is 'none', or when
    // there was never a stored pick to preserve).
    if (luckyPairResolved.writeDate === null && task.lucky_date != null) {
      db.prepare(`UPDATE tasks SET lucky_date = NULL, lucky_bonus = NULL WHERE id = ?`).run(id);
      // Composed from the SAME describer that built `msg` above, rather than
      // a hand-typed sentence duplicating describeEditPairRefusal's own
      // PAIR_REASON_LOCKED wording — this branch is only reachable with
      // reason LOCKED (see the comment above), so this reads as "Lucky task
      // cancelled." plus that one owner's locked-pair wording.
      msg = 'Lucky task cancelled. ' + describeEditPairRefusal(pairResolved.reason);
    }
    return redirectWithMsg(res, '/admin/tasks', msg, 'task-' + id);
  }

  if (!luckyPairResolved.ok) {
    return redirectWithMsg(
      res,
      '/admin/tasks',
      describeEditLuckyRefusal(luckyPairResolved.reason),
      'task-' + id
    );
  }

  if (!flashResolved.ok) {
    return redirectWithMsg(
      res,
      '/admin/tasks',
      describeEditFlashRefusal(flashResolved.reason),
      'task-' + id
    );
  }

  // The resolved pairs ARE what get written — each resolver already decided
  // whether that means the stored pair unchanged (a `hidden` write or an
  // absent field, criterion 6's partial-POST contract) or the validated
  // posted pair (possibly `(null, null)` for a `none` clear).
  const nextSpecialDate = pairResolved.writeDate;
  const nextSpecialBonus = pairResolved.writeBonus;
  const nextLuckyDate = luckyPairResolved.writeDate;
  const nextLuckyBonus = luckyPairResolved.writeBonus;
  const nextFlashBonus = flashResolved.writeBonus;
  const nextFlashMinutes = flashResolved.writeMinutes;
  const nextFlashStartAt = flashResolved.writeStartAt;

  // Exclusivity (issue #650 plan step 3) — only when the posted mode itself
  // names a special kind; SKIPPED for 'none'/'hidden' (the host's own
  // cancel/hide paths must never be refused by this guard). `task` (the
  // row's CURRENT data, before this save) is what whatSpecial reads, so a
  // task re-saving the SAME kind it already is never trips this — it can
  // only disagree when a DIFFERENT rule already owns the row (AC7(c)'s
  // "reverse" case: a task already lucky that the host tries to date as One
  // day only). specialKindBeingSet() (Finding C) is the SAME raw-mode-to-kind
  // mapping the create handler above uses.
  const settingKind = specialKindBeingSet(rawSpecialMode);
  if (settingKind) {
    const exclusivity = checkExclusivity(task, clock, settingKind);
    if (!exclusivity.ok) {
      return redirectWithMsg(
        res,
        '/admin/tasks',
        describeExclusivityRefusal(exclusivity.existingKind),
        'task-' + id
      );
    }
  }

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
              special_date = ?, special_bonus = ?, lucky_date = ?, lucky_bonus = ?,
              flash_bonus = ?, flash_minutes = ?, flash_start_at = ?
        WHERE id = ?`
    ).run(
      title,
      description,
      worth,
      specialMode,
      nextSpecialDate,
      nextSpecialBonus,
      nextLuckyDate,
      nextLuckyBonus,
      nextFlashBonus,
      nextFlashMinutes,
      nextFlashStartAt,
      id
    );

    // One lucky task per day (issue #650) — writing lucky_date = D here
    // first clears lucky_date/lucky_bonus on any OTHER task already holding
    // that day, in the SAME transaction. Touches only the two lucky columns
    // — in particular it must NOT write special_mode: a lucky task can be
    // hidden (special_mode='hidden' with lucky_date intact), and
    // liveTaskWhere is `special_mode <> 'hidden'`, so a clear that also
    // reset the mode would republish a task the host deliberately hid, to
    // every guest, with no host action and no message.
    if (nextLuckyDate) {
      db.prepare(
        `UPDATE tasks SET lucky_date = NULL, lucky_bonus = NULL WHERE lucky_date = ? AND id != ?`
      ).run(nextLuckyDate, id);
    }

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

  // A hidden task can still hold a live lucky pick (issue #650's "Deliberate
  // omissions, recorded": special_mode='hidden' with lucky_date intact is a
  // supported state, reachable by picking the Hidden radio on an
  // already-lucky task — resolveLuckyPairWrite leaves the pair untouched for
  // any raw mode other than 'lucky'/'none'). Left silent, that parks the
  // day's only lucky slot where no guest can reach it, with no chip and no
  // checklist row to notice from (issue #650 PR review fix, Finding F) — one
  // extra sentence on the save's own success message is the cheapest place
  // to surface it.
  let successMsg = 'Task updated.';
  if (specialMode === tasks.MODE_HIDDEN && nextLuckyDate != null) {
    successMsg += " This task is hidden, so guests can't win the lucky bonus on it.";
  }
  redirectWithMsg(res, '/admin/tasks', successMsg, 'task-' + id);
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
//              q-filtered by heading. Search box shown (AC3). EXCEPTION
//              (issue #748): when `task=<id>` also names a real task row,
//              the request is SCOPED to that one task instead of the whole
//              wall — the single resulting group includes taken-down
//              submissions too (a host scoping to one task is moderating
//              it, and a taken-down photo they can't see is one they can't
//              restore — DESIGN.md), and `q` is ignored entirely rather than
//              filtering the (single) group's heading. An absent,
//              non-numeric, or unknown `task` leaves the request unscoped,
//              rendering the ordinary by-task wall exactly as before.
// view=user:   LIVE submissions grouped by guest, q-filtered by heading.
//              Search box shown (AC3).
// Anything else falls back to recent (HTTP 200, no error) — same contract as
// GET /gallery (src/routes/community.js).
//
// The inline feed panel (src/views/admin-photos.ejs; no separate route per
// the issue's Touches list) renders whatever `photos` holds below: the FULL
// submission set (including taken-down, matching Recent) on every unscoped
// request, or — on a scoped view=task&task=<id> request (issue #748) — that
// one task's submissions only, so tapping any tile still lands on that same
// photo's card.
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

  // Optional task scope (issue #748) — only on view=task, and only when
  // `req.query.task` is a string of digits only. The regex test runs BEFORE
  // any parseInt: a repeated `?task=1&task=2` hands Express back an ARRAY
  // (fails the `typeof ... === 'string'` check below), and a value like
  // '12abc' fails `/^\d+$/` outright — neither is silently coerced to a
  // number. The id must also name a real row (the row supplies the group
  // heading below); anything else leaves the request unscoped (AC3).
  let taskScope = null;
  if (view === 'task' && typeof req.query.task === 'string' && /^\d+$/.test(req.query.task)) {
    const scopeRow = db
      .prepare('SELECT id, title FROM tasks WHERE id = ?')
      .get(parseInt(req.query.task, 10));
    if (scopeRow) taskScope = scopeRow;
  }

  // LEFT JOIN tasks (not JOIN): a memory (issue #247, s.task_id IS NULL) has
  // no task row to join — it must still appear here, with task_title coming
  // back NULL; the view falls back to "a shared memory" / "Memories".
  //
  // Scoped (issue #748): narrow this SAME query with `WHERE s.task_id = ?`
  // rather than running a second query — `photoRows` (and everything derived
  // from it below: the H1 count, the group, the inline feed panel) is then
  // already the scoped set, with no extra bookkeeping needed to keep them
  // in sync.
  const photosSelect = `SELECT s.id          AS id,
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
         LEFT JOIN tasks  t ON t.id = s.task_id`;
  // Written once, appended to both branches — the scoped view and the
  // unscoped wall must never disagree on photo order, and two copies of the
  // clause is how that drift starts.
  const photosOrder = ` ORDER BY s.created_at DESC, s.id DESC`;
  const photoRows = taskScope
    ? db.prepare(photosSelect + ` WHERE s.task_id = ?` + photosOrder).all(taskScope.id)
    : db.prepare(photosSelect + photosOrder).all();

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
  if (taskScope) {
    // Scoped (issue #748): one group only, built directly from the already-
    // scoped `photoRows` — NOT the taken_down filter the unscoped view=task
    // branch below applies (a host scoping to one task is moderating it, and
    // a taken-down photo they can't see is one they can't restore —
    // DESIGN.md), and no `q` heading filter at all (AC6: the scope wins, `q`
    // is ignored outright). Zero submissions emits NO group (`groups` stays
    // `[]`) rather than an empty-photo group — a zero-photo group heading
    // would render in place of the empty-state message below and fail AC2.
    if (photoRows.length > 0) {
      groups = [{ heading: taskScope.title, photos: photoRows }];
    }
  } else if (view === 'task' || view === 'user') {
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
    // The scoped task's { id, title } row, or null when unscoped (issue
    // #748) — the view picks the empty-state branch when it is set but
    // `groups` came back empty (AC2).
    taskScope,
    // The same scope, already reduced to what a hidden input needs: the bare
    // id, or '' when unscoped. Resolving the null here rather than in the
    // template is what lets every mutating form write `task` as flatly as it
    // writes `view`/`q` (so the scope survives a POST, AC4) — a template that
    // had to re-derive it at each of a dozen sites is one `taskScope.id` away
    // from a TypeError on the default, unscoped page.
    taskScopeId: taskScope ? taskScope.id : '',
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
