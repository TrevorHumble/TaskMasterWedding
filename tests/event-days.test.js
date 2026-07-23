// tests/event-days.test.js
// Unit coverage for src/services/event-days.js (issue #681):
//   AC2 — America/Denver and America/Phoenix (same standard-time offset,
//         opposite DST behavior) round-trip as distinct IANA option values,
//         and a grouped member (America/Boise) resolves to its group's
//         canonical entry (America/Denver) for pre-selection.
//   AC3 — eventDays(2026-08-07, 2026-08-09) returns exactly three days
//         labeled "Aug 7"/"Aug 8"/"Aug 9" (no year, no weekday), one per
//         calendar day inclusive, correct regardless of the server's local
//         timezone (the "Aug 7 becomes Aug 6" pitfall).
//
// No app/DB boot needed — this module has no dependency on src/db.js or
// config.js, so these are plain unit tests against the real @vvo/tzdb data.
'use strict';

const {
  timezoneOptions,
  isKnownTimezone,
  resolveSelectedZone,
  eventDays,
  eventLocalDateString,
  dayOpensAt,
  eventLocalInstant,
  singleDayLabel,
} = require('../src/services/event-days');

describe('timezoneOptions', () => {
  const options = timezoneOptions();

  it('includes America/Denver and America/Phoenix as distinct IANA values with the approved label shape', () => {
    const denver = options.find((o) => o[0] === 'America/Denver');
    const phoenix = options.find((o) => o[0] === 'America/Phoenix');
    expect(denver).toEqual(['America/Denver', '(UTC-07:00) Mountain Time — Denver']);
    expect(phoenix).toEqual(['America/Phoenix', '(UTC-07:00) Mountain Time — Phoenix']);
    // Same standard-time offset, but two separate option rows — a consumer
    // reading option[0] back gets the exact zone name, never a merged label.
    expect(denver[0]).not.toBe(phoenix[0]);
  });

  it('orders every option by UTC offset descending (UTC+14 first, most-negative offset last)', () => {
    // Every option value is an IANA name; re-derive each pair's offset via
    // resolveSelectedZone + isKnownTimezone would be indirect — instead walk
    // the option array's own IANA names against the same tzdb source used to
    // build it (getTimeZones), asserting each is <= the previous entry's
    // offset (non-increasing across the list).
    const { getTimeZones } = require('@vvo/tzdb');
    const offsetByName = new Map(
      getTimeZones({ includeUtc: true }).map((z) => [z.name, z.rawOffsetInMinutes])
    );
    for (let i = 1; i < options.length; i++) {
      const prevOffset = offsetByName.get(options[i - 1][0]);
      const curOffset = offsetByName.get(options[i][0]);
      expect(curOffset).toBeLessThanOrEqual(prevOffset);
    }
  });
});

describe('isKnownTimezone', () => {
  it('accepts a canonical entry and a grouped member of the same real zone', () => {
    expect(isKnownTimezone('America/Denver')).toBe(true);
    expect(isKnownTimezone('America/Boise')).toBe(true);
  });

  it('rejects an unknown name, a bare offset string, and empty input', () => {
    expect(isKnownTimezone('Not/AZone')).toBe(false);
    expect(isKnownTimezone('UTC-07:00')).toBe(false);
    expect(isKnownTimezone('')).toBe(false);
  });
});

describe('resolveSelectedZone', () => {
  it('a grouped member (America/Boise) resolves to its group canonical entry (America/Denver)', () => {
    expect(resolveSelectedZone('America/Boise')).toBe('America/Denver');
  });

  it('an already-canonical name resolves to itself', () => {
    expect(resolveSelectedZone('America/Denver')).toBe('America/Denver');
  });

  it('an unknown name is returned unchanged rather than substituted', () => {
    expect(resolveSelectedZone('Not/AZone')).toBe('Not/AZone');
  });
});

describe('eventDays', () => {
  const originalTZ = process.env.TZ;
  afterEach(() => {
    if (originalTZ === undefined) delete process.env.TZ;
    else process.env.TZ = originalTZ;
  });

  it('2026-08-07..2026-08-09 returns three days labeled Aug 7 / Aug 8 / Aug 9, no year or weekday', () => {
    expect(eventDays('2026-08-07', '2026-08-09')).toEqual([
      { iso: '2026-08-07', label: 'Aug 7' },
      { iso: '2026-08-08', label: 'Aug 8' },
      { iso: '2026-08-09', label: 'Aug 9' },
    ]);
  });

  it('the calendar-day label is correct regardless of the server local timezone', () => {
    // A server local timezone far ahead of UTC (UTC+14) is exactly the
    // condition that would shift Aug 7 to Aug 6 (or vice versa) if the
    // implementation ever built the Date from a bare, non-UTC-anchored
    // string. eventDays anchors with a 'Z' suffix and formats with
    // timeZone: 'UTC', so the result must be identical either way.
    process.env.TZ = 'Pacific/Kiritimati';
    expect(eventDays('2026-08-07', '2026-08-07')).toEqual([{ iso: '2026-08-07', label: 'Aug 7' }]);

    process.env.TZ = 'Pacific/Honolulu'; // UTC-10, the opposite extreme
    expect(eventDays('2026-08-07', '2026-08-07')).toEqual([{ iso: '2026-08-07', label: 'Aug 7' }]);
  });

  it('start === end returns exactly one day', () => {
    expect(eventDays('2026-08-07', '2026-08-07')).toEqual([{ iso: '2026-08-07', label: 'Aug 7' }]);
  });

  it('start after end returns an empty array rather than looping backwards', () => {
    expect(eventDays('2026-08-09', '2026-08-07')).toEqual([]);
  });

  it('a month boundary formats correctly (no year, abbreviated month changes mid-range)', () => {
    expect(eventDays('2026-07-31', '2026-08-01')).toEqual([
      { iso: '2026-07-31', label: 'Jul 31' },
      { iso: '2026-08-01', label: 'Aug 1' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Issue #753 AC2: "today" and "when a day opens" both answer in the EVENT'S
// configured timezone, never server UTC. America/Boise observes Mountain
// Daylight Time (UTC-6) in August, so a UTC instant a few hours past
// midnight is still the PREVIOUS calendar day locally — exactly the
// condition that would silently flip a challenge's day boundary if this
// module ever built the answer from server-local time or bare UTC instead.
// ---------------------------------------------------------------------------
describe('eventLocalDateString (issue #753)', () => {
  it('2026-08-08T04:00Z is still 2026-08-07 in America/Boise (UTC-6 in August)', () => {
    expect(eventLocalDateString('America/Boise', new Date('2026-08-08T04:00:00Z'))).toBe(
      '2026-08-07'
    );
  });

  it('2026-08-08T06:00:01Z has crossed into 2026-08-08 in America/Boise (just past local midnight)', () => {
    expect(eventLocalDateString('America/Boise', new Date('2026-08-08T06:00:01Z'))).toBe(
      '2026-08-08'
    );
  });

  it('the same instant reads a different calendar date in a zone ahead of UTC', () => {
    // 2026-08-08T04:00Z is already 2026-08-08 in Pacific/Auckland (UTC+12),
    // the opposite side of the date line from the America/Boise case above —
    // proof this reads the REQUESTED zone, not a hardcoded one.
    expect(eventLocalDateString('Pacific/Auckland', new Date('2026-08-08T04:00:00Z'))).toBe(
      '2026-08-08'
    );
  });

  it('omitting `instant` defaults to "now" rather than throwing', () => {
    expect(eventLocalDateString('America/Boise')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('dayOpensAt (issue #753)', () => {
  it('2026-08-07 opens at 2026-08-07T06:00:00Z in America/Boise (local midnight, MDT = UTC-6)', () => {
    expect(dayOpensAt('2026-08-07', 'America/Boise').toISOString()).toBe(
      '2026-08-07T06:00:00.000Z'
    );
  });

  it('the returned instant round-trips through eventLocalDateString back to the same date', () => {
    const opens = dayOpensAt('2026-08-09', 'America/Boise');
    expect(eventLocalDateString('America/Boise', opens)).toBe('2026-08-09');
    // One millisecond earlier is still the PREVIOUS calendar day locally —
    // proof this is the exact boundary instant, not just "sometime that day".
    const oneMsEarlier = new Date(opens.getTime() - 1);
    expect(eventLocalDateString('America/Boise', oneMsEarlier)).toBe('2026-08-08');
  });

  it('a UTC-ahead zone opens its day before UTC midnight, not after', () => {
    // Pacific/Auckland is UTC+12 in (southern-hemisphere winter) August, so
    // its local midnight on 2026-08-08 falls on 2026-08-07T12:00:00Z.
    expect(dayOpensAt('2026-08-08', 'Pacific/Auckland').toISOString()).toBe(
      '2026-08-07T12:00:00.000Z'
    );
  });

  it('a zone whose local midnight does not exist on this date (review fix): America/Santiago skips 00:00->01:00 on 2026-09-06, still round-trips', () => {
    // Chile's spring-forward transition lands at 2026-09-06T04:00Z: clocks
    // jump from 00:00 straight to 01:00 local, so there is no instant that
    // reads as "2026-09-06T00:00" on a Santiago wall clock. The naive first
    // pass already lands on the correct instant (04:00Z, the first real
    // moment of 2026-09-06 in that zone); the SECOND pass's offset re-check
    // used to "correct" past it onto 03:00Z, which reads back as 23:00 on
    // 2026-09-05 -- the previous day. Assert both the exact instant AND that
    // it round-trips back through eventLocalDateString, the same shape the
    // America/Boise round-trip test above asserts.
    const opens = dayOpensAt('2026-09-06', 'America/Santiago');
    expect(opens.toISOString()).toBe('2026-09-06T04:00:00.000Z');
    expect(eventLocalDateString('America/Santiago', opens)).toBe('2026-09-06');
  });
});

// Issue #763 plan step 1 (renamed to eventLocalInstant() at PR review, M5 --
// dayOpensAt() now names ONLY the 2-argument local-midnight question; this is
// the general 4-argument form it wraps): the candidate-selection rule
// described in that issue's "The date math" section -- NOT a widened
// round-trip guard, which the issue's own probe showed returns an instant an
// hour EARLY for a DST-gap wall time in every zone east of UTC (Correction
// B). Every expected value below is copied verbatim from that issue's own
// table, independently re-derived by a same-file probe script before being
// written here (not transcribed on faith) -- see the two-argument-parity
// describe block further down for the regression half of that same
// correction.
describe('eventLocalInstant with hour/minute (issue #763 criterion 7)', () => {
  it('an ordinary wall time (no nearby DST transition): 2026-08-07 19:00 America/Boise reads back exactly', () => {
    const opens = eventLocalInstant('2026-08-07', 'America/Boise', 19, 0);
    expect(opens.toISOString()).toBe('2026-08-08T01:00:00.000Z');
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Boise',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(opens);
    const get = (t) => parts.find((p) => p.type === t).value;
    expect(`${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`).toBe(
      '2026-08-07 19:00'
    );
  });

  it('a DST-gap wall time WEST of UTC (America/Boise 2027-03-14 02:30, spring-forward jumps 02:00->03:00): resolves to the first real moment at or after it, 03:30 -- never the previous day, never an hour early', () => {
    const opens = eventLocalInstant('2027-03-14', 'America/Boise', 2, 30);
    expect(opens.toISOString()).toBe('2027-03-14T09:30:00.000Z');
  });

  it('a DST-gap wall time EAST of UTC (Europe/Paris 2027-03-28 02:30): the class the naive widened-guard rule gets wrong -- must read back 03:30, not an hour early at 01:30', () => {
    const opens = eventLocalInstant('2027-03-28', 'Europe/Paris', 2, 30);
    expect(opens.toISOString()).toBe('2027-03-28T01:30:00.000Z');
    const hourMin = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Paris',
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).format(opens);
    expect(hourMin).toBe('03:30');
  });

  it('a DST-gap wall time EAST of UTC, southern hemisphere (Australia/Sydney 2026-10-04 02:30): also reads back 03:30, not 01:30', () => {
    const opens = eventLocalInstant('2026-10-04', 'Australia/Sydney', 2, 30);
    expect(opens.toISOString()).toBe('2026-10-03T16:30:00.000Z');
    const hourMin = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Australia/Sydney',
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).format(opens);
    expect(hourMin).toBe('03:30');
  });

  it('an AMBIGUOUS wall time (America/Boise 2027-11-07 01:30, fall-back repeats 01:00-02:00 twice): resolves to its FIRST occurrence', () => {
    const opens = eventLocalInstant('2027-11-07', 'America/Boise', 1, 30);
    expect(opens.toISOString()).toBe('2027-11-07T07:30:00.000Z');
    const hourMin = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Boise',
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).format(opens);
    expect(hourMin).toBe('01:30');
  });
});

// Issue #763's Correction A/B: the existing TWO-argument callers (#753's
// seal predicate, #754's daily-challenge rows) must see byte-identical
// behavior now that eventLocalInstant() (dayOpensAt()'s general form) exists
// -- asserted directly for the skipped-local-midnight-EAST-of-UTC class the
// pre-#763 test suite never covered (only Boise/Auckland/Santiago, none of
// that class), which is exactly the class the widened-round-trip-guard
// alternative regressed. See the exhaustive sweep further down for the same
// claim made across every zone, not just these three hand-picked ones.
describe('dayOpensAt two-argument parity after gaining hour/minute (issue #763 Correction B)', () => {
  it('Africa/Cairo 2026-04-24 (skips local midnight, east of UTC): unchanged from the pre-#763 behavior, 2026-04-23T22:00:00.000Z (reads 01:00, not the previous day)', () => {
    const opens = dayOpensAt('2026-04-24', 'Africa/Cairo');
    expect(opens.toISOString()).toBe('2026-04-23T22:00:00.000Z');
    expect(eventLocalDateString('Africa/Cairo', opens)).toBe('2026-04-24');
  });

  it('Asia/Beirut 2027-03-28 (skips local midnight, east of UTC): still reads back as 2027-03-28, never the previous day', () => {
    const opens = dayOpensAt('2027-03-28', 'Asia/Beirut');
    expect(eventLocalDateString('Asia/Beirut', opens)).toBe('2027-03-28');
  });

  it('every previously-tested two-argument case is still byte-identical: America/Boise, Pacific/Auckland, America/Santiago', () => {
    expect(dayOpensAt('2026-08-07', 'America/Boise').toISOString()).toBe(
      '2026-08-07T06:00:00.000Z'
    );
    expect(dayOpensAt('2026-08-08', 'Pacific/Auckland').toISOString()).toBe(
      '2026-08-07T12:00:00.000Z'
    );
    expect(dayOpensAt('2026-09-06', 'America/Santiago').toISOString()).toBe(
      '2026-09-06T04:00:00.000Z'
    );
  });
});

// ---------------------------------------------------------------------------
// Issue #763 PR review, M2: this file's own doc comments (and DESIGN.md's
// matching ADR paragraph) used to CLAIM a sweep across every
// Intl.supportedValuesOf('timeZone') zone and a year of transition-adjacent
// dates with zero differences -- but no such sweep existed anywhere in the
// repo (`grep -rn "supportedValuesOf" tests/ src/` matched only the doc
// comment itself). These two describe blocks ARE that sweep, committed and
// runnable, so every sentence the doc comments make about it is checkable by
// running this suite. The date set below is 9 dates, not a "full year" --
// picked to land on or near a real DST transition somewhere in the world
// (the classes issue #763's own table already names: Boise/Paris/Sydney
// gaps, the Boise ambiguous hour, the Cairo/Santiago skipped-midnight cases)
// plus two ordinary control dates, rather than walking all 365 days of a
// year for a marginal gain in coverage at 40x the runtime.
// ---------------------------------------------------------------------------
const DST_SWEEP_ZONES = Intl.supportedValuesOf('timeZone');
const DST_SWEEP_DATES = [
  '2027-01-01', // ordinary control, no transition anywhere near it
  '2027-03-14', // America/Boise spring-forward gap (issue #763's own case)
  '2027-03-28', // Europe/Paris + Asia/Beirut spring-forward gap
  '2027-04-04', // ordinary control, a different season
  '2027-04-24', // Africa/Cairo-class skipped-local-midnight date
  '2027-09-06', // America/Santiago-class spring-forward (S. hemisphere)
  '2027-10-04', // Australia/Sydney-class spring-forward (S. hemisphere)
  '2027-10-31', // common Northern-Hemisphere fall-back (last Sunday Oct)
  '2027-11-07', // America/Boise fall-back, ambiguous hour
];

// A locally-defined copy of the algorithm dayOpensAt() shipped BEFORE issue
// #763 (transcribed from the pre-#763 git diff, not re-derived from memory),
// so this sweep compares the SHIPPED two-argument dayOpensAt() against an
// independent implementation of what it used to do -- not against itself.
function tzOffsetMsPreIssue763(timezone, utcMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
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
function dayOpensAtPreIssue763(dateIso, timezone) {
  const [y, m, d] = dateIso.split('-').map(Number);
  const naiveUtc = Date.UTC(y, m - 1, d, 0, 0, 0);
  const offset1 = tzOffsetMsPreIssue763(timezone, naiveUtc);
  const uncorrectedMs = naiveUtc - offset1;
  let instantMs = uncorrectedMs;
  const offset2 = tzOffsetMsPreIssue763(timezone, instantMs);
  if (offset2 !== offset1) {
    const correctedMs = naiveUtc - offset2;
    instantMs =
      eventLocalDateString(timezone, new Date(correctedMs)) === dateIso
        ? correctedMs
        : uncorrectedMs;
  }
  return new Date(instantMs);
}

describe('dayOpensAt exhaustive two-argument regression sweep (issue #763 M2 fix)', () => {
  it(`matches the pre-#763 algorithm across every zone Intl.supportedValuesOf('timeZone') reports (${DST_SWEEP_ZONES.length} zones) and ${DST_SWEEP_DATES.length} transition-adjacent dates (${DST_SWEEP_ZONES.length * DST_SWEEP_DATES.length} pairs): zero differences`, () => {
    const differences = [];
    for (const tz of DST_SWEEP_ZONES) {
      for (const dateIso of DST_SWEEP_DATES) {
        const shipped = dayOpensAt(dateIso, tz).toISOString();
        const pre763 = dayOpensAtPreIssue763(dateIso, tz).toISOString();
        if (shipped !== pre763) {
          differences.push(`${tz} ${dateIso}: shipped=${shipped} pre-#763=${pre763}`);
        }
      }
    }
    expect(differences).toEqual([]);
  });
});

describe('eventLocalInstant never reads back before the requested wall time (issue #763 M2 fix)', () => {
  it(`holds across every zone (${DST_SWEEP_ZONES.length}) and the same ${DST_SWEEP_DATES.length} transition-adjacent dates at a non-midnight wall time, 02:30 local (${DST_SWEEP_ZONES.length * DST_SWEEP_DATES.length} pairs)`, () => {
    const hour = 2;
    const minute = 30;
    const violations = [];
    for (const tz of DST_SWEEP_ZONES) {
      for (const dateIso of DST_SWEEP_DATES) {
        const [y, m, d] = dateIso.split('-').map(Number);
        const requestedKey = ((y * 100 + m) * 100 + d) * 10000 + hour * 100 + minute;
        const instant = eventLocalInstant(dateIso, tz, hour, minute);
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone: tz,
          hourCycle: 'h23',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        }).formatToParts(instant);
        const get = (type) => Number(parts.find((p) => p.type === type).value);
        const readingKey =
          ((get('year') * 100 + get('month')) * 100 + get('day')) * 10000 +
          get('hour') * 100 +
          get('minute');
        if (readingKey < requestedKey) {
          violations.push(
            `${tz} ${dateIso} ${hour}:${minute} -> reads back key ${readingKey}, requested ${requestedKey}`
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('singleDayLabel (issue #753)', () => {
  it('formats a single date as "Aug 7" (no year, no weekday)', () => {
    expect(singleDayLabel('2026-08-07')).toBe('Aug 7');
  });

  it('formats a date OUTSIDE the configured wedding range — eventDays() cannot do this, singleDayLabel can', () => {
    expect(singleDayLabel('2026-12-25')).toBe('Dec 25');
  });

  it('is correct regardless of the server local timezone (same UTC-anchoring as eventDays)', () => {
    const originalTZ = process.env.TZ;
    try {
      process.env.TZ = 'Pacific/Kiritimati';
      expect(singleDayLabel('2026-08-07')).toBe('Aug 7');
    } finally {
      if (originalTZ === undefined) delete process.env.TZ;
      else process.env.TZ = originalTZ;
    }
  });
});
