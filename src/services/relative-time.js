// src/services/relative-time.js
// Server-rendered "how long ago" formatting for the admin dashboard's pulse
// line (issue #256) — e.g. "4 minutes ago". Server-rendered on purpose: the
// approved design calls for no client JS on this line, so the string must be
// correct at render time, not refreshed in the browser.
//
// This module is also the SINGLE OWNER of one storage-format decision: how a
// stored `created_at` string becomes a JS Date, and back again. SQLite's
// `datetime('now')` (src/db.js's default for every `created_at` column, and
// the CASE-WHEN literal src/routes/admin.js's task-liveness seams use for
// `tasks.live_since` — issue #778) writes "YYYY-MM-DD HH:MM:SS" in UTC with
// no 'T' separator and no offset marker. Handed to `new Date()` as-is, that
// shape is parsed as LOCAL time, not UTC — silently skewing every derived
// value by the server's UTC offset. The parse-side fix (space -> 'T', append
// 'Z') lives here in `parseSqliteDatetime`; the emit side (epoch
// milliseconds -> that exact stored shape) lives here in `toSqliteDatetime`,
// its inverse. Both live here and nowhere else: src/services/export.js's
// `fmtDate` and src/services/notifications.js's announcements source (issue
// #778, which needs the emit side to turn a JS-computed instant — a
// challenge's day-start, a flash window's start — into a `when` value
// directly comparable, by plain string comparison, to every other `when` in
// the recap merge) both route through these two functions rather than each
// keeping its own copy of either half of the rule.
'use strict';

/**
 * Parse a stored `created_at` value into a Date understood as UTC.
 *
 * Accepts a Date instance (returned as-is when valid) or a SQLite
 * `datetime('now')`-shaped string ("YYYY-MM-DD HH:MM:SS", UTC). The string is
 * rewritten to an explicit ISO+'Z' form before parsing so it is read as UTC,
 * not local time.
 *
 * @param {Date|string|null|undefined} value
 * @returns {Date|null} null when `value` is missing or unparseable.
 */
function parseSqliteDatetime(value) {
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  const parsed = new Date(value.replace(' ', 'T') + 'Z');
  return isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * The inverse of parseSqliteDatetime above: epoch milliseconds -> the exact
 * string shape every `datetime('now')` column in this app writes
 * ("YYYY-MM-DD HH:MM:SS", UTC, whole-second resolution, no 'T'/'Z'). Built
 * from `Date.prototype.toISOString()` (always UTC, regardless of the
 * server's own local timezone) with the millisecond/'T'/'Z' punctuation
 * stripped back to this app's storage shape.
 *
 * @param {number} ms - epoch milliseconds.
 * @returns {string}
 */
function toSqliteDatetime(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * @param {number} n
 * @param {string} unit - singular form, e.g. "minute"
 * @returns {string} e.g. "1 minute ago", "4 minutes ago"
 */
function pluralize(n, unit) {
  return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
}

/**
 * Format `date` as a short relative-time string relative to now.
 *
 * @param {Date|string|null|undefined} date - a Date, or a SQLite
 *   `datetime('now')`-shaped string ("YYYY-MM-DD HH:MM:SS", UTC).
 * @returns {string} "just now", "1 minute ago", "4 minutes ago", "2 hours
 *   ago", "3 days ago" — or '' when `date` is missing/unparseable, so a
 *   caller can render nothing instead of a bogus "NaN minutes ago".
 */
function relativeTime(date) {
  const then = parseSqliteDatetime(date);
  if (!then) {
    return '';
  }

  const deltaMs = Date.now() - then.getTime();
  // Clock skew or a future timestamp: clamp rather than show a negative age.
  const deltaSec = Math.max(0, Math.floor(deltaMs / 1000));

  if (deltaSec < 60) {
    return 'just now';
  }

  const deltaMin = Math.floor(deltaSec / 60);
  if (deltaMin < 60) {
    return pluralize(deltaMin, 'minute');
  }

  const deltaHour = Math.floor(deltaMin / 60);
  if (deltaHour < 24) {
    return pluralize(deltaHour, 'hour');
  }

  const deltaDay = Math.floor(deltaHour / 24);
  return pluralize(deltaDay, 'day');
}

module.exports = { relativeTime, parseSqliteDatetime, toSqliteDatetime };
