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

// Every mode this build's JS layer recognizes (issue #682 review fix — the
// WRITE-side counterpart to liveTaskWhere/isTaskLive's READ-side ownership).
// normalizeMode/isValidMode below are the two consumers of THIS list, and
// they pick up a new value automatically once it is added here — but this
// array is NOT the only place a new mode must be registered. Adding
// one_day/lucky/flash (#624/#649/#650) also requires updating, by hand, in
// lockstep:
//   - src/db.js (~line 49 and ~line 233): the tasks.special_mode column's own
//     `CHECK (special_mode IN ('none','hidden'))` constraint — SQLite
//     enforces this independently of anything in this file, so an app-layer
//     value MODES accepts but the CHECK rejects fails at INSERT/UPDATE time
//     with SQLITE_CONSTRAINT_CHECK, not a friendly validation message.
//   - src/views/partials/task-create-dialog.ejs and task-edit-dialog.ejs: the
//     Special radio's option list is hard-coded markup in both partials
//     (`<input type="radio" name="special_mode" value="...">`) — there is no
//     shared template loop reading MODES, so a new mode is invisible to the
//     host until both dialogs grow their own new <label>.
const MODES = [MODE_NONE, MODE_HIDDEN];

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
  MODES,
  MIN_WORTH,
  MAX_WORTH,
  DEFAULT_WORTH,
  liveTaskWhere,
  isTaskLive,
  isValidMode,
  normalizeMode,
  normalizeWorth,
};
