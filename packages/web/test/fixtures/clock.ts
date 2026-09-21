import { startOfLocalDay, toLocalDate } from '@dongfan/shared';

/**
 * An instant earlier today, in the baby's timezone.
 *
 * "Two hours ago" is a different local day for two hours every night, and a
 * fixture written that way passes all day and fails in the small hours --
 * which is precisely when this app is used. Anything that has to land on
 * today's date goes through here.
 *
 * Two clamps, and the second one is the one that was missing. The result is
 * never earlier than the start of the local day, or the event belongs to
 * yesterday; and it is never later than `now`, because in the first minutes
 * of a local day there is no "two hours ago" that is still today, and a
 * fixture that answered with a *future* instant made every end time invalid.
 * A timer started then and stopped at the current moment ends before it
 * began, and the suite failed for one minute a day.
 */
export function earlierToday(msAgo: number, timeZone: string, now: number = Date.now()): number {
  const dayStart = startOfLocalDay(toLocalDate(now, timeZone), timeZone);
  return Math.min(now, Math.max(now - msAgo, dayStart));
}
