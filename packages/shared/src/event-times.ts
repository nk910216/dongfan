import { startOfLocalDay, toLocalDate } from './datetime.js';
import type { EventIntent, EventTypeConfig } from './types.js';

/**
 * Derives the time fields a new event must carry.
 *
 * Kept here rather than in a form so the rule has one definition: the API
 * will validate against the same contract, and a prototype that invents its
 * own shape would hide the mismatch until the two are wired together.
 */
export type EventTimes = {
  readonly startedAt: number;
  readonly endedAt: number | null;
  /** Only a running timer takes the type's single active slot (spec 3.5). */
  readonly active: boolean;
};

export function deriveEventTimes(
  type: EventTypeConfig,
  at: number,
  intent: EventIntent,
  timeZone: string,
): EventTimes {
  // An all-day event has no clock time: it is pinned to local midnight so
  // its local_date is unambiguous whatever hour it was entered (spec 3.9).
  if (type.allDay) {
    return {
      startedAt: startOfLocalDay(toLocalDate(at, timeZone), timeZone),
      endedAt: null,
      active: false,
    };
  }

  if (type.timerEnabled && intent === 'start_timer') {
    return { startedAt: at, endedAt: null, active: true };
  }

  // Everything else is left open. A type without a range has no end time at
  // all, and a back-filled range is waiting for the parent to supply one --
  // writing `now` into it would invent a duration nobody measured.
  return { startedAt: at, endedAt: null, active: false };
}
