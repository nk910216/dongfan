/**
 * Every date calculation in the project goes through this module.
 *
 * The rules it enforces are the ones that fail silently when broken
 * (spec 3.4, 3.4.1, 5.3):
 *
 *   - instants are UTC epoch milliseconds, always;
 *   - the timezone belongs to the baby record, never to the device;
 *   - a local date is derived here and nowhere else.
 *
 * Conversion uses Intl, which Workers ships with a full ICU for. Hand-rolled
 * offset arithmetic is banned because it silently ignores DST.
 */

/** A calendar day in the baby's timezone, `YYYY-MM-DD`. */
export type LocalDate = string;

/**
 * The longest an event may last (spec 3.4.1).
 *
 * This single bound is what guarantees an event crosses midnight at most
 * once, which is what lets the splitting logic stay two cases instead of N.
 */
export const MAX_EVENT_DURATION_MS = 24 * 60 * 60 * 1000;

const DATE_FORMATTERS = new Map<string, Intl.DateTimeFormat>();
const PART_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = DATE_FORMATTERS.get(timeZone);
  if (!f) {
    // en-CA formats as YYYY-MM-DD, which is what we store.
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    DATE_FORMATTERS.set(timeZone, f);
  }
  return f;
}

function partFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = PART_FORMATTERS.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    PART_FORMATTERS.set(timeZone, f);
  }
  return f;
}

/** The calendar day an instant falls on, in the given timezone. */
export function toLocalDate(instant: number, timeZone: string): LocalDate {
  return dateFormatter(timeZone).format(new Date(instant));
}

type Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function partsOf(instant: number, timeZone: string): Parts {
  const parts = partFormatter(timeZone).formatToParts(new Date(instant));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** Offset of `timeZone` from UTC at a given instant, in milliseconds. */
function offsetAt(instant: number, timeZone: string): number {
  const p = partsOf(instant, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - instant;
}

/**
 * Turns a wall-clock time in the baby's timezone into a UTC instant.
 *
 * Needed by every form: the parent picks "today at 15:42", and that has to
 * become an instant without the device's own timezone leaking in. Two passes
 * because the offset itself depends on the instant we are solving for.
 */
export function localToUtc(
  local: { year: number; month: number; day: number; hour?: number; minute?: number; second?: number },
  timeZone: string,
): number {
  const naive = Date.UTC(local.year, local.month - 1, local.day, local.hour ?? 0, local.minute ?? 0, local.second ?? 0);
  const firstGuess = naive - offsetAt(naive, timeZone);
  return naive - offsetAt(firstGuess, timeZone);
}

function parseLocalDate(date: LocalDate): { year: number; month: number; day: number } {
  const [y, m, d] = date.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined || Number.isNaN(y)) {
    throw new Error(`Malformed local date: ${date}`);
  }
  return { year: y, month: m, day: d };
}

/** The instant at which a local calendar day begins. */
export function startOfLocalDay(date: LocalDate, timeZone: string): number {
  return localToUtc(parseLocalDate(date), timeZone);
}

/** Shifts a local date by whole days, staying in calendar space. */
export function addLocalDays(date: LocalDate, days: number): LocalDate {
  const { year, month, day } = parseLocalDate(date);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

export type DurationSegment = { date: LocalDate; ms: number };

/**
 * Splits an interval into per-day segments in the baby's timezone.
 *
 * Sleep from 23:10 to 07:05 belongs to the earlier day by count, but its
 * duration has to land on both days, or a chart shows one night at zero
 * hours and the next at sixteen (spec 3.4).
 */
export function splitByLocalDate(startedAt: number, endedAt: number, timeZone: string): DurationSegment[] {
  if (endedAt < startedAt) throw new Error('endedAt precedes startedAt');
  if (endedAt === startedAt) return [];

  const segments: DurationSegment[] = [];
  let cursor = startedAt;

  while (cursor < endedAt) {
    const date = toLocalDate(cursor, timeZone);
    const nextMidnight = startOfLocalDay(addLocalDays(date, 1), timeZone);
    const segmentEnd = Math.min(nextMidnight, endedAt);
    segments.push({ date, ms: segmentEnd - cursor });
    cursor = segmentEnd;
  }

  return segments;
}

/**
 * Duration in whole minutes.
 *
 * Totals are summed in milliseconds and rounded once at the end; rounding
 * each event first accumulates error across a day of feeds (spec 5.3).
 */
export function msToMinutes(ms: number): number {
  return Math.round(ms / 60000);
}

export type Duration = { hours: number; minutes: number };

/** Splits a duration for display. Formatting into words belongs to the UI. */
export function splitDuration(ms: number): Duration {
  const total = msToMinutes(ms);
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}

export type Age = { months: number; days: number };

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Age in whole months and days, both resolved in the baby's timezone.
 *
 * Counts from the monthly anniversary of the birth date, clamped to the
 * length of the month. A baby born on the 31st turns one month old on the
 * 28th of February, not on the 3rd of March; borrowing days instead of
 * clamping goes negative for exactly that case.
 */
export function ageAt(birthDate: LocalDate, instant: number, timeZone: string): Age {
  const birth = parseLocalDate(birthDate);
  const today = parseLocalDate(toLocalDate(instant, timeZone));

  const anniversaryDay = (year: number, month: number): number =>
    Math.min(birth.day, daysInMonth(year, month));

  let months = (today.year - birth.year) * 12 + (today.month - birth.month);
  let year = today.year;
  let month = today.month;

  // Not yet reached this month's anniversary, so count from the last one.
  if (today.day < anniversaryDay(year, month)) {
    months -= 1;
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }

  const elapsedMs =
    Date.UTC(today.year, today.month - 1, today.day) -
    Date.UTC(year, month - 1, anniversaryDay(year, month));

  return {
    months: Math.max(0, months),
    days: Math.max(0, Math.round(elapsedMs / 86_400_000)),
  };
}
