import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { isRealLocalDate, toLocalDate, zhTW } from '@dongfan/shared';
import { EmptyDay, EventRow, WaitingRow } from '../components/EventRow.js';
import { PageMenu } from '../components/PageMenu.js';
import { calendarDay } from '../lib/db.js';
import type { DayEntry } from '../lib/db.js';
import { draftFor, useStore } from '../lib/store.js';

/**
 * One day, looked back at (spec 7.5).
 *
 * Read out of IndexedDB rather than fetched. A day already on the device
 * has to open with no network, and the events are all here anyway
 * (spec 6.2) -- going to the server for a screen whose data is already
 * local would make looking back the one thing the app cannot do on a
 * train.
 *
 * `/day` and `/day/2026-09-20` mean different things on purpose. Without a
 * date it is "today", and stays today when the clock passes midnight under
 * a phone left on a bedside table; with one it is that day and does not
 * move. So "back to today" goes to `/day` rather than to today's date.
 */
export function Calendar(): React.JSX.Element {
  const { baby, scope, now, events, unsynced, stopDrafts } = useStore();
  const params = useParams();
  const navigate = useNavigate();

  const today = toLocalDate(now, baby.timezone);
  const asked = params['date'];
  const date = asked ?? today;

  const [entries, setEntries] = useState<DayEntry[] | null>(null);

  useEffect(() => {
    if (!isRealLocalDate(date)) return;

    let cancelled = false;
    void calendarDay(scope, date, baby.timezone).then((rows) => {
      if (!cancelled) setEntries(rows);
    });
    return () => {
      cancelled = true;
    };
    // `events` is not read here: it is the signal that the store has been
    // filled again, which is when this day may have changed. Watching the
    // store's own state rather than re-syncing keeps this screen a reader.
  }, [scope, date, baby.timezone, events, unsynced, stopDrafts]);

  /**
   * The waiting records that belong to this day.
   *
   * Same rule as the home screen: a record the parent made and cannot see
   * gets made again (spec 6.2). Counted by the day it starts on, because
   * that is the day the server will file it under.
   */
  const waiting = useMemo(() => {
    const known = new Set((entries ?? []).map((entry) => entry.event.id));
    return unsynced.filter(
      (entry) =>
        !known.has(entry.eventId) &&
        toLocalDate(entry.input.startedAt, baby.timezone) === date,
    );
  }, [unsynced, entries, baby.timezone, date]);

  // A date typed into the address bar, or one left behind by an older
  // build. Today is the honest fallback, and it is one the screen can
  // always show.
  if (!isRealLocalDate(date)) return <Navigate to="/day" replace />;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-1 px-2 pt-2.5 pb-1.5">
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

        {date === today && asked === undefined ? (
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
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 pb-24">
        {entries !== null && entries.length === 0 && waiting.length === 0 ? (
          <EmptyDay title={zhTW.calendar.empty} />
        ) : (
          <>
            {waiting.map((entry) => (
              <WaitingRow key={entry.eventId} entry={entry} timezone={baby.timezone} />
            ))}
            {(entries ?? []).map(({ event, carriedOver, msOnDay }) => (
              <EventRow
                key={event.id}
                event={event}
                timezone={baby.timezone}
                drafted={draftFor(stopDrafts, event.id) !== null}
                carriedOver={carriedOver}
                msOnDay={msOnDay}
              />
            ))}
          </>
        )}
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
