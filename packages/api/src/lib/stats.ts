import {
  SUPPORTED_TIMEZONES, addLocalDays, getEventType, msToMinutes, startOfLocalDay,
} from '@dongfan/shared';
import type { Aggregation, StatSeriesDto } from '@dongfan/shared';

/**
 * Daily aggregates, computed by the database.
 *
 * This is an architectural rule and not an optimisation (spec 5.6). A year
 * is around 7,300 events; pulling those rows into the Worker to add them up
 * in JavaScript and serialise the result would very likely exceed the 10 ms
 * CPU budget, and it would do so only once there was a year of data to read
 * -- which is to say, long after the code was written and reviewed.
 *
 * So everything below groups in SQL and returns at most one row per local
 * date per type. The only work left in JavaScript is deciding which days
 * with nothing recorded should still carry a zero, which is a rule about
 * meaning rather than a computation over rows.
 */

/** The aggregations that are a plain group-by over the stored value. */
const DIRECT: readonly Aggregation[] = ['count', 'sum', 'max', 'avg'];

export function isDirect(aggregation: Aggregation): boolean {
  return DIRECT.includes(aggregation);
}

/**
 * One row per type per day, for everything that is a plain group-by.
 *
 * All four aggregates are computed in the same pass rather than one query
 * per aggregation: the row set is identical, and the 50-query budget is per
 * request, not per type (spec 2.5, 4.2).
 *
 * `AVG` is rounded in SQL, so the integer contract holds without the value
 * ever being a float in JavaScript (spec 5.3). SQLite's `ROUND` returns a
 * float, hence the `CAST`.
 */
const DIRECT_SQL = (placeholders: string): string => `
SELECT type_id AS typeId,
       local_date AS date,
       COUNT(*) AS n,
       CAST(COALESCE(SUM(value), 0) AS INTEGER) AS total,
       CAST(COALESCE(MAX(value), 0) AS INTEGER) AS high,
       CAST(ROUND(COALESCE(AVG(value), 0)) AS INTEGER) AS mean
  FROM events
 WHERE baby_id = ?
   AND deleted_at IS NULL
   AND type_id IN (${placeholders})
   AND local_date >= ? AND local_date <= ?
 GROUP BY type_id, local_date
 ORDER BY local_date`;

/**
 * The last value recorded on each day, for weight, height and head size.
 *
 * "Last" is by `started_at`, with the id breaking ties, which is the same
 * order the summary uses so that two screens cannot disagree about which of
 * two weighings taken in the same second is the later one (spec 5.5).
 *
 * A window function rather than a correlated subquery: one pass over the
 * index, and no per-day query to multiply by 366.
 */
const LAST_SQL = (placeholders: string): string => `
SELECT typeId, date, CAST(value AS INTEGER) AS value FROM (
  SELECT type_id AS typeId,
         local_date AS date,
         value,
         ROW_NUMBER() OVER (
           PARTITION BY type_id, local_date
           ORDER BY started_at DESC, id DESC
         ) AS rank
    FROM events
   WHERE baby_id = ?
     AND deleted_at IS NULL
     AND type_id IN (${placeholders})
     AND local_date >= ? AND local_date <= ?
) WHERE rank = 1
 ORDER BY date`;

/**
 * Time spent per day, with the night that crossed midnight split in two.
 *
 * A sleep from 23:10 to 07:05 is *counted* on the earlier evening, because
 * `local_date` comes from `started_at`. Its duration belongs to both days,
 * and attributing all of it to either one makes a chart showing one night at
 * zero hours and the next at sixteen (spec 3.4).
 *
 * The shape spec 5.6 asks for: `UNION ALL` over "before midnight" and "after
 * midnight", which is enough because an event lasts at most 24 hours and so
 * crosses midnight at most once (spec 3.4.1 rule 1). **That invariant is
 * what makes two parts sufficient.** It is enforced when an event is
 * written; a row that broke it would have its whole tail attributed to the
 * following day.
 *
 * Two of the conditions change the answer and one does not, which is worth
 * separating rather than listing them as though all three were load-bearing:
 *
 * - `deleted_at IS NULL` — a tombstone keeps its times, so without this a
 *   deleted night still counts. **Dropping it fails a test.**
 * - the lower bound is **one day earlier than asked for**, because the sleep
 *   that gives this morning its first seven hours is filed under last night
 *   (spec 3.4.1 rule 2). The segments are filtered back to the range after
 *   the split, not before it. **Dropping it fails a test.**
 * - `ended_at IS NOT NULL` — an unfinished event has no length (spec 3.4.1
 *   rule 3), which is why the chart says it shows finished records only
 *   (spec 7.7). **This one is not observable**: `MIN(NULL, boundary)` is
 *   NULL, NULL minus anything is NULL, and `SUM` skips it, so SQLite
 *   already leaves those rows out. Removing the condition passes every
 *   test. It stays because the intent should be readable here rather than
 *   inferred from NULL arithmetic, and because a later edit to the `MIN`
 *   could make it matter — not because anything checks it.
 *
 * `boundary` is the start of the day after the one the event is filed under,
 * as an instant. SQLite's `unixepoch` gives UTC midnight of a date; the
 * baby's offset turns that into local midnight. `offsetMs` is bound, and
 * `offsetFor` refuses to guess it when a zone could have more than one.
 */
const DURATION_SQL = (placeholders: string): string => `
WITH spans AS (
  SELECT type_id,
         local_date,
         started_at,
         ended_at,
         unixepoch(local_date, '+1 day') * 1000 - ? AS boundary
    FROM events
   WHERE baby_id = ?
     AND deleted_at IS NULL
     AND ended_at IS NOT NULL
     AND type_id IN (${placeholders})
     AND local_date >= ? AND local_date <= ?
),
parts AS (
  SELECT type_id, local_date AS date, MIN(ended_at, boundary) - started_at AS ms
    FROM spans
  UNION ALL
  SELECT type_id, date(local_date, '+1 day') AS date, ended_at - boundary AS ms
    FROM spans
   WHERE ended_at > boundary
)
SELECT type_id AS typeId, date, CAST(SUM(ms) AS INTEGER) AS ms
  FROM parts
 WHERE date >= ? AND date <= ?
 GROUP BY type_id, date
 ORDER BY date`;

/*
 * A note on that last `WHERE`, so nobody takes it for a correctness guard.
 *
 * It keeps the widened day, and any day a night spilled into past the end,
 * out of what comes back. It cannot change the response: `withGaps` builds
 * the points from `from` to `to` and reads the map by date, so a row outside
 * the range is never looked at. No assertion about a response can tell the
 * two apart, and removing it passes every test.
 *
 * What it does is bound the rows crossing from the database to the Worker,
 * which is the number spec 5.6 caps at 366. Kept for that, and said here
 * rather than left looking tested.
 */

type DurationRow = { typeId: string; date: string; ms: number };

/**
 * The baby's offset from UTC, in milliseconds.
 *
 * The SQL above turns a UTC midnight into a local one with a single number,
 * which is only sound for a zone whose offset never changes. So this is an
 * **allow-list**, not a detection: it serves the zones the project has
 * declared fixed-offset (spec 5.3 — `Asia/Taipei` alone in v1, which has no
 * daylight saving) and refuses everything else.
 *
 * Deliberately not "check the offset at both ends of the range and compare".
 * That looks like a safety net and is not one: a range from June to June
 * spans two transitions and has the same offset at each end, so it would
 * pass while every night on two days of the year was split an hour out.
 *
 * Nothing reaches the refusal today: the timezone on a baby is validated
 * against the same list when the record is written. It is here so that
 * adding a zone means dealing with this query rather than discovering it
 * later, and it makes no promise about detecting anything.
 */
export function offsetFor(timeZone: string, date: string): number {
  if (!SUPPORTED_TIMEZONES.includes(timeZone as (typeof SUPPORTED_TIMEZONES)[number])) {
    throw new Error(
      `${timeZone} is not a zone this query can be used with. The midnight `
      + 'split binds one UTC offset for the whole range, which is only correct '
      + 'where the offset never changes (spec 5.3).',
    );
  }

  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y as number, (m as number) - 1, d as number) - startOfLocalDay(date, timeZone);
}

type DirectRow = { typeId: string; date: string; n: number; total: number; high: number; mean: number };
type LastRow = { typeId: string; date: string; value: number };

function pick(aggregation: Aggregation, row: DirectRow): number {
  switch (aggregation) {
    case 'count': return row.n;
    case 'sum': return row.total;
    case 'max': return row.high;
    case 'avg': return row.mean;
    default: return 0;
  }
}

/** `?, ?, ?` for a list whose length is bounded by the type config. */
function placeholdersFor(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/**
 * Fills in the days nothing was recorded on, where that means zero.
 *
 * Spec 7.7 splits these two cases and the split is the whole point: a day
 * with no feeds really had no feeds, so `count`, `sum` and `duration_sum`
 * carry a zero. A day nobody weighed the baby is not a day the baby weighed
 * nothing, so `last`, `avg` and `max` leave it out and let the chart join
 * the points either side. Zero-filling a weight curve drops it to the
 * floor.
 *
 * Done here rather than in the browser so there is one implementation of a
 * rule that is easy to get backwards, and so it can be tested against a
 * real database. It is not aggregation: no rows are read, the range is
 * already capped at 366 days, and the array is built once.
 */
const FILLED: readonly Aggregation[] = ['count', 'sum', 'duration_sum'];

function withGaps(
  aggregation: Aggregation,
  found: Map<string, number>,
  from: string,
  to: string,
): { date: string; value: number }[] {
  if (!FILLED.includes(aggregation)) {
    return [...found.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, value]) => ({ date, value }));
  }

  const points: { date: string; value: number }[] = [];
  for (let date = from; date <= to; date = addLocalDays(date, 1)) {
    points.push({ date, value: found.get(date) ?? 0 });
  }
  return points;
}

/**
 * Daily series for each requested type.
 *
 * Two statements at most, whatever the number of types: one for the plain
 * group-bys and one for "the last value of the day". Neither grows with the
 * range, and nothing here runs a query per day or per type.
 */
export async function statsFor(
  db: D1Database,
  babyId: string,
  timeZone: string,
  typeIds: readonly string[],
  from: string,
  to: string,
): Promise<StatSeriesDto[]> {
  const kinds = new Map<string, Aggregation>();
  for (const id of typeIds) {
    const type = getEventType(id);
    if (type) kinds.set(id, type.aggregation);
  }

  const direct = [...kinds].filter(([, a]) => isDirect(a)).map(([id]) => id);
  const last = [...kinds].filter(([, a]) => a === 'last').map(([id]) => id);
  const spans = [...kinds].filter(([, a]) => a === 'duration_sum').map(([id]) => id);

  const values = new Map<string, Map<string, number>>();
  for (const id of kinds.keys()) values.set(id, new Map());

  if (direct.length > 0) {
    const { results } = await db
      .prepare(DIRECT_SQL(placeholdersFor(direct.length)))
      .bind(babyId, ...direct, from, to)
      .all<DirectRow>();
    for (const row of results) {
      const aggregation = kinds.get(row.typeId);
      if (aggregation) values.get(row.typeId)?.set(row.date, pick(aggregation, row));
    }
  }

  if (last.length > 0) {
    const { results } = await db
      .prepare(LAST_SQL(placeholdersFor(last.length)))
      .bind(babyId, ...last, from, to)
      .all<LastRow>();
    for (const row of results) values.get(row.typeId)?.set(row.date, row.value);
  }

  if (spans.length > 0) {
    const { results } = await db
      .prepare(DURATION_SQL(placeholdersFor(spans.length)))
      .bind(
        offsetFor(timeZone, from),
        babyId,
        ...spans,
        // One day earlier than asked for, because last night's sleep is
        // filed under last night and gives this morning its first hours
        // (spec 3.4.1 rule 2). The segments are filtered back to the range
        // inside the query, after the split.
        addLocalDays(from, -1),
        to,
        from,
        to,
      )
      .all<DurationRow>();

    // Summed in milliseconds and converted once per day, through the shared
    // helper so the API and the app round the same way. Rounding each event
    // first accumulates error across a day of naps (spec 5.3).
    for (const row of results) values.get(row.typeId)?.set(row.date, msToMinutes(row.ms));
  }

  // In the order they were asked for, so a screen can pair the series with
  // its own list of types without matching on ids.
  return typeIds
    .filter((id) => kinds.has(id))
    .map((id) => {
      const aggregation = kinds.get(id) as Aggregation;
      return {
        typeId: id,
        aggregation,
        // Minutes, not milliseconds and not seconds (spec 5.6). A duration
        // type has no value spec to take a unit from.
        unit: aggregation === 'duration_sum' ? 'min' : getEventType(id)?.value?.unit ?? null,
        points: withGaps(aggregation, values.get(id) ?? new Map(), from, to),
      };
    });
}
