import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { isRealLocalDate, startOfLocalDay, toLocalDate, zhTW } from '@dongfan/shared';
import { EmptyDay } from '../components/EventRow.js';
import { PageMenu } from '../components/PageMenu.js';
import { SyncState } from '../components/SyncState.js';
import { Timeline } from '../components/Timeline.js';
import { calendarDay } from '../lib/db.js';
import type { DayEntry } from '../lib/db.js';
import { DEFAULT_METRICS, MINUTES_IN_DAY, itemsFor, layOut, openingMinute } from '../lib/timeline.js';
import { useStore } from '../lib/store.js';

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
export function Calendar(): React.JSX.Element {
  const { baby, scope, now, events, unsynced, stopDrafts } = useStore();
  const params = useParams();
  const navigate = useNavigate();

  const today = toLocalDate(now, baby.timezone);
  const asked = params['date'];
  const date = asked ?? today;
  const isToday = date === today;

  /**
   * What was read, and **which day it was read for**.
   *
   * The day travels with the rows because the read is asynchronous: for a
   * moment after the date changes, the previous day's events are still in
   * hand. Laying those out under the new date drew the wrong day, and the
   * scroll below then positioned against them and marked the new date as
   * done -- so when the right rows arrived, nothing moved.
   */
  const [loaded, setLoaded] = useState<{ date: string; rows: DayEntry[] } | null>(null);
  const entries = loaded !== null && loaded.date === date ? loaded.rows : null;
  const scroller = useRef<HTMLDivElement | null>(null);
  /**
   * Which day has already been scrolled into place.
   *
   * Once per day looked at, and never again. Spec 7.5 is explicit that a
   * background sync or the clock ticking must not keep taking the scroll
   * position back: somebody reading last night's feeds at 3am would find the
   * page snapping to the current hour under their thumb.
   */
  const placed = useRef<string | null>(null);

  useEffect(() => {
    if (!isRealLocalDate(date)) return;

    let cancelled = false;
    void calendarDay(scope, date, baby.timezone).then((rows) => {
      if (!cancelled) setLoaded({ date, rows });
    });
    return () => {
      cancelled = true;
    };
    // `events` is not read here: it is the signal that the store has been
    // filled again, which is when this day may have changed. Watching the
    // store's own state rather than re-syncing keeps this screen a reader.
  }, [scope, date, baby.timezone, events, unsynced, stopDrafts]);

  const layout = useMemo(
    () => layOut(itemsFor(entries ?? [], unsynced, stopDrafts, isRealLocalDate(date) ? date : today, baby.timezone)),
    [entries, unsynced, stopDrafts, date, today, baby.timezone],
  );

  /** Minutes into the day, from the baby's clock. Null on any other day. */
  const nowMinutes = isToday
    ? Math.min((now - startOfLocalDay(today, baby.timezone)) / 60_000, MINUTES_IN_DAY)
    : null;

  useEffect(() => {
    // `entries` is null until the rows for *this* date have arrived, so this
    // never positions against the day before's.
    if (entries === null || placed.current === date) return;
    const element = scroller.current;
    if (!element) return;

    const target = openingMinute(isToday, nowMinutes, layout);
    placed.current = date;
    if (target === null) return;

    element.scrollTop = Math.max((target / 60) * DEFAULT_METRICS.hourHeight - 80, 0);
    // `nowMinutes` deliberately absent: it changes every second, and this
    // must happen once per day looked at, not every tick (spec 7.5).
  }, [entries, date, isToday, layout]);

  // A date typed into the address bar, or one left behind by an older build.
  if (!isRealLocalDate(date)) return <Navigate to="/day" replace />;

  const nothing = entries !== null
    && layout.allDay.length === 0
    && layout.clusters.length === 0;

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

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto pb-24" data-testid="day-scroller">
        {nothing ? (
          <div className="px-3.5 pt-2">
            <EmptyDay title={zhTW.calendar.empty} />
          </div>
        ) : null}
        <Timeline layout={layout} timezone={baby.timezone} nowMinutes={nowMinutes} />
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
