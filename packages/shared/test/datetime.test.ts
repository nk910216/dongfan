import { describe, expect, it } from 'vitest';
import {
  MAX_EVENT_DURATION_MS,
  addLocalDays,
  addLocalMonths,
  ageAt,
  coversLocalDate,
  localToUtc,
  msOnLocalDate,
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

describe('addLocalMonths', () => {
  it('moves whole months', () => {
    expect(addLocalMonths('2026-06-15', 1)).toBe('2026-07-15');
    expect(addLocalMonths('2026-06-15', 6)).toBe('2026-12-15');
    expect(addLocalMonths('2026-06-15', 12)).toBe('2027-06-15');
  });

  it('clamps to the last day rather than rolling into the next month', () => {
    // 31 January plus a month is 28 February. Rolling over gives 3 March,
    // and a "month" range would then quietly include three days of the one
    // after it.
    expect(addLocalMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addLocalMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(addLocalMonths('2028-01-31', 1)).toBe('2028-02-29');
  });

  it('goes backwards across a year boundary', () => {
    expect(addLocalMonths('2026-01-15', -1)).toBe('2025-12-15');
    expect(addLocalMonths('2026-01-15', -12)).toBe('2025-01-15');
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

describe('msOnLocalDate', () => {
  const started = taipei(2026, 9, 20, 23, 10);
  const ended = taipei(2026, 9, 21, 7, 5);

  it('gives each day only its own share of a sleep that crossed midnight', () => {
    expect(msOnLocalDate(started, ended, '2026-09-20', TAIPEI)).toBe(50 * 60_000);
    expect(msOnLocalDate(started, ended, '2026-09-21', TAIPEI)).toBe(7 * 60 * 60_000 + 5 * 60_000);
  });

  it('answers zero for a day the event never reached', () => {
    expect(msOnLocalDate(started, ended, '2026-09-22', TAIPEI)).toBe(0);
    expect(msOnLocalDate(started, ended, '2026-09-19', TAIPEI)).toBe(0);
  });

  it('answers zero for an event that has not ended, on its own day', () => {
    // Its length changes with the clock, so it cannot be counted anywhere.
    expect(msOnLocalDate(started, null, '2026-09-20', TAIPEI)).toBe(0);
  });
});

describe('coversLocalDate', () => {
  const started = taipei(2026, 9, 20, 23, 10);
  const ended = taipei(2026, 9, 21, 7, 5);

  it('shows an overnight sleep on the morning it ran into', () => {
    // The whole point: its local_date is the 20th, so a calendar for the
    // 21st that asked only for local_date = 21 would lose seven hours.
    expect(coversLocalDate('2026-09-20', started, ended, '2026-09-21', TAIPEI)).toBe(true);
  });

  it('shows an event on the day it is counted on', () => {
    expect(coversLocalDate('2026-09-20', started, ended, '2026-09-20', TAIPEI)).toBe(true);
  });

  it('shows an unfinished event on its own day and nowhere else', () => {
    // Zero duration does not mean absent. A running timer belongs on the
    // day it started, and on no other, however long it has been going.
    expect(coversLocalDate('2026-09-20', started, null, '2026-09-20', TAIPEI)).toBe(true);
    expect(coversLocalDate('2026-09-20', started, null, '2026-09-21', TAIPEI)).toBe(false);
  });

  it('does not show an event on a day it merely touches the edge of', () => {
    // Ending exactly at midnight puts nothing in the new day.
    const toMidnight = taipei(2026, 9, 21, 0, 0);
    expect(coversLocalDate('2026-09-20', started, toMidnight, '2026-09-21', TAIPEI)).toBe(false);
  });

  it('does not show an unrelated day', () => {
    expect(coversLocalDate('2026-09-20', started, ended, '2026-09-22', TAIPEI)).toBe(false);
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
