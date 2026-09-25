import { describe, expect, it } from 'vitest';
import { daysBetween, localToUtc, toLocalDate } from '@dongfan/shared';
import { RANGES, axisLabel, startEndingToday, windowFor } from '../src/lib/stats-range.js';

/**
 * The arithmetic behind the statistics screen.
 *
 * Every mistake available here is off by one day or one label, which is
 * exactly the kind that looks right on a chart. A week that is eight days
 * long, or a month range that reaches into the next month, changes every
 * total on the screen without anything appearing wrong.
 */

const TAIPEI = 'Asia/Taipei';

describe('the window a range covers', () => {
  it('makes a week seven days, not eight', () => {
    expect(windowFor('week', '2026-06-15')).toEqual({ from: '2026-06-15', to: '2026-06-21' });
    expect(daysBetween('2026-06-15', '2026-06-21')).toBe(7);
  });

  it('ends a month the day before the next one starts', () => {
    expect(windowFor('month', '2026-06-15')).toEqual({ from: '2026-06-15', to: '2026-07-14' });
  });

  it('does not reach into the month after when the start has no counterpart', () => {
    // 31 January plus a month is 28 February, so the window ends on the
    // 27th. Rolling over would put three days of March in a month view.
    expect(windowFor('month', '2026-01-31')).toEqual({ from: '2026-01-31', to: '2026-02-27' });
  });

  it('covers six months and a year', () => {
    expect(windowFor('halfYear', '2026-01-01')).toEqual({ from: '2026-01-01', to: '2026-06-30' });
    expect(windowFor('year', '2026-01-01')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  });

  it('never asks for more days than the endpoint will aggregate', () => {
    // The API refuses anything over 366 days (spec 5.6), so a range the
    // screen can select and the endpoint will not answer would be a dead
    // control. A leap year is the widest case.
    for (const range of RANGES) {
      for (const start of ['2026-06-15', '2027-03-01', '2028-01-01', '2028-02-29']) {
        const { from, to } = windowFor(range, start);
        expect(daysBetween(from, to), `${range} from ${start}`).toBeLessThanOrEqual(366);
      }
    }
  });
});

describe('the start that ends a range today', () => {
  const now = localToUtc({ year: 2026, month: 6, day: 15, hour: 10 }, TAIPEI);
  const today = toLocalDate(now, TAIPEI);

  it('ends on today, not tomorrow', () => {
    for (const range of RANGES) {
      const { to } = windowFor(range, startEndingToday(range, now, TAIPEI));
      expect(to, range).toBe(today);
    }
  });

  it('reads today in the baby timezone, never the device one', () => {
    // 16:30 UTC is already the next day in Taipei, and a chart that opened
    // on the wrong day would be off by one for eight hours of every day.
    const evening = Date.UTC(2026, 5, 15, 16, 30);
    expect(startEndingToday('week', evening, TAIPEI)).toBe('2026-06-10');
    expect(startEndingToday('week', evening, 'UTC')).toBe('2026-06-09');
  });
});

describe('how dense the axis labels are', () => {
  it('labels every day of a week, with the month', () => {
    expect(axisLabel('week', '2026-06-15', 0)).toBe('06/15');
    expect(axisLabel('week', '2026-06-21', 6)).toBe('06/21');
  });

  it('labels the 1st, 5th, 10th and so on of a month', () => {
    expect(axisLabel('month', '2026-06-01', 0)).toBe('1');
    expect(axisLabel('month', '2026-06-05', 4)).toBe('5');
    expect(axisLabel('month', '2026-06-10', 9)).toBe('10');
    expect(axisLabel('month', '2026-06-07', 6)).toBeNull();
  });

  it('labels only the months over six months and a year', () => {
    expect(axisLabel('halfYear', '2026-07-01', 30)).toBe('7');
    expect(axisLabel('halfYear', '2026-07-02', 31)).toBeNull();
    expect(axisLabel('year', '2026-12-01', 334)).toBe('12');
  });

  it('labels the first point even when the range starts mid-month', () => {
    // Otherwise a year from the 15th opens with a bare axis until the 1st.
    expect(axisLabel('year', '2026-06-15', 0)).toBe('6');
    expect(axisLabel('halfYear', '2026-06-15', 0)).toBe('6');
  });
});
