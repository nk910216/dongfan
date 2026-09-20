/**
 * MOCK ONLY — computes locally what `GET /events/summary` will return.
 *
 * The real implementation aggregates in SQL (spec 5.5, 5.6); this exists so
 * the screens can be reviewed first. It is deliberately written to produce
 * the same shape, so swapping in the API changes the data source and not the
 * components.
 */

import { getEventType, toLocalDate } from '@dongfan/shared';
import type { MockBaby, MockEvent } from './data.js';

export type TypeSummary = {
  typeId: string;
  lastStartedAt: number | null;
  lastValue: number | null;
  activeEventId: string | null;
  activeStartedAt: number | null;
};

export type TodaySummary = {
  totalBottleMl: number;
  diaper: { pee: number; poo: number; both: number; unknown: number; total: number };
};

export type Summary = {
  types: Map<string, TypeSummary>;
  today: TodaySummary;
  /** Deliberately not scoped to today: at 00:30 the last feed was yesterday. */
  lastFeedAt: number | null;
};

/** Newest first, with id as a tiebreak so equal timestamps stay stable. */
function newestFirst(a: MockEvent, b: MockEvent): number {
  return b.startedAt - a.startedAt || b.id.localeCompare(a.id);
}

export function deriveSummary(events: MockEvent[], baby: MockBaby, now: number): Summary {
  const today = toLocalDate(now, baby.timezone);
  const live = events.filter((e) => !e.id.startsWith('deleted-'));

  const types = new Map<string, TypeSummary>();
  for (const event of [...live].sort(newestFirst)) {
    const existing = types.get(event.typeId);
    if (!existing) {
      types.set(event.typeId, {
        typeId: event.typeId,
        lastStartedAt: event.startedAt,
        lastValue: event.value,
        activeEventId: event.active ? event.id : null,
        activeStartedAt: event.active ? event.startedAt : null,
      });
    } else if (event.active && existing.activeEventId === null) {
      // The running timer is not necessarily the newest row: a later
      // back-filled event can sit above it (spec 5.5).
      existing.activeEventId = event.id;
      existing.activeStartedAt = event.startedAt;
    }
  }

  const todays = live.filter((e) => toLocalDate(e.startedAt, baby.timezone) === today);

  // Expressed milk is output, not intake, so pumping never counts here.
  const totalBottleMl = todays
    .filter((e) => e.typeId === 'bottle')
    .reduce((sum, e) => sum + e.value, 0);

  const diaper = { pee: 0, poo: 0, both: 0, unknown: 0, total: 0 };
  for (const event of todays.filter((e) => e.typeId === 'diaper')) {
    diaper.total += 1;
    const kind = event.metadata['diaper_kind'];
    if (kind === 'pee') diaper.pee += 1;
    else if (kind === 'poo') diaper.poo += 1;
    else if (kind === 'both') {
      diaper.both += 1;
      diaper.pee += 1;
      diaper.poo += 1;
    } else diaper.unknown += 1;
  }

  const lastFeedAt =
    [...live]
      .filter((e) => e.typeId === 'nursing' || e.typeId === 'bottle')
      .sort(newestFirst)[0]?.startedAt ?? null;

  return { types, today: { totalBottleMl, diaper }, lastFeedAt };
}

/** Today's events, all-day first, then newest first (spec 7.2). */
export function todaysEvents(events: MockEvent[], baby: MockBaby, now: number): MockEvent[] {
  const today = toLocalDate(now, baby.timezone);
  return events
    .filter((e) => toLocalDate(e.startedAt, baby.timezone) === today)
    .sort((a, b) => {
      const aAllDay = getEventType(a.typeId)?.allDay ?? false;
      const bAllDay = getEventType(b.typeId)?.allDay ?? false;
      if (aAllDay !== bAllDay) return aAllDay ? -1 : 1;
      return newestFirst(a, b);
    });
}
