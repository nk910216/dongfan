import { addLocalDays, getEventType } from '@dongfan/shared';
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

/** The aggregations served here. `duration_sum` needs the midnight split. */
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
 * with no feeds really had no feeds, so `count` and `sum` carry a zero. A
 * day nobody weighed the baby is not a day the baby weighed nothing, so
 * `last`, `avg` and `max` leave it out and let the chart join the points
 * either side. Zero-filling a weight curve drops it to the floor.
 *
 * Done here rather than in the browser so there is one implementation of a
 * rule that is easy to get backwards, and so it can be tested against a
 * real database. It is not aggregation: no rows are read, the range is
 * already capped at 366 days, and the array is built once.
 */
function withGaps(
  aggregation: Aggregation,
  found: Map<string, number>,
  from: string,
  to: string,
): { date: string; value: number }[] {
  if (aggregation !== 'count' && aggregation !== 'sum') {
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

  // In the order they were asked for, so a screen can pair the series with
  // its own list of types without matching on ids.
  return typeIds
    .filter((id) => kinds.has(id))
    .map((id) => {
      const aggregation = kinds.get(id) as Aggregation;
      return {
        typeId: id,
        aggregation,
        unit: getEventType(id)?.value?.unit ?? null,
        points: withGaps(aggregation, values.get(id) ?? new Map(), from, to),
      };
    });
}
