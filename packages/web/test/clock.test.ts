import { describe, expect, it } from 'vitest';
import { startOfLocalDay, toLocalDate } from '@dongfan/shared';
import { earlierToday } from './fixtures/clock.js';

/**
 * A test helper with a test of its own.
 *
 * It earns one because its failure mode is the worst kind this repository
 * has: the whole screen suite passes all day and fails for a minute after
 * local midnight, on a machine nobody is watching, in the hour the app was
 * written for. Pinning the boundary here means the flow tests do not have
 * to wait for the clock to come round to find out.
 */

const TZ = 'Asia/Taipei';
const HOUR = 3_600_000;

/** A wall-clock instant in the baby's timezone, as a number. */
function at(date: string, clock: string): number {
  return startOfLocalDay(date, TZ) + hoursToMs(clock);
}

function hoursToMs(clock: string): number {
  const [h = '0', m = '0', s = '0'] = clock.split(':');
  return (Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000;
}

describe('an instant earlier today', () => {
  it('is the offset asked for, in the middle of the day', () => {
    const now = at('2026-09-22', '12:00:00');
    expect(earlierToday(2 * HOUR, TZ, now)).toBe(at('2026-09-22', '10:00:00'));
  });

  it('never lands on yesterday', () => {
    const now = at('2026-09-22', '01:00:00');
    const result = earlierToday(6 * HOUR, TZ, now);

    expect(result).toBe(at('2026-09-22', '00:00:00'));
    expect(toLocalDate(result, TZ)).toBe('2026-09-22');
  });

  it.each([
    ['exactly midnight', '00:00:00'],
    ['a second past it', '00:00:01'],
    ['half a minute past it', '00:00:30'],
    ['a minute past it', '00:01:00'],
  ])('is never in the future at %s', (_name, clock) => {
    const now = at('2026-09-22', clock);
    const started = earlierToday(2 * HOUR, TZ, now);

    // A start time after now makes every end time invalid: a timer begun
    // then and stopped at this moment ends before it began.
    expect(started).toBeLessThanOrEqual(now);
    expect(toLocalDate(started, TZ)).toBe('2026-09-22');
  });

  it('holds for every minute of the day', () => {
    const dayStart = at('2026-09-22', '00:00:00');

    for (let minute = 0; minute < 24 * 60; minute += 1) {
      const now = dayStart + minute * 60_000;
      const started = earlierToday(3 * HOUR, TZ, now);

      expect(started).toBeLessThanOrEqual(now);
      expect(started).toBeGreaterThanOrEqual(dayStart);
      expect(toLocalDate(started, TZ)).toBe('2026-09-22');
    }
  });
});
