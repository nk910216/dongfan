import { addLocalDays, daysBetween, toLocalDate } from '@dongfan/shared';

/**
 * Which stretch of days a chart is about, and how to label its axis.
 *
 * Pure, and separate from the screen, because every rule here is arithmetic
 * that goes wrong by a day or a label at a time -- the kind of thing that
 * looks plausible on screen and is only provable in a test (spec 11.1).
 */

/** The four the spec offers (7.7). */
export const RANGES = ['week', 'month', 'halfYear', 'year'] as const;
export type Range = (typeof RANGES)[number];

/**
 * How many days each range covers.
 *
 * Fixed counts, not calendar months, and that is a decision rather than an
 * approximation.
 *
 * A window of calendar months cannot always end today. "A month ending on 29
 * March" would need a start whose month-later date is 30 March, and there is
 * none: 28 February lands on 28 March and 1 March lands on 1 April. So a
 * calendar-month range either misses today or reaches into days that have not
 * happened -- the second of which is worse, because the server fills them with
 * zeros and they drag the daily average down.
 *
 * Fixed counts also make the figures comparable. A total and a daily average
 * over a calendar month change between February and March partly because the
 * months are different lengths, which is not a fact about the baby.
 *
 * All four are inside `MAX_STATS_DAYS`, so no range the screen offers is one
 * the endpoint will refuse.
 */
const DAYS: Record<Range, number> = {
  week: 7,
  month: 30,
  halfYear: 183,
  year: 365,
};

export function daysIn(range: Range): number {
  return DAYS[range];
}

/**
 * The window a range covers, starting on the given day.
 *
 * Closed at both ends, like every range the API takes (spec 3.4.1 rule 4),
 * so a week is seven days and not eight.
 */
export function windowFor(range: Range, start: string): { from: string; to: string } {
  return { from: start, to: addLocalDays(start, DAYS[range] - 1) };
}

/**
 * The start that makes a range end today.
 *
 * What somebody opening the screen wants to see, and the reason the picker
 * holds a start rather than an end: once it is there, moving it is how you
 * look at March.
 *
 * Exact for every range on every day, because the length is a number of days
 * rather than something reversed through a calendar.
 */
export function startEndingToday(range: Range, now: number, timeZone: string): string {
  return addLocalDays(toLocalDate(now, timeZone), -(DAYS[range] - 1));
}

/** Where a date sits on the axis: 0 for `from`, counting whole days. */
export function dayIndex(from: string, date: string): number {
  return daysBetween(from, date) - 1;
}

/**
 * Which days get a label on the horizontal axis (spec 7.7).
 *
 * Asked of the **days of the range**, not of the points that came back. A
 * growth chart has a value every week or two, so labelling only the days that
 * have one puts the month markers wherever somebody happened to weigh the
 * baby -- and loses a month entirely when nothing was recorded on its first.
 *
 * A week shows every day; a month shows the 1st, 5th, 10th and so on; six
 * months and a year show only the month. Labelling 365 points leaves a grey
 * smear where the axis should be.
 */
export function axisLabel(range: Range, date: string, index: number): string | null {
  const day = Number(date.slice(8, 10));
  const month = Number(date.slice(5, 7));

  if (range === 'week') return date.slice(5).replace('-', '/');
  if (range === 'month') return day === 1 || day % 5 === 0 ? String(day) : null;
  // Only where a month begins, so the spacing follows the calendar rather
  // than the number of points -- and the first day always gets one, or a
  // range starting mid-month opens with no label at all.
  return day === 1 || index === 0 ? `${month}` : null;
}

/** Every day of the window, oldest first. At most `MAX_STATS_DAYS` of them. */
export function daysOf(range: Range, start: string): string[] {
  const { from } = windowFor(range, start);
  return Array.from({ length: DAYS[range] }, (_, i) => addLocalDays(from, i));
}
