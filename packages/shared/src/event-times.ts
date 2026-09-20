import { startOfLocalDay, toLocalDate } from './datetime.js';
import type { EventIntent, EventTypeConfig } from './types.js';

/**
 * Derives the time fields an event must carry.
 *
 * Kept here rather than in a form or a handler so the rule has one
 * definition: the API validates against the same contract, and a prototype
 * that invented its own shape would hide the mismatch until the two were
 * wired together.
 */
export type EventTimes = {
  readonly startedAt: number;
  readonly endedAt: number | null;
  /** Only a running timer takes the type's single active slot (spec 3.5). */
  readonly active: boolean;
};

export type EventTimeInput = {
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly intent: EventIntent;
};

/**
 * Normalises the times of a submitted event.
 *
 * The client says what it meant with `intent`; everything else about
 * `active` and `ended_at` is decided here, because the two intents carry
 * identical fields and the server must not guess (spec 3.5).
 */
export function resolveEventTimes(
  type: EventTypeConfig,
  input: EventTimeInput,
  timeZone: string,
): EventTimes {
  // An all-day event has no clock time: it is pinned to local midnight so
  // its local_date is unambiguous whatever hour it was entered (spec 3.9).
  if (type.allDay) {
    return {
      startedAt: startOfLocalDay(toLocalDate(input.startedAt, timeZone), timeZone),
      endedAt: null,
      active: false,
    };
  }

  if (type.timerEnabled && input.intent === 'start_timer') {
    return { startedAt: input.startedAt, endedAt: null, active: true };
  }

  // A type without a range never has an end time; a back-filled range may
  // carry one, or may still be waiting for the parent to supply it. Writing
  // `now` into an empty one would invent a duration nobody measured.
  return {
    startedAt: input.startedAt,
    endedAt: type.hasRange ? input.endedAt : null,
    active: false,
  };
}

/** The times a brand new event gets when it is created from a form. */
export function deriveEventTimes(
  type: EventTypeConfig,
  at: number,
  intent: EventIntent,
  timeZone: string,
): EventTimes {
  return resolveEventTimes(type, { startedAt: at, endedAt: null, intent }, timeZone);
}
