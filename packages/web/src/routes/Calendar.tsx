import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { isRealLocalDate, startOfLocalDay, toLocalDate, zhTW } from '@dongfan/shared';
import { EmptyDay } from '../components/EventRow.js';
import { PageMenu } from '../components/PageMenu.js';
import { SyncState } from '../components/SyncState.js';
import { TIMELINE_GUTTER, Timeline } from '../components/Timeline.js';
import { calendarDay } from '../lib/db.js';
import type { DayEntry, StopDraft } from '../lib/db.js';
import { DEFAULT_METRICS, MINUTES_IN_DAY, itemsFor, layOut, openingMinute } from '../lib/timeline.js';
import { useStore } from '../lib/store.js';
import { useViewportWidth } from '../lib/viewport.js';

/**
 * One day, on a fixed 00:00-24:00 axis (spec 7.5).
 *
 * Read out of IndexedDB rather than fetched. A day already on the device has
 * to open with no network, and the events are all here anyway (spec 6.2) --
 * going to the server for a screen whose data is already local would make
 * looking back the one thing the app cannot do on a train. The layout adds
 * no request of its own and recomputes no summary or statistic from what it
 * draws.
 *
 * `/day` and `/day/2026-09-20` mean different things on purpose. Without a
 * date it is "today", and stays today when the clock passes midnight under a
 * phone left on a bedside table; with one it is that day and does not move.
 * So "back to today" goes to `/day` rather than to today's date.
 */

/**
 * Where each day was last left, for as long as the app is open.
 *
 * Module state rather than a ref, because the point is to survive this
 * screen being unmounted: tapping a record navigates away, and coming back
 * to the morning's first feed when you were reading last night is the whole
 * complaint. Not persisted -- a reload is a fresh look at the day, and the
 * default positioning is right for that.
 */
const remember = new Map<string, number>();

/** For tests, which share a module registry between them. */
export function forgetScrollPositions(): void {
  remember.clear();
}

/**
 * One day's rows, and the day they were read for.
 *
 * The day travels with them because the read is asynchronous: for a moment
 * after the date changes the previous day's events are still in hand. Laying
 * those out under the new date drew the wrong day, and positioning against
 * them marked the new date as done, so the right rows arrived to a page that
 * had stopped listening.
 *
 * Shared by both calendar screens, so the two-day view cannot end up with a
 * second idea of what a day contains.
 */
export function useDay(date: string, drafts: readonly StopDraft[]): DayEntry[] | null {
  const { scope, baby, events, unsynced } = useStore();
  const [loaded, setLoaded] = useState<{ date: string; rows: DayEntry[] } | null>(null);

  useEffect(() => {
    if (!isRealLocalDate(date)) return;

    let cancelled = false;
    // The drafts go in, so a timer stopped here at 07:00 after a night that
    // began at 23:00 is known to cover this morning (spec 7.2).
    void calendarDay(scope, date, baby.timezone, drafts).then((rows) => {
      if (!cancelled) setLoaded({ date, rows });
    });
    return () => {
      cancelled = true;
    };
    // `events` is not read here: it is the signal that the store has been
    // filled again, which is when this day may have changed. Watching the
    // store's own state rather than re-syncing keeps this screen a reader.
  }, [scope, date, baby.timezone, events, unsynced, drafts]);

  return loaded !== null && loaded.date === date ? loaded.rows : null;
}

/** Remembers where a day was left, and puts it back there. */
export function useDayScroll(date: string, ready: boolean, decide: () => number | null): {
  scroller: React.RefObject<HTMLDivElement | null>;
  onScroll: (event: React.UIEvent<HTMLDivElement>) => void;
} {
  const { scope } = useStore();
  const scroller = useRef<HTMLDivElement | null>(null);
  /**
   * Which day has already been scrolled into place *this time round*.
   *
   * Once per day looked at, and never again while it is open. Spec 7.5 is
   * explicit that a background sync or the clock ticking must not keep
   * taking the scroll position back: somebody reading last night's feeds at
   * 3am would find the page snapping to the current hour under their thumb.
   */
  const placed = useRef<string | null>(null);

  useEffect(() => {
    if (!ready || placed.current === date) return;
    const element = scroller.current;
    if (!element) return;

    placed.current = date;

    // Where this day was left, if it has been read before. Tapping a record
    // and coming back is not a first visit: re-deciding would drop somebody
    // reading last night's cluster back at the morning's first feed, with
    // the list they had opened still open, somewhere off the screen.
    const remembered = remember.get(`${scope}\u0000${date}`);
    if (remembered !== undefined) {
      element.scrollTop = remembered;
      return;
    }

    const target = decide();
    element.scrollTop = target === null
      ? 0
      : Math.max((target / 60) * DEFAULT_METRICS.hourHeight - 80, 0);
    // `decide` is read once per day looked at, deliberately: it closes over
    // the clock, which moves.
  }, [ready, date, scope]);

  return {
    scroller,
    onScroll: (event) => remember.set(`${scope}\u0000${date}`, event.currentTarget.scrollTop),
  };
}

export function Calendar(): React.JSX.Element {
  const { baby, now, unsynced, stopDrafts } = useStore();
  const params = useParams();
  const navigate = useNavigate();

  const today = toLocalDate(now, baby.timezone);
  const asked = params['date'];
  const date = asked ?? today;
  const isToday = date === today;

  const entries = useDay(date, stopDrafts);

  // One day owns everything right of the hour labels. That width decides how
  // much each card can say and whether an hour has to be collapsed at all,
  // so it is measured rather than assumed (spec 7.5).
  const bandWidth = useViewportWidth() - TIMELINE_GUTTER;

  const layout = useMemo(
    () => layOut(
      itemsFor(entries ?? [], unsynced, stopDrafts, isRealLocalDate(date) ? date : today, baby.timezone),
      DEFAULT_METRICS,
      bandWidth,
    ),
    [entries, unsynced, stopDrafts, date, today, baby.timezone, bandWidth],
  );

  /**
   * Minutes into the day, from the baby's clock. Null on any other day.
   *
   * Whole minutes, so this changes once a minute rather than once a second.
   * The store's clock ticks every second, and a value that moved with it
   * re-rendered every card on the day sixty times a minute for a line that
   * cannot move by less than a pixel in that time.
   */
  const nowMinutes = isToday
    ? Math.min(Math.floor((now - startOfLocalDay(today, baby.timezone)) / 60_000), MINUTES_IN_DAY)
    : null;

  const { scroller, onScroll } = useDayScroll(
    date,
    entries !== null,
    // Today near the current hour, another day on its first record, and a
    // day with nothing on the hour axis -- empty, or only a milestone in the
    // band above -- at the top.
    () => openingMinute(isToday, nowMinutes, layout),
  );

  // A date typed into the address bar, or one left behind by an older build.
  if (!isRealLocalDate(date)) return <Navigate to="/day" replace />;

  const nothing = entries !== null
    && layout.allDay.length === 0
    && layout.spans.length === 0
    && layout.pins.length === 0
    && layout.chips.length === 0;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex shrink-0 flex-col px-2 pt-2.5 pb-1.5">
        <div className="flex items-center gap-1">
          <PageMenu />

          {/* The date is the control. A native date input is the sliding
              year/month/day picker spec 7.5 asks for on a phone, and it is
              the one a parent already knows how to use. */}
          <input
            type="date"
            aria-label={zhTW.calendar.date}
            data-testid="calendar-date"
            value={date}
            onChange={(e) => {
              // Navigated rather than held in state, so the day being looked
              // at survives a reload and can be shared. Replaced rather than
              // pushed: spinning the wheel fires this for every day it
              // passes, and Back should return to where the parent came
              // from, not step through the dates they scrolled over.
              const picked = e.target.value;
              if (isRealLocalDate(picked)) navigate(`/day/${picked}`, { replace: true });
            }}
            className="min-h-11 flex-1 bg-transparent text-center font-numeric text-base outline-none"
          />

          {isToday && asked === undefined ? (
            <span className="size-11" />
          ) : (
            <Link
              to="/day"
              data-testid="back-to-today"
              className="flex min-h-11 items-center px-2 text-[13px] text-accent"
            >
              {zhTW.calendar.today}
            </Link>
          )}
        </div>

        {/* Spec 6.1 asks for a manual sync here as well as on the home
            screen. Sitting on last Tuesday while the other parent adds
            something to it is exactly the case the automatic pulls miss. */}
        <div className="flex justify-center">
          <SyncState now={now} />
        </div>
      </header>

      <div
        ref={scroller}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto pb-24"
        data-testid="day-scroller"
      >
        {nothing ? (
          <div className="px-3.5 pt-2">
            <EmptyDay title={zhTW.calendar.empty} />
          </div>
        ) : null}
        <Timeline
          layout={layout}
          day={date}
          timezone={baby.timezone}
          nowMinutes={nowMinutes}
          bandWidth={bandWidth}
        />
      </div>

      {/* Adds to the day being looked at, not to today. Carried in the URL
          rather than in router state, because a reload must not silently
          turn a record for the 18th into a record for now (spec 2.1). */}
      <Link
        to={`/add?on=${date}`}
        aria-label={zhTW.a11y.addEvent}
        className="absolute right-4.5 bottom-6 flex size-15 items-center justify-center rounded-full bg-accent shadow-lg shadow-black/50"
      >
        <Plus size={26} className="text-ground" strokeWidth={2.6} />
      </Link>
    </div>
  );
}
