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
