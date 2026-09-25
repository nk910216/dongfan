import { isRealLocalDate, startOfLocalDay, toLocalDate } from '@dongfan/shared';

/**
 * Adding a record to a day that is not today.
 *
 * The day travels in the query string, not in router state. A reload must
 * not turn a record for the 18th into a record for now: router state is
 * gone after one, and the screen would carry on looking the same while
 * meaning something else (spec 2.1).
 */

/** The day an add was started from, if it was started from one. */
export function askedDay(search: string): string | null {
  const on = new URLSearchParams(search).get('on');
  return on !== null && isRealLocalDate(on) ? on : null;
}

/**
 * The query an add carries: the day it is for, and where it came from.
 *
 * Both or neither travel together, because losing the second is what sent
 * somebody adding from the two-day view back to the single-day one. Built in
 * one place so every link in the chain writes the same thing.
 */
export function addQuery(day: string | null, from: string | null): string {
  const parts: string[] = [];
  if (day !== null) parts.push(`on=${day}`);
  if (from !== null) parts.push(`from=${encodeURIComponent(from)}`);
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

/**
 * When a record added from a given day should start.
 *
 * The day being looked at, **at the current time of day** -- spec 7.3 in as
 * many words. Today is simply now.
 *
 * An earlier version of this used midday, on the reasoning that a time
 * carried over from the clock looks like something observed and gets saved
 * unlooked at. That argument only ever applied to the form: the nappy
 * shortcut has no time field at all, so midday was written there with
 * nothing to confirm it against -- a nappy at 12:00 that the app invented.
 * Whatever else is true of the spec's rule, it is the same rule in both
 * places.
 *
 * The time of day is carried as the offset from local midnight. v1 is
 * `Asia/Taipei` only (spec 5.3), which has no daylight saving; in a zone
 * that had it, a day whose midnight had moved would land an hour out.
 */
export function startFor(day: string | null, timeZone: string, now: number): number {
  const todayHere = toLocalDate(now, timeZone);
  if (day === null || day === todayHere) return now;
  return startOfLocalDay(day, timeZone) + (now - startOfLocalDay(todayHere, timeZone));
}

/**
 * The calendar path for a day.
 *
 * Today is `/day`, which goes on meaning today after midnight, rather than
 * today's date, which does not.
 */
export function dayView(day: string, timeZone: string, now: number): string {
  return day === toLocalDate(now, timeZone) ? '/day' : `/day/${day}`;
}
