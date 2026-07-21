// src/services/tasks.js
//
// The ONE active-task owner (issue #727): the single definition of "live for
// guests" every reader in the app consults, plus the worth constants a task
// row carries. Dependency-free (no `db` require) — a pure module of constants
// and predicates over an already-loaded task row or a caller-supplied SQL
// alias, so requiring this file can never introduce a require cycle.
//
// special_mode replaces the old is_active (0/1) column (#727): 'none' is an
// ordinary live task, 'hidden' is what the admin toggle now writes instead of
// is_active = 0. The enum is forward-compatible with a future one_day/lucky/
// flash mode (#624/#649/#650) because liveness is defined as "not hidden"
// (`<> 'hidden'`) rather than "= none" — a future mode is live automatically,
// with no reader needing an update.
//
// Mirrors feed.js's VISIBLE_WHERE ownership pattern: liveTaskWhere() returns a
// SQL fragment string a caller interpolates into its own prepared statement
// (a trusted internal constant, never user input), and isTaskLive() is the
// JS-level equivalent for a caller that already holds a loaded row rather
// than running a query. This is the ONLY place the 'hidden' liveness literal
// lives — every converted reader (guest.js, admin.js, badges.js,
// submissions.js) consumes one of these two instead of re-deriving it.

'use strict';

const MODE_NONE = 'none';
const MODE_HIDDEN = 'hidden';
const MODE_ONEDAY = 'oneday';

// Every mode this build's JS layer recognizes (issue #682 review fix — the
// WRITE-side counterpart to liveTaskWhere/isTaskLive's READ-side ownership).
// normalizeMode/isValidMode below are the two consumers of THIS list, and
// they pick up a new value automatically once it is added here — but this
// array is NOT the only place a new mode must be registered.
//
// 'oneday' (issue #753) is registered here and its CHECK widened in src/db.js
// (ensureTaskSpecialDayColumns), but this issue ships NO host-facing screen —
// neither task-create-dialog.ejs nor task-edit-dialog.ejs offers a "Special:
// one-day-only" radio yet (that is #755's job), and admin.js's create/edit
// handlers still route every posted special_mode through normalizeMode with
// no companion special_date field to set. A host cannot reach 'oneday'
// through the UI today; only a direct/hand-crafted POST could, and would
// write special_mode = 'oneday' with special_date left NULL — inert (not
// sealed: isSealed requires special_date; not excluded from Completionist:
// that exclusion also keys on special_date), never a crash. #755 is the
// screen that lets a host set special_date, and is deliberately ordered to
// land LAST (see this issue's dependency map) specifically so nothing
// downstream can misbehave before it does. Lucky/flash (#649/#650) still
// require the same by-hand updates in lockstep when they arrive:
//   - src/db.js: the tasks.special_mode column's own CHECK constraint —
//     SQLite enforces this independently of anything in this file, so an
//     app-layer value MODES accepts but the CHECK rejects fails at
//     INSERT/UPDATE time with SQLITE_CONSTRAINT_CHECK, not a friendly
//     validation message.
//   - src/views/partials/task-create-dialog.ejs and task-edit-dialog.ejs: the
//     Special radio's option list is hard-coded markup in both partials
//     (`<input type="radio" name="special_mode" value="...">`) — there is no
//     shared template loop reading MODES, so a new mode is invisible to the
//     host until both dialogs grow their own new <label>.
const MODES = [MODE_NONE, MODE_HIDDEN, MODE_ONEDAY];

const MIN_WORTH = 1;
const MAX_WORTH = 3;
const DEFAULT_WORTH = 1;

/**
 * The SQL fragment for "this task is live" — `<alias>.special_mode <>
 * 'hidden'`, or the bare column name when no alias is given. A caller
 * interpolates this into its own WHERE clause; it is never itself a
 * prepared statement.
 *
 * @param {string} alias - the table alias the query uses for `tasks` (e.g.
 *   't'), or '' for an unaliased single-table query.
 * @returns {string}
 */
function liveTaskWhere(alias) {
  const prefix = alias ? `${alias}.` : '';
  return `${prefix}special_mode <> '${MODE_HIDDEN}'`;
}

// A YYYY-MM-DD-shaped string. sealedTaskWhere below defensively validates
// against this before interpolating a caller-supplied `todayIso` into SQL
// text — `todayIso` is always module-computed (src/services/event-days.js's
// eventLocalDateString), never user input, but the check catches a future
// caller passing something else by mistake rather than silently building a
// malformed (or, in the worst case, injectable) WHERE clause.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The ONE owner of "is this one-day-only challenge sealed" (issue #753):
 * `taskRow` is sealed exactly when it carries a `special_date` strictly
 * AFTER `todayIso` — a task dated tomorrow is sealed, a task dated TODAY is
 * OPEN (the whole point of the feature: it unseals on the day itself, not
 * the day after), and a task dated yesterday (or any earlier day) is also
 * open, same as an ordinary task. An ordinary task (`special_date` NULL or
 * undefined) is never sealed. Plain string comparison is correct here
 * because both sides are always `YYYY-MM-DD` — that format sorts
 * lexicographically identically to sorting by actual calendar date.
 *
 * `todayIso` is a parameter, not read from a clock in here, so this stays a
 * pure function of its inputs — the caller (src/services/submissions.js)
 * derives "today" from event-days.js's eventLocalDateString(), never server
 * UTC, and a test can pin any `todayIso` it likes without mocking a clock.
 *
 * @param {{special_date?: string|null}} taskRow
 * @param {string} todayIso - YYYY-MM-DD, the event-local "today".
 * @returns {boolean}
 */
function isSealed(taskRow, todayIso) {
  // Validate todayIso the same way sealedTaskWhere() below does, and fail
  // the same way (issue #753 review fix): before this, an undefined or
  // malformed todayIso here silently compared as `undefined > todayIso` /
  // string-mismatched and fell through to `false` -- reporting "not sealed"
  // for a task that IS a one-day-only challenge, while sealedTaskWhere threw
  // on the identical bad input. Two owners of one rule must not disagree
  // about invalid input; both now throw.
  if (!ISO_DATE_RE.test(todayIso)) {
    throw new Error(`isSealed: todayIso must be YYYY-MM-DD, got ${JSON.stringify(todayIso)}`);
  }
  return !!(taskRow && taskRow.special_date && taskRow.special_date > todayIso);
}

/**
 * The SQL fragment mirroring isSealed() above, for a caller running a query
 * instead of testing an already-loaded row (e.g. a future list query that
 * must exclude a sealed challenge — #754). Same alias convention as
 * liveTaskWhere(). `todayIso` is validated against ISO_DATE_RE before being
 * interpolated (see that constant's comment) rather than bound as a `?`
 * parameter, matching liveTaskWhere's own "trusted internal constant"
 * interpolation style one line up.
 *
 * @param {string} alias - the table alias the query uses for `tasks`, or ''
 *   for an unaliased single-table query.
 * @param {string} todayIso - YYYY-MM-DD, the event-local "today".
 * @returns {string}
 */
function sealedTaskWhere(alias, todayIso) {
  if (!ISO_DATE_RE.test(todayIso)) {
    throw new Error(
      `sealedTaskWhere: todayIso must be YYYY-MM-DD, got ${JSON.stringify(todayIso)}`
    );
  }
  const prefix = alias ? `${alias}.` : '';
  // Parenthesized as one atom (issue #753 review fix): liveTaskWhere()
  // returns a single atom, but this fragment is two ANDed conditions. A
  // caller building `WHERE ... AND NOT ${sealedTaskWhere(...)}` (the
  // exclusion shape this function's own consumers use, e.g. #754's guest
  // task list) would otherwise get `NOT` binding to only the FIRST
  // condition -- `NOT (special_date IS NOT NULL) AND special_date > '...'`
  // -- which matches zero rows, since a row failing the first half can never
  // satisfy the second. Wrapping the whole fragment makes NOT apply to the
  // fragment as a unit, matching how a caller reading this as "one
  // predicate" expects it to compose.
  return `(${prefix}special_date IS NOT NULL AND ${prefix}special_date > '${todayIso}')`;
}

/**
 * The ONE owner of "is this task a one-day-only challenge" (issue #753
 * review fix): true whenever `taskRow` carries a `special_date`, regardless
 * of whether it is presently sealed. `special_date` is the single
 * authoritative "this is a challenge" fact (see the doc comment on the
 * `tasks.special_date` column, `src/db.js`) -- `special_mode`'s `'oneday'`
 * value is a lockstep marker, never read here. Before this function existed,
 * `src/services/badges.js`'s Completionist query hand-wrote
 * `t.special_date IS NULL` inline even though this module is the declared
 * owner of every other task-state predicate; #754 and #756 both need this
 * same fact and would otherwise each re-write it a third and fourth time.
 *
 * @param {{special_date?: string|null}} taskRow
 * @returns {boolean}
 */
function isChallenge(taskRow) {
  return !!(taskRow && taskRow.special_date != null);
}

/**
 * The SQL fragment mirroring isChallenge() above, for a caller running a
 * query instead of testing an already-loaded row. Same alias convention as
 * liveTaskWhere/sealedTaskWhere, and parenthesized as one atom for the same
 * reason sealedTaskWhere is (see that function's comment) -- a caller is
 * expected to compose this behind a `NOT`.
 *
 * @param {string} alias - the table alias the query uses for `tasks`, or ''
 *   for an unaliased single-table query.
 * @returns {string}
 */
function challengeTaskWhere(alias) {
  const prefix = alias ? `${alias}.` : '';
  return `(${prefix}special_date IS NOT NULL)`;
}

/**
 * Whether an already-loaded task row is live for guests. Mirrors
 * liveTaskWhere's predicate for the two call sites (task-detail 404, submit
 * gate) that hold a row rather than a query.
 *
 * @param {{special_mode: string}} taskRow
 * @returns {boolean}
 */
function isTaskLive(taskRow) {
  return taskRow.special_mode !== MODE_HIDDEN;
}

/**
 * True only for a value that is one of MODES exactly. The single validity
 * test normalizeMode below (and any future direct caller) consults, so
 * "what counts as a real mode" can never be re-derived a second way.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidMode(value) {
  return typeof value === 'string' && MODES.includes(value);
}

/**
 * The WRITE-side owner of "what special_mode value does a posted field
 * become" (issue #682 review fix): a valid MODES member passes through
 * unchanged; anything else (missing, empty, unrecognized, a future mode this
 * build doesn't know yet) falls back to `fallback`. src/routes/admin.js's
 * create and edit handlers BOTH route their posted `special_mode` through
 * this instead of each hand-coding their own "unknown -> ?" rule — before this
 * fix, create silently mapped unknown to MODE_NONE while edit silently kept
 * the task's CURRENT mode, an inconsistency a caller had to know about rather
 * than one shared rule enforcing it. Each caller supplies its own fallback
 * (create: tasks.MODE_NONE; edit: the task's current special_mode), so this
 * function stays fallback-agnostic rather than assuming either policy.
 *
 * DELIBERATELY forgiving, unlike the sibling badge_icon field in the same
 * POST /admin/tasks/:id/edit handler: an unrecognized badge_icon refuses the
 * WHOLE edit, while an unrecognized special_mode is silently coerced to
 * `fallback` instead. That is not an oversight — the two fields come from
 * different sources of truth. special_mode is a closed, host-picked RADIO
 * (the create wizard's step 2 / the edit popup's Special group): the only
 * way its value is ever anything but a MODES member is a stale client (an
 * older tab open across a deploy that adds a mode, or a hand-crafted
 * request), and coercing to a safe default degrades gracefully with no
 * confusing error for an ordinary host. badge_icon, by contrast, is chosen
 * from a live, still-open catalog (src/services/badge-icons.js) at the exact
 * moment of submit — an invalid pick there is far more likely to indicate a
 * real bug (a stale catalog id, a broken picker) worth refusing loudly
 * rather than silently papering over.
 *
 * @param {unknown} value - the posted special_mode field.
 * @param {string} fallback - what to return when value is not a valid mode.
 * @returns {string}
 */
function normalizeMode(value, fallback) {
  return isValidMode(value) ? value : fallback;
}

/**
 * The WRITE-side owner of "what worth value does a posted field become"
 * (issue #682 review fix), mirroring normalizeMode's shape: parses `raw` as
 * an integer and returns it only when it falls within [MIN_WORTH,
 * MAX_WORTH]; anything else (missing, non-numeric, out of range) falls back
 * to `fallback`. src/routes/admin.js's create (fallback DEFAULT_WORTH) and
 * edit (fallback the task's CURRENT worth) both call this instead of each
 * re-implementing the same parseInt-and-clamp check.
 *
 * @param {unknown} raw - the posted worth field.
 * @param {number} fallback - what to return when raw doesn't parse to a
 *   valid 1-3 worth.
 * @returns {number}
 */
function normalizeWorth(raw, fallback) {
  const parsed = parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= MIN_WORTH && parsed <= MAX_WORTH ? parsed : fallback;
}

module.exports = {
  MODE_NONE,
  MODE_HIDDEN,
  MODE_ONEDAY,
  MODES,
  MIN_WORTH,
  MAX_WORTH,
  DEFAULT_WORTH,
  liveTaskWhere,
  isTaskLive,
  isSealed,
  sealedTaskWhere,
  isChallenge,
  challengeTaskWhere,
  isValidMode,
  normalizeMode,
  normalizeWorth,
};
