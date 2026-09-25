import { memo } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { CircleCheck, CloudOff, TriangleAlert } from 'lucide-react';
import { eventTypeName, formatValue, getEventType, interpolate, zhTW } from '@dongfan/shared';
import { EventIconChip, FALLBACK_COLOR } from './EventIcon.js';
import { formatClock, formatDuration } from '../lib/format.js';
import { linkBack } from '../lib/return-to.js';
import {
  DEFAULT_METRICS, MINUTES_IN_DAY, POINT_PX, boxOf, columnSpan, extentOf, minutesToPx, tierFor,
} from '../lib/timeline.js';
import type { Cluster, DayLayout, Metrics, Placed, Tier, TimelineItem } from '../lib/timeline.js';

/**
 * A day drawn against a fixed 00:00-24:00 axis (spec 7.5).
 *
 * Every hour is the same height and an empty stretch stays empty. Nothing
 * here compresses a quiet afternoon or stretches a busy hour: the shape of a
 * day -- when the gaps are, how long the night was -- is the thing the page
 * exists to show, and a layout that tidied it away would be a list with
 * gridlines drawn on it.
 *
 * Two measurements per record, kept apart on purpose. The **extent** is real:
 * a finished range is a stripe from its start to its end, and it is never
 * adjusted to suit the words. The **card** carrying the words has a minimum
 * height, because a target smaller than a fingertip is no use at three in the
 * morning -- so when the card is taller than the extent, the tint *stops
 * where the record stops* and the height cannot be read as a duration.
 *
 * The card's top edge is the start minute. For everything, with no offset
 * and no exception -- which is what ties a card to a time now that the
 * anchor no longer lives in a lane of its own beside it
 * (docs/timeline-design.md).
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
/** The stripe carrying a range's true extent, at the card's own left edge. */
const STRIPE_WIDTH = 3;
/**
 * The least a collapsed entry may be, with and without its time range.
 *
 * A chip has three rows to fit -- badges, count, range -- and a stretch of
 * six minutes is 10px of axis. Without a floor the words were cut in half by
 * the entry's own height. It is the same compromise a card's minimum height
 * is, and a chip is already drawn as a container rather than as a record, so
 * nothing here can be read as a duration.
 */
const CHIP_MIN_HEIGHT = 58;
const CHIP_MIN_HEIGHT_TERSE = 44;

/** How much of the type's colour a card's body carries. */
const RANGE_TINT = 18;
const MOMENT_TINT = 11;
/**
 * A range is tinted harder than a moment, and that is not decoration.
 *
 * A range is a thing you compare -- how long was the night, how did tonight
 * differ -- and a moment is a thing you count. The heavier tint is what makes
 * the day's shape legible while scrolling past at speed, which is the whole
 * purpose of the two-day screen.
 */
function tintOf(item: TimelineItem): number {
  return item.lengthMin > 0 ? RANGE_TINT : MOMENT_TINT;
}

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
  const tint = `color-mix(in oklab, var(--type) ${tintOf(item)}%, var(--color-surface-raised))`;
  if (item.lengthMin <= 0 || extentPx >= heightPx) return tint;
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
function Card({ item, timezone, metrics, width, style, inList = false }: {
  item: TimelineItem;
  timezone: string;
  metrics: Metrics;
  /** The card's own width in pixels, which decides how much it can say. */
  width: number;
  style?: React.CSSProperties;
  inList?: boolean;
}): React.JSX.Element {
  const location = useLocation();
  const type = getEventType(item.typeId);
  const color = type?.color ?? FALLBACK_COLOR;
  const tier = inList ? 'A' : tierFor(width);
  const parts = partsOf(item, timezone, tier);
  const extent = extentOf(item, metrics);
  const height = Number.parseFloat(String(style?.height ?? '0'));

  // Name at A and B; at C the value wins, because the badge already said the
  // type and the number did not. The clock never drops: a timeline that has
  // stopped saying when has stopped being a timeline.
  const showName = tier === 'A' || tier === 'B' || (tier === 'C' && parts.figure === null);
  const figureOnTop = tier === 'A' || tier === 'C';
  const secondLine = [
    parts.clock,
    ...(figureOnTop ? [] : [parts.figure]),
    ...(tier === 'A' || tier === 'B' ? [parts.status] : []),
  ].filter((one): one is string => one !== null && one !== '');

  return (
    <Link
      to={linkFor(item, `${location.pathname}${location.search}`)}
      style={{
        ...style,
        // Set once per card; everything below is a mix of it, so a type's
        // colour is named in exactly one place.
        ['--type' as string]: color,
        background: inList
          ? `color-mix(in oklab, var(--type) ${tintOf(item)}%, var(--color-surface-raised))`
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
      {/* The extent, at the card's own left edge and starting at its top.
          Square, and outside nothing: `overflow: visible` above is what
          stops a rounded corner clipping a short range into a speck. */}
      {extent.point ? (
        <span
          aria-hidden
          data-testid="mark"
          data-shape="point"
          className="absolute rounded-full"
          style={{
            left: 2,
            top: -POINT_PX / 2,
            width: POINT_PX,
            height: POINT_PX,
            background: 'var(--type)',
            display: item.carriedOver || inList ? 'none' : undefined,
          }}
        />
      ) : (
        <span
          aria-hidden
          data-testid="mark"
          data-shape="bar"
          className={item.drafted ? 'absolute opacity-70' : 'absolute'}
          style={{
            left: 0,
            top: 0,
            width: STRIPE_WIDTH,
            height: inList ? '100%' : `${extent.px}px`,
            background: 'var(--type)',
          }}
        />
      )}

      {/* The end minute. Absent while a timer runs or a record continues
          past midnight, which is the same open edge as the top. */}
      {!inList && !extent.point && !item.continues && !item.running ? (
        <span
          aria-hidden
          className="absolute right-0 left-0 h-px"
          style={{
            top: `${Math.max(extent.px - 1, 0)}px`,
            background: 'color-mix(in oklab, var(--type) 45%, transparent)',
          }}
        />
      ) : null}

      <span className="flex min-w-0 items-center gap-1">
        <EventIconChip icon={type?.icon ?? 'circle-ellipsis'} color={color} size={20} />
        {showName ? (
          <span className="truncate text-[12px] font-semibold leading-tight">{parts.name}</span>
        ) : null}
        {figureOnTop && parts.figure !== null ? (
          <span
            className="font-numeric ml-auto shrink-0 pl-1 text-[12px] font-semibold"
            style={{ color: 'color-mix(in oklab, var(--type) 70%, var(--color-ink))' }}
          >
            {parts.figure}
          </span>
        ) : null}
        <StateMark item={item} />
      </span>
      <span className="truncate text-[10px] leading-tight text-ink-faint">
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
 */
function Chip({ cluster, timezone, metrics, width, onOpen }: {
  cluster: Cluster;
  timezone: string;
  metrics: Metrics;
  width: number;
  onOpen: () => void;
}): React.JSX.Element {
  const members = cluster.placed.map(({ item }) => item);
  const first = members[0] as TimelineItem;
  const last = members[members.length - 1] as TimelineItem;

  // Distinct types in start order. A type that appears more than once is one
  // badge carrying how many, rather than the same glyph repeated.
  const kinds: { typeId: string; count: number }[] = [];
  for (const item of members) {
    const seen = kinds.find((one) => one.typeId === item.typeId);
    if (seen) seen.count += 1;
    else kinds.push({ typeId: item.typeId, count: 1 });
  }
  const shown = kinds.length > 4 ? kinds.slice(0, 3) : kinds;

  const startOf = (item: TimelineItem): number =>
    item.event?.startedAt ?? item.queued?.input.startedAt ?? 0;
  const range = `${formatClock(startOf(first), timezone)} - ${formatClock(startOf(last), timezone)}`;
  // When outranks how many, so the range is the last thing the width takes.
  const showRange = width >= 64;

  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="crowded"
      style={{
        top: `${minutesToPx(cluster.fromMin, metrics)}px`,
        height: `${Math.max(
          minutesToPx(cluster.toMin - cluster.fromMin, metrics),
          showRange ? CHIP_MIN_HEIGHT : CHIP_MIN_HEIGHT_TERSE,
        )}px`,
        left: 0,
        right: `${GAP}px`,
      }}
      className="absolute flex min-h-11 flex-col justify-start gap-0.5 overflow-hidden rounded-lg border border-line bg-surface py-[5px] pr-1.5 pl-[9px] text-left"
    >
      {/* One segment per member, in start order, in that member's colour. */}
      <span aria-hidden className="absolute top-0 bottom-0 left-0 flex w-[3px] flex-col">
        {members.map((item) => (
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
        {interpolate(zhTW.calendar.crowded, { count: members.length })}
      </span>
      {showRange ? (
        <span className="font-numeric truncate text-[10px] text-ink-faint">{range}</span>
      ) : null}

      {/* Nothing is hidden from a screen reader either. */}
      <span className="sr-only">
        {members.map((item) =>
          `${eventTypeName(item.typeId)} ${formatClock(startOf(item), timezone)}`).join(', ')}
      </span>
    </button>
  );
}

/**
 * One stretch of the day, and its cards.
 *
 * Memoised because the clock ticks. `now` moves every second in the store,
 * and without this every card on the day was rebuilt each time -- which on a
 * busy day is the difference between a screen that responds and one that
 * does not.
 *
 * Whether a crowded stretch is open lives in the URL rather than in state
 * here. Opening one, tapping into an event and coming back unmounted this
 * component and lost it, so the list a parent had just opened collapsed
 * under them; in the URL it survives that, and a reload as well.
 */
const ClusterBody = memo(function ClusterBody({ cluster, day, timezone, metrics, bandWidth }: {
  cluster: Cluster;
  /** The date this band is for. Part of what identifies the stretch. */
  day: string;
  timezone: string;
  metrics: Metrics;
  /** How wide this day's band is, in pixels, which decides each card's tier. */
  bandWidth: number;
}): React.JSX.Element {
  const [search, setSearch] = useSearchParams();
  // The day is in the name, not only the minute. Two columns showing two
  // days both have a 09:00, and keyed on the minute alone opening one opened
  // the other and closing either closed both (spec 7.6).
  const id = `${day}@${cluster.fromMin}`;
  const open = search.get('open') === id;

  const setOpen = (wanted: boolean): void => {
    const next = new URLSearchParams(search);
    if (wanted) next.set('open', id);
    else next.delete('open');
    // Replaced, not pushed: opening a list is not a place to go back to.
    setSearch(next, { replace: true });
  };

  // Percentages of the band this day occupies, which the parent positions.
  // One day's band is everything right of the hour labels; two days split
  // that between them, and neither this nor the cards below need to know
  // which it is.
  const place = (placed: Placed): React.CSSProperties => {
    const box = boxOf(placed.item, metrics);
    const { left, width } = columnSpan(placed);
    return {
      top: `${minutesToPx(box.top, metrics)}px`,
      height: `${minutesToPx(box.bottom - box.top, metrics)}px`,
      left: `${left * 100}%`,
      width: `calc(${width * 100}% - ${GAP}px)`,
    };
  };

  /** The same arithmetic in pixels, for deciding how much a card can say. */
  const widthOf = (placed: Placed): number => bandWidth * columnSpan(placed).width - GAP;

  // Past what fits across this band there is no width left for words, so the
  // stretch offers a way in instead -- and every one of them is in it
  // (spec 7.5). How many fit is the screen's to say: half a phone is not the
  // same amount of room as all of it.
  if (cluster.crowded && !open) {
    return (
      <Chip
        cluster={cluster}
        timezone={timezone}
        metrics={metrics}
        width={bandWidth - GAP}
        onOpen={() => setOpen(true)}
      />
    );
  }

  if (cluster.crowded && open) {
    // A list, so its rows carry no time geometry: a row is as tall as its
    // words, and nothing in it is scaled by a duration. Drawing bars in
    // here would say that one of these lasted longer than another because
    // its row happened to be taller, which is not what a row means.
    return (
      <div
        style={{ top: `${minutesToPx(cluster.fromMin, metrics)}px`, left: 0, right: `${GAP}px` }}
        className="absolute z-10 rounded-lg border border-line bg-surface p-1 shadow-lg shadow-black/50"
        data-testid="crowded-open"
      >
        {cluster.placed.map(({ item }) => (
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

  return (
    <>
      {cluster.placed.map((placed) => (
        <Card
          key={placed.item.key}
          item={placed.item}
          timezone={timezone}
          metrics={metrics}
          width={widthOf(placed)}
          style={place(placed)}
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
      {layout.clusters.map((cluster) => (
        <ClusterBody
          key={cluster.key}
          cluster={cluster}
          day={day}
          timezone={timezone}
          metrics={metrics}
          bandWidth={bandWidth}
        />
      ))}

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
