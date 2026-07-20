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
