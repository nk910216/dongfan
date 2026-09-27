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
/**
 * A range, placed: a real extent on the axis with a card over it.
 *
 * `left` and `width` are fractions of the band rather than pixels, because
 * the band's width in CSS is a `calc` the screen owns and this arithmetic
 * should not have a second opinion about it. `labelWidth` is in pixels,
 * because it answers a question about words.
 */
export type PlacedSpan = {
  readonly item: TimelineItem;
  /** Pixels from the top of the axis; the card's top edge is the start. */
  readonly top: number;
  /** The card's height, at least a fingertip however short the record. */
  readonly height: number;
  /** The true extent, which is the stripe and where the tint stops. */
  readonly extentPx: number;
  readonly left: number;
  readonly width: number;
  /**
   * How much of this card's own width is not covered by a pin or a chip.
   *
   * What the words are laid out in. Guaranteed to be at least `LABEL_W` or
   * the card's whole width, whichever is smaller -- which is the rule that
   * stops a range being reduced to a badge by a nappy landing on it.
   */
  readonly labelWidth: number;
};

/** A moment, placed. It has no extent, so it has no height of its own. */
export type PlacedPin = {
  readonly item: TimelineItem;
  readonly top: number;
  readonly height: number;
  readonly left: number;
  readonly width: number;
  /** Drawn over a range rather than beside one, so it says so. */
  readonly overSpan: boolean;
};

/**
 * Moments from one clock hour that there was no room for, behind one entry.
 *
 * The hour is the whole of the bound, and it is a bound somebody can see on
 * the axis rather than a number in the code: a record in the eight o'clock
 * hour can never be behind the same entry as one from the eleven o'clock
 * hour, whatever else is on the screen.
 */
export type HourChip = {
  readonly key: string;
  readonly hour: number;
  readonly members: readonly TimelineItem[];
  readonly top: number;
  readonly height: number;
  readonly left: number;
  readonly width: number;
};

export type DayLayout = {
  /** No hour belongs to these; they head the day (spec 3.9). */
  readonly allDay: readonly TimelineItem[];
  readonly spans: readonly PlacedSpan[];
  readonly pins: readonly PlacedPin[];
  readonly chips: readonly HourChip[];
  /** The first minute anything happens on, for deciding where to open. */
  readonly firstMin: number | null;
};

/**
 * The least width a range keeps for its words, whatever lands on top of it.
 *
 * Enough for a badge, a type name and a clock, which is the floor a
 * comparison screen needs: a night whose card says neither how long it was
 * nor what it is cannot be compared with anything.
 */
export const LABEL_W = 96;

/**
 * And how much it keeps when there is more to go round.
 *
 * A proportion of the band rather than a constant, because 96px is the
 * right floor for a 173px two-day column and much too little for a 346px
 * single day -- there, a five-hour nursing had a nappy on its top corner
 * and so could not say five hours, on a card nearly two hundred pixels
 * wide. Capped, because past about a clock and a duration more reserved
 * width only takes room from the moments beside it.
 */
export function labelWidthFor(bandWidth: number): number {
  return Math.min(Math.max(bandWidth * 0.42, LABEL_W), 150);
}

/**
 * How much of a covered range stays visible: its stripe and its badge.
 *
 * Not the tap-target 44 by coincidence, but not the same 44 either. It is
 * what a range needs to keep saying *how long* and *which type* while a
 * moment sits on top of it, and those two are the ones that must never be
 * covered.
 */
export const SPAN_KEEP = 44;

/** Beyond this, moments beside each other stop being worth telling apart. */
export const MAX_PIN_COLUMNS = 4;

/**
 * How tall a collapsed entry is, at the least.
 *
 * It carries three rows -- the badges of what is inside, the count, and the
 * stretch it covers -- and a huddle of five records in one minute is no
 * pixels of axis at all. The number lives here rather than in the screen
 * because the layout has to collide against the height that is *drawn*:
 * computing from 44px while drawing 58 let an entry cover the top of the
 * next record by ten pixels.
 */
export const CHIP_HEIGHT = 58;

/**
 * Is this record's card its own extent, or is the card bigger than it?
 *
 * **This, not "does it have a duration", is where the two layout problems
 * divide.** A card is at least a fingertip tall whatever the record, so a
 * five-minute nursing gets a 44px card covering 27.5 minutes of axis -- and
 * that size is a fact about a fingertip, exactly as a moment's is. Laying it
 * out by its real minutes, as though the card were those minutes, put two
 * five-minute feeds ten minutes apart in the same column with 28px of one
 * card on top of the other.
 *
 * When the card *is* the extent the arithmetic is safe, and that is the
 * whole reason the line is here: if a card's height is its duration, then
 * two records whose times do not intersect have cards that do not intersect
 * either. Nothing else needs checking.
 *
 * It is also the same line that decides whether the tint fills the card.
 */
function isBlock(item: TimelineItem, metrics: Metrics): boolean {
  return item.lengthMin >= minCardMinutes(metrics);
}

/**
 * May this record be folded into an "N of them"?
 *
 * Only a record with no duration at all. A range always keeps its own block,
 * however short it is and however narrow the screen (spec 7.5) -- being laid
 * out among the moments is about *where* it is drawn, not about whether it
 * can be hidden behind a count.
 */
function isMergeable(item: TimelineItem): boolean {
  return item.lengthMin <= 0;
}

type Interval = { readonly from: number; readonly to: number };

const overlaps = (a: Interval, b: Interval): boolean => a.from < b.to && b.from < a.to;

/** Greedy by start: the first column free for the whole of this interval. */
function assignColumns<T>(
  entries: readonly { readonly key: T; readonly at: Interval }[],
): Map<T, number> {
  // A real interval list per column, not one "last bottom" each: ranges are
  // placed before moments, so entries no longer arrive in start order and a
  // single number per column is then wrong.
  const columns: Interval[][] = [];
  const placed = new Map<T, number>();

  for (const entry of entries) {
    let column = columns.findIndex((taken) => !taken.some((one) => overlaps(one, entry.at)));
    if (column === -1) {
      column = columns.length;
      columns.push([]);
    }
    (columns[column] as Interval[]).push(entry.at);
    placed.set(entry.key, column);
  }

  return placed;
}

/** Groups by transitive overlap of whatever interval is handed in. */
function groupBy<T>(
  entries: readonly { readonly key: T; readonly at: Interval }[],
): { readonly key: T; readonly at: Interval }[][] {
  const sorted = [...entries].sort((a, b) => a.at.from - b.at.from || a.at.to - b.at.to);
  const groups: { key: T; at: Interval }[][] = [];
  let reach = -Infinity;

  for (const entry of sorted) {
    const last = groups[groups.length - 1];
    if (last === undefined || entry.at.from >= reach) groups.push([entry]);
    else last.push(entry);
    reach = last === undefined || entry.at.from >= reach
      ? entry.at.to
      : Math.max(reach, entry.at.to);
  }

  return groups;
}

/**
 * A day's records, placed on a band of a given width.
 *
 * The one structural decision here is that **ranges and moments are two
 * different problems** (docs/timeline-design.md, spec 7.5):
 *
 * - A range has a real extent, so two ranges are concurrent when their
 *   *times* intersect. Never their cards: a moment's card covers 27.5
 *   minutes because of a fingertip, and letting that artefact narrow a fact
 *   is how a nappy at 17:06 pushed a five-hour nursing into a third of the
 *   band and then into a collapsed cluster. **Ranges never merge.**
 * - A moment has no extent, so its card's box is all there is to go on. Two
 *   moments collide when their boxes do, and when the width genuinely runs
 *   out the excess merge -- but only ever with moments from the **same clock
 *   hour**.
 *
 * What is gone with the old model: a cluster was a transitive chain of card
 * boxes and `crowded` was decided for the whole chain, so four crowded
 * minutes collapsed six and a half hours of an evening into one button.
 */
export function layOut(
  items: readonly TimelineItem[],
  metrics: Metrics = DEFAULT_METRICS,
  bandWidth = 0,
): DayLayout {
  const { allDay, timed } = splitAllDay(items);
  const width = bandWidth > 0 ? bandWidth : DEFAULT_BAND;

  const spans = placeSpans(timed.filter((one) => isBlock(one, metrics)), metrics, width);
  const { pins, chips } = placePins(
    timed.filter((one) => !isBlock(one, metrics)),
    spans,
    metrics,
    width,
  );

  const starts = [
    ...spans.map(({ item }) => item.startMin),
    ...pins.map(({ item }) => item.startMin),
    ...chips.flatMap((chip) => chip.members.map((one) => one.startMin)),
  ];
  return {
    allDay,
    spans: spans.map((span) => ({
      ...span,
      labelWidth: uncoveredWidth(span, pins, chips, metrics, width),
    })),
    pins,
    chips,
    firstMin: starts.length === 0 ? null : Math.min(...starts),
  };
}

/**
 * A band width to fall back on before anything has been measured.
 *
 * A phone, less the hour labels. Laying a day out against a width of zero
 * would put every record in one column and merge most of the day, which is
 * a worse first paint than being slightly wrong for one frame.
 */
const DEFAULT_BAND = 346;

type Sized = Omit<PlacedSpan, 'labelWidth'>;

/**
 * Ranges, by true overlap, sharing the band equally within a group.
 *
 * Uniform width across a group means a range's width does not change part
 * way down it, which is the predictability a calendar buys at the cost of
 * some space: a fifteen-minute walk at 21:00 halves an eight-hour night for
 * the whole night. A per-slice width would use the space better and be much
 * harder to read.
 */
function placeSpans(
  items: readonly TimelineItem[],
  metrics: Metrics,
  bandWidth: number,
): Sized[] {
  const entries = items.map((item) => ({
    key: item,
    at: { from: item.startMin, to: item.startMin + item.lengthMin },
  }));

  const out: Sized[] = [];

  for (const group of groupBy(entries)) {
    // Longest first within a start, so the night takes column 0 and the
    // fifteen minutes that overlap it take column 1.
    const ordered = [...group].sort((a, b) =>
      a.at.from - b.at.from || (b.at.to - b.at.from) - (a.at.to - a.at.from));
    const columns = assignColumns(ordered);
    const count = Math.max(...[...columns.values()].map((one) => one + 1), 1);

    for (const { key: item } of ordered) {
      const column = columns.get(item) ?? 0;
      const box = boxOf(item, metrics);
      out.push({
        item,
        top: minutesToPx(box.top, metrics),
        height: minutesToPx(box.bottom - box.top, metrics),
        extentPx: extentOf(item, metrics).px,
        left: column / count,
        width: 1 / count,
      });
    }
  }

  // More concurrent ranges than the band can give a readable width to means
  // narrow cards, not hidden ones -- a card nobody can read still beats a
  // record nobody can reach, and a range may never be folded into an entry
  // (spec 7.5).
  //
  // An earlier note here said this could barely happen, because spec 3.5
  // allows one live timer per range type. That is wrong and was caught in
  // review: `active = 1` constrains *running* timers and nothing else.
  // Finished and back-filled ranges have no such limit, so ten overlapping
  // sleeps can be written by hand. The behaviour above is therefore the
  // defined answer for a real case rather than a formality: they share the
  // band equally and get narrow.
  void bandWidth;
  return out;
}

/** Rows of the band that a placed range's card occupies, in pixels. */
const rowsOf = (span: Sized): Interval => ({ from: span.top, to: span.top + span.height });

/** The rows a range keeps its words in: the top of its card, one card tall. */
const labelRowsOf = (span: Sized, metrics: Metrics): Interval =>
  ({ from: span.top, to: span.top + Math.min(span.height, metrics.minCardHeight) });

/**
 * How far from the band's left a moment must start, to cover no range's
 * stripe, badge or words.
 *
 * Two reserves, and the wider one wins: a range under this moment keeps
 * `SPAN_KEEP`, and a range whose *label zone* is in these rows keeps its
 * whole label width. The second is what makes rule 11 terminate -- without
 * a fixed reservation the tier depends on the coverage, the coverage on how
 * wide the moments are, and the moments on the tier.
 */
function reserveFor(box: Interval, spans: readonly Sized[], metrics: Metrics, bandWidth: number): number {
  let reserve = 0;

  for (const span of spans) {
    const leftPx = span.left * bandWidth;
    const widthPx = span.width * bandWidth;

    if (overlaps(rowsOf(span), box)) {
      reserve = Math.max(reserve, leftPx + Math.min(SPAN_KEEP, widthPx));
    }
    if (overlaps(labelRowsOf(span, metrics), box)) {
      reserve = Math.max(reserve, leftPx + Math.min(labelWidthFor(bandWidth), widthPx) + GAP);
    }
  }

  return reserve;
}

/** Between a card and the next column. The screen uses the same number. */
const GAP = 4;

/**
 * Everything whose card is bigger than its extent: moments, running timers,
 * back-filled records with no end, and ranges too short to fill a card.
 *
 * Three rules hold here whatever the width:
 *
 * - **Nothing is ever stacked.** Columns are assigned greedily over real
 *   intervals, so two cards can share a column only when they do not
 *   overlap. When there is not enough width the columns get narrower than
 *   `minCardWidth`; they never get put on top of one another.
 * - **Folding is the last resort and is bounded by the clock hour.** It
 *   happens only when the columns would not otherwise fit, one hour at a
 *   time, busiest first, and only ever to records with no duration.
 * - **A clock hour folds once, for the whole day.** Two huddles forty
 *   minutes apart do not overlap, so they are laid out separately -- but
 *   they are one hour, and an hour is one entry. Folding them separately
 *   made two entries with the same name, and pressing either opened both
 *   on top of each other.
 */
function placePins(
  items: readonly TimelineItem[],
  spans: readonly Sized[],
  metrics: Metrics,
  bandWidth: number,
): { pins: PlacedPin[]; chips: HourChip[] } {
  let boxes: Box[] = items.map((item) => {
    const box = boxOf(item, metrics);
    return {
      members: [item],
      at: { from: minutesToPx(box.top, metrics), to: minutesToPx(box.bottom, metrics) },
    };
  });

  // Group, place, and if any stretch of the day has run out of columns,
  // fold its busiest hour **across the whole day** and start again. Each
  // fold leaves that hour with one entry and no loose records, so the same
  // hour cannot be chosen twice and this terminates.
  let placed = placeBoxes(boxes, spans, metrics, bandWidth);
  for (;;) {
    const tight = placed.find((group) => group.count > group.fits);
    if (tight === undefined) break;
    const hour = busiestHour(tight.boxes);
    if (hour === null) break;
    boxes = foldHour(boxes, hour, metrics);
    placed = placeBoxes(boxes, spans, metrics, bandWidth);
  }

  const pins: PlacedPin[] = [];
  const chips: HourChip[] = [];

  for (const group of placed) {
    const columnWidth = group.available / group.count;

    for (const box of group.boxes) {
      const column = group.columns.get(box) ?? 0;
      const left = (group.reserve + column * columnWidth) / bandWidth;
      const width = columnWidth / bandWidth;
      const first = box.members[0] as TimelineItem;

      if (box.members.length === 1) {
        pins.push({
          item: first,
          top: box.at.from,
          height: box.at.to - box.at.from,
          left,
          width,
          overSpan: spans.some((span) => overlaps(rowsOf(span), box.at)),
        });
        continue;
      }

      chips.push({
        key: `chip:${Math.floor(first.startMin / 60)}`,
        hour: Math.floor(first.startMin / 60),
        members: box.members,
        top: box.at.from,
        height: box.at.to - box.at.from,
        left,
        width,
      });
    }
  }

  return { pins, chips };
}

type Group = {
  readonly boxes: readonly Box[];
  readonly columns: Map<Box, number>;
  readonly reserve: number;
  readonly available: number;
  readonly count: number;
  readonly fits: number;
};

function placeBoxes(
  boxes: readonly Box[],
  spans: readonly Sized[],
  metrics: Metrics,
  bandWidth: number,
): Group[] {
  return groupBy(boxes.map((box) => ({ key: box, at: box.at }))).map((group) => {
    // One reserve for the whole group, so its columns line up. Computed
    // from the widest any member needs: a grid that shifted from row to row
    // would read as records jumping sideways down the screen.
    //
    // **Clamped to what the band actually has.** Asking for more than there
    // is and then widening the columns to the minimum anyway put records
    // past the right-hand edge -- up to 43% past it on a narrow column,
    // which on a real iPhone is a screen you have to swipe sideways to
    // read. When the two cannot both be had, being on the screen wins and
    // the range gives up some of its reserve.
    const wanted = Math.max(
      ...group.map(({ at }) => reserveFor(at, spans, metrics, bandWidth)),
      0,
    );
    const reserve = Math.max(Math.min(wanted, bandWidth - metrics.minCardWidth), 0);
    const available = bandWidth - reserve;
    const columns = assignColumns(group);

    return {
      boxes: group.map(({ key }) => key),
      columns,
      reserve,
      available,
      count: widthOf(columns),
      fits: Math.max(1, Math.min(
        Math.floor(available / metrics.minCardWidth),
        MAX_PIN_COLUMNS,
      )),
    };
  });
}

/** One record, or the clock hour's worth of them that share an entry. */
type Box = { readonly members: readonly TimelineItem[]; readonly at: Interval };

const widthOf = (columns: Map<unknown, number>): number =>
  Math.max(...[...columns.values()].map((one) => one + 1), 1);

/**
 * The fullest clock hour that could be folded, or null if none can be.
 *
 * Busiest first, so the fewest records are hidden for the width gained; the
 * earliest hour breaks a tie, so the result does not depend on the order
 * records happen to arrive in. An hour with one loose record is not folded,
 * because a list of one is not a list.
 */
function busiestHour(boxes: readonly Box[]): number | null {
  const hours = new Map<number, number>();

  for (const box of boxes) {
    if (box.members.length !== 1) continue;
    const only = box.members[0] as TimelineItem;
    if (!isMergeable(only)) continue;
    const hour = Math.floor(only.startMin / 60);
    hours.set(hour, (hours.get(hour) ?? 0) + 1);
  }

  let chosen: number | null = null;
  let most = 1;
  for (const [hour, count] of [...hours.entries()].sort((a, b) => a[0] - b[0])) {
    if (count > most) {
      chosen = hour;
      most = count;
    }
  }
  return chosen;
}

/** Folds every loose record of one clock hour, day-wide, into one entry. */
function foldHour(boxes: readonly Box[], hour: number, metrics: Metrics): Box[] {
  const taken = boxes.filter((box) => box.members.length === 1
    && isMergeable(box.members[0] as TimelineItem)
    && Math.floor((box.members[0] as TimelineItem).startMin / 60) === hour);

  const members = taken
    .map((box) => box.members[0] as TimelineItem)
    .sort((a, b) => a.startMin - b.startMin);
  const first = members[0] as TimelineItem;
  const last = members[members.length - 1] as TimelineItem;
  const from = minutesToPx(first.startMin, metrics);

  return [
    ...boxes.filter((box) => !taken.includes(box)),
    {
      members,
      at: {
        from,
        // **The height the entry is actually drawn at**, not the height of
        // one card. It carries three rows -- badges, count, range -- and
        // computing collisions from 44px while drawing 58 let an entry
        // cover the top of the next record by ten pixels. One number,
        // decided here, used as it is by the screen.
        to: Math.max(minutesToPx(last.startMin, metrics) + metrics.minCardHeight, from + CHIP_HEIGHT),
      },
    },
  ];
}
/**
 * The widest strip of a range's card, from its own left edge, that nothing
 * covers across the rows its words live in.
 *
 * The tier comes from this rather than from the column width, so a range
 * with a nappy sitting on its right-hand half still says its type, its time
 * and how long it was.
 */
function uncoveredWidth(
  span: Sized,
  pins: readonly PlacedPin[],
  chips: readonly HourChip[],
  metrics: Metrics,
  bandWidth: number,
): number {
  const rows = labelRowsOf(span, metrics);
  const leftPx = span.left * bandWidth;
  let right = leftPx + span.width * bandWidth;

  for (const one of [...pins, ...chips]) {
    if (!overlaps({ from: one.top, to: one.top + one.height }, rows)) continue;
    const coverLeft = one.left * bandWidth;
    if (coverLeft > leftPx) right = Math.min(right, coverLeft - GAP);
  }

  return Math.max(right - leftPx, 0);
}

/**
 * The least a range's tint may be drawn as.
 *
 * Three pixels is under two minutes at the default metrics. It is there so
 * that a two-minute feed is visible at all, and it is the only place the
 * drawing departs from the clock -- deliberately not the other direction,
 * because a tint stretched to fit words would be a duration nobody
 * recorded.
 */
export const MIN_EXTENT_PX = 3;

/**
 * The real extent of a record, in pixels, which is not its card's height.
 *
 * Measured from the card's own top edge, because the card's top edge **is**
 * the start minute -- for everything, with no offset and no exceptions.
 *
 * **The extent is the tint, and the tint is the only thing that draws it.**
 * There was a stripe down the card's left as well, and a dot on the edge for
 * a moment; both said a second time what the top edge and the tint already
 * said, and three marks that have to be read together read as debris. So:
 * colour in the card means duration, and a card with no colour in it is a
 * moment. Nothing else has to be learnt.
 *
 * A moment gets no tint at all, because a tint of no height is nothing and a
 * tint of some height would be a duration nobody recorded (spec 3.4.1
 * rule 3).
 */
export type Extent = {
  /** Height of the tinted part, in pixels. Zero for a moment. */
  readonly px: number;
  /** A moment rather than a range, so nothing is tinted. */
  readonly point: boolean;
};

export function extentOf(item: TimelineItem, metrics: Metrics): Extent {
  if (item.lengthMin <= 0) return { px: 0, point: true };
  return { px: Math.max(minutesToPx(item.lengthMin, metrics), MIN_EXTENT_PX), point: false };
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

/**
 * Roughly how wide a string is, in pixels, at a given size.
 *
 * An estimate, and deliberately a cheap one: measuring text means a DOM, a
 * layout pass and a number that arrives after the render that needed it.
 * What it is for is deciding whether a card can carry a thing at all --
 * "1 ..." where a duration should be says less than nothing, and a card is
 * better off dropping the figure than cutting it in half.
 *
 * A CJK glyph is one em; Latin letters and digits are a little over half;
 * punctuation and spaces are narrower again. Wrong by a few pixels either
 * way, which is why every caller leaves a margin.
 */
export function textWidth(text: string, fontSize: number): number {
  let ems = 0;
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    if (point > 0x2e80) ems += 1;
    else if (character === ' ') ems += 0.3;
    else if (':.,'.includes(character)) ems += 0.32;
    else if (character === '·' || character === '-') ems += 0.45;
    else ems += 0.58;
  }
  return ems * fontSize;
}

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
export function openingMinute(
  isToday: boolean,
  nowMinutes: number | null,
  layout: DayLayout,
): number | null {
  if (isToday) return nowMinutes;
  return layout.firstMin;
}

/** Greedy by start: the first column whose last card has finished. */