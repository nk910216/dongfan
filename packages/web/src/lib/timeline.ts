import { MAX_EVENT_DURATION_MS, getEventType, startOfLocalDay } from '@dongfan/shared';
import type { EventDto } from '@dongfan/shared';
import type { DayEntry, QueuedCreate, StopDraft } from './db.js';

/**
 * Placing a day's events on a fixed 00:00-24:00 axis (spec 7.5).
 *
 * Pure, and the whole of the arithmetic, because a timeline is a picture of
 * numbers and a picture cannot be argued with: an event drawn an hour out, or
 * a nap drawn as long as a night because its card has a minimum height, looks
 * exactly as convincing as a correct one.
 *
 * The rule the layout exists to protect: **the axis is proportional and the
 * card is not**. A record has a real anchor at its real minute and, when it
 * is a finished range, a real extent. The card that carries the words may be
 * taller than that extent -- a tap target smaller than 44px is no use at 3am
 * -- so the two are separate numbers here and drawn as separate things.
 */

export const MINUTES_IN_DAY = 24 * 60;

/** What a card needs to be tappable, expressed on the axis by the screen. */
export type Metrics = {
  /** Pixels per hour. The axis never varies this; empty hours stay empty. */
  readonly hourHeight: number;
  /** The least a card may be, in pixels. */
  readonly minCardHeight: number;
};

export const DEFAULT_METRICS: Metrics = { hourHeight: 64, minCardHeight: 44 };

/** How many minutes of the axis a card's minimum height covers. */
export function minCardMinutes(metrics: Metrics): number {
  return (metrics.minCardHeight / metrics.hourHeight) * 60;
}

export type ItemKind =
  /** On the server, finished or not. */
  | 'event'
  /** In the outbox: written here, not yet accepted (spec 6.1). */
  | 'queued'
  /** Stopped here with nobody having confirmed when (spec 7.2). */
  | 'draft';

export type TimelineItem = {
  /** Stable across re-renders and unique within a day. */
  readonly key: string;
  readonly kind: ItemKind;
  readonly typeId: string;
  /** The event this points at, for the edit screen. Null for a queued add. */
  readonly eventId: string | null;
  readonly queued: QueuedCreate | null;
  readonly event: EventDto | null;
  /** Minutes from local midnight, clipped to this day. */
  readonly startMin: number;
  /**
   * Minutes of it that fall on this day, zero for anything without an end.
   *
   * Zero is not "instant"; it is "this has no length to draw". A bottle has
   * none because it is a moment, and a running timer has none because its
   * length is not a fact yet (spec 3.4.1 rule 3).
   */
  readonly lengthMin: number;
  /** Began before this day and runs into it. */
  readonly carriedOver: boolean;
  /** Reaches past the end of this day. */
  readonly continues: boolean;
  /** A timer with nothing to end it by, on the server. */
  readonly running: boolean;
  /** Stopped here, awaiting confirmation; `lengthMin` is the draft's. */
  readonly drafted: boolean;
  /**
   * The draft asks for something longer than an event may be.
   *
   * A timer forgotten overnight stops at a moment the server will refuse, so
   * the screen has to say the time needs correcting rather than offering a
   * confirmation that cannot succeed (spec 7.2, 3.4.1 rule 1).
   */
  readonly draftTooLong: boolean;
};

export type Placed = {
  readonly item: TimelineItem;
  /** Column within its cluster, and how many columns that cluster has. */
  readonly column: number;
  readonly columns: number;
};

export type Cluster = {
  readonly key: string;
  /** Minutes from midnight that the cluster's boxes span. */
  readonly fromMin: number;
  readonly toMin: number;
  readonly placed: readonly Placed[];
  /**
   * Too many at once for the width of a phone.
   *
   * The entry stays: spec 7.5 allows an "N of them" opening that expands,
   * and forbids anything being silently dropped. The axis around it keeps
   * its proportions either way.
   */
  readonly crowded: boolean;
};

export type DayLayout = {
  /** No hour belongs to these; they head the day (spec 3.9). */
  readonly allDay: readonly TimelineItem[];
  readonly clusters: readonly Cluster[];
};

/** Past this many side by side, a phone has no width left for words. */
export const MAX_COLUMNS = 3;

function minutesInto(day: number, instant: number): number {
  return (instant - day) / 60_000;
}

function clampToDay(minutes: number): number {
  return Math.min(Math.max(minutes, 0), MINUTES_IN_DAY);
}

/**
 * One day's events, drafts and unsent adds, as things with a place.
 *
 * `entries` comes from `calendarDay`, which already decides *which* events
 * belong to this day -- including the night before that ran into it, and
 * excluding a running timer from every day but its own (spec 3.4.1). Nothing
 * here widens that.
 */
export function itemsFor(
  entries: readonly DayEntry[],
  queued: readonly QueuedCreate[],
  drafts: readonly StopDraft[],
  date: string,
  timeZone: string,
): TimelineItem[] {
  const day = startOfLocalDay(date, timeZone);
  const dayEnd = day + MINUTES_IN_DAY * 60_000;
  const items: TimelineItem[] = [];

  for (const { event, carriedOver } of entries) {
    const draft = drafts.find((d) => d.eventId === event.id) ?? null;
    // A stopped-but-unconfirmed timer is drawn ending where the button was
    // pressed, not still running (spec 7.2). It is the draft's moment, and
    // the screen marks it as unconfirmed rather than as the server's.
    const endedAt = draft?.endedAt ?? event.endedAt;

    const startMin = clampToDay(minutesInto(day, event.startedAt));
    const endMin = endedAt === null ? null : clampToDay(minutesInto(day, endedAt));

    items.push({
      key: `event:${event.id}`,
      kind: draft === null ? 'event' : 'draft',
      typeId: event.typeId,
      eventId: event.id,
      queued: null,
      event,
      startMin,
      // An end before this day's start cannot happen: `calendarDay` only
      // returns what covers the day. An end after it is clipped, and the
      // carrying-on is said in words instead.
      lengthMin: endMin === null ? 0 : Math.max(endMin - startMin, 0),
      carriedOver,
      continues: endedAt !== null && endedAt > dayEnd,
      running: event.active && draft === null,
      drafted: draft !== null,
      draftTooLong: draft !== null && draft.endedAt - event.startedAt > MAX_EVENT_DURATION_MS,
    });
  }

  for (const entry of queued) {
    // The same de-duplication the home screen does: between the queue
    // dropping an entry and both stores being read again, each holds a copy,
    // and one feed shown twice is its own small lie (spec 6.2).
    if (entries.some(({ event }) => event.id === entry.eventId)) continue;

    const startMin = minutesInto(day, entry.input.startedAt);
    if (startMin < 0 || startMin >= MINUTES_IN_DAY) continue;

    const endMin = entry.input.endedAt === null
      ? null
      : clampToDay(minutesInto(day, entry.input.endedAt));

    items.push({
      key: `queued:${entry.eventId}`,
      kind: 'queued',
      typeId: entry.input.typeId,
      eventId: null,
      queued: entry,
      event: null,
      startMin: clampToDay(startMin),
      lengthMin: endMin === null ? 0 : Math.max(endMin - clampToDay(startMin), 0),
      carriedOver: false,
      continues: entry.input.endedAt !== null && entry.input.endedAt > dayEnd,
      running: entry.input.intent === 'start_timer' && entry.input.endedAt === null,
      drafted: false,
      draftTooLong: false,
    });
  }

  return items;
}

/** Splits off the ones that head the day rather than sitting on an hour. */
export function splitAllDay(items: readonly TimelineItem[]): {
  allDay: TimelineItem[];
  timed: TimelineItem[];
} {
  const allDay: TimelineItem[] = [];
  const timed: TimelineItem[] = [];
  for (const item of items) {
    if (getEventType(item.typeId)?.allDay === true) allDay.push(item);
    else timed.push(item);
  }
  return { allDay, timed };
}

/**
 * The extent a card occupies on the axis, which is not its length.
 *
 * A bottle has no length at all and still needs somewhere to be read and
 * pressed. That space is what decides whether two things collide, and it is
 * deliberately not what decides how long either of them was.
 */
export function boxOf(item: TimelineItem, metrics: Metrics): { top: number; bottom: number } {
  const minimum = minCardMinutes(metrics);
  return { top: item.startMin, bottom: item.startMin + Math.max(item.lengthMin, minimum) };
}

/**
 * Groups what overlaps, and gives each member a column.
 *
 * Both kinds of overlap spec 7.5 names are the same problem here: ranges that
 * genuinely intersect, and points that do not but whose cards would sit on
 * top of one another. Grouping on the card's extent catches both, which is
 * why `boxOf` is what is compared and not the duration.
 */
export function layOut(
  items: readonly TimelineItem[],
  metrics: Metrics = DEFAULT_METRICS,
): DayLayout {
  const { allDay, timed } = splitAllDay(items);

  const sorted = [...timed].sort((a, b) =>
    a.startMin - b.startMin || b.lengthMin - a.lengthMin || (a.key < b.key ? -1 : 1));

  const clusters: Cluster[] = [];
  let current: TimelineItem[] = [];
  let reach = -1;

  const close = (): void => {
    if (current.length === 0) return;
    const placed = assignColumns(current, metrics);
    const columns = placed.reduce((most, one) => Math.max(most, one.column + 1), 1);
    const first = current[0] as TimelineItem;
    clusters.push({
      key: `cluster:${first.startMin}:${first.key}`,
      fromMin: first.startMin,
      toMin: reach,
      placed: placed.map((one) => ({ ...one, columns })),
      crowded: columns > MAX_COLUMNS,
    });
    current = [];
  };

  for (const item of sorted) {
    const box = boxOf(item, metrics);
    if (current.length > 0 && box.top >= reach) close();
    current.push(item);
    reach = current.length === 1 ? box.bottom : Math.max(reach, box.bottom);
  }
  close();

  return { allDay, clusters };
}

/** Greedy by start: the first column whose last card has finished. */
function assignColumns(
  items: readonly TimelineItem[],
  metrics: Metrics,
): { item: TimelineItem; column: number; columns: number }[] {
  const ends: number[] = [];

  return items.map((item) => {
    const box = boxOf(item, metrics);
    let column = ends.findIndex((end) => end <= box.top);
    if (column === -1) {
      column = ends.length;
      ends.push(box.bottom);
    } else {
      ends[column] = box.bottom;
    }
    return { item, column, columns: 1 };
  });
}
