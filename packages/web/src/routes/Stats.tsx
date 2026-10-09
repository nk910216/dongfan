import { useEffect, useMemo, useState } from 'react';
import {
  CATEGORY_IDS, categoryName, eventTypeName, eventTypesInCategory, formatValue, getEventType,
  interpolate, isRealLocalDate, splitDuration, zhTW,
} from '@dongfan/shared';
import type { EventTypeConfig, StatSeriesDto } from '@dongfan/shared';
import { Chart } from '../components/Chart.js';
import { ErrorLine, describeFailure } from '../components/FieldErrors.js';
import { PageMenu } from '../components/PageMenu.js';
import { SyncState } from '../components/SyncState.js';
import { RANGES, startEndingToday, windowFor } from '../lib/stats-range.js';
import type { Range } from '../lib/stats-range.js';
import { useStore } from '../lib/store.js';

/**
 * Looking back at one type over time (spec 7.7).
 *
 * The figures come from `GET /stats` and are never computed here. A year is
 * thousands of events; the device holds only what it has synced, so a chart
 * built locally would be short by whatever has not arrived while looking
 * complete, and it would disagree with the same chart on the other parent's
 * phone (spec 5.6, 6.2).
 *
 * Which means this screen needs a connection, and says so when it has none
 * rather than drawing an empty chart -- an empty chart is a claim.
 */

/**
 * Every type, grouped the way the add screen groups them.
 *
 * All of them, because every entry in the config carries an aggregation and
 * so has something to plot -- and because a list that quietly left some out
 * would be a second place deciding what is worth recording.
 */
function typesByCategory(): { category: string; types: EventTypeConfig[] }[] {
  return CATEGORY_IDS
    .map((category) => ({ category, types: eventTypesInCategory(category) }))
    .filter((group) => group.types.length > 0);
}

const RANGE_LABEL: Record<Range, string> = {
  week: zhTW.stats.week,
  month: zhTW.stats.month,
  halfYear: zhTW.stats.halfYear,
  year: zhTW.stats.year,
};

export function Stats(): React.JSX.Element {
  const { baby, now, unsynced, syncedAt, events, loadStats } = useStore();

  const [typeId, setTypeId] = useState('bottle');
  const [range, setRange] = useState<Range>('week');
  const [kind, setKind] = useState<'bar' | 'line'>('bar');
  const [start, setStart] = useState(() => startEndingToday('week', now, baby.timezone));

  const [series, setSeries] = useState<StatSeriesDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  /** Bumped to ask again after a failure, since nothing else has changed. */
  const [attempt, setAttempt] = useState(0);

  const type = getEventType(typeId);
  const { from, to } = useMemo(() => windowFor(range, start), [range, start]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailure(null);

    loadStats([typeId], from, to)
      .then((body) => {
        if (cancelled) return;
        setSeries(body.series[0] ?? null);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // The series is deliberately left alone. Nothing can show it: the
        // render checks `loading` and then `failure` before it reaches the
        // points, and the next attempt sets both before this one is
        // replaced. Clearing it here was dead code that read like a guard.
        setFailure(describeFailure(error));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // `syncedAt` and `events` are not read in here. They are the signal that
    // the store has caught up or that something local has changed, and the
    // figures are the server's -- so a sync that brought in the other
    // parent's feeds, or a queued record that has just been sent, changes
    // this chart. Without them the header could say "just synced" with the
    // unsynced notice gone while the chart was still missing the record it
    // was about (spec 6.1).
  }, [loadStats, typeId, from, to, syncedAt, events, attempt]);

  /**
   * Records this device is still holding.
   *
   * The figures are the server's, so anything waiting to be sent is missing
   * from them. Saying so is the difference between a chart that is behind
   * and a chart that is wrong (spec 7.7, 6.2).
   */
  const waiting = unsynced.length;

  const points = series?.points ?? [];
  const total = points.reduce((sum, point) => sum + point.value, 0);

  /** Stored integers into something readable, by the type's own rules. */
  const format = (value: number): string => {
    if (series?.aggregation === 'duration_sum') {
      const { hours, minutes } = splitDuration(value * 60_000);
      return hours === 0
        ? interpolate(zhTW.stats.minutesOnly, { minutes })
        : interpolate(zhTW.stats.hoursMinutes, { hours, minutes });
    }
    if (type?.value) return `${formatValue(value, type.value)}${type.value.unit}`;
    return interpolate(zhTW.stats.times, { count: value });
  };

  /** Adding up a weight or a temperature is meaningless; a total is not. */
  const totalsMakeSense = series !== null
    && ['count', 'sum', 'duration_sum'].includes(series.aggregation);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex shrink-0 flex-col px-2 pt-2.5 pb-1.5">
        <div className="flex items-center gap-1">
          <PageMenu />
          <span className="flex-1 text-center text-base font-medium">{zhTW.stats.title}</span>
          <span className="size-11" />
        </div>
        <div className="flex justify-center">
          <SyncState now={now} />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto pb-8">
        <label className="mb-3 block px-3.5">
          <span className="mb-1.5 block text-xs tracking-wide text-ink-faint">{zhTW.stats.type}</span>
          <select
            aria-label={zhTW.stats.type}
            data-testid="stats-type"
            value={typeId}
            onChange={(e) => setTypeId(e.target.value)}
            className="w-full rounded-xl border border-line bg-surface px-4 py-3 text-base outline-none"
          >
            {typesByCategory().map(({ category, types }) => (
              <optgroup key={category} label={categoryName(category)}>
                {types.map((option) => (
                  <option key={option.id} value={option.id}>{eventTypeName(option.id)}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        <div className="mb-3 flex gap-1 px-3.5" role="group" aria-label={zhTW.stats.range}>
          {RANGES.map((option) => (
            <button
              key={option}
              type="button"
              data-testid={`range-${option}`}
              aria-pressed={range === option}
              onClick={() => {
                setRange(option);
                // The window moves with the range, so switching from a week
                // to a year does not leave the year starting last Monday.
                setStart(startEndingToday(option, now, baby.timezone));
              }}
              className={`min-h-11 flex-1 rounded-xl border text-[13px] ${
                range === option
                  ? 'border-accent bg-accent/15 text-accent'
                  : 'border-line text-ink-muted'
              }`}
            >
              {RANGE_LABEL[option]}
            </button>
          ))}
        </div>

        <div className="mb-3 flex items-end gap-2 px-3.5">
          <label className="min-w-0 flex-1">
            <span className="mb-1.5 block text-xs tracking-wide text-ink-faint">{zhTW.stats.start}</span>
            <input
              type="date"
              aria-label={zhTW.stats.start}
              data-testid="stats-start"
              value={start}
              onChange={(e) => {
                if (isRealLocalDate(e.target.value)) setStart(e.target.value);
              }}
              className="block min-h-11 w-full rounded-xl border border-line bg-surface px-4 py-3 font-numeric text-base outline-none"
            />
          </label>
          <div className="flex gap-1" role="group" aria-label={zhTW.stats.chart}>
            {(['bar', 'line'] as const).map((option) => (
              <button
                key={option}
                type="button"
                data-testid={`kind-${option}`}
                aria-pressed={kind === option}
                onClick={() => setKind(option)}
                className={`min-h-11 rounded-xl border px-3 text-[13px] ${
                  kind === option
                    ? 'border-accent bg-accent/15 text-accent'
                    : 'border-line text-ink-muted'
                }`}
              >
                {option === 'bar' ? zhTW.stats.bar : zhTW.stats.line}
              </button>
            ))}
          </div>
        </div>

        {/* The window, written out. The buttons say how many days, but
            which days is what somebody needs to read a chart -- and a range
            that quietly ran two days into March is invisible without it. */}
        <p className="mb-3 px-4.5 font-numeric text-[11px] text-ink-faint" data-testid="stats-window">
          {interpolate(zhTW.stats.showing, { from, to })}
        </p>

        {loading ? (
          <p className="px-3.5 text-sm text-ink-dim" data-testid="stats-loading">{zhTW.app.loading}</p>
        ) : failure !== null ? (
          <div className="px-3.5" data-testid="stats-failed">
            <ErrorLine failure={failure} />
            <p className="text-sm text-ink-muted">{zhTW.stats.failed}</p>
            {/* Its own button. Pressing sync only asks again if the sync
                itself succeeds, and the first thing that fails here is
                usually the connection. */}
            <button
              type="button"
              data-testid="stats-retry"
              onClick={() => setAttempt((n) => n + 1)}
              className="mt-2 min-h-11 rounded-xl border border-line px-4 text-sm text-accent"
            >
              {zhTW.stats.retry}
            </button>
          </div>
        ) : points.length === 0 ? (
          <p className="px-3.5 text-sm text-ink-dim" data-testid="stats-empty">{zhTW.stats.empty}</p>
        ) : (
          <>
            <Chart
              points={points}
              range={range}
              start={start}
              kind={kind}
              color={type?.color ?? '#e8b15c'}
              format={format}
            />

            {totalsMakeSense ? (
              <div className="mx-3.5 mt-3 flex gap-6 px-1" data-testid="stats-totals">
                <div>
                  <span className="block text-[11px] text-ink-faint">{zhTW.stats.total}</span>
                  <span className="font-numeric text-[17px] font-semibold text-ink">{format(total)}</span>
                </div>
                <div>
                  <span className="block text-[11px] text-ink-faint">{zhTW.stats.average}</span>
                  <span className="font-numeric text-[17px] font-semibold text-ink">
                    {format(Math.round(total / points.length))}
                  </span>
                </div>
              </div>
            ) : null}

            {/* A timer still running has no length yet, so today looks
                short for a reason nobody can see (spec 7.7). Only where
                there is a chart to qualify. */}
            {type?.hasRange ? (
              <p className="mt-3 px-4.5 text-[11px] text-ink-dim" data-testid="finished-only">
                {zhTW.stats.finishedOnly}
              </p>
            ) : null}
          </>
        )}

        {/* Outside all of that, on purpose. "No records" plus a record
            waiting on this phone is exactly when the reason matters most,
            and it was the one case where this was hidden (spec 6.2). */}
        {!loading && failure === null && waiting > 0 ? (
          <p className="mt-3 px-4.5 text-[11px] text-warn-soft" data-testid="stats-unsynced">
            {interpolate(zhTW.stats.unsynced, { count: waiting })}
          </p>
        ) : null}
      </div>
    </div>
  );
}
