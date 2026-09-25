import { describe, expect, it } from 'vitest';
import { addLocalDays, daysBetween, localToUtc, startOfLocalDay, toLocalDate } from '@dongfan/shared';
import {
  RANGES, axisLabel, dayIndex, daysIn, daysOf, startEndingToday, windowFor,
} from '../src/lib/stats-range.js';

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

  it('makes the other three a fixed number of days too', () => {
    // Fixed counts rather than calendar months, and deliberately.
    //
    // A calendar-month window cannot always end today: "a month ending on 29
    // March" would need a start whose month-later date is 30 March, and there
    // is none -- 28 February lands on 28 March and 1 March on 1 April. So a
    // calendar range either misses today or reaches into days that have not
    // happened, and the server fills those with zeros that drag the average
    // down.
    //
    // They are also comparable this way: a total over a calendar month
    // changes between February and March partly because the months are
    // different lengths, which is not a fact about the baby.
    expect(daysIn('week')).toBe(7);
    expect(daysIn('month')).toBe(30);
    expect(daysIn('halfYear')).toBe(183);
    expect(daysIn('year')).toBe(365);

    expect(windowFor('month', '2026-06-15')).toEqual({ from: '2026-06-15', to: '2026-07-14' });
    expect(windowFor('year', '2026-01-01')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  });

  it('is the same length whatever month it starts in', () => {
    for (const start of ['2026-01-31', '2026-02-01', '2028-02-29']) {
      const { from, to } = windowFor('month', start);
      expect(daysBetween(from, to), start).toBe(30);
    }
  });

  it('gives every day of the window, in order and without gaps', () => {
    const days = daysOf('week', '2026-06-15');
    expect(days).toHaveLength(7);
    expect(days[0]).toBe('2026-06-15');
    expect(days[6]).toBe('2026-06-21');
  });

  it('places a date by its day, not by where it sits in a list', () => {
    // Three weighings on the 1st, the 2nd and the 30th are three points.
    // Spacing them evenly draws a month of steady growth that never
    // happened, which is why the chart asks for this rather than counting.
    expect(dayIndex('2026-09-01', '2026-09-01')).toBe(0);
    expect(dayIndex('2026-09-01', '2026-09-02')).toBe(1);
    expect(dayIndex('2026-09-01', '2026-09-30')).toBe(29);
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

  it('ends on today on every day of three years, leap Februaries included', () => {
    // One fixed day proves nothing here. `addLocalMonths` clamps and is
    // therefore not reversible, so subtracting a month and adding a day gave
    // a window ending on 27 February when today was the 28th -- today itself
    // missing from a chart of the last month -- and one ending on 31 March
    // when today was the 29th, so two days that had not happened were
    // included, zero-filled, and dragged the average down. Both passed the
    // single-date test above.
    const wrong: string[] = [];

    for (let date = '2026-01-01'; date <= '2028-12-31'; date = addLocalDays(date, 1)) {
      const noon = startOfLocalDay(date, TAIPEI) + 12 * 3_600_000;
      for (const range of RANGES) {
        const { to } = windowFor(range, startEndingToday(range, noon, TAIPEI));
        if (to !== date) wrong.push(`${range} on ${date} ended ${to}`);
      }
    }

    expect(wrong).toEqual([]);
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
