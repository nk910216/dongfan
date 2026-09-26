import { useMemo, useRef } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import {
  addLocalDays, isRealLocalDate, startOfLocalDay, toLocalDate, zhTW,
} from '@dongfan/shared';
import { AllDayBand, DayBand, Hours, TIMELINE_GUTTER } from '../components/Timeline.js';
import { PageMenu } from '../components/PageMenu.js';
import { SyncState } from '../components/SyncState.js';
import { DEFAULT_METRICS, MINUTES_IN_DAY, itemsFor, layOut, openingMinute } from '../lib/timeline.js';
import type { DayLayout } from '../lib/timeline.js';
import { addQuery } from '../lib/dated-add.js';
import { useDay, useDayScroll } from './Calendar.js';
import { useStore } from '../lib/store.js';
import { useMeasuredWidth } from '../lib/viewport.js';

/**
 * Two days side by side, on one set of hours (spec 7.6).
 *
 * The point is comparison: yesterday's night against tonight's, this
 * afternoon's naps against yesterday's. That only works if the two columns
 * share an hour scale, so there is **one** axis of hour labels and the days
 * are two bands drawn over it at the same `hourHeight`. Everything about how
 * a record is placed, sized, overlapped or opened comes from the single-day
 * timeline unchanged.
 *
 * The chosen date is the **right-hand** column and the day before it is on
 * the left, oldest first, which is the order spec 7.6 asks for and the order
 * a night reads in: it begins on the left and ends on the right.
 */
export function TwoDays(): React.JSX.Element {
  const { baby, now, unsynced, stopDrafts } = useStore();
  const params = useParams();
  const navigate = useNavigate();
  const location = useLocation();

  const today = toLocalDate(now, baby.timezone);
  const asked = params['date'];
  const date = isRealLocalDate(asked ?? today) ? (asked ?? today) : today;
  const earlier = addLocalDays(date, -1);
  const isToday = date === today;

  const leftRows = useDay(earlier, stopDrafts);
  const rightRows = useDay(date, stopDrafts);

  /**
   * Half a phone is not the same amount of room as all of it.
   *
   * Two days divide what one day had, so the single-day ceiling of three
   * side by side puts one clipped character where a type name should be --
   * which is the state spec 7.5 says to offer an "N of them" entry for
   * rather than to draw (spec 7.6).
   */
  // Measured off the element rather than taken from the window: the shell
  // is capped at `max-w-md`, so at a 1024px window this believed each
  // column had 490px when it had about 202 -- and the reserve, the number
  // of columns and which words to drop were all decided on that number.
  const measure = useRef<HTMLDivElement | null>(null);
  const bandWidth = Math.max((useMeasuredWidth(measure) - TIMELINE_GUTTER) / 2, 0);

  const left = useMemo<DayLayout>(
    () => layOut(
      itemsFor(leftRows ?? [], unsynced, stopDrafts, earlier, baby.timezone),
      DEFAULT_METRICS,
      bandWidth,
    ),
    [leftRows, unsynced, stopDrafts, earlier, baby.timezone, bandWidth],
  );
  const right = useMemo<DayLayout>(
    () => layOut(
      itemsFor(rightRows ?? [], unsynced, stopDrafts, date, baby.timezone),
      DEFAULT_METRICS,
      bandWidth,
    ),
    [rightRows, unsynced, stopDrafts, date, baby.timezone, bandWidth],
  );

  /** Whole minutes, so the clock ticking does not rebuild both days. */
  const nowMinutes = isToday
    ? Math.min(Math.floor((now - startOfLocalDay(today, baby.timezone)) / 60_000), MINUTES_IN_DAY)
    : null;

  const { scroller, onScroll } = useDayScroll(
    `two:${date}`,
    leftRows !== null && rightRows !== null,
    // Today near the current hour; otherwise the earliest record of either
    // column, because a pair of days opens where the pair begins.
    () => {
      const here = openingMinute(isToday, nowMinutes, right);
      const there = openingMinute(false, null, left);
      if (here === null) return there;
      if (there === null) return here;
      return isToday ? here : Math.min(here, there);
    },
  );

  if (asked !== undefined && !isRealLocalDate(asked)) return <Navigate to="/two" replace />;

  const column = `calc((100% - ${TIMELINE_GUTTER}px) / 2)`;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex shrink-0 flex-col px-2 pt-2.5 pb-1.5">
        <div className="flex items-center gap-1">
          <PageMenu />
          <input
            type="date"
            aria-label={zhTW.calendar.date}
            data-testid="calendar-date"
            value={date}
            onChange={(e) => {
              const picked = e.target.value;
              if (isRealLocalDate(picked)) navigate(`/two/${picked}`, { replace: true });
            }}
            className="min-h-11 flex-1 bg-transparent text-center font-numeric text-base outline-none"
          />
          {isToday && asked === undefined ? (
            <span className="size-11" />
          ) : (
            <Link
              to="/two"
              data-testid="back-to-today"
              className="flex min-h-11 items-center px-2 text-[13px] text-accent"
            >
              {zhTW.calendar.today}
            </Link>
          )}
        </div>
        <div className="flex justify-center">
          <SyncState now={now} />
        </div>
      </header>

      {/* One row of headings, lined up with the two bands below, so it is
          never in doubt which column is which day. */}
      <div className="flex shrink-0 border-b border-line px-2 pb-1 text-center">
        <span className="shrink-0" style={{ width: `${TIMELINE_GUTTER}px` }} />
        <span className="font-numeric text-[11px] text-ink-faint" style={{ width: column }} data-testid="column-earlier">
          {earlier}
        </span>
        <span className="font-numeric text-[11px] text-ink" style={{ width: column }} data-testid="column-later">
          {date}
        </span>
      </div>

      <div
        ref={(node) => {
          scroller.current = node;
          measure.current = node;
        }}
        onScroll={onScroll}
        // Never sideways. The axis scrolls up and down and nothing else: a
        // card placed past the right-hand edge turned a phone into a screen
        // that had to be swiped to be read, and a clip here means a
        // mistake in the arithmetic shows up as a truncated card rather
        // than as half the day being off-screen.
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-24"
        data-testid="day-scroller"
      >
        {/* Each column has its own all-day band, because an all-day record
            belongs to one of the two days and not to the pair (spec 7.6). */}
        {left.allDay.length > 0 || right.allDay.length > 0 ? (
          <div className="mb-1 flex gap-1 border-b border-line px-2 py-1.5">
            <span className="shrink-0 pt-1 text-[10px] text-ink-dim" style={{ width: `${TIMELINE_GUTTER}px` }}>
              {zhTW.calendar.allDay}
            </span>
            <AllDayBand
              items={left.allDay}
              timezone={baby.timezone}
              metrics={DEFAULT_METRICS}
              bandWidth={bandWidth}
              label=""
            />
            <AllDayBand
              items={right.allDay}
              timezone={baby.timezone}
              metrics={DEFAULT_METRICS}
              bandWidth={bandWidth}
              label=""
            />
          </div>
        ) : null}

        <div
          className="relative"
          style={{ height: `${(MINUTES_IN_DAY / 60) * DEFAULT_METRICS.hourHeight}px` }}
          data-testid="timeline"
        >
          {/* Drawn once. Two columns on two scales would be two charts side
              by side rather than a comparison. */}
          <Hours metrics={DEFAULT_METRICS} />

          {/* A line between the two columns. Without it a card at the right
              edge of one day abuts a card at the left edge of the other with
              nothing to say they belong to different days. Drawn rather than
              spaced, so it takes no width from either band. */}
          <div
            aria-hidden
            className="absolute top-0 bottom-0 w-px bg-line-soft"
            style={{ left: `calc(${TIMELINE_GUTTER}px + ${column})` }}
          />

          <DayBand
            layout={left}
            day={earlier}
            timezone={baby.timezone}
            metrics={DEFAULT_METRICS}
            nowMinutes={null}
            bandWidth={bandWidth}
            style={{ left: `${TIMELINE_GUTTER}px`, width: column }}
          />
          <DayBand
            layout={right}
            day={date}
            timezone={baby.timezone}
            metrics={DEFAULT_METRICS}
            nowMinutes={nowMinutes}
            bandWidth={bandWidth}
            style={{ left: `calc(${TIMELINE_GUTTER}px + ${column})`, width: column }}
          />
        </div>
      </div>

      {/* Files under the later day, which is the one the date control names
          and the one somebody is most likely adding to (spec 7.3) -- and says
          where it came from, so saving comes back here rather than to the
          single-day view. */}
      <Link
        to={`/add${addQuery(date, `${location.pathname}${location.search}`)}`}
        aria-label={zhTW.a11y.addEvent}
        className="absolute right-4.5 bottom-6 flex size-15 items-center justify-center rounded-full bg-accent shadow-lg shadow-black/50"
      >
        <Plus size={26} className="text-ground" strokeWidth={2.6} />
      </Link>
    </div>
  );
}
