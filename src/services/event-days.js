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
//
// A fourth, added by issue #763 for the flash-task scheduler (src/routes/
// admin.js's resolveFlashWrite): "when does a given event day open at a
// SPECIFIC time of day", not just at local midnight.
//   4. eventLocalInstant(dateIso, timezone, hour, minute) -- the general
//      form of #3's dayOpensAt(), which is now a thin wrapper over this
//      function with hour/minute fixed at 0/0 rather than a second copy of
//      the same candidate-selection algorithm.
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
 * `timezone`'s wall-clock reading (calendar + time-of-day, as plain numbers)
 * at `utcMs`. Internal helper shared by tzOffsetMs() and eventLocalInstant()
 * below (issue #763 plan step 1) — both need the SAME full-precision reading (not
 * just the date eventLocalDateString() returns), so this is the one place
 * formatToParts is called with the h23/second-precision option set, rather
 * than each caller building its own formatter that could silently drift out
 * of step (e.g. one using hour12).
 * @param {string} timezone
 * @param {number} utcMs
 * @returns {{year:number, month:number, day:number, hour:number, minute:number, second:number}}
 */
function wallClockParts(timezone, utcMs) {
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
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/**
 * The UTC offset (in milliseconds, east-of-UTC positive) `timezone` is
 * observing at `utcMs`. Internal helper for eventLocalInstant() below: read what a
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
  const w = wallClockParts(timezone, utcMs);
  const asIfUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asIfUtc - utcMs;
}

/**
 * The absolute instant `dateIso` (YYYY-MM-DD) at wall-clock `hour:minute`
 * occurs in `timezone`, as a UTC Date. `hour`/`minute` default to `0`/`0` --
 * local midnight -- so dayOpensAt() below can be a thin 2-argument wrapper
 * over this function (issue #763 PR review, M5): the two questions this
 * module answers -- "when is local midnight" and "when is this specific
 * event-local wall-clock moment" -- are different enough to need different
 * names even though one is a special case of the other, and #753's seal
 * predicate / #754's daily-challenge callers keep asking exactly the
 * question they always asked, byte-identical (see the regression note
 * below).
 *
 * Candidate-selection rule (issue #763 Corrections A and B — NOT a widened
 * round-trip guard; that rule silently returns an instant an HOUR EARLY for
 * a gap time in a zone east of UTC, and regresses the two-argument
 * skipped-local-midnight-east-of-UTC case — both demonstrated in the issue's
 * "The date math" section with failing zones):
 *
 *   1. Compute two candidate instants for the naive UTC reading of
 *      `dateIso T hour:minute` -- the offset observed AT that naive instant
 *      (candidate A), and the offset observed AT candidate A itself
 *      (candidate B). These two bracket a DST transition landing on the
 *      requested wall time; on an ordinary day (no nearby transition) they
 *      are the same instant.
 *   2. If either candidate's OWN local reading equals the request EXACTLY
 *      (calendar date AND time-of-day), return it. This is the ordinary case
 *      (no transition nearby) and the AMBIGUOUS case (a fall-back transition,
 *      where both candidates read back correctly but at different UTC
 *      instants) -- candidate A is checked first, so an ambiguous wall time
 *      resolves to its FIRST occurrence, never its second.
 *   3. Otherwise the requested wall time does not exist (a spring-forward
 *      transition jumped over it -- a "gap"): return the EARLIEST candidate
 *      whose local reading is AT OR AFTER the request. This is what makes a
 *      gap resolve to the first real moment at or after the request, in
 *      EITHER direction from UTC -- the naive "always take the corrected
 *      candidate" rule the widened-guard proposal used gets this backwards
 *      for a zone east of UTC (issue #763 Correction B's Paris/Sydney probe).
 *   4. If somehow neither candidate is at-or-after (not reachable by any
 *      case this file's own regression probe or issue #763's table
 *      exercises, but defensive rather than silently wrong): the later of
 *      the two candidates, which is the first real moment of the requested
 *      day in every skipped-local-midnight case actually observed.
 *
 * Verified (issue #763): the DST-gap table in "The date math" (Boise west,
 * Paris/Sydney east), the Boise ambiguous-hour case (first occurrence), and
 * two regression sweeps committed in tests/event-days.test.js, both run
 * across every zone `Intl.supportedValuesOf('timeZone')` reports (418 zones
 * on the Node version this was verified against) and 9 transition-adjacent
 * dates (3,762 zone/date pairs): dayOpensAt()'s hour=0/minute=0 output
 * against a locally-defined copy of the PRE-#763 two-argument algorithm
 * (zero differences), and this function's output at a non-midnight wall time
 * against the "never reads back before the request" invariant (zero
 * violations). Both sweeps are real committed tests, not a claim recorded
 * only here.
 *
 * @param {string} dateIso - YYYY-MM-DD
 * @param {string} timezone - an IANA zone name.
 * @param {number} [hour] - 0-23, defaults to 0.
 * @param {number} [minute] - 0-59, defaults to 0.
 * @returns {Date}
 */
function eventLocalInstant(dateIso, timezone, hour, minute) {
  const h = hour == null ? 0 : hour;
  const mi = minute == null ? 0 : minute;
  const [y, m, d] = dateIso.split('-').map(Number);
  const naiveUtc = Date.UTC(y, m - 1, d, h, mi, 0);

  const offsetA = tzOffsetMs(timezone, naiveUtc);
  const candidateA = naiveUtc - offsetA;
  const offsetB = tzOffsetMs(timezone, candidateA);
  const candidateB = naiveUtc - offsetB;
  const candidates = candidateA === candidateB ? [candidateA] : [candidateA, candidateB];

  const readsAsRequested = (ms) => {
    const w = wallClockParts(timezone, ms);
    return w.year === y && w.month === m && w.day === d && w.hour === h && w.minute === mi;
  };
  const exact = candidates.find(readsAsRequested);
  if (exact !== undefined) {
    return new Date(exact);
  }

  // No candidate reads back exactly -- a DST gap swallowed the requested
  // wall time. A single sortable integer key per reading (year/month/day/
  // hour/minute, most-significant first) lets "at or after" compare across
  // a month/year boundary the same as within one day.
  const requestedKey = ((y * 100 + m) * 100 + d) * 10000 + h * 100 + mi;
  const readingKey = (ms) => {
    const w = wallClockParts(timezone, ms);
    return ((w.year * 100 + w.month) * 100 + w.day) * 10000 + w.hour * 100 + w.minute;
  };
  const atOrAfter = candidates.filter((ms) => readingKey(ms) >= requestedKey).sort((a, b) => a - b);
  if (atOrAfter.length > 0) {
    return new Date(atOrAfter[0]);
  }
  return new Date(Math.max(...candidates));
}

/**
 * The absolute instant local midnight of `dateIso` (YYYY-MM-DD) occurs in
 * `timezone`, as a UTC Date -- the two-argument question #753's seal
 * predicate and #754's daily-challenge callers have always asked. A thin
 * wrapper over eventLocalInstant() above (hour/minute fixed at 0/0), not a
 * second copy of the algorithm, so the two can never drift apart (issue
 * #763 PR review, M5 -- this function's name must keep meaning exactly this
 * one question now that eventLocalInstant() answers the general one).
 *
 * @param {string} dateIso - YYYY-MM-DD
 * @param {string} timezone - an IANA zone name.
 * @returns {Date}
 */
function dayOpensAt(dateIso, timezone) {
  return eventLocalInstant(dateIso, timezone, 0, 0);
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
  eventLocalInstant,
  singleDayLabel,
};
