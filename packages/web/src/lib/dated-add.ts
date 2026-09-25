import { isRealLocalDate, startOfLocalDay, toLocalDate } from '@dongfan/shared';

/**
 * Adding a record to a day that is not today.
 *
 * The day travels in the query string, not in router state. A reload must
 * not turn a record for the 18th into a record for now: router state is
 * gone after one, and the screen would carry on looking the same while
 * meaning something else (spec 2.1).
 */

/** Midday, as a starting point for a day that has already happened. */
const MIDDAY_MS = 12 * 3_600_000;

/** The day an add was started from, if it was started from one. */
export function askedDay(search: string): string | null {
  const on = new URLSearchParams(search).get('on');
  return on !== null && isRealLocalDate(on) ? on : null;
}

/** `?on=2026-09-18`, or nothing at all. Built in one place so it matches. */
export function daySuffix(day: string | null, separator = '?'): string {
  return day === null ? '' : `${separator}on=${day}`;
}

/**
 * When a record added from a given day should start.
 *
 * Today is now: that is the ordinary case and the clock is the best answer
 * there is. Any other day is **midday**, and deliberately not the current
 * time of day transplanted onto it. A time carried over from the clock
 * looks like something that was observed and gets accepted without a
 * glance; midday is obviously a placeholder, and the field it sits in is
 * the one thing the parent has to fill in for a record they are writing
 * from memory.
 */
export function startFor(day: string | null, timeZone: string, now: number): number {
  if (day === null || day === toLocalDate(now, timeZone)) return now;
  return startOfLocalDay(day, timeZone) + MIDDAY_MS;
}

/**
 * Where to go once a record has been written, having come from a day.
 *
 * The day the record actually landed on, which is the day it was added
 * from unless the parent changed the time to another one. Returning to the
 * day they were browsing regardless would show them a day without the
 * record they just made, and "it did not save" is the wrong thing to learn
 * from a screen.
 *
 * Today goes to `/day`, which keeps meaning today after midnight, rather
 * than to today's date, which does not.
 */
export function dayAfterAdding(startedAt: number, timeZone: string, now: number): string {
  const landed = toLocalDate(startedAt, timeZone);
  return landed === toLocalDate(now, timeZone) ? '/day' : `/day/${landed}`;
}
