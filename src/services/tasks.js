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

module.exports = {
  MODE_NONE,
  MODE_HIDDEN,
  MIN_WORTH,
  MAX_WORTH,
  DEFAULT_WORTH,
  liveTaskWhere,
  isTaskLive,
};
