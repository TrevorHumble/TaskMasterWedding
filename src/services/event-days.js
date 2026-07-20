// src/services/event-days.js
//
// Two responsibilities the Configuration page (issue #681) and its future
// consumers (#682 day chips, #646 dashboard checklist) both need:
//
//   1. timezoneOptions()   -- the <select> option list for GET /admin/config,
//      built from the maintained @vvo/tzdb package (auto-updated from IANA,
//      DST-aware, grouped by identical rule -- e.g. America/Boise and
//      America/Denver share one Mountain Time entry). Also isKnownTimezone()
//      and resolveSelectedZone(), so admin.js's validator and pre-select
//      logic read this ONE tzdb-backed source instead of each hand-rolling
//      its own scan.
//   2. eventDays(startDate, endDate) -- the calendar-day enumerator every
//      day-aware surface will read once #682/#646 land.

'use strict';

const { getTimeZones } = require('@vvo/tzdb');

// Same offset-formatting formula the phase-1 preview shim used (owner
// approved the resulting labels against `npm run preview` before this file
// existed) -- reused verbatim rather than re-derived, so the approved look
// cannot drift from a "cleaner" reformulation that rounds a half-hour/45-
// minute offset differently.
function pad(n) {
  return String(Math.abs(n)).padStart(2, '0');
}

function formatOffset(mins) {
  const sign = mins < 0 ? '-' : '+';
  return `UTC${sign}${pad(Math.trunc(mins / 60))}:${pad(mins % 60)}`;
}

/**
 * All grouped IANA zones as [ianaName, label] pairs, ordered by standard-time
 * UTC offset descending (UTC+14 -> UTC-12) so the rendered <select> reads
 * monotonically. Label shape: "(UTC±HH:MM) <alternativeName> — <first main
 * city>" per the owner-approved screen (docs/wip-issues/681's "Approved
 * screen" section).
 * @returns {[string, string][]}
 */
function timezoneOptions() {
  return getTimeZones({ includeUtc: true })
    .slice()
    .sort((a, b) => b.rawOffsetInMinutes - a.rawOffsetInMinutes)
    .map((z) => {
      const city = z.mainCities && z.mainCities[0] ? ` — ${z.mainCities[0]}` : '';
      return [z.name, `(${formatOffset(z.rawOffsetInMinutes)}) ${z.alternativeName}${city}`];
    });
}

/**
 * Whether `name` is a real zone name from the maintained tzdb list -- either
 * a grouped entry's own canonical name (the values timezoneOptions() emits)
 * or one of the DST-identical zone names folded into that entry's `group`
 * (e.g. America/Boise, folded into the America/Denver entry). The single
 * validator POST /admin/config calls; keeps "is this timezone real" owned
 * here rather than duplicated inline in the route.
 * @param {string} name
 * @returns {boolean}
 */
function isKnownTimezone(name) {
  if (!name) return false;
  return getTimeZones({ includeUtc: true }).some(
    (z) => z.name === name || (z.group || []).includes(name)
  );
}

/**
 * Resolve a stored/submitted timezone name to the option that should show
 * `selected` in the <select> built by timezoneOptions() above. A grouped
 * member (e.g. America/Boise) resolves to its group's canonical entry (e.g.
 * America/Denver, Mountain Time) -- the two share identical DST rules, so
 * this is a display-only fold, never a change to which real zone rule is in
 * effect. Falls back to the input unchanged if it matches no known zone (so
 * a caller passing an already-canonical or already-unknown name is a no-op,
 * not a silent substitution to some other zone).
 * @param {string} stored
 * @returns {string}
 */
function resolveSelectedZone(stored) {
  const match = getTimeZones({ includeUtc: true }).find(
    (z) => z.name === stored || (z.group || []).includes(stored)
  );
  return match ? match.name : stored;
}

/**
 * One entry per calendar day from `startDate` to `endDate` inclusive (both
 * `YYYY-MM-DD`), label = abbreviated month + day ("Aug 7" -- no year, no
 * weekday). Built and formatted entirely in UTC so the server's own local
 * timezone can never shift which calendar day a date string lands on (the
 * "Aug 7 becomes Aug 6" pitfall a local-time Date/format pass would hit).
 * `startDate` after `endDate` yields an empty array rather than looping
 * backwards or forever -- POST /admin/config's own validation already
 * refuses to persist that ordering, so this is a defensive floor, not the
 * primary guard.
 * @param {string} startDate
 * @param {string} endDate
 * @returns {{ iso: string, label: string }[]}
 */
function eventDays(startDate, endDate) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

  const days = [];
  const cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    days.push({ iso: cursor.toISOString().slice(0, 10), label: fmt.format(cursor) });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

module.exports = { timezoneOptions, isKnownTimezone, resolveSelectedZone, eventDays };
