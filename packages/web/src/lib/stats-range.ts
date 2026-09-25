import { addLocalDays, addLocalMonths, toLocalDate } from '@dongfan/shared';

/**
 * Which stretch of days a chart is about, and how to label its axis.
 *
 * Pure, and separate from the screen, because every rule here is arithmetic
 * that is wrong by a day or a label at a time -- the kind of thing that looks
 * plausible on screen and is only provable in a test (spec 11.1).
 */

/** The four the spec offers (7.7). */
export const RANGES = ['week', 'month', 'halfYear', 'year'] as const;
export type Range = (typeof RANGES)[number];

/**
 * The window a range covers, starting on the given day.
 *
 * Closed at both ends, like every range the API takes (spec 3.4.1 rule 4),
 * so a week is seven days and not eight. Months are counted in calendar
 * space, so a month from 31 January ends on 27 February rather than on the
 * 2nd of March.
 */
export function windowFor(range: Range, start: string): { from: string; to: string } {
  if (range === 'week') return { from: start, to: addLocalDays(start, 6) };
  const months = range === 'month' ? 1 : range === 'halfYear' ? 6 : 12;
  return { from: start, to: addLocalDays(addLocalMonths(start, months), -1) };
}

/**
 * The start that makes a range end today.
 *
 * What somebody opening the screen wants to see, and the reason the picker
 * holds a start rather than an end: once it is on screen, moving it is how
 * you look at March.
 */
export function startEndingToday(range: Range, now: number, timeZone: string): string {
  const today = toLocalDate(now, timeZone);
  if (range === 'week') return addLocalDays(today, -6);
  const months = range === 'month' ? 1 : range === 'halfYear' ? 6 : 12;
  return addLocalDays(addLocalMonths(today, -months), 1);
}

/**
 * Which points get a label on the horizontal axis (spec 7.7).
 *
 * A week shows every day; a month shows the 1st, 5th, 10th and so on; six
 * months and a year show only the month. Labelling 365 points puts a grey
 * smear where the axis should be, and labelling every seventh one leaves a
 * chart whose ticks mean nothing in particular.
 */
export function axisLabel(range: Range, date: string, index: number): string | null {
  const day = Number(date.slice(8, 10));
  const month = Number(date.slice(5, 7));

  if (range === 'week') return date.slice(5).replace('-', '/');
  if (range === 'month') return day === 1 || day % 5 === 0 ? String(day) : null;
  // Only where a month begins, so the spacing follows the calendar rather
  // than the number of points -- and the first point always gets one, or a
  // range starting mid-month opens with no label at all.
  return day === 1 || index === 0 ? `${month}` : null;
}
