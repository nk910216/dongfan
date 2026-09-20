/**
 * The home screen's data, in three queries (spec 5.5).
 *
 * Written against D1 directly rather than the query builder: the per-type
 * figures need a window function, and the aggregation has to happen in SQL
 * because a year of events pulled into the worker would not fit in ten
 * milliseconds of CPU (spec 5.6).
 */

/** The two types the "how long since a feed" line covers (spec 5.5). */
const FEED_TYPE_IDS = ['nursing', 'bottle'] as const;

export type TypeSummary = {
  typeId: string;
  lastStartedAt: number;
  lastValue: number;
  /** Null unless a timer is running; not derived from endedAt (spec 3.5). */
  activeEventId: string | null;
  activeStartedAt: number | null;
  /** Needed to stop the timer, because PATCH demands a version (spec 6.3). */
  activeVersion: number | null;
};

export type DiaperCounts = {
  pee: number;
  poo: number;
  both: number;
  unknown: number;
  total: number;
};

export type Summary = {
  types: TypeSummary[];
  today: { totalBottleMl: number; diaper: DiaperCounts };
  /** Deliberately not scoped to today: at 00:30 the last feed was yesterday. */
  lastFeedAt: number | null;
};

/**
 * The newest row per type, plus whichever row is running.
 *
 * They are looked up separately on purpose. The two are not always the same
 * row: back-filling a finished sleep leaves an older timer still running,
 * and a plain GROUP BY with bare columns would hand back a mismatched id,
 * timestamp and value (spec 5.5).
 */
const PER_TYPE_SQL = `
WITH latest AS (
  SELECT type_id, started_at, value,
         ROW_NUMBER() OVER (PARTITION BY type_id ORDER BY started_at DESC, id DESC) AS rn
    FROM events
   WHERE baby_id = ? AND deleted_at IS NULL
),
running AS (
  SELECT type_id, id, started_at, version
    FROM events
   WHERE baby_id = ? AND active = 1 AND deleted_at IS NULL
)
SELECT latest.type_id        AS type_id,
       latest.started_at     AS last_started_at,
       latest.value          AS last_value,
       running.id            AS active_event_id,
       running.started_at    AS active_started_at,
       running.version       AS active_version
  FROM latest
  LEFT JOIN running ON running.type_id = latest.type_id
 WHERE latest.rn = 1`;

/**
 * Today's totals.
 *
 * Only bottles count towards intake: pumping measures what came out of a
 * parent, not what went into the baby, and adding the two would roughly
 * double the number on the home screen (spec 5.5).
 *
 * Nappies are counted per recorded kind. Combining them here would lose the
 * distinction between "both" and "not filled in", which is exactly the one
 * the summary has to keep.
 */
const TODAY_SQL = `
SELECT
  COALESCE(SUM(CASE WHEN type_id = 'bottle' THEN value ELSE 0 END), 0) AS total_bottle_ml,
  COALESCE(SUM(CASE WHEN type_id = 'diaper' AND kind = 'pee'  THEN 1 ELSE 0 END), 0) AS pee_only,
  COALESCE(SUM(CASE WHEN type_id = 'diaper' AND kind = 'poo'  THEN 1 ELSE 0 END), 0) AS poo_only,
  COALESCE(SUM(CASE WHEN type_id = 'diaper' AND kind = 'both' THEN 1 ELSE 0 END), 0) AS both_kinds,
  COALESCE(SUM(CASE WHEN type_id = 'diaper' AND (kind IS NULL OR kind NOT IN ('pee','poo','both'))
                    THEN 1 ELSE 0 END), 0) AS unfilled
FROM (
  SELECT type_id, value, json_extract(metadata, '$.diaper_kind') AS kind
    FROM events
   WHERE baby_id = ? AND local_date = ? AND deleted_at IS NULL
)`;

const LAST_FEED_SQL = `
SELECT started_at
  FROM events
 WHERE baby_id = ? AND deleted_at IS NULL AND type_id IN (${FEED_TYPE_IDS.map(() => '?').join(', ')})
 ORDER BY started_at DESC, id DESC
 LIMIT 1`;

type PerTypeRow = {
  type_id: string;
  last_started_at: number;
  last_value: number;
  active_event_id: string | null;
  active_started_at: number | null;
  active_version: number | null;
};

type TodayRow = {
  total_bottle_ml: number;
  pee_only: number;
  poo_only: number;
  both_kinds: number;
  unfilled: number;
};

export async function buildSummary(
  DB: D1Database,
  babyId: string,
  today: string,
): Promise<Summary> {
  const [perType, todayRow, lastFeed] = await DB.batch<PerTypeRow | TodayRow | { started_at: number }>([
    DB.prepare(PER_TYPE_SQL).bind(babyId, babyId),
    DB.prepare(TODAY_SQL).bind(babyId, today),
    DB.prepare(LAST_FEED_SQL).bind(babyId, ...FEED_TYPE_IDS),
  ]);

  const types = (perType?.results ?? []).map((row): TypeSummary => {
    const r = row as PerTypeRow;
    return {
      typeId: r.type_id,
      lastStartedAt: r.last_started_at,
      lastValue: r.last_value,
      activeEventId: r.active_event_id,
      activeStartedAt: r.active_started_at,
      activeVersion: r.active_version,
    };
  });

  const counts = (todayRow?.results?.[0] ?? null) as TodayRow | null;
  const peeOnly = counts?.pee_only ?? 0;
  const pooOnly = counts?.poo_only ?? 0;
  const both = counts?.both_kinds ?? 0;
  const unknown = counts?.unfilled ?? 0;

  return {
    types,
    today: {
      totalBottleMl: counts?.total_bottle_ml ?? 0,
      diaper: {
        // "Both" counts towards each, and is also reported on its own, so a
        // reader can recover the event count: pee + poo - both + unknown.
        pee: peeOnly + both,
        poo: pooOnly + both,
        both,
        unknown,
        total: peeOnly + pooOnly + both + unknown,
      },
    },
    lastFeedAt: ((lastFeed?.results?.[0] ?? null) as { started_at: number } | null)?.started_at ?? null,
  };
}
