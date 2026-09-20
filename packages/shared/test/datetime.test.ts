import { describe, expect, it } from 'vitest';
import {
  MAX_EVENT_DURATION_MS,
  addLocalDays,
  ageAt,
  localToUtc,
  msToMinutes,
  splitByLocalDate,
  splitDuration,
  startOfLocalDay,
  toLocalDate,
} from '../src/datetime.js';

const TAIPEI = 'Asia/Taipei';

/** Builds an instant from a Taipei wall-clock time. */
const taipei = (year: number, month: number, day: number, hour = 0, minute = 0): number =>
  localToUtc({ year, month, day, hour, minute }, TAIPEI);

describe('toLocalDate', () => {
  it('resolves the calendar day in the baby timezone, not UTC', () => {
    // 16:30 UTC is already the next day in Taipei (UTC+8).
    const instant = Date.UTC(2026, 8, 20, 16, 30);
    expect(toLocalDate(instant, TAIPEI)).toBe('2026-09-21');
    expect(toLocalDate(instant, 'UTC')).toBe('2026-09-20');
  });

  it('places an instant just before local midnight on the earlier day', () => {
    expect(toLocalDate(taipei(2026, 9, 20, 23, 59), TAIPEI)).toBe('2026-09-20');
    expect(toLocalDate(taipei(2026, 9, 21, 0, 0), TAIPEI)).toBe('2026-09-21');
  });
});

describe('localToUtc', () => {
  it('round-trips a wall-clock time back to the same calendar day', () => {
    const instant = taipei(2026, 2, 29 - 1, 9, 15);
    expect(toLocalDate(instant, TAIPEI)).toBe('2026-02-28');
  });

  it('treats a Taipei midnight as 16:00 UTC the previous day', () => {
    expect(taipei(2026, 9, 20)).toBe(Date.UTC(2026, 8, 19, 16, 0));
  });
});

describe('addLocalDays', () => {
  it('crosses a month boundary', () => {
    expect(addLocalDays('2026-09-30', 1)).toBe('2026-10-01');
  });

  it('crosses a year boundary backwards', () => {
    expect(addLocalDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('handles a leap day', () => {
    expect(addLocalDays('2028-02-28', 1)).toBe('2028-02-29');
  });
});

describe('splitByLocalDate', () => {
  it('returns a single segment when the event stays within one day', () => {
    const segments = splitByLocalDate(taipei(2026, 9, 20, 13, 5), taipei(2026, 9, 20, 13, 24), TAIPEI);
    expect(segments).toEqual([{ date: '2026-09-20', ms: 19 * 60_000 }]);
  });

  it('splits sleep that crosses midnight across both days', () => {
    // 23:10 to 07:05 is the case that breaks naive charts: counted on the
    // start day, but its duration has to land on both.
    const segments = splitByLocalDate(taipei(2026, 9, 20, 23, 10), taipei(2026, 9, 21, 7, 5), TAIPEI);
    expect(segments).toEqual([
      { date: '2026-09-20', ms: 50 * 60_000 },
      { date: '2026-09-21', ms: 7 * 60 * 60_000 + 5 * 60_000 },
    ]);
  });

  it('does not emit an empty segment when the event ends exactly at midnight', () => {
    const segments = splitByLocalDate(taipei(2026, 9, 20, 23, 0), taipei(2026, 9, 21, 0, 0), TAIPEI);
    expect(segments).toEqual([{ date: '2026-09-20', ms: 60 * 60_000 }]);
  });

  it('attributes an event starting exactly at midnight to the new day', () => {
    const segments = splitByLocalDate(taipei(2026, 9, 21, 0, 0), taipei(2026, 9, 21, 0, 30), TAIPEI);
    expect(segments).toEqual([{ date: '2026-09-21', ms: 30 * 60_000 }]);
  });

  it('crosses midnight at most once for the longest allowed event', () => {
    const start = taipei(2026, 9, 20, 12, 0);
    const segments = splitByLocalDate(start, start + MAX_EVENT_DURATION_MS, TAIPEI);
    expect(segments).toHaveLength(2);
    expect(segments.reduce((sum, s) => sum + s.ms, 0)).toBe(MAX_EVENT_DURATION_MS);
  });

  it('returns nothing for a zero-length interval', () => {
    const at = taipei(2026, 9, 20, 8, 0);
    expect(splitByLocalDate(at, at, TAIPEI)).toEqual([]);
  });

  it('rejects an interval that ends before it starts', () => {
    expect(() => splitByLocalDate(taipei(2026, 9, 20, 9, 0), taipei(2026, 9, 20, 8, 0), TAIPEI)).toThrow();
  });
});

describe('startOfLocalDay', () => {
  it('matches the instant of local midnight', () => {
    expect(startOfLocalDay('2026-09-20', TAIPEI)).toBe(taipei(2026, 9, 20));
  });
});

describe('duration helpers', () => {
  it('rounds to whole minutes once, at the end', () => {
    // Twenty events each 30 seconds over a minute boundary would drift by
    // ten minutes if rounded individually.
    const total = 20 * 90_000;
    expect(msToMinutes(total)).toBe(30);
  });

  it('splits into hours and minutes', () => {
    expect(splitDuration(83 * 60_000)).toEqual({ hours: 1, minutes: 23 });
  });
});

describe('ageAt', () => {
  it('counts whole months and remaining days', () => {
    expect(ageAt('2026-03-08', taipei(2026, 9, 20, 10, 0), TAIPEI)).toEqual({ months: 6, days: 12 });
  });

  it('borrows from the previous month when the day has not been reached', () => {
    expect(ageAt('2026-01-31', taipei(2026, 3, 1, 10, 0), TAIPEI)).toEqual({ months: 1, days: 1 });
  });

  it('clamps the anniversary to the length of a short month', () => {
    // Born on the 31st: one month old on the last day of February.
    expect(ageAt('2026-01-31', taipei(2026, 2, 28, 10, 0), TAIPEI)).toEqual({ months: 1, days: 0 });
  });

  it('reports zero on the day of birth', () => {
    expect(ageAt('2026-09-20', taipei(2026, 9, 20, 23, 0), TAIPEI)).toEqual({ months: 0, days: 0 });
  });
});
