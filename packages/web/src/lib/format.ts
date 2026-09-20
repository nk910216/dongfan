import { interpolate, splitDuration, zhTW } from '@dongfan/shared';

/**
 * Display helpers.
 *
 * Every string comes from the copy file; nothing here holds literal text.
 */

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Coarse elapsed time for the last-occurrence line on quick actions. */
export function relativeTime(instant: number | null, now: number): string {
  if (instant === null) return zhTW.timer.neverHappened;

  const elapsed = now - instant;
  if (elapsed < MINUTE) return zhTW.timer.justNow;
  if (elapsed < HOUR) return interpolate(zhTW.timer.minutesAgo, { minutes: Math.floor(elapsed / MINUTE) });
  if (elapsed < DAY) return interpolate(zhTW.timer.hoursAgo, { hours: Math.floor(elapsed / HOUR) });
  if (elapsed < 7 * DAY) return interpolate(zhTW.timer.daysAgo, { days: Math.floor(elapsed / DAY) });
  return zhTW.timer.longAgo;
}

export function formatDuration(ms: number): string {
  const { hours, minutes } = splitDuration(ms);
  return hours === 0
    ? interpolate(zhTW.event.durationMinutes, { minutes })
    : interpolate(zhTW.event.duration, { hours, minutes });
}

/**
 * How long ago the last successful pull finished.
 *
 * Written from the stored timestamp rather than assumed. A header that
 * always says "just synced" is worse than one that says nothing: it is an
 * assurance, and it is wrong exactly when the other parent's records are
 * the thing being waited for (spec 6.1).
 */
export function syncedAgo(syncedAt: number | null, now: number): string {
  if (syncedAt === null) return zhTW.home.neverSynced;

  const elapsed = now - syncedAt;
  if (elapsed < MINUTE) return zhTW.home.syncedJustNow;
  if (elapsed < HOUR) return interpolate(zhTW.home.syncedAt, { minutes: Math.floor(elapsed / MINUTE) });
  if (elapsed < DAY) return interpolate(zhTW.home.syncedHoursAgo, { hours: Math.floor(elapsed / HOUR) });
  return interpolate(zhTW.home.syncedDaysAgo, { days: Math.floor(elapsed / DAY) });
}

/** Running timers read as a clock rather than prose: 1:23:41. */
export function formatStopwatch(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${hours}:${pad(minutes)}:${pad(seconds)}`;
}

/** Wall-clock time in the baby's timezone. Never the device's. */
export function formatClock(instant: number, timeZone: string): string {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(instant));
}
