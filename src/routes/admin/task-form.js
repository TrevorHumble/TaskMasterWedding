// src/routes/admin/task-form.js
// Create/edit form validation helpers shared by tasks.js (POST /tasks, POST
// /tasks/:id/edit) and tasks-manage.js (POST /tasks/:id/badge) — the
// task-form/validation helper module named in issue #969's seam table.
// resolveBadgeIcon (#682) plus the one-day/lucky/flash pair-write resolvers
// (#755/#650/#763) and the exclusivity guard (#650) all live here, single
// owner per issue #969 AC1b.

const { getEventConfig } = require('../../db');
const tasks = require('../../services/tasks');
const badgeIcons = require('../../services/badge-icons');
const eventDaysSvc = require('../../services/event-days');
const { eventDays: computeEventDays } = eventDaysSvc;

// Validate and resolve a posted badge-icon pick (#682) —
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

// Reason CODES resolveSpecialPairWrite refuses with (#755) — mirrors resolveBadgeIcon's own
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
// value" and use to clobber a real stored date (the caller no
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
  // The floor (a positive integer) is owned by tasks.flashWindow() (#763)
  // — probing it with the candidate minutes against a known-valid bonus
  // and instant makes flashWindow() itself the validity oracle for "is
  // this a duration the engine will ever pay", rather than re-stating its
  // floor as a bare `minutes < 1` here. Without this, a future
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
// checkExclusivity is asked to guard (#650).
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
          : // Neutral fallback (#650), never the
            // bare kind string — `existingKind` here would be an unrecognized
            // SPECIAL_RULES `kind` value, and printing it verbatim would render
            // ungrammatical host-facing text like "already flash" (missing its
            // article) if a future rule's kind spelling doesn't happen to read
            // as a noun phrase on its own.
            'another special task';
  return 'This task is already ' + label + ' — cancel that first.';
}

// This file's one clock (#650). Built the same way src/services/submissions.js's submitPhoto
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

module.exports = {
  resolveBadgeIcon,
  resolveSpecialPairWrite,
  describeCreatePairRefusal,
  describeEditPairRefusal,
  resolveLuckyPairWrite,
  describeCreateLuckyRefusal,
  describeEditLuckyRefusal,
  resolveFlashWrite,
  describeCreateFlashRefusal,
  describeEditFlashRefusal,
  checkExclusivity,
  specialKindBeingSet,
  describeExclusivityRefusal,
  currentClock,
};
