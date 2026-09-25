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
  /**
   * The least a card may be **across**, in pixels.
   *
   * A height that cannot be pressed and a width that cannot be read are the
   * same kind of failure, and only the first of them had a number. Below
   * this a card shows one truncated character where its type should be, so
   * the stretch is better offered as an "N of them" entry (spec 7.5).
   */
  readonly minCardWidth: number;
};

export const DEFAULT_METRICS: Metrics = {
  /**
   * Ninety-six, not sixty-four.
   *
   * The minimum card height is a fingertip, and at 64px an hour a fingertip
   * covers **41 minutes of axis** -- so two records half an hour apart, with
   * nothing whatever between them, collided as cards and were laid out as if
   * they were simultaneous. That spurious collision is what chained a whole
   * evening into one group and then collapsed it (docs/timeline-design.md).
   *
   * At 96 the same 44px covers 27.5 minutes. The cost is a day 2304px tall
   * instead of 1536, which is about seven hours on a phone rather than ten:
   * taken deliberately, because nobody reads a day at once and the thing
   * that is read -- a night, an evening -- is about four hours.
   */
  hourHeight: 96,
  minCardHeight: 44,
  /**
   * What a card needs to be readable, which is not what it needs to be
   * *complete*.
   *
   * This was 128 -- the width for an icon, a name, a value and a clock on
   * one line -- and requiring all four is what made the screen give up so
   * eagerly. A card degrades by dropping words instead: the badge says the
   * type and the clock says when, and those two fit in 48.
   */
  minCardWidth: 48,
};

/** How many minutes of the axis a card's minimum height covers. */
export function minCardMinutes(metrics: Metrics): number {
  return (metrics.minCardHeight / metrics.hourHeight) * 60;
}

/** Minutes of the day as pixels down the axis. The one conversion there is. */
export function minutesToPx(minutes: number, metrics: Metrics): number {
  return (minutes / 60) * metrics.hourHeight;
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
   * The moment the stop was pressed, when there is a draft.
   *
   * Carried here rather than read off the event, because the event the
   * server knows about has no end at all -- it is a running timer. Reading
   * `endedAt` from it gave `null`, and a card that turned that into a clock
   * printed 08:00 in Taipei: the epoch, formatted (spec 7.2).
   */
  readonly draftEndedAt: number | null;
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

/** Past this many side by side, no phone has width left for words. */
export const MAX_COLUMNS = 3;

/**
 * How many cards fit across a band, given how wide the band actually is.
 *
 * Not a constant, because the two calendars do not have the same width to
 * divide: one day owns everything right of the hour labels and two days own
 * half of it each. Carrying "three side by side is fine" over to a half-width
 * column is what put four characters of a type name on screen and cut the
 * rest, which is the state spec 7.5 says to offer an entry for instead.
 *
 * A width of zero means nobody has measured yet; the old ceiling is the
 * answer then, rather than collapsing a day that may be perfectly readable.
 */
export function columnsFor(bandWidth: number, metrics: Metrics): number {
  if (!Number.isFinite(bandWidth) || bandWidth <= 0) return MAX_COLUMNS;
  const fits = Math.floor(bandWidth / metrics.minCardWidth);
  return Math.min(Math.max(fits, 1), MAX_COLUMNS);
}

/** A moment's mark: a dot straddling the card's top edge. */
export const POINT_PX = 7;

/**
 * The least a range's bar may be drawn as.
 *
 * Three pixels is under three minutes at the default metrics. It is there so
 * that a two-minute feed is visible at all, and it is the only place the
 * drawing departs from the clock -- deliberately not the other direction,
 * because a bar stretched to fit words would be a duration nobody recorded.
 */
export const MIN_BAR_PX = 3;

/**
 * The real extent of a record, in pixels, which is not its card's height.
 *
 * Measured from the card's own top edge, because the card's top edge **is**
 * the start minute -- for everything, with no offset and no exceptions. That
 * is the whole of how a card is tied to a time now: an anchor drawn in a
 * lane beside the card was one record drawn as two objects, and the marks
 * read as debris scattered down the column.
 *
 * A finished range gets a stripe of exactly its minutes. Anything without a
 * length -- a bottle, a running timer, a back-filled record with no end --
 * gets a dot on the edge and no stripe at all, because a stripe of no height
 * is nothing and a stripe of some height would be a duration nobody
 * recorded (spec 3.4.1 rule 3).
 */
export type Extent = {
  /** Height of the stripe, in pixels. Zero when there is nothing to draw. */
  readonly px: number;
  /** A moment rather than a range, so it is drawn as a dot. */
  readonly point: boolean;
};

export function extentOf(item: TimelineItem, metrics: Metrics): Extent {
  if (item.lengthMin <= 0) return { px: 0, point: true };
  return { px: Math.max(minutesToPx(item.lengthMin, metrics), MIN_BAR_PX), point: false };
}

/**
 * How much of itself a card can say at a given width.
 *
 * A card narrows by dropping words, never by disappearing. The badge goes
 * last because it is the only thing that says which type, and the clock goes
 * never: a timeline that has stopped saying when has stopped being a
 * timeline (docs/timeline-design.md).
 */
export type Tier = 'A' | 'B' | 'C' | 'D';

export function tierFor(width: number): Tier {
  if (width >= 160) return 'A';
  if (width >= 96) return 'B';
  if (width >= 64) return 'C';
  return 'D';
}

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
      draftEndedAt: draft?.endedAt ?? null,
      draftTooLong: draft !== null && draft.endedAt - event.startedAt > MAX_EVENT_DURATION_MS,
    });
  }

  for (const entry of queued) {
    // The same de-duplication the home screen does: between the queue
    // dropping an entry and both stores being read again, each holds a copy,
    // and one feed shown twice is its own small lie (spec 6.2).
    if (entries.some(({ event }) => event.id === entry.eventId)) continue;

    const { startedAt, endedAt } = entry.input;

    // Clipped to the day exactly as a stored event is. A sleep written up
    // offline from 23:00 to 07:00 belongs to both days; keeping only the
    // ones that *start* here made the morning of it invisible until the
    // queue drained, and then seven hours appeared out of nowhere.
    //
    // The midnight end is strict: something finishing exactly at 00:00 has
    // nothing on the new day, and the closed-interval rule for day queries
    // does not mean drawing it twice (spec 7.5).
    const startsHere = startedAt >= day && startedAt < dayEnd;
    const runsInto = endedAt !== null && startedAt < day && endedAt > day;
    if (!startsHere && !runsInto) continue;

    const startMin = clampToDay(minutesInto(day, startedAt));
    const endMin = endedAt === null ? null : clampToDay(minutesInto(day, endedAt));

    items.push({
      key: `queued:${entry.eventId}`,
      kind: 'queued',
      typeId: entry.input.typeId,
      eventId: null,
      queued: entry,
      event: null,
      startMin,
      lengthMin: endMin === null ? 0 : Math.max(endMin - startMin, 0),
      carriedOver: runsInto,
      continues: endedAt !== null && endedAt > dayEnd,
      running: entry.input.intent === 'start_timer' && endedAt === null,
      drafted: false,
      draftEndedAt: null,
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
  maxColumns: number = MAX_COLUMNS,
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
      crowded: columns > maxColumns,
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

/**
 * A column's share of the width, as fractions of the **event area**.
 *
 * Not of the whole page. The hour labels take a fixed strip off the left, and
 * an earlier version added that strip to the offset while still dividing the
 * full width -- so a single column ran 40px past the right edge, and so did
 * the last of any row. The screen turns these fractions into a `calc` that
 * subtracts the strip once.
 */
export function columnSpan(placed: Placed): { left: number; width: number } {
  return { left: placed.column / placed.columns, width: 1 / placed.columns };
}

/**
 * Where a day should open, in minutes from midnight.
 *
 * Today near the current hour; any other day on its first record, because
 * the top of an empty night is not where the day is. Null when there is
 * nothing to go to and the top will do.
 */
export function openingMinute(
  isToday: boolean,
  nowMinutes: number | null,
  layout: DayLayout,
): number | null {
  if (isToday) return nowMinutes;
  return layout.clusters[0]?.fromMin ?? null;
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
