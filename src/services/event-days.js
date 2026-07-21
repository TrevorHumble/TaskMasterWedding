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
//
// A third responsibility, added by issue #753 for the one-day-only challenge
// engine (src/services/tasks.js's seal predicate, src/services/submissions.js's
// on-day bonus banking): "what is today, and when does a given day open" in
// the EVENT'S configured timezone, never server UTC.
//   3. eventLocalDateString(timezone, instant) -- today's (or `instant`'s)
//      YYYY-MM-DD in `timezone`.
//      dayOpensAt(dateIso, timezone) -- the absolute instant that calendar
//      day opens (local midnight) in `timezone`, as a UTC Date.
//      singleDayLabel(dateIso) -- the "Aug 7" label for ONE date, unlike
//      eventDays() above which can only label a date inside an enumerated
//      start/end range.
// Timezone comes from db.getEventConfig().timezone -- callers pass it in
// rather than this module reading db itself, keeping this file dependency-
// free (no `db` require, matching src/services/tasks.js's own reasoning) so
// it stays pure Intl-driven date math a unit test can exercise directly.

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

// ---------------------------------------------------------------------------
// Event-local "today" (issue #753). Built on Intl.DateTimeFormat's
// formatToParts, which resolves a UTC instant to its wall-clock date/time in
// any IANA zone WITHOUT the server's own local timezone ever entering the
// computation -- the same UTC-anchoring discipline eventDays() above uses,
// just reading a real timezone's offset instead of pinning to UTC itself.
// ---------------------------------------------------------------------------

/**
 * `instant`'s calendar date (YYYY-MM-DD) as it reads on a wall clock in
 * `timezone`. Defaults `instant` to "now" so a caller asking "what day is it
 * for the event right now" doesn't have to pass `new Date()` itself, while a
 * test (or a future scheduler) can pin an exact instant -- e.g.
 * eventLocalDateString('America/Boise', new Date('2026-08-08T04:00:00Z'))
 * must answer '2026-08-07': that instant is 22:00 MDT the evening before,
 * not yet past local midnight.
 *
 * @param {string} timezone - an IANA zone name (e.g. 'America/Boise').
 * @param {Date} [instant] - defaults to `new Date()`.
 * @returns {string} YYYY-MM-DD
 */
function eventLocalDateString(timezone, instant) {
  const when = instant || new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(when);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * The UTC offset (in milliseconds, east-of-UTC positive) `timezone` is
 * observing at `utcMs`. Internal helper for dayOpensAt() below: read what a
 * wall clock in `timezone` shows at that instant, then re-interpret that
 * wall-clock reading AS IF it were itself a UTC instant -- the difference
 * between the two is exactly the zone's current offset. Standard technique
 * for deriving a specific-instant zone offset from Intl alone (no fixed
 * offset table, so it is correct across a DST transition).
 * @param {string} timezone
 * @param {number} utcMs
 * @returns {number}
 */
function tzOffsetMs(timezone, utcMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    // hourCycle: 'h23' (issue #753 review fix, replacing hour12: false) makes
    // local midnight unrepresentable as anything but "00" -- hour12: false
    // could format it as "24" in some ICU builds, which needed a separate
    // 24->0 correction below. h23 removes the case entirely rather than
    // correcting for it.
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const asIfUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second')
  );
  return asIfUtc - utcMs;
}

/**
 * The absolute instant local midnight of `dateIso` (YYYY-MM-DD) occurs in
 * `timezone`, as a UTC Date. Two-pass offset resolution (compute the offset
 * at a naive UTC-midnight guess, re-derive the instant, then re-check the
 * offset at THAT instant and correct once more if it moved) so a date that
 * falls exactly on a DST transition still resolves to the real local
 * midnight rather than the wrong side of the transition by an hour.
 *
 * Some zones skip local midnight entirely on a DST-forward transition (issue
 * #753 review fix) -- e.g. America/Santiago on 2026-09-06, which jumps
 * 00:00 straight to 01:00. There the naive first pass already lands on the
 * correct instant (the first real moment of that calendar day), but the
 * second pass's offset re-check sees the POST-transition offset and
 * "corrects" past it onto the tail end of the PREVIOUS day instead. The
 * round-trip check below catches exactly this: a corrected candidate that
 * no longer reads back as `dateIso` in `timezone` is discarded in favor of
 * the uncorrected one, which — having no real local midnight to land on
 * either side of the correction — is the right answer for that case.
 *
 * @param {string} dateIso - YYYY-MM-DD
 * @param {string} timezone - an IANA zone name.
 * @returns {Date}
 */
function dayOpensAt(dateIso, timezone) {
  const [y, m, d] = dateIso.split('-').map(Number);
  const naiveUtc = Date.UTC(y, m - 1, d, 0, 0, 0);
  const offset1 = tzOffsetMs(timezone, naiveUtc);
  const uncorrectedMs = naiveUtc - offset1;
  let instantMs = uncorrectedMs;
  const offset2 = tzOffsetMs(timezone, instantMs);
  if (offset2 !== offset1) {
    const correctedMs = naiveUtc - offset2;
    instantMs =
      eventLocalDateString(timezone, new Date(correctedMs)) === dateIso
        ? correctedMs
        : uncorrectedMs;
  }
  return new Date(instantMs);
}

/**
 * The "Aug 7" label (no year, no weekday) for a SINGLE date, regardless of
 * whether it falls inside the configured wedding date range -- unlike
 * eventDays() above, which only labels a date it itself enumerated between
 * startDate/endDate. Same UTC-anchored Intl.DateTimeFormat formula as
 * eventDays(), reused rather than re-derived, so the two can never render
 * the same calendar date with two different label strings.
 * @param {string} dateIso - YYYY-MM-DD
 * @returns {string}
 */
function singleDayLabel(dateIso) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  return fmt.format(new Date(`${dateIso}T00:00:00Z`));
}

module.exports = {
  timezoneOptions,
  isKnownTimezone,
  resolveSelectedZone,
  eventDays,
  eventLocalDateString,
  dayOpensAt,
  singleDayLabel,
};
