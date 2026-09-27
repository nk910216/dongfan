import { memo } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { CircleCheck, CloudOff, TriangleAlert } from 'lucide-react';
import { eventTypeName, formatValue, getEventType, interpolate, zhTW } from '@dongfan/shared';
import { EventIconChip, FALLBACK_COLOR } from './EventIcon.js';
import { formatClock, formatDuration } from '../lib/format.js';
import { linkBack } from '../lib/return-to.js';
import {
  DEFAULT_METRICS, MINUTES_IN_DAY, extentOf, minutesToPx, textWidth, tierFor,
} from '../lib/timeline.js';
import type { DayLayout, HourChip, Metrics, Tier, TimelineItem } from '../lib/timeline.js';

/**
 * A day drawn against a fixed 00:00-24:00 axis (spec 7.5).
 *
 * Every hour is the same height and an empty stretch stays empty. Nothing
 * here compresses a quiet afternoon or stretches a busy hour: the shape of a
 * day -- when the gaps are, how long the night was -- is the thing the page
 * exists to show, and a layout that tidied it away would be a list with
 * gridlines drawn on it.
 *
 * Two measurements per record, kept apart on purpose. The **extent** is real
 * and is never adjusted to suit the words. The **card** carrying them has a
 * minimum height, because a target smaller than a fingertip is no use at
 * three in the morning -- so when the card is taller than the extent, the
 * tint *stops where the record stops* and the height cannot be read as a
 * duration.
 *
 * Two marks and no more: **the card's top edge is the start minute**, for
 * everything, with no offset and no exception; and **colour inside the card
 * is duration**, so a card with none is a moment. A stripe down the left and
 * a dot on the edge said the same two things a third and a fourth time, and
 * marks that have to be read together read as debris.
 */

const HOUR_LABEL_WIDTH = 38;
const RAIL_WIDTH = 6;
/**
 * Taken off the left once, before the columns divide what is left.
 *
 * Exported because the two-day view has to line its headings and its bands
 * up with the same hour labels; two ideas of how wide they are would show up
 * as a column half a character out of true.
 */
export const TIMELINE_GUTTER = HOUR_LABEL_WIDTH + RAIL_WIDTH;
const GUTTER = TIMELINE_GUTTER;
/** Between a card and the next column, and the right-hand edge. */
const GAP = 4;
/**
 * How much of the type's colour a range's body carries.
 *
 * Only a range carries any. That is the whole of how the two kinds are told
 * apart, and it means the colour on the screen *is* the time accounted for:
 * the shape of a day -- when the sleeping was, how the two nights differ --
 * is legible while scrolling past at speed, which is what the two-day
 * screen is for. A moment has no duration and so no fill; its top edge, its
 * border and its badge carry its colour.
 *
 * Twenty-eight per cent, not eighteen: at eighteen the two kinds were told
 * apart only by looking for the fill rather than by seeing it. The cost is
 * paid on the second line, which is why a tinted card lifts it -- see
 * below.
 */
const RANGE_TINT = 28;

/** The time a record is anchored to, for the card and for screen readers. */
function describeTime(item: TimelineItem, timezone: string): string {
  const started = item.event?.startedAt ?? item.queued?.input.startedAt ?? 0;
  if (item.carriedOver) return zhTW.calendar.carriedOver;
  return formatClock(started, timezone);
}

function detailOf(item: TimelineItem, timezone: string): string {
  const parts: string[] = [describeTime(item, timezone)];
  const type = getEventType(item.typeId);

  if (item.drafted) {
    // The draft's own moment. The event the server knows about is a running
    // timer with no end at all, and formatting that null as a clock printed
    // the epoch -- 08:00 in Taipei (spec 7.2).
    parts.push(item.draftTooLong || item.draftEndedAt === null
      ? zhTW.calendar.draftTooLong
      : interpolate(zhTW.calendar.draftEndedAt, {
        time: formatClock(item.draftEndedAt, timezone),
      }));
  } else if (item.running) {
    parts.push(zhTW.event.inProgress);
  } else if (item.lengthMin > 0) {
    parts.push(formatDuration(item.lengthMin * 60_000));
  } else if (type?.hasRange === true) {
    // A record somebody has not finished filling in. Saying so beats
    // drawing a length nobody entered (spec 3.5).
    parts.push(zhTW.calendar.noEnd);
  }

  if (item.continues) parts.push(zhTW.calendar.continues);
  if (item.kind === 'queued') parts.push(zhTW.unsynced.badge);

  return parts.join(' · ');
}

/**
 * Where a tap goes, which is never a new screen invented for this page.
 *
 * The edit screen is told where it was opened from, so coming back lands on
 * the day being read with whatever was open still open -- rather than on the
 * home screen, on today.
 */
function linkFor(item: TimelineItem, from: string): string {
  if (item.kind === 'queued') return linkBack('/unsynced', from);
  if (item.drafted) return linkBack(`/stop/${item.eventId ?? ''}`, from);
  return linkBack(`/event/${item.eventId ?? ''}`, from);
}

/**
 * What a card shows, in the order it gives things up.
 *
 * Split from `detailOf` -- which still builds the whole sentence for the
 * accessible name -- because a card at 48px and a card at 346px show
 * different subsets of the same facts, and nothing may be invented for
 * either of them.
 */
type Parts = {
  readonly name: string;
  /** The value with its unit, or the duration. Never both. */
  readonly figure: string | null;
  readonly clock: string;
  readonly status: string | null;
};

function figureOf(item: TimelineItem, type: ReturnType<typeof getEventType>): string | null {
  const spec = type?.value ?? null;
  const value = item.event?.value ?? item.queued?.input.value ?? null;
  if (spec && value !== null) return `${formatValue(value, spec)}${spec.unit}`;
  if (item.lengthMin <= 0) return null;

  const duration = formatDuration(item.lengthMin * 60_000);
  // A night shown on the morning it ran into is seven hours of *this* day
  // out of eight, and the card is the only place that can say so
  // (spec 3.4.1, zhTW.calendar.onThisDay).
  return item.carriedOver || item.continues
    ? interpolate(zhTW.calendar.onThisDay, { duration })
    : duration;
}

function partsOf(item: TimelineItem, timezone: string, tier: Tier): Parts {
  const type = getEventType(item.typeId);
  const started = item.event?.startedAt ?? item.queued?.input.startedAt ?? 0;
  const ended = item.drafted
    ? item.draftEndedAt
    : item.event?.endedAt ?? item.queued?.input.endedAt ?? null;

  // The full range at the width that can hold it, and the start alone
  // otherwise. A clipped half says only where it begins on this day; the
  // rest of it is in the status and in the figure.
  const clock = item.carriedOver
    ? zhTW.calendar.carriedOver
    : tier === 'A' && ended !== null && !item.continues && item.lengthMin > 0
      ? `${formatClock(started, timezone)} - ${formatClock(ended, timezone)}`
      : formatClock(started, timezone);

  return {
    name: eventTypeName(item.typeId),
    figure: figureOf(item, type),
    clock,
    status: statusOf(item, timezone),
  };
}

function statusOf(item: TimelineItem, timezone: string): string | null {
  if (item.drafted) {
    return item.draftTooLong || item.draftEndedAt === null
      ? zhTW.calendar.draftTooLong
      : interpolate(zhTW.calendar.draftEndedAt, {
        time: formatClock(item.draftEndedAt, timezone),
      });
  }
  if (item.running) return zhTW.event.inProgress;
  if (item.kind === 'queued') return zhTW.unsynced.badge;
  if (item.continues) return zhTW.calendar.continues;
  if (item.lengthMin <= 0 && getEventType(item.typeId)?.hasRange === true) {
    return zhTW.calendar.noEnd;
  }
  return null;
}

/**
 * The one glyph that says what state a record is in.
 *
 * `drafted` and `queued` used to share a dashed warn border and were told
 * apart only by reading the words. A parent who confuses "stopped, not
 * confirmed" with "not sent" either stops a timer twice or leaves it running
 * all night, so they get different marks.
 *
 * These are status marks, not event types, so they are imported here rather
 * than added to `EventIcon`'s map -- whose keys belong to the event type
 * config.
 */
function StateMark({ item }: { item: TimelineItem }): React.JSX.Element | null {
  // In the row rather than over its corner. Hung off the top right it sat on
  // top of the value, and "160ml" with a cloud through it is worse than
  // either mark on its own.
  const style = 'ml-auto shrink-0 self-start text-warn';
  if (item.draftTooLong) return <TriangleAlert size={11} className={style} aria-hidden />;
  if (item.drafted) return <CircleCheck size={11} className={style} aria-hidden />;
  if (item.kind === 'queued') return <CloudOff size={11} className={style} aria-hidden />;
  return null;
}

/**
 * The body of a card: its tint, and where the tint stops.
 *
 * When a card is taller than the record it stands for -- anything under 27.5
 * minutes at the default metrics -- the tint ends at the extent and the rest
 * is plain. A thirteen-minute nursing is therefore a band of colour inside a
 * 44px card rather than a 44px block, and its height cannot be read as its
 * duration. That is the trap spec 7.5 names, answered with geometry instead
 * of a caption.
 *
 * When the extent covers the card this degenerates to a flat tint, which is
 * the common case -- so it is one rule with no branch in it.
 */
function bodyOf(item: TimelineItem, extentPx: number, heightPx: number): string {
  if (item.lengthMin <= 0) return 'var(--color-surface-raised)';
  const tint = `color-mix(in oklab, var(--type) ${RANGE_TINT}%, var(--color-surface-raised))`;
  if (extentPx >= heightPx) return tint;
  return `linear-gradient(to bottom, ${tint} 0, ${tint} ${extentPx}px, `
    + `var(--color-surface-raised) ${extentPx}px)`;
}

/**
 * The words, and the way in.
 *
 * On the axis it is placed by its start and given at least a fingertip of
 * height; in a list -- the crowded expansion, the all-day band -- it has no
 * geometry at all, because a row there stands for a record and not for a
 * stretch of time.
 */
function Card({ item, timezone, metrics, width, style, inList = false, overSpan = false }: {
  item: TimelineItem;
  timezone: string;
  metrics: Metrics;
  /**
   * The width the words have, in pixels, which decides how much is said.
   *
   * For a moment that is the card. For a range it is the part of the card
   * nothing is covering, which is why a nursing with a nappy on its right
   * still says its type, its time and how long it was.
   */
  width: number;
  style?: React.CSSProperties;
  inList?: boolean;
  /** Drawn over a range, so it needs an edge against it. */
  overSpan?: boolean;
}): React.JSX.Element {
  const location = useLocation();
  const type = getEventType(item.typeId);
  const color = type?.color ?? FALLBACK_COLOR;
  const tier = inList ? 'A' : tierFor(width);
  const parts = partsOf(item, timezone, tier);
  const extent = extentOf(item, metrics);
  const height = Number.parseFloat(String(style?.height ?? '0'));

  // Name at A and B only. At C the value wins, because the badge already
  // said the type and the number did not -- and with no value the name is
  // dropped rather than cut to one character, which is the state the owner
  // reported: a glyph saying "solid food" beside a character saying nothing.
  // The clock never drops: a timeline that has stopped saying when has
  // stopped being a timeline.
  /**
   * What actually fits, rather than what the tier allows.
   *
   * The tier says what a card of this width is *entitled* to; this decides
   * what it can hold. Anything that would be cut is left out instead: a
   * figure truncated to "1 ..." where a duration should be says less than
   * nothing, and a name cut to one character next to a badge that already
   * said the type is the state the owner reported in the first place.
   *
   * Dropping is in order and stops at the first thing that does not fit --
   * keeping a later, shorter item would put the card's facts in an order
   * nobody chose.
   */
  const room = Math.max(width - 15, 0);
  const fits = (candidates: (string | null)[], space: number, size: number): string[] => {
    const out: string[] = [];
    let used = 0;
    for (const one of candidates) {
      if (one === null || one === '') continue;
      const cost = textWidth(one, size) + (out.length > 0 ? textWidth(' · ', size) : 0);
      if (used + cost > space) break;
      out.push(one);
      used += cost;
    }
    return out;
  };

  const figureWidth = parts.figure === null ? 0 : textWidth(parts.figure, 12);
  const figureOnTop = parts.figure !== null
    && (tier === 'A' || tier === 'C')
    && figureWidth + 4 <= room - 20 - 4;
  const showName = (tier === 'A' || tier === 'B')
    && textWidth(parts.name, 12) <= room - 20 - 4 - (figureOnTop ? figureWidth + 4 : 0);

  // The clock goes on whether it fits or not: a timeline that has stopped
  // saying when has stopped being a timeline, and it is the one thing here
  // that is better truncated than absent.
  const secondLine = [
    parts.clock,
    ...fits(
      [figureOnTop ? null : parts.figure, parts.status],
      room - textWidth(parts.clock, 10),
      10,
    ),
  ];

  return (
    <Link
      to={linkFor(item, `${location.pathname}${location.search}`)}
      style={{
        ...style,
        // Set once per card; everything below is a mix of it, so a type's
        // colour is named in exactly one place.
        ['--type' as string]: color,
        background: inList
          ? bodyOf(item, Number.POSITIVE_INFINITY, 0)
          : bodyOf(item, extent.px, height),
        borderColor: item.drafted || item.kind === 'queued'
          ? undefined
          : 'color-mix(in oklab, var(--type) 30%, var(--color-line))',
        // The start minute, drawn. A record carried over from yesterday
        // began somewhere this day cannot show, so it has no top edge --
        // an open edge means "keeps going", in either direction.
        borderTopColor: item.carriedOver ? 'transparent' : 'var(--type)',
        borderTopWidth: item.carriedOver ? 1 : 2,
        // Solid even when the rest of the border is dashed. The dashes say
        // the record has not been settled; the time it began at is settled
        // either way, and that edge is what says it.
        borderTopStyle: 'solid',
        // A moment over a range is on top of it, not beside it, and needs a
        // line of ground between the two or they read as one block.
        ...(overSpan ? { boxShadow: '0 0 0 2px var(--color-ground)' } : {}),
      }}
      data-testid={`slot-${item.typeId}`}
      data-kind={item.kind}
      data-tier={tier}
      aria-label={`${eventTypeName(item.typeId)} ${detailOf(item, timezone)}`}
      className={`flex min-h-11 flex-col overflow-visible rounded-lg border py-[5px] pr-1.5 pl-[9px] ${
        inList ? 'relative mb-1 justify-center' : 'absolute justify-start'
      } ${
        item.kind === 'queued'
          ? 'border-dashed border-warn/55 opacity-90'
          : item.drafted
            ? 'border-dashed border-warn/70'
            : ''
      }`}
    >
      {/* The words live in whatever width is not covered, which for a
          range is narrower than its card (docs/timeline-design.md). */}
      <span
        className="flex min-w-0 items-center gap-1"
        style={inList ? undefined : { maxWidth: `${Math.max(width - 15, 24)}px` }}
      >
        <EventIconChip icon={type?.icon ?? 'circle-ellipsis'} color={color} size={20} />
        {showName ? (
          <span className="truncate text-[12px] font-semibold leading-tight">{parts.name}</span>
        ) : null}
        {figureOnTop ? (
          <span
            className="font-numeric ml-auto shrink-0 pl-1 text-[12px] font-semibold"
            style={{ color: 'color-mix(in oklab, var(--type) 70%, var(--color-ink))' }}
          >
            {parts.figure}
          </span>
        ) : null}
        <StateMark item={item} />
      </span>
      {/* Lifted on a tinted card. The faint ink was chosen against the
          plain surface and is already near the floor there; over a fill of
          one of the lighter type colours it stops being readable, and the
          clock is on this line. */}
      <span
        className={`truncate text-[10px] leading-tight ${
          item.lengthMin > 0 ? 'text-ink-muted' : 'text-ink-faint'
        }`}
        style={inList ? undefined : { maxWidth: `${Math.max(width - 15, 24)}px` }}
      >
        {secondLine.join(' · ')}
      </span>
    </Link>
  );
}

/**
 * What is behind an "N of them", said without opening it.
 *
 * A count on its own is not an answer: six records could be six nappies or a
 * bath, a feed and four moods, over four minutes or over seven hours. So the
 * entry carries the badges of what is inside in start order, the count, the
 * stretch it covers, and a stripe segmented one colour per member -- a
 * miniature of its contents in time order, which costs nothing and survives
 * down to the narrowest width (docs/timeline-design.md).
 *
 * Deliberately unlike a card: `surface` rather than a tint, and a plain
 * border, so that nobody reads it as a record.
 *
 * Whether it is open lives in the URL rather than in state here. Opening
 * one, tapping into an event and coming back unmounted this component and
 * lost it, so the list a parent had just opened collapsed under them.
 *
 * The key is the **day and the hour**, not a minute. Both columns of the
 * two-day screen have a 09:00, so the day has to be in it; a minute moves
 * when a record is added nearby, which would silently close a list somebody
 * had open, and an hour does not. It is also the same key on both screens,
 * so a list opened on one is still open on the other.
 */
const ChipBody = memo(function ChipBody({ chip, day, timezone, metrics, bandWidth }: {
  chip: HourChip;
  day: string;
  timezone: string;
  metrics: Metrics;
  bandWidth: number;
}): React.JSX.Element {
  const [search, setSearch] = useSearchParams();
  const id = `${day}@h${chip.hour}`;
  const open = search.get('open') === id;

  const setOpen = (wanted: boolean): void => {
    const next = new URLSearchParams(search);
    if (wanted) next.set('open', id);
    else next.delete('open');
    // Replaced, not pushed: opening a list is not a place to go back to.
    setSearch(next, { replace: true });
  };

  const width = chip.width * bandWidth - GAP;
  const place = {
    top: `${chip.top}px`,
    left: `${chip.left * 100}%`,
    width: `calc(${chip.width * 100}% - ${GAP}px)`,
  };

  if (open) {
    // A list, so its rows carry no time geometry: a row is as tall as its
    // words, and nothing in it is scaled by a duration. Drawing extents in
    // here would say that one of these lasted longer than another because
    // its row happened to be taller, which is not what a row means.
    //
    // And it takes the **whole day band**, not the entry's column. It is a
    // layer over the day rather than a record in it, and the entry's column
    // can be 54px -- where its rows were being laid out as though they had
    // the band, so every one of them overflowed.
    return (
      <div
        style={{ top: `${chip.top}px`, left: 0, right: `${GAP}px` }}
        className="absolute z-10 rounded-lg border border-line bg-surface p-1 shadow-lg shadow-black/50"
        data-testid="crowded-open"
      >
        {chip.members.map((item) => (
          <Card
            key={item.key}
            item={item}
            timezone={timezone}
            metrics={metrics}
            width={bandWidth - GAP}
            inList
          />
        ))}
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="min-h-11 w-full text-[11px] text-ink-dim"
        >
          {zhTW.calendar.crowdedClose}
        </button>
      </div>
    );
  }

  const first = chip.members[0] as TimelineItem;
  const last = chip.members[chip.members.length - 1] as TimelineItem;

  // Distinct types in start order. A type that appears more than once is one
  // badge carrying how many, rather than the same glyph repeated.
  const kinds: { typeId: string; count: number }[] = [];
  for (const item of chip.members) {
    const seen = kinds.find((one) => one.typeId === item.typeId);
    if (seen) seen.count += 1;
    else kinds.push({ typeId: item.typeId, count: 1 });
  }
  const shown = kinds.length > 4 ? kinds.slice(0, 3) : kinds;

  const startOf = (item: TimelineItem): number =>
    item.event?.startedAt ?? item.queued?.input.startedAt ?? 0;
  // When outranks how many, so this is the last thing the width takes --
  // and it gives up the end before it gives up the beginning, rather than
  // printing half a range and an ellipsis.
  const both = `${formatClock(startOf(first), timezone)} - ${formatClock(startOf(last), timezone)}`;
  const range = width >= 108 ? both : formatClock(startOf(first), timezone);
  const showRange = width >= 56;

  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      data-testid="crowded"
      // The height the layout gave it, exactly. Adding to it here is what
      // let an entry cover the top of the record below: the collisions were
      // computed against one number and the screen drew another.
      style={{ ...place, height: `${chip.height}px` }}
      className="absolute flex min-h-11 flex-col justify-start gap-0.5 overflow-hidden rounded-lg border border-line bg-surface py-[5px] pr-1.5 pl-[9px] text-left"
    >
      {/* One segment per member, in start order, in that member's colour. */}
      <span aria-hidden className="absolute top-0 bottom-0 left-0 flex w-[3px] flex-col">
        {chip.members.map((item) => (
          <span
            key={item.key}
            className="flex-1"
            style={{ background: getEventType(item.typeId)?.color ?? FALLBACK_COLOR }}
          />
        ))}
      </span>

      <span className="flex items-center gap-1">
        {shown.map(({ typeId, count }) => (
          <span
            key={typeId}
            data-testid="chip-type"
            data-type={typeId}
            className="flex shrink-0 items-center"
          >
            <EventIconChip
              icon={getEventType(typeId)?.icon ?? 'circle-ellipsis'}
              color={getEventType(typeId)?.color ?? FALLBACK_COLOR}
              size={16}
            />
            {/* Beside the badge rather than over its corner: the entry
                clips its overflow, and a numeral hung off the corner was
                cut in half by that. */}
            {count > 1 ? (
              <span className="font-numeric text-[10px] leading-none text-ink-muted">
                ×{count}
              </span>
            ) : null}
          </span>
        ))}
        {kinds.length > shown.length ? (
          <span className="font-numeric text-[10px] text-ink-muted">
            +{kinds.length - shown.length}
          </span>
        ) : null}
      </span>

      <span className="truncate text-[11px] text-ink-muted">
        {interpolate(zhTW.calendar.crowded, { count: chip.members.length })}
      </span>
      {showRange ? (
        <span className="font-numeric truncate text-[10px] text-ink-faint">{range}</span>
      ) : null}

      {/* Nothing is hidden from a screen reader either. */}
      <span className="sr-only">
        {chip.members.map((item) =>
          `${eventTypeName(item.typeId)} ${formatClock(startOf(item), timezone)}`).join(', ')}
      </span>
    </button>
  );
});

/**
 * One day's records: its ranges, its moments, and any hour it had to
 * collapse.
 *
 * Memoised because the clock ticks. `now` moves every second in the store,
 * and the current-time line is next to this: without the split, every card
 * on the day was rebuilt once a second for a line that cannot move by less
 * than a pixel in that time.
 *
 * Ranges are drawn first so that a moment over one sits on top of it, which
 * is what the ring on `overSpan` says out loud.
 */
const Records = memo(function Records({ layout, day, timezone, metrics, bandWidth }: {
  layout: DayLayout;
  day: string;
  timezone: string;
  metrics: Metrics;
  bandWidth: number;
}): React.JSX.Element {
  return (
    <>
      {layout.spans.map((span) => (
        <Card
          key={span.item.key}
          item={span.item}
          timezone={timezone}
          metrics={metrics}
          width={span.labelWidth}
          style={{
            top: `${span.top}px`,
            height: `${span.height}px`,
            left: `${span.left * 100}%`,
            width: `calc(${span.width * 100}% - ${GAP}px)`,
          }}
        />
      ))}

      {layout.pins.map((pin) => (
        <Card
          key={pin.item.key}
          item={pin.item}
          timezone={timezone}
          metrics={metrics}
          width={pin.width * bandWidth - GAP}
          overSpan={pin.overSpan}
          style={{
            top: `${pin.top}px`,
            height: `${pin.height}px`,
            left: `${pin.left * 100}%`,
            width: `calc(${pin.width * 100}% - ${GAP}px)`,
          }}
        />
      ))}

      {layout.chips.map((chip) => (
        <ChipBody
          key={chip.key}
          chip={chip}
          day={day}
          timezone={timezone}
          metrics={metrics}
          bandWidth={bandWidth}
        />
      ))}
    </>
  );
});

/**
 * Everything belonging to one day, inside the band it was given.
 *
 * Absolutely positioned over the full height of the axis, so the cards keep
 * their `top` in pixels whatever width the band has. That is what lets two
 * days sit beside each other on **the same hour scale**, which is the whole
 * point of showing two (spec 7.6).
 */
export function DayBand({ layout, day, timezone, metrics, nowMinutes, bandWidth, style }: {
  layout: DayLayout;
  /** The date this band shows, which names its stretches apart. */
  day: string;
  timezone: string;
  metrics: Metrics;
  /** Minutes into this column's day, or null when it is not today. */
  nowMinutes: number | null;
  /** This band's width in pixels: one day's whole band, or half of it. */
  bandWidth: number;
  style: React.CSSProperties;
}): React.JSX.Element {
  return (
    <div className="absolute top-0 bottom-0" style={style}>
      <Records
        layout={layout}
        day={day}
        timezone={timezone}
        metrics={metrics}
        bandWidth={bandWidth}
      />

      {/* Only on today, and from the baby's clock rather than the
          device's (spec 3.4). */}
      {nowMinutes !== null ? (
        <div
          className="pointer-events-none absolute right-0 left-0 flex items-center"
          style={{ top: `${minutesToPx(nowMinutes, metrics)}px` }}
          data-testid="now-line"
        >
          <span className="size-1.5 shrink-0 rounded-full bg-accent" />
          <span className="h-px flex-1 bg-accent/70" />
        </div>
      ) : null}
    </div>
  );
}

/** The band above the hours, for events with no time of day (spec 3.9). */
export function AllDayBand({ items, timezone, metrics, bandWidth, label }: {
  items: readonly TimelineItem[];
  timezone: string;
  metrics: Metrics;
  bandWidth: number;
  /** Shown once on a single day; on two days each column says its date. */
  label: string;
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1" data-testid="all-day">
      <span className="text-[10px] text-ink-dim">{label}</span>
      {items.map((item) => (
        <Card
          key={item.key}
          item={item}
          timezone={timezone}
          metrics={metrics}
          width={bandWidth}
          inList
        />
      ))}
    </div>
  );
}

/** The rules behind everything. They never change, so they are built once. */
export const Hours = memo(function Hours({ metrics }: { metrics: Metrics }): React.JSX.Element {
  return (
    <>
      {Array.from({ length: 25 }, (_, hour) => hour).map((hour) => (
        <div
          key={hour}
          className="absolute right-0 left-0 flex items-start"
          style={{ top: `${minutesToPx(hour * 60, metrics)}px` }}
        >
          <span className="-mt-1.5 w-9 pr-1 text-right font-numeric text-[10px] text-ink-dim">
            {hour === 24 ? '24:00' : `${String(hour).padStart(2, '0')}:00`}
          </span>
          <span className="mt-px h-px flex-1 bg-line-soft" />
        </div>
      ))}
    </>
  );
});

export function Timeline({
  layout, day, timezone, nowMinutes, bandWidth, metrics = DEFAULT_METRICS,
}: {
  layout: DayLayout;
  day: string;
  timezone: string;
  /** Minutes into this day, or null when the day is not today. */
  nowMinutes: number | null;
  /** The band's width in pixels: the viewport less the hour labels. */
  bandWidth: number;
  metrics?: Metrics;
}): React.JSX.Element {
  return (
    <div>
      {layout.allDay.length > 0 ? (
        <div className="mb-1 flex gap-1 border-b border-line px-2 py-1.5">
          <span className="w-8 shrink-0 pt-1 text-[10px] text-ink-dim">{zhTW.calendar.allDay}</span>
          <AllDayBand
            items={layout.allDay}
            timezone={timezone}
            metrics={metrics}
            bandWidth={bandWidth}
            label=""
          />
        </div>
      ) : null}

      <div
        className="relative"
        style={{ height: `${minutesToPx(MINUTES_IN_DAY, metrics)}px` }}
        data-testid="timeline"
      >
        <Hours metrics={metrics} />
        <DayBand
          layout={layout}
          day={day}
          timezone={timezone}
          metrics={metrics}
          nowMinutes={nowMinutes}
          bandWidth={bandWidth}
          style={{ left: `${GUTTER}px`, right: 0 }}
        />
      </div>
    </div>
  );
}
