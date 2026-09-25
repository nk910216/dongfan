import { memo } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { eventTypeName, formatValue, getEventType, interpolate, zhTW } from '@dongfan/shared';
import { EventIcon, FALLBACK_COLOR } from './EventIcon.js';
import { formatClock, formatDuration } from '../lib/format.js';
import { linkBack } from '../lib/return-to.js';
import { DEFAULT_METRICS, MINUTES_IN_DAY, boxOf, columnSpan } from '../lib/timeline.js';
import type { Cluster, DayLayout, Metrics, Placed, TimelineItem } from '../lib/timeline.js';

/**
 * A day drawn against a fixed 00:00-24:00 axis (spec 7.5).
 *
 * Every hour is the same height and an empty stretch stays empty. Nothing
 * here compresses a quiet afternoon or stretches a busy hour: the shape of a
 * day -- when the gaps are, how long the night was -- is the thing the page
 * exists to show, and a layout that tidied it away would be a list with
 * gridlines drawn on it.
 *
 * Two measurements per record, kept apart on purpose. The **anchor and the
 * bar** are real: a nap of twenty minutes is twenty minutes of axis. The
 * **card** carrying the words has a minimum height, because a target smaller
 * than a fingertip is no use at three in the morning -- and it is drawn
 * beside the bar rather than as the bar, so its height never reads as a
 * duration.
 */

const HOUR_LABEL_WIDTH = 38;
const RAIL_WIDTH = 6;
/** Taken off the left once, before the columns divide what is left. */
const GUTTER = HOUR_LABEL_WIDTH + RAIL_WIDTH;
/** Between a card and the next column, and the right-hand edge. */
const GAP = 4;

function minutesToPx(minutes: number, metrics: Metrics): number {
  return (minutes / 60) * metrics.hourHeight;
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

function Card({ item, timezone, metrics, style }: {
  item: TimelineItem;
  timezone: string;
  metrics: Metrics;
  style: React.CSSProperties;
}): React.JSX.Element {
  const location = useLocation();
  const type = getEventType(item.typeId);
  const color = type?.color ?? FALLBACK_COLOR;
  const spec = type?.value ?? null;
  const value = item.event?.value ?? item.queued?.input.value ?? null;

  return (
    <Link
      to={linkFor(item, `${location.pathname}${location.search}`)}
      style={style}
      data-testid={`slot-${item.typeId}`}
      data-kind={item.kind}
      aria-label={`${eventTypeName(item.typeId)} ${detailOf(item, timezone)}`}
      className={`absolute flex min-h-11 flex-col justify-center overflow-hidden rounded-lg border px-1.5 py-1 ${
        item.kind === 'queued'
          ? 'border-dashed border-warn/60 bg-warn/10 opacity-90'
          : item.drafted
            ? 'border-dashed border-warn/70 bg-warn/10'
            : 'border-line bg-surface-raised'
      }`}
    >
      <div className="flex items-center gap-1">
        <EventIcon icon={type?.icon ?? 'circle-ellipsis'} color={color} size={13} />
        <span className="truncate text-[12px] font-medium leading-tight">
          {eventTypeName(item.typeId)}
        </span>
        {spec && value !== null ? (
          <span className="font-numeric shrink-0 text-[11px] font-semibold" style={{ color }}>
            {formatValue(value, spec)}
            <span className="text-[9px] text-ink-faint">{spec.unit}</span>
          </span>
        ) : null}
      </div>
      <span className="truncate text-[10px] leading-tight text-ink-faint">
        {detailOf(item, timezone)}
      </span>
      {/* The real extent, alongside the card and never replaced by it. A
          twenty-minute nap is twenty minutes tall here however tall the
          words beside it have to be (spec 7.5). */}
      <span
        aria-hidden
        className="absolute top-0 left-0 w-1 rounded-full"
        style={{
          backgroundColor: color,
          height: item.lengthMin > 0
            ? `${Math.max(minutesToPx(item.lengthMin, metrics), 2)}px`
            : '2px',
        }}
      />
    </Link>
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
const ClusterBody = memo(function ClusterBody({ cluster, timezone, metrics }: {
  cluster: Cluster;
  timezone: string;
  metrics: Metrics;
}): React.JSX.Element {
  const [search, setSearch] = useSearchParams();
  const open = search.get('open') === String(cluster.fromMin);

  const setOpen = (wanted: boolean): void => {
    const next = new URLSearchParams(search);
    if (wanted) next.set('open', String(cluster.fromMin));
    else next.delete('open');
    // Replaced, not pushed: opening a list is not a place to go back to.
    setSearch(next, { replace: true });
  };

  const place = (placed: Placed): React.CSSProperties => {
    const box = boxOf(placed.item, metrics);
    const { left, width } = columnSpan(placed);
    // The gutter comes off once and the columns divide what is left, so the
    // last one ends at the right edge instead of `GUTTER` past it.
    const area = `(100% - ${GUTTER}px)`;
    return {
      top: `${minutesToPx(box.top, metrics)}px`,
      height: `${minutesToPx(box.bottom - box.top, metrics)}px`,
      left: `calc(${GUTTER}px + ${area} * ${left})`,
      width: `calc(${area} * ${width} - ${GAP}px)`,
    };
  };

  // Past three at once there is no width left for words, so the stretch
  // offers a way in instead -- and every one of them is in it (spec 7.5).
  if (cluster.crowded && !open) {
    const first = cluster.placed[0] as Placed;
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="crowded"
        style={{
          top: `${minutesToPx(cluster.fromMin, metrics)}px`,
          height: `${Math.max(minutesToPx(cluster.toMin - cluster.fromMin, metrics), 44)}px`,
          left: `${GUTTER}px`,
          right: `${GAP}px`,
        }}
        className="absolute flex min-h-11 items-center justify-center rounded-lg border border-line bg-surface-raised text-[12px] text-ink-muted"
      >
        {interpolate(zhTW.calendar.crowded, { count: cluster.placed.length })}
        <span className="sr-only">{eventTypeName(first.item.typeId)}</span>
      </button>
    );
  }

  if (cluster.crowded && open) {
    return (
      <div
        style={{ top: `${minutesToPx(cluster.fromMin, metrics)}px`, left: `${GUTTER}px`, right: `${GAP}px` }}
        className="absolute z-10 rounded-lg border border-line bg-surface p-1 shadow-lg shadow-black/50"
        data-testid="crowded-open"
      >
        {cluster.placed.map(({ item }) => (
          <Card
            key={item.key}
            item={item}
            timezone={timezone}
            metrics={metrics}
            style={{ position: 'relative', marginBottom: '4px' }}
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
          style={place(placed)}
        />
      ))}
    </>
  );
});

/** The rules behind everything. They never change, so they are built once. */
const Hours = memo(function Hours({ metrics }: { metrics: Metrics }): React.JSX.Element {
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

export function Timeline({ layout, timezone, nowMinutes, metrics = DEFAULT_METRICS }: {
  layout: DayLayout;
  timezone: string;
  /** Minutes into this day, or null when the day is not today. */
  nowMinutes: number | null;
  metrics?: Metrics;
}): React.JSX.Element {
  return (
    <div>
      {/* Events with no time of day at all head the day rather than sitting
          at midnight under the night feeds (spec 3.9). */}
      {layout.allDay.length > 0 ? (
        <div className="mb-1 flex gap-1 border-b border-line px-2 py-1.5" data-testid="all-day">
          <span className="w-8 shrink-0 pt-1 text-[10px] text-ink-dim">{zhTW.calendar.allDay}</span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {layout.allDay.map((item) => (
              <Card
                key={item.key}
                item={item}
                timezone={timezone}
                metrics={metrics}
                style={{ position: 'relative' }}
              />
            ))}
          </div>
        </div>
      ) : null}

      <div
        className="relative"
        style={{ height: `${minutesToPx(MINUTES_IN_DAY, metrics)}px` }}
        data-testid="timeline"
      >
        <Hours metrics={metrics} />

        {layout.clusters.map((cluster) => (
          <ClusterBody key={cluster.key} cluster={cluster} timezone={timezone} metrics={metrics} />
        ))}

        {/* Only on today, and from the baby's clock rather than the
            device's (spec 3.4). */}
        {nowMinutes !== null ? (
          <div
            className="pointer-events-none absolute right-0 left-9 flex items-center"
            style={{ top: `${minutesToPx(nowMinutes, metrics)}px` }}
            data-testid="now-line"
          >
            <span className="size-1.5 shrink-0 rounded-full bg-accent" />
            <span className="h-px flex-1 bg-accent/70" />
          </div>
        ) : null}
      </div>
    </div>
  );
}
