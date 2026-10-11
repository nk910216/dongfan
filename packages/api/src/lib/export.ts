import { EVENT_TYPES, toLocalDate } from '@dongfan/shared';

/**
 * Everything a baby has, as one JSON document (spec 5.9).
 *
 * Three decisions here each prevent a file that looks complete and is not:
 *
 * - **Every page is read in one `batch()`**, which D1 runs as a single
 *   transaction. Read page by page in separate requests, a record added or
 *   deleted on the other phone mid-export shifts the offsets, and one row is
 *   repeated or skipped with nothing in the file to say so.
 * - **The page count is taken from a count made first, plus one page of
 *   room.** The count and the batch are two moments; the extra page absorbs
 *   what can be written between them (milliseconds). The batch reads the
 *   count again, inside its own transaction, and the rows it returned must
 *   equal it exactly -- if they do not, the answer is an error, never a
 *   shorter file.
 * - **Past the limit the answer is `EXPORT_TOO_LARGE`, never the first part.**
 *   A truncated export is indistinguishable from a complete one.
 *
 * **The JSON is built by SQLite**, one `json_object` per row. The Worker
 * joins strings and does not touch a field: the CPU limit is 10 ms
 * (spec 2.5), and a year is about 7,300 records. What that costs in a
 * deployed Worker has not been measured -- nothing local can (spec 11.2).
 */

/** Rows per page. Large, because each page is a statement and statements are budgeted. */
export const EXPORT_PAGE_SIZE = 2000;

/**
 * The most pages one export reads: 24 pages of 2,000, which with the
 * spare page held back is a little under 46,000 records.
 *
 * Bounded by the query budget rather than chosen. The handler spends four
 * statements besides its pages -- the count, the baby, the tags, the second
 * count -- and the session and the permission check spend two before it
 * runs; spec 11.2's guardrail is thirty. It was 25 until the test that
 * counts the whole request at the ceiling came to 31.
 */
export const EXPORT_MAX_PAGES = 24;

const COUNT = 'SELECT COUNT(*) AS n FROM events WHERE baby_id = ? AND deleted_at IS NULL';

const BABY = `
SELECT json_object(
  'id', id, 'nickname', nickname, 'gender', gender,
  'birthDate', birth_date, 'timezone', timezone
) AS j
FROM babies WHERE id = ?`;

const TAGS = `
SELECT json_object('id', id, 'name', name, 'createdAt', created_at) AS j
FROM tags WHERE baby_id = ?
ORDER BY name, id`;

/**
 * One page of records, oldest first with the id breaking ties, so the pages
 * of one transaction tile the table exactly.
 *
 * `rev`, `version` and `deleted_at` are left out: they mean something only
 * to this database's sync, and a reader could mistake them for facts about
 * the baby. Deleted records are not exported at all.
 */
const EVENTS_PAGE = `
SELECT json_object(
  'id', e.id,
  'typeId', e.type_id,
  'startedAt', e.started_at,
  'endedAt', e.ended_at,
  'localDate', e.local_date,
  'value', e.value,
  'note', e.note,
  'metadata', json(e.metadata),
  'active', json(CASE WHEN e.active = 1 THEN 'true' ELSE 'false' END),
  'tagIds', (SELECT json_group_array(tag_id)
               FROM (SELECT et.tag_id FROM event_tags et
                      WHERE et.event_id = e.id ORDER BY et.tag_id)),
  'createdBy', e.created_by,
  'createdAt', e.created_at,
  'updatedAt', e.updated_at
) AS j
FROM events e
WHERE e.baby_id = ? AND e.deleted_at IS NULL
ORDER BY e.started_at, e.id
LIMIT ? OFFSET ?`;

/** How each type's stored integers read: the same rules as spec 5.3. */
function typesTable(): string {
  const types: Record<string, { unit: string | null; scale: number | null; aggregation: string }> = {};
  for (const type of EVENT_TYPES) {
    types[type.id] = {
      unit: type.value?.unit ?? null,
      scale: type.value?.scale ?? null,
      aggregation: type.aggregation,
    };
  }
  return JSON.stringify(types);
}

export type ExportResult =
  | { kind: 'ok'; body: string; filename: string; eventCount: number }
  | { kind: 'too_large'; eventCount: number }
  | { kind: 'not_found' }
  /** The count moved further than the room left for it. Not reachable by a person. */
  | { kind: 'moved' };

type Row = { j: string };

function strings(result: D1Result | undefined): string[] {
  return ((result?.results ?? []) as Row[]).map((row) => row.j);
}

export async function exportBaby(
  DB: D1Database,
  babyId: string,
  timezone: string,
  limits: { pageSize: number; maxPages: number } = { pageSize: EXPORT_PAGE_SIZE, maxPages: EXPORT_MAX_PAGES },
): Promise<ExportResult> {
  const counted = (await DB.prepare(COUNT).bind(babyId).first<{ n: number }>())?.n ?? 0;
  // One page more than the count needs, which is the room for whatever is
  // written between this count and the batch.
  const pages = Math.floor(counted / limits.pageSize) + 1;
  if (pages > limits.maxPages) return { kind: 'too_large', eventCount: counted };

  const results = await DB.batch([
    DB.prepare(BABY).bind(babyId),
    DB.prepare(TAGS).bind(babyId),
    DB.prepare(COUNT).bind(babyId),
    ...Array.from({ length: pages }, (_, page) =>
      DB.prepare(EVENTS_PAGE).bind(babyId, limits.pageSize, page * limits.pageSize)),
  ]);

  const [babyResult, tagsResult, countResult, ...pageResults] = results;
  const baby = strings(babyResult)[0];
  if (baby === undefined) return { kind: 'not_found' };

  const eventCount = ((countResult?.results ?? []) as { n: number }[])[0]?.n ?? 0;
  const events = pageResults.flatMap(strings);
  // Same transaction, so these agree unless more was written before the
  // batch than the spare page could hold. Then the file would be short, and
  // a short file is the one thing this must never hand over.
  if (events.length !== eventCount) return { kind: 'moved' };

  const now = Date.now();
  const body = `{"format":"dongfan-export","formatVersion":1,"exportedAt":${now},`
    + `"baby":${baby},"types":${typesTable()},`
    + `"tags":[${strings(tagsResult).join(',')}],`
    + `"eventCount":${eventCount},"events":[${events.join(',')}]}`;

  return {
    kind: 'ok',
    body,
    // ASCII only: a nickname in a header needs an encoding every browser
    // agrees on, and the date says enough.
    filename: `dongfan-${toLocalDate(now, timezone)}.json`,
    eventCount,
  };
}
